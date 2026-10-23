const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "eb-"));
execSync(`npx tsc src/modules/mep/elbow-geometry.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`, { stdio: "inherit" });
const g = require(path.join(out, "elbow-geometry.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

t("90 degree left bend: T1,T2 at r from corner, arc endpoints coincide", () => {
  const e = g.elbowGeometry([0, 0], 0, Math.PI / 2, 1);
  near(e.T1[0], -1); near(e.T1[1], 0); near(e.T2[0], 0); near(e.T2[1], 1);
  const pts = g.arcPoints(e, 8);
  near(pts[0][0], e.T1[0]); near(pts[0][1], e.T1[1]);
  near(pts[8][0], e.T2[0]); near(pts[8][1], e.T2[1]);
});
t("tangent length uses tan(turn/2) for non-90 bends", () => {
  const e = g.elbowGeometry([0, 0], 0, Math.PI / 4, 2);
  near(e.tangent, 2 * Math.tan(Math.PI / 8));
  near(Math.hypot(e.T1[0], e.T1[1]), e.tangent);
  near(Math.hypot(e.T2[0], e.T2[1]), e.tangent);
});
t("arc is tangent to both runs for many angles, both turn directions", () => {
  for (const aIn of [0, 0.7, 2.1, -1.4, 3.0]) for (const turn of [0.4, 1.0, 1.9, -0.5, -1.3, -2.5]) {
    const e = g.elbowGeometry([3, -2], aIn, aIn + turn, 0.8);
    assert.ok(e, "geometry exists");
    const pts = g.arcPoints(e, 400);
    // every arc point is r from O
    for (const p of [pts[0], pts[200], pts[400]]) near(Math.hypot(p[0] - e.O[0], p[1] - e.O[1]), 0.8, 1e-9);
    // endpoints
    near(pts[0][0], e.T1[0], 1e-9); near(pts[0][1], e.T1[1], 1e-9);
    near(pts[400][0], e.T2[0], 1e-9); near(pts[400][1], e.T2[1], 1e-9);
    // tangent direction at T1 matches incoming run, at T2 the outgoing run
    const d1 = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], l1 = Math.hypot(...d1);
    near(Math.atan2(d1[1], d1[0]), Math.atan2(Math.sin(aIn), Math.cos(aIn)), 0.01);
    const d2 = [pts[400][0] - pts[399][0], pts[400][1] - pts[399][1]];
    const aOut = Math.atan2(Math.sin(aIn + turn), Math.cos(aIn + turn));
    near(Math.atan2(d2[1], d2[0]), aOut, 0.01);
    void l1;
    // T1 lies on the incoming line through C, T2 on the outgoing line
    const cross1 = (e.T1[0] - 3) * Math.sin(aIn) - (e.T1[1] + 2) * Math.cos(aIn);
    near(cross1, 0, 1e-9);
  }
});
t("straight and reversed runs have no elbow", () => {
  assert.strictEqual(g.elbowGeometry([0, 0], 0, 0, 1), null);
  assert.strictEqual(g.elbowGeometry([0, 0], 0, Math.PI, 1), null);
});
t("radius clamp keeps tangent within the shorter run", () => {
  const turn = Math.PI / 2;
  const r = g.clampBendRadius(5, turn, 2, 10);
  assert.ok(g.tangentLength(r, 0, turn) <= 0.45 * 2 + 1e-9);
  near(g.clampBendRadius(0.1, turn, 20, 20), 0.1);
});
t("default radius is 1.5 W", () => { near(g.defaultBendRadius(0.4), 0.6); });
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
