/**
 * Journal replay unit tests — issue #101 (automatic journal replay).
 *
 * Strategy (mirrors core-journal.test.cjs / project-persistence.test.cjs):
 *   1. compile the REAL production modules (journal-replay.ts, which pulls
 *      in the pure project-schema.ts normalizer, and indexeddb-journal.ts
 *      for the quarantine prune selector) with tsc and exercise their
 *      exported behaviour directly;
 *   2. assert the real boot wiring in the sources that cannot run headless
 *      (main.ts crash-recovery step ordering, auto-reopen suppression,
 *      crash-marker gating).
 *
 * Covers: apply-entry, stop-on-corrupt, idempotency, quarantine-tail,
 * delete semantics, corrupt snapshot, seq gaps, wrong-project entries,
 * unknown kinds, and the quarantine retention cap.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-journal-replay-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");

/* ── compile the real production implementations ───────────────────────── */
execSync(
  `npx tsc src/modules/projects/journal-replay.ts src/modules/projects/indexeddb-journal.ts ` +
  `--outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const find = (d, n) => {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = find(p, n); if (r) return r; }
    else if (f.name === n) return p;
  }
  return undefined;
};
const { replayJournalOps, replayIsIdempotent } = require(find(out, "journal-replay.js"));
const { selectQuarantinePruneKeys, PROJECT_JOURNAL_QUARANTINE_KEEP } = require(find(out, "indexeddb-journal.js"));

const PID = "proj-replay-test";
const otherPid = "proj-someone-else";

function doc(id, wallCount, updatedAt) {
  return {
    id, name: `Project ${id}`, createdAt: 1000, updatedAt,
    elements: Array.from({ length: wallCount }, (_, i) => ({ id: `wall-${i + 1}`, type: "wall", name: `Wall ${i + 1}`, params: {} })),
    models: [], grids: [], levels: [], issues: [],
  };
}
function op(seq, kind, payload) { return { seq, kind, payload }; }
function snapshot(seq, stateDoc) { return { seq, state: JSON.stringify(stateDoc) }; }

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`ok - ${name}`); }

/* ── 1. apply-entry ───────────────────────────────────────────────────── */
check("replace-state entries apply in seq order, last wins", () => {
  const r = replayJournalOps(PID, null, [op(1, "replace-state", doc(PID, 1, 100)), op(2, "replace-state", doc(PID, 2, 200))]);
  assert.equal(r.status, "full");
  assert.equal(r.doc.elements.length, 2);
  assert.equal(r.doc.updatedAt, 200);
  assert.deepEqual(r.appliedSeqs, [1, 2]);
  assert.equal(r.lastAppliedSeq, 2);
  assert.equal(r.stoppedAtSeq, null);
  assert.deepEqual(r.quarantined, []);
});

check("snapshot is restored first; entries at or below its seq are ignored", () => {
  const r = replayJournalOps(PID, snapshot(5, doc(PID, 5, 500)), [
    op(3, "replace-state", doc(PID, 3, 300)), // already snapshotted: ignored
    op(5, "replace-state", doc(PID, 9, 900)), // at snapshot seq: ignored
    op(6, "replace-state", doc(PID, 6, 600)),
  ]);
  assert.equal(r.status, "full");
  assert.equal(r.baseSeq, 5);
  assert.equal(r.doc.elements.length, 6);
  assert.deepEqual(r.appliedSeqs, [6]);
});

check("delete ends replay with null and status deleted; nothing is resurrected", () => {
  const r = replayJournalOps(PID, null, [op(1, "replace-state", doc(PID, 1, 100)), op(2, "delete", null)]);
  assert.equal(r.status, "deleted");
  assert.equal(r.doc, null);
  assert.deepEqual(r.appliedSeqs, [1, 2]);
});

check("replace-state after a delete restores the project (explicit re-creation only)", () => {
  const r = replayJournalOps(PID, null, [op(1, "delete", null), op(2, "replace-state", doc(PID, 1, 100))]);
  assert.equal(r.status, "full");
  assert.equal(r.doc.elements.length, 1);
});

check("empty journal replays to empty, never to a fabricated document", () => {
  const r = replayJournalOps(PID, null, []);
  assert.equal(r.status, "empty");
  assert.equal(r.doc, null);
});

/* ── 2. stop-on-corrupt ───────────────────────────────────────────────── */
check("corrupt entry stops replay at that point; earlier state survives", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(2, "replace-state", null), // torn / null payload
    op(3, "replace-state", doc(PID, 3, 300)), // good, but after the stop: never applied
  ]);
  assert.equal(r.status, "partial");
  assert.equal(r.doc.elements.length, 1, "state up to the last good entry is recovered");
  assert.equal(r.doc.updatedAt, 100);
  assert.equal(r.stoppedAtSeq, 2);
  assert.match(r.stoppedReason, /not a usable project document|no document payload/);
  assert.deepEqual(r.appliedSeqs, [1]);
});

check("quarantine tail is the stopped entry plus every later entry, with reasons", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(2, "replace-state", { id: "", name: "x" }), // no usable id: corrupt
    op(3, "replace-state", doc(PID, 3, 300)),
    op(4, "delete", null),
  ]);
  assert.deepEqual(r.quarantined.map((q) => q.seq), [2, 3, 4]);
  assert.deepEqual(r.unreplayed.map((q) => q.seq), [2, 3, 4]);
  assert.match(r.quarantined[0].reason, /not a usable project document/);
  assert.match(r.quarantined[1].reason, /not reached/);
  assert.match(r.quarantined[2].reason, /not reached/);
  assert.equal(r.quarantined[0].raw.id, "", "the raw payload is preserved as evidence");
  assert.equal(r.doc.elements.length, 1, "nothing after the stop is applied, not even a delete");
});

check("unknown entry kind stops replay — no semantics are invented", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(2, "move-wall", { wall: "w1" }),
    op(3, "replace-state", doc(PID, 3, 300)),
  ]);
  assert.equal(r.status, "partial");
  assert.equal(r.stoppedAtSeq, 2);
  assert.match(r.stoppedReason, /unknown kind "move-wall"/);
  assert.equal(r.doc.elements.length, 1);
  assert.deepEqual(r.quarantined.map((q) => q.seq), [2, 3]);
});

check("entry for another project stops replay", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(2, "replace-state", doc(otherPid, 5, 200)),
  ]);
  assert.equal(r.status, "partial");
  assert.equal(r.stoppedAtSeq, 2);
  assert.match(r.stoppedReason, new RegExp(otherPid));
  assert.equal(r.doc.elements.length, 1);
});

check("repeated sequence stops replay — entries are never applied out of order", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(1, "replace-state", doc(PID, 2, 200)),
  ]);
  assert.equal(r.status, "partial");
  assert.equal(r.stoppedAtSeq, 1);
  assert.match(r.stoppedReason, /backwards or repeated/);
  assert.equal(r.doc.elements.length, 1);
});

check("corrupt snapshot does not poison the ops — replay starts from empty", () => {
  const r = replayJournalOps(PID, { seq: 5, state: "{not json" }, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(2, "replace-state", doc(PID, 2, 200)),
  ]);
  assert.equal(r.snapshotCorrupt, true);
  assert.equal(r.baseSeq, 0);
  assert.equal(r.status, "full");
  assert.equal(r.doc.elements.length, 2);
  assert.deepEqual(r.appliedSeqs, [1, 2]);
});

check("snapshot for another project is treated as corrupt, not trusted", () => {
  const r = replayJournalOps(PID, snapshot(5, doc(otherPid, 5, 500)), [
    op(6, "replace-state", doc(PID, 1, 100)),
  ]);
  assert.equal(r.snapshotCorrupt, true);
  assert.equal(r.doc.elements.length, 1);
});

check("sequence gaps are tolerated but recorded", () => {
  const r = replayJournalOps(PID, null, [
    op(1, "replace-state", doc(PID, 1, 100)),
    op(4, "replace-state", doc(PID, 2, 400)), // seq 2, 3 missing
  ]);
  assert.equal(r.status, "full");
  assert.deepEqual(r.seqGaps, [2, 3]);
  assert.equal(r.doc.elements.length, 2);
});

/* ── 3. idempotency ───────────────────────────────────────────────────── */
check("replaying the same journal twice yields the same state", () => {
  const ops = [op(1, "replace-state", doc(PID, 1, 100)), op(2, "replace-state", doc(PID, 2, 200))];
  const first = replayJournalOps(PID, null, ops);
  const second = replayJournalOps(PID, null, ops);
  assert.equal(replayIsIdempotent(first, second), true);
  assert.deepEqual(first, second);
});

check("replaying after recovery re-appended the same document yields the same state", () => {
  const ops = [op(1, "replace-state", doc(PID, 1, 100)), op(2, "replace-state", doc(PID, 2, 200))];
  const first = replayJournalOps(PID, null, ops);
  // putProject() re-appends the recovered document as a new entry (seq 3, same content).
  const afterRecovery = replayJournalOps(PID, null, [...ops, op(3, "replace-state", doc(PID, 2, 200))]);
  assert.equal(replayIsIdempotent(first, afterRecovery), true);
  assert.deepEqual(first.doc, afterRecovery.doc);
});

check("replaying a partially recovered journal twice yields the same partial state", () => {
  const ops = [op(1, "replace-state", doc(PID, 1, 100)), op(2, "replace-state", null)];
  const first = replayJournalOps(PID, null, ops);
  const second = replayJournalOps(PID, null, ops);
  assert.equal(first.status, "partial");
  assert.equal(replayIsIdempotent(first, second), true);
  assert.deepEqual(first.quarantined.map((q) => q.seq), second.quarantined.map((q) => q.seq));
});

/* ── 4. quarantine retention ──────────────────────────────────────────── */
check("quarantine keeps the newest 50 per project", () => {
  assert.equal(PROJECT_JOURNAL_QUARANTINE_KEEP, 50);
  const existing = Array.from({ length: 51 }, (_, i) => ({ key: `p:${i + 1}`, seq: i + 1 }));
  assert.deepEqual(selectQuarantinePruneKeys(existing, 50), ["p:2", "p:1"]); // newest-first, like selectBrowserRecoveryDeletes
  assert.deepEqual(selectQuarantinePruneKeys(existing.slice(0, 49), 50), []); // 49 existing + pending add = 50: nothing pruned
  assert.deepEqual(selectQuarantinePruneKeys([], 50), []);
});

/* ── 5. boot wiring (source-shape assertions for what cannot run headless) ── */
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
check("boot runs crash recovery before auto-reopen, and only when a crash marker exists", () => {
  const main = read("src/main.ts");
  const recoveryAt = main.indexOf('step("project-crash-recovery"');
  const reopenAt = main.indexOf('step("project-auto-reopen"');
  assert.ok(recoveryAt > 0 && reopenAt > recoveryAt, "crash-recovery step must precede auto-reopen in main.ts");
  assert.match(main, /const marker = readCrashMarker\(\);\s*if \(!marker\) return;/);
  assert.match(main, /await recoverCrashedProject\(marker\.projectId\)/);
  assert.match(main, /dispatchRecoveryOutcome\(outcome\)/);
  // The event itself is dispatched by the shared helper, not inline in
  // main.ts — assert it there, so a refactor cannot silently drop the
  // banner update.
  const helper = read("src/modules/projects/journal-recovery.ts");
  assert.match(helper, /window\.dispatchEvent\(new CustomEvent\("obs:recovery-replayed"/);
});
check("manual open replays a never-triaged crash, gated on that project's marker", () => {
  const projects = read("src/modules/projects/projects.ts");
  const openAt = projects.indexOf("export async function openProject");
  assert.ok(openAt > 0, "openProject must exist");
  const body = projects.slice(openAt, projects.indexOf("const load = await store.loadProjectDoc", openAt));
  assert.match(body, /readCrashMarker\(\)/);
  assert.match(body, /marker\.projectId === id/);
  assert.match(body, /await recoverCrashedProject\(id\)/);
  assert.match(body, /dispatchRecoveryOutcome\(outcome\)/);
  assert.match(body, /suppressReopen/);
  // The replay must run BEFORE the primary record is loaded: a corrupt
  // primary is refused outright by loadProjectDoc, so replaying after
  // it would be too late.
  assert.ok(body.indexOf("recoverCrashedProject") < projects.indexOf("const load = await store.loadProjectDoc", openAt));
});
check("manual open never touches the journal without a marker for that project", () => {
  const projects = read("src/modules/projects/projects.ts");
  // No static import of the recovery module: the journal read is
  // dynamic and marker-gated, so a clean open never pays for it — and
  // the persistence cycle (persistence imports projects) stays out of
  // the static graph.
  assert.doesNotMatch(projects, /^import .* from "\.\/journal-recovery";/m);
  assert.doesNotMatch(projects, /^import .* from "\.\/persistence";/m);
});
check("auto-reopen never resurrects a journal-deleted project", () => {
  const reopen = read("src/modules/projects/auto-reopen.ts");
  assert.match(reopen, /obs\.recovery\.last/);
  assert.match(reopen, /suppressReopen === true/);
});
check("recovery never uses the blind Journal.open replay path", () => {
  const wiring = read("src/modules/projects/journal-recovery.ts");
  assert.doesNotMatch(wiring, /recoverProjectState/);
  assert.match(wiring, /replayJournalOps\(projectId, raw\.snapshot, raw\.ops\)/);
  assert.match(wiring, /quarantineProjectJournalOps\(projectId, replay\.quarantined\)/);
  assert.match(wiring, /putProject\(replay\.doc\)/);
});
check("crash marker is cleared only after triage, never before a retry is due", () => {
  const wiring = read("src/modules/projects/journal-recovery.ts");
  assert.match(wiring, /clearCrashMarker\(\);/);
  assert.match(wiring, /restore write failed:/);
  assert.match(wiring, /marker kept for retry/);
});

console.log(`PASS journal replay (${passed} checks)`);
