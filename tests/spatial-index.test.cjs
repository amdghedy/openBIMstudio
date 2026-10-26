/**
 * Spatial index unit tests (AabbOctree + PlanQuadtree).
 * Run: node tests/spatial-index.test.cjs
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-spatial-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/snapping/spatial-index.ts",
  { cwd: root, stdio: "pipe", shell: true },
);
const S = require(path.join(tmpOut, "modules/snapping/spatial-index.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  PASS", name); pass++; }
  catch (e) { console.error("  FAIL", name, e.message); fail++; }
}

t("octree queryRadius finds nearby items only", () => {
  const tree = new S.AabbOctree({
    min: [-50, -5, -50],
    max: [50, 20, 50],
  });
  tree.rebuild([
    { id: "near", aabb: { min: [0, 0, 0], max: [1, 3, 1] } },
    { id: "far", aabb: { min: [40, 0, 40], max: [41, 3, 41] } },
  ]);
  const hits = tree.queryRadius([0.5, 1, 0.5], 2);
  const ids = hits.map((h) => h.id).sort();
  assert.deepStrictEqual(ids, ["near"]);
});

t("octree update moves item", () => {
  const tree = new S.AabbOctree({ min: [-10, -1, -10], max: [10, 5, 10] });
  tree.insert({ id: "a", aabb: { min: [0, 0, 0], max: [1, 1, 1] } });
  tree.update("a", { min: [8, 0, 8], max: [9, 1, 9] });
  const nearOrigin = tree.queryRadius([0, 0, 0], 2);
  assert.strictEqual(nearOrigin.length, 0);
  const nearFar = tree.queryRadius([8.5, 0.5, 8.5], 2);
  assert.strictEqual(nearFar.length, 1);
  assert.strictEqual(nearFar[0].id, "a");
});

t("plan quadtree queryRadius", () => {
  const q = new S.PlanQuadtree({ min: [-20, -20], max: [20, 20] });
  q.rebuild([
    { id: "w1", aabb: S.aabbFromSegment2([0, 0], [5, 0], 0.1) },
    { id: "w2", aabb: S.aabbFromSegment2([15, 15], [18, 15], 0.1) },
  ]);
  const hits = q.queryRadius(2, 0, 3);
  assert.ok(hits.some((h) => h.id === "w1"));
  assert.ok(!hits.some((h) => h.id === "w2"));
});

t("aabbFromSegment2 expands thickness", () => {
  const box = S.aabbFromSegment2([0, 0], [10, 0], 0.5);
  assert.ok(box.min[1] <= -0.5);
  assert.ok(box.max[1] >= 0.5);
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
