/**
 * A14 dead-code guard: the duplicate snap engine and the snapping octree
 * were removed (AutoCAD parity A14), and the modules the audit claimed
 * were dead but are actually live must still be present.
 *
 * Deleted (must stay gone):
 * - src/modules/cad-viewer/cad-snap-engine.ts — duplicate OSNAP/polar/
 *   OTRACK/grid pipeline, zero product importers. The live snapper is
 *   viewer-math.ts findSnap (+ grid-snap.ts for the grid step, A4).
 * - src/modules/snapping/spatial-index.ts — AabbOctree/PlanQuadtree,
 *   only ever consumed by its own unit test. The live broad-phase is
 *   the grid index in viewer-math.ts.
 *
 * Kept (the audit's "zero importers" claim was refuted on the A14 base):
 * - src/modules/snapping/engine.ts + state-machine.ts — CI-wired
 *   test:v68-acceptance / test:v68-interaction call their exports
 *   through the snapping barrel.
 * - src/modules/streaming/spatial-octree.ts + memory-budget-manager.ts
 *   + src/features/streaming-panel.ts — the budget manager is
 *   instantiated at boot, exposed via window.__obsStreamingBudget,
 *   and reachable from the command palette; test:collab covers them.
 *
 * Run: node tests/dead-code-a14.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  PASS", name); pass++; }
  catch (e) { console.error("  FAIL", name, e.message); fail++; }
}

const DELETED_FILES = [
  "src/modules/cad-viewer/cad-snap-engine.ts",
  "src/modules/snapping/spatial-index.ts",
];

const KEPT_FILES = [
  "src/modules/cad-viewer/viewer-math.ts",
  "src/modules/cad-viewer/grid-snap.ts",
  "src/modules/snapping/engine.ts",
  "src/modules/snapping/state-machine.ts",
  "src/modules/snapping/index.ts",
  "src/modules/streaming/spatial-octree.ts",
  "src/modules/streaming/memory-budget-manager.ts",
  "src/features/streaming-panel.ts",
];

/** All source files under the given dirs, skipping build output and deps. */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

t("deleted modules are gone from the tree", () => {
  for (const rel of DELETED_FILES) {
    assert.ok(!fs.existsSync(path.join(root, rel)), `${rel} still exists`);
  }
});

t("no source file references the deleted modules", () => {
  const needles = ["cad-snap-engine", "snapping/spatial-index", "snapping\\spatial-index"];
  const self = path.resolve(__filename);
  const offenders = [];
  for (const dir of ["src", "tests", "scripts"]) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const file of walk(base)) {
      if (path.resolve(file) === self) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const needle of needles) {
        if (text.includes(needle)) offenders.push(`${path.relative(root, file)}: ${needle}`);
      }
    }
  }
  assert.deepStrictEqual(offenders, []);
});

t("snapping barrel no longer re-exports the octree", () => {
  const barrel = fs.readFileSync(path.join(root, "src/modules/snapping/index.ts"), "utf8");
  assert.ok(!barrel.includes("spatial-index"), "barrel still re-exports ./spatial-index");
  for (const mod of ["./engine", "./state-machine", "./wall-column", "./alignment", "./smart-perp-snap"]) {
    assert.ok(barrel.includes(mod), `barrel lost re-export of ${mod}`);
  }
});

t("live snap / streaming counterparts still exist", () => {
  for (const rel of KEPT_FILES) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is missing — over-deletion`);
  }
});

t("live snapper still exports findSnap", () => {
  const math = fs.readFileSync(path.join(root, "src/modules/cad-viewer/viewer-math.ts"), "utf8");
  assert.ok(/export (function|const) findSnap/.test(math), "viewer-math.ts no longer exports findSnap");
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
