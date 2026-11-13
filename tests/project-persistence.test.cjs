/**
 * Production persistence & recovery tests — project-persistence.test.cjs
 *
 * Strategy (mirrors project-journal.test.cjs):
 *   1. compile the REAL production modules (project-schema.ts, project-file.ts)
 *      with tsc and exercise their exported behaviour directly;
 *   2. assert the real wiring in the sources that cannot run headless
 *      (IndexedDB projects.ts / store.ts / persistence.ts / file IO / UI);
 *   3. large-project + fuzz scenarios against the compiled implementations.
 *
 * Covers: save-close-reopen shape, interrupted/corrupted data, schema
 * migration, quota detection, atomic import, crash marker, unload guard,
 * save-state machine, and backward compatibility invariants.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-project-persist-"));

/* ── compile the real production implementations ───────────────────────── */
execSync(
  `npx tsc src/modules/projects/project-schema.ts src/modules/projects/project-file.ts src/modules/projects/project-journal.ts ` +
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
const schema = require(find(out, "project-schema.js"));
const pf = require(find(out, "project-file.js"));
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");

const validDoc = (over = {}) => ({
  id: "p-test-1", name: "Tower A", createdAt: 1000, updatedAt: 2000, schemaVersion: 2,
  elements: [{ id: "e1", type: "wall", name: "W1", params: { height: 3, thickness: 0.2, elevation: 0 } }],
  models: [{ id: "m1", name: "structure.ifc", bytes: 123 }],
  ...over,
});

let n = 0;
const t = (label, fn) => { n += 1; fn(); console.log(`  ok ${n} — ${label}`); };

(async () => {

  console.log("project-persistence: schema validation & migration");

  t("valid doc passes with schema stamped and no issues", () => {
    const r = schema.normalizeProjectDoc(validDoc());
    assert.equal(r.ok, true);
    assert.equal(r.doc.schemaVersion, schema.PROJECT_DOC_SCHEMA_VERSION);
    assert.deepEqual(r.issues, []);
    assert.deepEqual(r.migrations, []);
    assert.equal(r.doc.elements.length, 1);
    assert.equal(r.doc.models[0].bytes, 123);
  });

  t("missing collections are backfilled; missing timestamps are defaulted + reported", () => {
    const r = schema.normalizeProjectDoc({ id: "p-x", name: "N" });
    assert.equal(r.ok, true);
    for (const key of ["elements", "models", "grids", "levels", "issues"]) assert.deepEqual(r.doc[key], []);
    assert.ok(r.issues.some((i) => /createdAt/.test(i)));
    assert.ok(r.issues.some((i) => /updatedAt/.test(i)));
    assert.equal(r.doc.createdAt > 0, true);
    assert.equal(r.doc.updatedAt, r.doc.createdAt);
  });

  t("non-object input is refused with a fatal reason", () => {
    for (const bad of [null, 42, "doc", [], true]) {
      const r = schema.normalizeProjectDoc(bad);
      assert.equal(r.ok, false);
      assert.equal(typeof r.fatal, "string");
    }
  });

  t("missing id is fatal — identity is never invented", () => {
    const r = schema.normalizeProjectDoc({ name: "No id" });
    assert.equal(r.ok, false);
    assert.match(r.fatal, /id/);
  });

  t("corrupted timestamps are repaired and reported", () => {
    const r = schema.normalizeProjectDoc({ ...validDoc(), createdAt: "yesterday", updatedAt: null });
    assert.equal(r.ok, true);
    assert.equal(typeof r.doc.createdAt, "number");
    assert.equal(typeof r.doc.updatedAt, "number");
    assert.ok(r.issues.some((i) => /createdAt/.test(i)));
    assert.ok(r.issues.some((i) => /updatedAt/.test(i)));
  });

  t("corrupted collection (string instead of array) is reset and reported", () => {
    const r = schema.normalizeProjectDoc({ ...validDoc(), elements: "oops" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.doc.elements, []);
    assert.ok(r.issues.some((i) => /elements/.test(i)));
  });

  t("model entries without id are dropped and counted — never silent", () => {
    const r = schema.normalizeProjectDoc(validDoc({
      models: [{ id: "m-ok", name: "a.ifc", bytes: 5 }, { name: "orphan.ifc" }, "junk", null],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.doc.models.length, 1);
    assert.equal(r.doc.models[0].id, "m-ok");
    assert.ok(r.issues.some((i) => /3 linked model entr/.test(i)));
  });

  t("legacy v1 document (no schemaVersion) migrates to current", () => {
    const legacy = JSON.parse(JSON.stringify(validDoc()));
    delete legacy.schemaVersion;
    const m = schema.normalizeProjectDoc(legacy);
    assert.equal(m.ok, true);
    assert.deepEqual(m.migrations, ["schema v1 → v2"]);
    assert.equal(m.doc.schemaVersion, schema.PROJECT_DOC_SCHEMA_VERSION);
  });

  t("future schema version is refused with an upgrade hint", () => {
    const r = schema.normalizeProjectDoc(validDoc({ schemaVersion: 99 }));
    assert.equal(r.ok, false);
    assert.match(r.fatal, /Update the app/);
  });

  t("fuzz: malformed inputs never throw and always explain themselves", () => {
    const junk = [undefined, null, 0, -1, "", "x", [], [{ id: 1 }], { id: 5 }, { id: "ok", createdAt: {} },
      { id: "ok", models: { 0: "not-array" } }, { id: "ok", schemaVersion: "two" }, { id: "ok", schemaVersion: -3 },
      { id: "  " }, { id: "ok", name: 42 }, { id: "ok", elements: [undefined] }, { id: "ok", updatedAt: Infinity }, () => {}];
    for (const input of junk) {
      const r = schema.normalizeProjectDoc(input); // must not throw
      assert.equal(typeof r.ok, "boolean");
      assert.ok(Array.isArray(r.issues));
      if (r.ok === false) assert.equal(typeof r.fatal, "string");
    }
  });

  t("repairProjectDocInPlace fixes a typed doc in place and is idempotent", () => {
    const doc = validDoc({ elements: undefined, updatedAt: "bad" });
    const issues1 = schema.repairProjectDocInPlace(doc);
    assert.ok(issues1.length >= 2);
    assert.deepEqual(doc.elements, []);
    assert.equal(typeof doc.updatedAt, "number");
    assert.equal(doc.schemaVersion, schema.PROJECT_DOC_SCHEMA_VERSION);
    const issues2 = schema.repairProjectDocInPlace(doc);
    assert.deepEqual(issues2, []);
  });

  t("isQuotaError recognises Chromium and Gecko quota failures", () => {
    const q1 = new Error("encountered"); q1.name = "QuotaExceededError";
    assert.equal(schema.isQuotaError(q1), true);
    assert.equal(schema.isQuotaError(new Error("The quota has been exceeded")), true);
    const q2 = new Error("nope"); q2.name = "NS_ERROR_DOM_QUOTA_REACHED";
    assert.equal(schema.isQuotaError(q2), true);
    assert.equal(schema.isQuotaError(new Error("random failure")), false);
    assert.equal(schema.isQuotaError(undefined), false);
  });

  console.log("project-persistence: .obsproj format (real build/parse)");

  const docA = validDoc();
  const blobOf = (bytes) => new Blob([new Uint8Array(bytes)]);
  const blobs = [
    { modelId: "m1", name: "structure.ifc", blob: blobOf(2048) },
    { modelId: "m2", name: "arch.frag", blob: blobOf(4096) },
  ];
  const file = pf.buildProjectFile(docA, blobs);
  const parsed = await pf.parseProjectFile(file);
  assert.equal(parsed.doc.id, "p-test-1");
  assert.equal(parsed.doc.elements.length, 1);
  assert.equal(parsed.blobs.length, 2);
  assert.equal(parsed.blobs[0].blob.size, 2048);
  assert.equal(parsed.blobs[1].name, "arch.frag");
  n += 1; console.log(`  ok ${n} — .obsproj roundtrip preserves document and payload sizes`);

  // truncated payload
  const truncated = await file.slice(0, file.size - 3000).arrayBuffer();
  await assert.rejects(async () => pf.parseProjectFile(new Blob([truncated])), /truncated/);
  n += 1; console.log(`  ok ${n} — truncated file is refused with a precise message`);

  // wrong magic
  const allBytes = new Uint8Array(await file.arrayBuffer());
  await assert.rejects(async () => pf.parseProjectFile(new Blob([allBytes.fill(0)])), /not an Open BIM Studio project file/);
  n += 1; console.log(`  ok ${n} — wrong magic is refused`);

  // damaged header length
  const damaged = new Uint8Array(await file.arrayBuffer());
  new DataView(damaged.buffer).setUint32(8, 0xffffffff, true);
  await assert.rejects(async () => pf.parseProjectFile(new Blob([damaged])), /damaged/);
  n += 1; console.log(`  ok ${n} — damaged header length is refused`);

  // future file version — hand-built container
  const header = { format: "obsproj", version: 99, savedAt: 1, app: "x", doc: validDoc(), blobs: [] };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  await assert.rejects(async () => pf.parseProjectFile(new Blob(["OBSPROJ1", len, json])), /newer version/);
  n += 1; console.log(`  ok ${n} — file from a newer app version is refused with an upgrade hint`);

  // valid container, garbage doc — the container parses, the schema gate must refuse
  const badHeader = { format: "obsproj", version: 1, savedAt: 1, app: "x", doc: { name: "no id" }, blobs: [] };
  const badJson = new TextEncoder().encode(JSON.stringify(badHeader));
  new DataView(len.buffer).setUint32(0, badJson.byteLength, true);
  const badFile = new Blob(["OBSPROJ1", len, badJson]);
  const badParsed = await pf.parseProjectFile(badFile); // container ok
  const gate = schema.normalizeProjectDoc(badParsed.doc);
  assert.equal(gate.ok, false);
  assert.match(gate.fatal, /id/);
  n += 1; console.log(`  ok ${n} — malformed project inside a valid container is caught by the schema gate (import refuses, file untouched)`);

  // save-close-reopen shape: JSON.stringify must carry everything needed to reopen
  const serialized = JSON.parse(JSON.stringify(parsed.doc));
  const reopened = schema.normalizeProjectDoc(serialized);
  assert.equal(reopened.ok, true);
  assert.equal(reopened.doc.models.length, 1);
  assert.equal(reopened.doc.elements.length, 1);
  n += 1; console.log(`  ok ${n} — save→close→reopen shape: JSON roundtrip revalidates cleanly`);

  // large project: 30k elements normalize quickly, large .obsproj roundtrips
  const big = validDoc({ elements: [] });
  for (let i = 0; i < 30_000; i++) big.elements.push({ id: `e${i}`, type: "wall", name: `W${i}`, params: { height: 3, thickness: 0.2, elevation: 0 } });
  const t0 = Date.now();
  const bigR = schema.normalizeProjectDoc(big);
  const dt = Date.now() - t0;
  assert.equal(bigR.ok, true);
  assert.equal(bigR.doc.elements.length, 30_000);
  assert.ok(dt < 2000, `normalize took ${dt}ms`);
  const bigFile = pf.buildProjectFile(bigR.doc, blobs);
  const bigParsed = await pf.parseProjectFile(bigFile);
  assert.equal(bigParsed.doc.elements.length, 30_000);
  assert.equal(bigParsed.blobs.length, 2);
  n += 1; console.log(`  ok ${n} — large project (30k elements, ${Math.round(bigFile.size / 1024)} KB file) normalizes in ${dt}ms and roundtrips intact`);

  console.log("project-persistence: save-state machine & failure handling (real sources)");

  const projects = src("src/modules/projects/projects.ts");

  t("saveProject has an in-flight guard — overlapping autosave writes impossible", () => {
    assert.match(projects, /if \(saving\) return; \/\/ a write is already in flight/);
    assert.match(projects, /saving = false;/);
  });

  t("saveProject is generation-guarded — edits during a write stay dirty", () => {
    assert.match(projects, /const gen = dirtyGeneration;/);
    assert.match(projects, /if \(dirtyGeneration === gen\) dirty = false;/);
    assert.match(projects, /dirtyGeneration \+= 1;/);
  });

  t("save failure keeps the document dirty and is never silent", () => {
    const catchBlock = projects.slice(projects.indexOf("} catch (err) {"), projects.indexOf("} catch (err) {") + 1600);
    assert.match(catchBlock, /dirty = true;/, "failed save must keep dirty");
    assert.match(catchBlock, /isQuotaError\(err\)/);
    assert.match(catchBlock, /dispatchEvent\(new CustomEvent\("obs:save-failed"/);
    assert.match(catchBlock, /toast\("error"/, "silent autosave failures must still toast (throttled)");
    assert.match(catchBlock, /SAVE FAILED/);
  });

  t("markDirty is suppressed during open/create transitions", () => {
    assert.match(projects, /if \(transitioning\) return;/);
    const open = projects.slice(projects.indexOf("export async function openProject"), projects.indexOf("Banners"));
    assert.match(open, /transitioning = true;/);
    assert.match(open, /transitioning = false;/);
    const create = projects.slice(projects.indexOf("export async function createProject"), projects.indexOf("Open project"));
    assert.match(create, /transitioning = true;/);
    assert.match(create, /transitioning = false;/);
  });

  t("autosave interval moved to persistence.ts with guards (no bare interval left)", () => {
    assert.doesNotMatch(projects, /setInterval\(\(\) => \{ if \(dirty && current\) void saveProject\(true\); \}, 25_000\)/);
    const persistence = src("src/modules/projects/persistence.ts");
    assert.match(persistence, /setInterval\(\(\) => \{/);
    assert.match(persistence, /isTransitioning\(\)/);
    assert.match(persistence, /getSaveState\(\)\.state === "saving"/);
    assert.match(persistence, /document\.hidden/);
  });

  t("unload guard: beforeunload warns and writes the crash marker", () => {
    const persistence = src("src/modules/projects/persistence.ts");
    assert.match(persistence, /addEventListener\("beforeunload"/);
    assert.match(persistence, /e\.preventDefault\(\)/);
    assert.match(persistence, /e\.returnValue = /);
    assert.match(persistence, /writeCrashMarker\(\)/);
    assert.match(persistence, /clearCrashMarker\(\)/);
    assert.match(persistence, /visibilitychange/);
    assert.match(persistence, /visibilityState === "hidden"/);
    assert.match(persistence, /CRASH_MARKER_KEY = "obs\.session\.unsaved"/);
    assert.match(persistence, /navigator\.storage\?\.persist/);
    assert.match(persistence, /estimateStorage\(\)/);
  });

  t("no new window.__obs* globals and no confirm(/prompt( in new persistence code", () => {
    for (const f of ["src/modules/projects/persistence.ts", "src/modules/projects/project-schema.ts", "src/features/project-recovery.ts"]) {
      const s = src(f);
      assert.doesNotMatch(s, /window\.__obs/, `window.__obs in ${f}`);
      assert.doesNotMatch(s, /(?<![\w.])confirm\(/, `confirm( in ${f}`);
      assert.doesNotMatch(s, /(?<![\w.])prompt\(/, `prompt( in ${f}`);
    }
  });

  console.log("project-persistence: store layer (real sources)");

  const store = src("src/modules/projects/store.ts");

  t("atomic import: document + payloads in ONE readwrite transaction", () => {
    assert.match(store, /export async function importProjectWithBlobs/);
    const fn = store.slice(store.indexOf("export async function importProjectWithBlobs"), store.indexOf("estimateStorage"));
    assert.match(fn, /tx = db\.transaction\(\[S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS\], "readwrite"\)/);
    assert.match(fn, /projects\.put\(doc\)/);
    assert.match(fn, /blobsStore\.put\(\{ key, projectId: doc\.id/);
    assert.match(fn, /if \(replace\)/);
  });

  t("writes are repaired before persisting; reads are normalized, corruption never discarded", () => {
    assert.match(store, /repairProjectDocInPlace\(doc\);/);
    assert.match(store, /const parsed = normalizeProjectDoc\(result\);/);
    assert.match(store, /export async function loadProjectDoc/);
    assert.match(store, /loaded: false, fatal: parsed\.fatal/);
  });

  t("existing store API surface is unchanged (backward compatibility)", () => {
    for (const fn of ["putProject", "getProject", "listProjectDocs", "deleteProjectRecord", "putModelBlob", "putImportedModel", "getModelBlobs", "deleteModelBlobs", "listProjectRecoverySnapshots", "restoreProjectSnapshot", "summarize"]) {
      assert.match(store, new RegExp(`export (async )?function ${fn}\\b`), fn);
    }
    assert.match(store, /const DB_VERSION = 2;/, "DB version must not change (no forced migration)");
    assert.match(store, /createObjectStore\(S_PROJECTS, \{ keyPath: "id" \}\)/);
  });

  console.log("project-persistence: file IO & menus (real sources)");

  const fileIo = src("src/modules/projects/project-file-io.ts");
  t("import validates the file's document before touching storage and imports atomically", () => {
    const imp = fileIo.slice(fileIo.indexOf("export async function importProjectFile"), fileIo.indexOf("export async function openProjectFromFile"));
    assert.match(imp, /normalizeProjectDoc\(doc\)/);
    assert.match(imp, /throw new ProjectFileError\(/);
    assert.match(imp, /importProjectWithBlobs\(clean, blobs, replace\)/);
    assert.doesNotMatch(imp, /for \(const b of blobs\) await store\.putModelBlob/);
    assert.doesNotMatch(imp, /store\.deleteModelBlobs\(id\);/);
  });

  const fileMenu = src("src/shell/file-menu.ts");
  t("Save-As copy is atomic; legacy JSON import is validated; recovery reachable", () => {
    assert.match(fileMenu, /importProjectWithBlobs\(copy, blobs, false\)/);
    assert.match(fileMenu, /normalizeProjectDoc\(raw\)/);
    assert.match(fileMenu, /Recovery checkpoints…/);
  });

  console.log("project-persistence: recovery UI & boot wiring (real sources)");

  const recovery = src("src/features/project-recovery.ts");
  t("the previously-unreachable recovery API now has real consumers", () => {
    assert.match(recovery, /listProjectRecoverySnapshots/);
    assert.match(recovery, /restoreProjectRecoverySnapshot/);
    assert.match(recovery, /id: "project\.recovery"/);
    assert.match(recovery, /obs:recovery-available/);
  });

  const statusBar = src("src/shell/status-bar.ts");
  t("status bar reflects the full save state machine incl. failure + retry", () => {
    assert.match(statusBar, /getSaveState/);
    assert.match(statusBar, /state === "saving"/);
    assert.match(statusBar, /state === "error"/);
    assert.match(statusBar, /state === "saved"/);
    assert.match(statusBar, /data-save-retry/);
    assert.match(statusBar, /obs:save-failed/, "status bar must react to save failures");
    assert.match(statusBar, /fmtDateTime/);
  });

  const main = src("src/main.ts");
  t("boot registers persistence + recovery steps (observable via boot health)", () => {
    assert.match(main, /step\("persistence", async \(\) => \(await import\("\.\/modules\/projects\/persistence"\)\)\.setupProjectPersistence\(\)\)/);
    assert.match(main, /step\("project-recovery"/);
  });

  t("ratchet: pre-existing __obs plan globals in projects.ts unchanged (no new ones)", () => {
    // 2 live reads + 1 pending fallback each for planDims/planAnno/planRegions.
    const hits = (projects.match(/__obs[A-Za-z]*/g) ?? []).length;
    assert.equal(hits, 9, `expected the 9 pre-existing __obs plan reads, found ${hits}`);
  });

  console.log(`\nPASS project persistence & recovery — ${n} checks against real production implementations`);
})().catch((e) => { console.error(e); process.exit(1); });
