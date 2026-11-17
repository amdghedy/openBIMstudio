/**
 * tests/critical-workflow-pack-2.test.cjs
 *
 * Regression tests for the 11-command QA / exchange / modify pack
 * (src/modules/bim-gaps/critical-workflow-pack-2.ts).
 *
 * The pack originally published results on dead window globals and
 * dispatched its commands through a CustomEvent nobody listens to, so the
 * commands never appeared in the palette. These tests pin the corrected
 * behaviour:
 *   1. no window globals — results live on the workflowPack2 service
 *   2. all 11 commands are registered into the REAL command palette
 *   3. the model-check / soft-clash / purge math is correct on fixtures
 *
 * Run: `node tests/critical-workflow-pack-2.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
const deep = require("node:assert").deepStrictEqual;

/* ── localStorage shim (before module load) ─────────────────────────── */
const lsStore = new Map();
globalThis.localStorage = {
  setItem: (k, v) => lsStore.set(String(k), String(v)),
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => lsStore.delete(String(k)),
  clear: () => lsStore.clear(),
};

/* ── Compile the single module to CommonJS ──────────────────────────── */
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "src/modules/bim-gaps/critical-workflow-pack-2.ts");
const tmpOut = path.join(os.tmpdir(), "obs-cwp2-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });
// --noResolve: compile only this file; every local import is stubbed via the
// Module._load hook below, mirroring tests/critical-workflow-pack.test.cjs.
execSync(
  `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(tmpOut)} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const compiled = path.join(tmpOut, "critical-workflow-pack-2.js");
const source = fs.readFileSync(compiled, "utf8");

/* ── Stub the import graph ──────────────────────────────────────────── */
const registered = [];
const notifications = [];
const selectedIds = [];
let validationDiagnostics = [];

const ctxStub = { features: {} };
const stubs = {
  "../../core/context": { ctx: ctxStub },
  "../../core/notify": { notify: (kind, message) => notifications.push({ kind, message }) },
  "./authored-ifc": { exportAuthoredToIfc: () => {} },
  "../native-bim/model-validation": {
    validateNativeModel: (snapshot) => { void snapshot; return validationDiagnostics; },
  },
  "../../features/command-palette": {
    registerCommand: (cmd) => registered.push(cmd),
  },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return origLoad.call(this, request, parent, isMain);
};

const pack = require(compiled);

/* ── Fixtures ───────────────────────────────────────────────────────── */
const els = [
  { id: "w1", type: "wall", name: "Wall 001", params: { start: [0, 0], end: [0.001, 0], elevation: 0, height: 3, thickness: 0.2 } },
  { id: "w2", type: "wall", name: "Wall 002", params: { start: [0, 0], end: [6, 0], elevation: 0, height: 3, thickness: 0.2 } },
  { id: "d1", type: "door", name: "Door 001", params: { point: [1, 0], elevation: 0, height: 2.1, thickness: 0.06 } },
  { id: "dk1", type: "duct", name: "Duct 001", params: { start: [2, 0], end: [4, 0], elevation: 3, height: 0.3, thickness: 0.3 } },
];
ctxStub.features.authoring = {
  getElements: () => els,
  getLevels: () => [],
  getGrids: () => [],
  getSelectedIds: () => selectedIds,
  setSelectedAuthored: (ids) => { selectedIds.length = 0; selectedIds.push(...ids); },
};

/* ── Tests ──────────────────────────────────────────────────────────── */
t("compiled source contains no window globals (honesty ratchet)", () => {
  assert(!/__obs[A-Za-z0-9]*/.test(source), "pack-2 still references window globals");
});

t("setup registers 11 commands into the REAL palette", () => {
  pack.setupCriticalWorkflowPack2();
  assert(registered.length === 11, "expected 11 registrations, got " + registered.length);
});

t("command ids match the documented rg-* set", () => {
  const ids = registered.map((c) => c.id);
  deep(ids, [
    "rg-modelcheck", "rg-softclash", "rg-ifc-export", "rg-json-dump",
    "rg-ortho-walls", "rg-align-x", "rg-align-z", "rg-split-mid",
    "rg-mirror-x", "rg-select-sim", "rg-purge",
  ]);
});

t("commands carry QA / Exchange / Modify categories and run functions", () => {
  for (const c of registered) {
    assert(typeof c.run === "function", c.id + " has no run()");
    assert(["QA", "Exchange", "Modify"].includes(c.category), c.id + " category " + c.category);
    assert(typeof c.label === "string" && c.label.length > 0, c.id + " missing label");
  }
});

t("workflowPack2 service exposes the 10 functions and result getters", () => {
  const api = ctxStub.features.workflowPack2;
  assert(api, "ctx.features.workflowPack2 not set");
  for (const fn of ["modelQualityCheck", "softClashCheck", "exportModelIfc", "exportModelJson",
    "orthoWalls", "alignSelection", "splitSelectionMid", "mirrorSelection", "selectSimilar", "purgeUnused"]) {
    assert(typeof api[fn] === "function", "missing " + fn);
  }
  assert("lastModelCheck" in api, "missing lastModelCheck getter");
  assert("lastSoftClash" in api, "missing lastSoftClash getter");
});

t("modelQualityCheck flags the zero-length wall and the unhosted door", () => {
  const r = pack.modelQualityCheck();
  assert(r.errors === 1, "expected 1 error, got " + r.errors);
  assert(r.warnings === 1, "expected 1 warning, got " + r.warnings);
  assert(r.issues.some((i) => i.code === "ZERO_LENGTH" && i.elementId === "w1"), "ZERO_LENGTH missing");
  assert(r.issues.some((i) => i.code === "UNHOSTED" && i.elementId === "d1"), "UNHOSTED missing");
  assert(ctxStub.features.workflowPack2.lastModelCheck.errors === 1, "lastModelCheck not surfaced");
  assert(typeof ctxStub.features.workflowPack2.lastModelCheck.at === "number", "timestamp missing");
});

t("validation diagnostics merge into the report", () => {
  validationDiagnostics = [{ severity: "error", code: "STUB", message: "stub" }];
  const r = pack.modelQualityCheck();
  assert(r.errors === 2, "stub diagnostic not merged, errors " + r.errors);
  validationDiagnostics = [];
});

t("softClashCheck reports wall-wall overlap and the duct crossing the wall", () => {
  const hits = pack.softClashCheck();
  // Wall 001 (degenerate) still overlaps Wall 002, and Duct 001 crosses Wall 002.
  assert(hits.length === 2, "expected 2 hits, got " + hits.length);
  assert(hits.some((h) => (h.a === "Duct 001" && h.b === "Wall 002") || (h.a === "Wall 002" && h.b === "Duct 001")), "duct × wall pair missing");
  assert(ctxStub.features.workflowPack2.lastSoftClash.length === 2, "lastSoftClash not surfaced");
});

t("selectSimilar selects every element of the picked type", () => {
  selectedIds.length = 0;
  selectedIds.push("w2");
  const n = pack.selectSimilar();
  assert(n === 2, "expected 2 selected, got " + n);
  deep(selectedIds.sort(), ["w1", "w2"]);
});

t("purgeUnused removes the degenerate wall", () => {
  const before = els.length;
  const removed = pack.purgeUnused();
  assert(removed === 1, "expected 1 removal, got " + removed);
  assert(els.length === before - 1, "element not removed");
  assert(!els.some((e) => e.id === "w1"), "w1 still present");
});

console.log(`\ncritical-workflow-pack-2: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
