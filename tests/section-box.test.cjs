const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-"));
execSync(`npx tsc src/features/section-box-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`, { stdio: "inherit" });
const m = require(path.join(out, "section-box-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

t("ray crossing the x-axis line at x=5 gives t=5", () => {
  // axis line through (0,0,0) along +x; ray from (5,10,0) pointing down -y
  const tt = m.closestParamOnLine({ x: 5, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  near(tt, 5);
});
t("skew ray: closest point still projects correctly", () => {
  const tt = m.closestParamOnLine({ x: 3, y: 10, z: 4 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  near(tt, 3);
});
t("oblique perspective ray", () => {
  // camera at (0,10,10) looking at point (7,0,0) on the axis
  const d = { x: 7, y: -10, z: -10 };
  const tt = m.closestParamOnLine({ x: 0, y: 10, z: 10 }, d, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  near(tt, 7);
});
t("parallel ray returns null", () => {
  assert.strictEqual(m.closestParamOnLine({ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), null);
});
t("moveBoxFace respects min size on both signs", () => {
  const b = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } };
  near(m.moveBoxFace(b, "x", 1, 2).max.x, 2);
  near(m.moveBoxFace(b, "x", 1, -5, 0.5).max.x, 0.5);
  near(m.moveBoxFace(b, "y", -1, 99, 0.5).min.y, 4.5);
  near(m.moveBoxFace(b, "z", -1, 3).min.z, 3);
  near(b.max.x, 10); // input untouched
});
t("handle size stays bounded", () => {
  assert.ok(m.handleSize(1000, 10) <= 2.5);
  assert.ok(m.handleSize(0.01, 10) >= 0.1);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
