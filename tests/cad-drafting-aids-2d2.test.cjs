/*
 * Shared drafting-aid state (2D-2 — A12 follow-up: main-shell status-bar
 * toggles).
 *
 * The CAD viewer's drafting aids (GRID, SNAP, OSNAP, ORTHO, POLAR,
 * OTRACK, DYN, LWT) used to live only as `let` bindings inside the
 * per-tab engine closure in cad-viewer.ts, so the main-shell status bar
 * had no way to read or switch them and showed no toggles at all. The
 * fix adds the shared module cad-drafting-aids.ts as the single source
 * of truth: the viewer publishes its live flags from `updateStatus()`
 * and applies remote changes, and the shell status bar toggles the same
 * flags through the module.
 *
 * Strategy (repo precedent: grid-snap.test.cjs):
 *   1. Compile the real cad-drafting-aids.ts with tsc and test the real
 *      module behaviourally — no mocks of the decision logic.
 *   2. Source markers prove cad-viewer.ts and status-bar.ts actually
 *      wire the module into the live paths — these fail on the unfixed
 *      tree, where the module and the wiring do not exist.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-drafting-aids-"));
execSync(
  `npx tsc src/modules/cad-viewer/cad-drafting-aids.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const A = require(path.join(out, "cad-drafting-aids.js"));
const viewer = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
const statusBar = fs.readFileSync(path.join(root, "src", "shell", "status-bar.ts"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};
const has = (needle, label) => assert.ok(viewer.includes(needle), label || needle);
const hasBar = (needle, label) => assert.ok(statusBar.includes(needle), label || needle);

/* ── defaults ── */

t("defaults match the viewer's declared engine defaults", () => {
  assert.deepEqual(A.getDraftingAids(), {
    grid: true, snap: false, osnap: true, ortho: false,
    polar: true, otrack: true, dyn: true, lwt: true,
  });
  assert.equal(A.DRAFTING_AID_DEFAULTS.osnap, true);
  assert.equal(A.DRAFTING_AID_DEFAULTS.snap, false);
  assert.equal(A.DRAFTING_AID_DEFAULTS.grid, true);
});

t("getDraftingAids returns a copy — mutating it does not move the store", () => {
  const copy = A.getDraftingAids();
  copy.osnap = false;
  assert.equal(A.getDraftingAid("osnap"), true);
});

/* ── set / toggle ── */

t("set + toggle round-trip on one aid without touching the others", () => {
  A.resetDraftingAids();
  assert.equal(A.setDraftingAid("ortho", true), true);
  assert.equal(A.getDraftingAid("ortho"), true);
  assert.equal(A.getDraftingAid("osnap"), true);
  assert.equal(A.toggleDraftingAid("ortho"), false);
  assert.equal(A.getDraftingAid("ortho"), false);
  assert.equal(A.toggleDraftingAid("snap"), true);
  assert.equal(A.getDraftingAid("snap"), true);
  A.resetDraftingAids();
});

t("unknown keys are a fail-closed no-op", () => {
  A.resetDraftingAids();
  const before = A.getDraftingAids();
  assert.equal(A.setDraftingAid("nope", true), false);
  assert.equal(A.toggleDraftingAid("nope"), false);
  assert.equal(A.setDraftingAid("", true), false);
  assert.equal(A.setDraftingAid(null, true), false);
  assert.deepEqual(A.getDraftingAids(), before);
  assert.equal(A.isDraftingAidKey("osnap"), true);
  assert.equal(A.isDraftingAidKey("OSNAP"), false);
  assert.equal(A.isDraftingAidKey("ucs"), false);
});

/* ── apply + notify ── */

t("applyDraftingAids returns only the keys that actually changed", () => {
  A.resetDraftingAids();
  assert.deepEqual(A.applyDraftingAids({ ortho: true, polar: true }), ["ortho"]);
  assert.deepEqual(A.applyDraftingAids({ ortho: true }), []);
  assert.deepEqual(A.applyDraftingAids({ grid: false, lwt: false }), ["grid", "lwt"]);
  A.resetDraftingAids();
});

