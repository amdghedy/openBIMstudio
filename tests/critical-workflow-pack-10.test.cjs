/**
 * tests/critical-workflow-pack-10.test.cjs
 *
 * Regression tests for the 3D-engine workflow pack
 * (src/modules/bim-gaps/critical-workflow-pack-10.ts), items 1, 2 and 10.
 *
 * Why this file exists: Select Similar / Invert Selection / Clear
 * Selection called authoring methods that never existed (setSelectedIds,
 * selectIds, clearSelection, addToSelection), so the commands silently
 * did nothing while still toasting success. The authoring API now
 * implements setSelectedIds (the replace-selection primitive) and the
 * pack calls it directly, failing closed with a warning if it ever goes
 * missing. These tests pin that behaviour against a stubbed authoring
 * API — the same compile-and-stub harness as
 * tests/critical-workflow-pack.test.cjs.
 *
 * Run: `node tests/critical-workflow-pack-10.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}

/* ── Compile the single module to CommonJS ──────────────────────────── */
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "src/modules/bim-gaps/critical-workflow-pack-10.ts");
const tmpOut = path.join(os.tmpdir(), "obs-cwp10-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });
execSync(
  `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(tmpOut)} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const compiled = path.join(tmpOut, "critical-workflow-pack-10.js");

/* ── Stubs for the module's local imports ───────────────────────────── */
const authored = [
  { id: "wa1", type: "wall", params: { start: [0, 0], end: [10, 0] } },
  { id: "wa2", type: "wall", params: { start: [0, 4], end: [0, 9] } },
  { id: "wa3", type: "wall", params: { start: [2, 2], end: [8, 2] } },
  { id: "c1", type: "column", params: { point: [0, 0], height: 3 } },
  { id: "c2", type: "column", params: { point: [4, 0], height: 3 } },
];
let selection = [];
const notices = [];

// Toggleable: when false the stubbed authoring API has no setSelectedIds,
// i.e. the pre-fix engine, so the fail-closed path can be pinned.
let withSetSelectedIds = true;
const authoringStub = {
  getElements: () => authored,
  getSelectedIds: () => [...selection],
};
Object.defineProperty(authoringStub, "setSelectedIds", {
  configurable: true,
  get() {
    return withSetSelectedIds ? (ids) => { selection = [...ids]; } : undefined;
  },
});

const ctxMock = { ctx: { features: { authoring: authoringStub } } };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "three") return {}; // only used by the ghost path, untested here
  if (request === "../../core/context") return ctxMock;
  if (request === "../../core/notify") {
    return { notify: (kind, msg) => notices.push({ kind, msg }) };
  }
  return originalLoad.apply(this, arguments);
};

const pack = require(compiled);
Module._load = originalLoad;

t("selectSimilar3d selects every element of the seed's type", () => {
  selection = ["wa1"];
  notices.length = 0;
  const n = pack.selectSimilar3d();
  assert.strictEqual(n, 3, "three walls match");
  assert.deepStrictEqual([...selection].sort(), ["wa1", "wa2", "wa3"]);
  assert.ok(notices.some((x) => x.kind === "success" && /3/.test(x.msg)), "success toast names the count");
});

t("selectSimilar3d on a column selects columns only", () => {
  selection = ["c2"];
  const n = pack.selectSimilar3d();
  assert.strictEqual(n, 2);
  assert.deepStrictEqual([...selection].sort(), ["c1", "c2"]);
});

t("selectSimilar3d with nothing selected warns and returns 0", () => {
  selection = [];
  notices.length = 0;
  const n = pack.selectSimilar3d();
  assert.strictEqual(n, 0);
  assert.ok(notices.some((x) => x.kind === "warn"), "warn toast");
  assert.deepStrictEqual(selection, []);
});

t("invertSelection3d selects everything except the current selection", () => {
  selection = ["wa1"];
  const n = pack.invertSelection3d();
  assert.strictEqual(n, 4);
  assert.deepStrictEqual([...selection].sort(), ["c1", "c2", "wa2", "wa3"]);
});

t("invertSelection3d with nothing selected selects everything", () => {
  selection = [];
  const n = pack.invertSelection3d();
  assert.strictEqual(n, 5);
  assert.deepStrictEqual([...selection].sort(), ["c1", "c2", "wa1", "wa2", "wa3"]);
});

t("both commands fail closed when setSelectedIds is missing", () => {
  withSetSelectedIds = false;
  try {
    selection = ["wa1"];
    notices.length = 0;
    assert.strictEqual(pack.selectSimilar3d(), 0, "selectSimilar returns 0");
    assert.deepStrictEqual(selection, ["wa1"], "selection is untouched");
    assert.ok(notices.some((x) => x.kind === "warn" && /setSelectedIds/.test(x.msg)), "warn names the missing method");
    notices.length = 0;
    assert.strictEqual(pack.invertSelection3d(), 0, "invert returns 0");
    assert.deepStrictEqual(selection, ["wa1"], "selection is untouched");
    assert.ok(notices.some((x) => x.kind === "warn" && /setSelectedIds/.test(x.msg)), "warn names the missing method");
  } finally {
    withSetSelectedIds = true;
  }
});

t("clearSelection3d empties the authored selection", async () => {
  selection = ["wa1", "c1"];
  await pack.clearSelection3d();
  assert.deepStrictEqual(selection, []);
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
