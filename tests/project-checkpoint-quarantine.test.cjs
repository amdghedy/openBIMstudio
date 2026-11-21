/**
 * Corrupt-checkpoint quarantine + manual-open recovery wiring — rank 4 (#91/#101).
 *
 * Strategy (mirrors project-journal.test.cjs / project-persistence.test.cjs):
 *   1. compile the REAL production modules (project-schema.ts,
 *      project-journal.ts, indexeddb-journal.ts) with tsc and exercise
 *      their exported pure behaviour directly;
 *   2. assert the real wiring in the sources that cannot run headless
 *      (IndexedDB store.ts list/restore, projects.ts openProject,
 *      project-recovery.ts UI).
 *
 * The rule under test: a corrupt recovery checkpoint is quarantined,
 * never listed as restorable and never written over the live document;
 * the user is offered the newest verified checkpoint (last known-good).
 * A corrupt operation-journal snapshot must never break saves: the
 * append path falls back to replaying ops from empty.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-checkpoint-quarantine-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");

/* ── compile the real production implementations ───────────────────────── */
execSync(
  `npx tsc src/modules/projects/project-schema.ts src/modules/projects/project-journal.ts ` +
  `src/modules/projects/indexeddb-journal.ts src/core/journal.ts ` +
  `--outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const find = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { const nested = find(file, name); if (nested) return nested; }
    else if (entry.name === name) return file;
  }
};
const journal = require(find(out, "project-journal.js"));
const idbJournal = require(find(out, "indexeddb-journal.js"));
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log(`  ok ${n} — ${name}`); };

const validDoc = (over = {}) => ({
  id: "p-1", name: "Checkpoint test", createdAt: 1000, updatedAt: 2000,
  elements: [{ id: "e1" }], models: [], grids: [], levels: [], issues: [], ...over,
});
const record = (doc, over = {}) => ({
  id: 7, projectId: "p-1", createdAt: 1500, reason: "project-save",
  doc, modelVersions: [], archivedModelIds: [], missingModelIds: [], ...over,
});

/* ── 1. checkpoint validation ─────────────────────────────────────────── */
t("validate: a well-formed checkpoint validates and returns the normalized doc", () => {
  const r = journal.validateRecoveryCheckpointRecord(record(validDoc()));
  assert.equal(r.ok, true);
  assert.equal(r.doc.id, "p-1");
  assert.equal(r.doc.elements.length, 1);
});

t("validate: a checkpoint with no document (null) is corrupt", () => {
  const r = journal.validateRecoveryCheckpointRecord(record(null));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no usable project document/);
});

t("validate: a checkpoint whose doc is not an object is corrupt", () => {
  const r = journal.validateRecoveryCheckpointRecord(record("torn-bytes"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no usable project document/);
});

t("validate: a checkpoint with no usable id is corrupt", () => {
  const r = journal.validateRecoveryCheckpointRecord(record({ name: "No id" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /no usable id/);
});

t("validate: a checkpoint from a newer schema version is corrupt", () => {
  const r = journal.validateRecoveryCheckpointRecord(record(validDoc({ schemaVersion: 99 })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /corrupt/);
});

t("validate: a checkpoint whose doc belongs to another project is corrupt", () => {
  const r = journal.validateRecoveryCheckpointRecord(record(validDoc({ id: "p-2" })));
  assert.equal(r.ok, false);
  assert.match(r.reason, /belongs to project/);
  assert.match(r.reason, /p-2/);
});

t("validate: torn collections are repaired, not quarantined", () => {
  // normalizeProjectDoc backfills non-array collections — a checkpoint
  // with a torn `elements` field is recoverable, so it must still be
  // offered, with the damage repaired, not set aside.
  const r = journal.validateRecoveryCheckpointRecord(record(validDoc({ elements: "torn" })));
  assert.equal(r.ok, true);
  assert.deepEqual(r.doc.elements, []);
});

/* ── 2. summary hardening ─────────────────────────────────────────────── */
t("summarize: a corrupt record never throws — it reports an untitled, empty summary", () => {
  const s = journal.summarizeProjectJournalRecord(record(null));
  assert.equal(s.projectName, "Untitled project");
  assert.equal(s.elementCount, 0);
  assert.equal(s.modelCount, 0);
  const s2 = journal.summarizeProjectJournalRecord(record(undefined));
  assert.equal(s2.projectName, "Untitled project");
});

t("summarize: a valid record still summarizes exactly as before", () => {
  const s = journal.summarizeProjectJournalRecord(record(validDoc()));
  assert.equal(s.projectName, "Checkpoint test");
  assert.equal(s.elementCount, 1);
  assert.equal(s.updatedAt, 2000);
});

/* ── 3. quarantine keys + pruning ─────────────────────────────────────── */
t("quarantine key: checkpoint keys are namespaced apart from op keys", () => {
  assert.equal(journal.getCheckpointQuarantineKey("p-1", 7), "p-1:checkpoint:7");
  assert.notEqual(journal.getCheckpointQuarantineKey("p-1", 7), "p-1:7");
});

t("quarantine pruning: newest checkpoints survive, oldest are evicted", () => {
  const existing = Array.from({ length: 50 }, (_, i) => ({ key: `p-1:checkpoint:${i + 1}`, seq: i + 1 }));
  const pruned = journal.selectCheckpointQuarantinePruneKeys(existing, 2);
  // Newest-first order (the helper sorts descending); the two oldest go.
  assert.deepEqual(pruned, ["p-1:checkpoint:2", "p-1:checkpoint:1"]);
});

t("quarantine pruning: under the cap nothing is pruned", () => {
  const existing = [{ key: "p-1:checkpoint:9", seq: 9 }];
  assert.deepEqual(journal.selectCheckpointQuarantinePruneKeys(existing, 1), []);
});

/* ── 4. corrupt journal snapshots never break saves ───────────────────── */
t("snapshot parse: a valid snapshot state parses to the document", () => {
  const doc = idbJournal.parseJournalSnapshotState(JSON.stringify(validDoc()));
  assert.equal(doc?.id, "p-1");
  assert.equal(doc?.elements.length, 1);
});

t("snapshot parse: torn JSON falls back to null (replay ops from empty)", () => {
  assert.equal(idbJournal.parseJournalSnapshotState('{"id": "p-1", "elem'), null);
  assert.equal(idbJournal.parseJournalSnapshotState("not json at all"), null);
});

t("snapshot parse: a non-document snapshot (null / number) falls back to null", () => {
  assert.equal(idbJournal.parseJournalSnapshotState("null"), null);
  assert.equal(idbJournal.parseJournalSnapshotState("42"), null);
  assert.equal(idbJournal.parseJournalSnapshotState('"just a string"'), null);
});

t("snapshot parse: a future-schema snapshot falls back to null", () => {
  assert.equal(idbJournal.parseJournalSnapshotState(JSON.stringify(validDoc({ schemaVersion: 99 }))), null);
});

t("snapshot parse: an id-less snapshot falls back to null", () => {
  assert.equal(idbJournal.parseJournalSnapshotState(JSON.stringify({ name: "No id" })), null);
});

/* ── 5. the blind recovery helper is gone ─────────────────────────────── */
t("no blind recoverProjectState: the helper no longer exists anywhere it could be called", () => {
  assert.equal(typeof idbJournal.recoverProjectState, "undefined");
  assert.doesNotMatch(src("src/modules/projects/indexeddb-journal.ts"), /export (async )?function recoverProjectState/);
  assert.doesNotMatch(src("src/modules/projects/journal-recovery.ts"), /recoverProjectState/);
  // The append path's restore callback is the tolerant parser, never a bare JSON.parse.
  const ij = src("src/modules/projects/indexeddb-journal.ts");
  assert.match(ij, /parseJournalSnapshotState\(state\)/);
  assert.doesNotMatch(ij, /latest = JSON\.parse\(state\)/);
});

/* ── 6. store wiring: list quarantines, restore refuses before writing ── */
t("store list: corrupt checkpoints are quarantined, good ones listed newest-first", () => {
  const store = src("src/modules/projects/store.ts");
  assert.match(store, /validateRecoveryCheckpointRecord\(record\)/);
  assert.match(store, /getCheckpointQuarantineKey\(projectId, record\.id\)/);
  assert.match(store, /S_JOURNAL_QUARANTINE/);
  assert.match(store, /quarantined: QuarantinedCheckpointSummary\[\]/);
  // The quarantine move deletes the corrupt record from the live journal.
  assert.match(store, /qtx\.objectStore\(S_JOURNAL\)\.delete\(record\.id\)/);
});

t("store restore: validation runs before any write to the live document", () => {
  const store = src("src/modules/projects/store.ts");
  const fnAt = store.indexOf("export async function restoreProjectSnapshot");
  assert.ok(fnAt > 0, "restoreProjectSnapshot must exist");
  const body = store.slice(fnAt);
  const validateAt = body.indexOf("validateRecoveryCheckpointRecord(snapshot)");
  const snapshotAt = body.indexOf('appendProjectSnapshot(tx, current, "before-restore"');
  const putAt = body.indexOf("projects.put(recovered.doc)");
  assert.ok(validateAt > 0 && snapshotAt > validateAt && putAt > validateAt,
    "validation must precede both the before-restore snapshot and the live write");
  assert.match(body, /refusing to restore a corrupt checkpoint/);
  assert.match(body, /result\.quarantined = true/);
  // The restored document is the VALIDATED (normalized) one, not the raw stored bytes.
  assert.match(body, /prepareRecoveredProjectDocument\(checked\.doc,/);
});

t("store restore: a refused checkpoint is quarantined in the same transaction", () => {
  const store = src("src/modules/projects/store.ts");
  assert.match(store, /\[S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS, S_JOURNAL_QUARANTINE\]/);
  assert.match(store, /journal\.delete\(snapshotId\)/);
});

/* ── 7. UI wiring: quarantine is shown, never silently dropped ────────── */
t("recovery UI: quarantined checkpoints are shown with their reason, and restore refusal is explicit", () => {
  const ui = src("src/features/project-recovery.ts");
  assert.match(ui, /data-quarantined-notice/);
  assert.match(ui, /data-quarantined-checkpoint/);
  assert.match(ui, /Damaged checkpoint — set aside/);
  assert.match(ui, /result\.quarantined/);
  assert.match(ui, /has been set aside — your current state was not touched/);
});

t("recovery UI: listing merges checkpoints quarantined by earlier sessions", () => {
  const projects = src("src/modules/projects/projects.ts");
  assert.match(projects, /listQuarantinedRecoverySnapshots\(current\.id\)/);
});

console.log(`PASS checkpoint quarantine (${n} checks)`);