t("applyDraftingAids drops unknown keys and non-boolean values", () => {
  A.resetDraftingAids();
  assert.deepEqual(A.applyDraftingAids({ nope: true, ortho: "yes", dyn: 1 }), []);
  assert.equal(A.getDraftingAid("ortho"), false);
  assert.equal(A.getDraftingAid("dyn"), true);
  assert.deepEqual(A.sanitizeDraftingAids({ osnap: false, bogus: 1 }), { osnap: false });
  assert.deepEqual(A.sanitizeDraftingAids(null), {});
  assert.deepEqual(A.sanitizeDraftingAids([true]), {});
});

t("subscribers are notified exactly once per change, with the new state", () => {
  A.resetDraftingAids();
  let calls = 0;
  let last = null;
  const unsub = A.subscribeDraftingAids((s) => { calls++; last = s; });
  A.setDraftingAid("ortho", true);
  assert.equal(calls, 1);
  assert.equal(last.ortho, true);
  A.setDraftingAid("ortho", true); // no change → no notify
  assert.equal(calls, 1);
  A.applyDraftingAids({ ortho: false, polar: false, grid: false });
  assert.equal(calls, 2); // one notification for the whole batch
  assert.equal(last.ortho, false);
  assert.equal(last.polar, false);
  unsub();
  A.setDraftingAid("ortho", true);
  assert.equal(calls, 2);
  A.resetDraftingAids();
});

t("reset restores the defaults", () => {
  A.setDraftingAid("osnap", false);
  A.setDraftingAid("ortho", true);
  A.resetDraftingAids();
  assert.deepEqual(A.getDraftingAids(), A.DRAFTING_AID_DEFAULTS);
});

/* ── wiring markers (fail on the unfixed tree) ── */

t("cad-viewer.ts imports the shared module and starts engines from it", () => {
  has('import * as Aids from "../modules/cad-viewer/cad-drafting-aids";', "module import");
  has('snapOn = Aids.getDraftingAid("osnap");', "engine init reads osnap");
  has('gridSnapOn = Aids.getDraftingAid("snap");', "engine init reads snap");
  has('showGrid = Aids.getDraftingAid("grid");', "engine init reads grid");
  has('orthoOn = Aids.getDraftingAid("ortho");', "engine init reads ortho");
});

t("cad-viewer.ts publishes the live flags from updateStatus()", () => {
  has("Aids.applyDraftingAids({", "publish call");
  has("osnap: snapOn,", "publish carries osnap");
  has("snap: gridSnapOn,", "publish carries grid snap");
});

t("cad-viewer.ts applies remote changes on subscribe + activate", () => {
  has("Aids.subscribeDraftingAids(", "engine subscribes");
  has("function syncDraftingAidsFromShared(): boolean {", "sync helper exists");
  const i = viewer.indexOf("showRibbonEngine(ribbonWrap, api);");
  assert.ok(i >= 0, "activate() ribbon hook exists");
  assert.ok(
    viewer.slice(i, i + 500).includes("syncDraftingAidsFromShared();"),
    "activate() re-reads the shared aids before drawing",
  );
});

t("the LWT ribbon action now calls updateStatus() so its toggle publishes", () => {
  const i = viewer.indexOf('lwt: () => {');
  assert.ok(i >= 0, "lwt ribbon action exists");
  const block = viewer.slice(i, i + 220);
  assert.ok(block.includes("updateStatus();"), "lwt action calls updateStatus");
});

t("status-bar.ts renders real toggle buttons wired to the module", () => {
  hasBar('b.dataset.aid = def.key;', "buttons carry data-aid");
  hasBar("toggleDraftingAid(def.key)", "click toggles via the module");
  hasBar("DRAFTING_AIDS_EVENT", "bar re-renders on the module event");
  hasBar('aria-pressed', "buttons expose pressed state");
  hasBar('{ key: "osnap", label: "OSNAP"', "OSNAP button defined");
  hasBar('{ key: "ortho", label: "ORTHO"', "ORTHO button defined");
  hasBar('{ key: "grid", label: "GRID"', "GRID button defined");
  hasBar('{ key: "snap", label: "SNAP"', "SNAP button defined");
  hasBar('{ key: "polar", label: "POLAR"', "POLAR button defined");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
