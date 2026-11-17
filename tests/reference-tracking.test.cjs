/* Reference-line tracking: the room-drawing case (4th wall square to the 1st). */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "reftrack-"));
execSync(`npx tsc src/modules/snapping/reference-tracking.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const { computeTracking } = require(path.join(out, "reference-tracking.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-9, `${m}: ${a} vs ${b}`);

// Room: A(0,0) -> B(10,0) -> C(10,6) -> D'(?,6). 4th wall must close to A, so D must have x == A.x.
const A = { x: 0, z: 0, dirs: [0] }, B = { x: 10, z: 0, dirs: [0, Math.PI / 2] }, C = { x: 10, z: 6, dirs: [Math.PI / 2] };

t("3rd wall end snaps to the crossing of 'above A' and 'level with C'", () => {
  const h = computeTracking([0.07, 6.05], [A, B, C], 0.15);
  assert.ok(h, "should track"); assert.strictEqual(h.lines.length, 2);
  near(h.point[0], 0, "x == A.x"); near(h.point[1], 6, "z == C.z");
});

t("single line: cursor level with an endpoint is pulled onto that line", () => {
  const h = computeTracking([4.2, 6.08], [C], 0.15);
  assert.strictEqual(h.lines.length, 1); near(h.point[1], 6, "z"); near(h.point[0], 4.2, "x kept");
});

t("perpendicular to a diagonal wall through its endpoint", () => {
  const d = Math.PI / 4, P = { x: 0, z: 0, dirs: [d] };
  const px = 3 * Math.cos(d + Math.PI / 2), pz = 3 * Math.sin(d + Math.PI / 2);
  const h = computeTracking([px + 0.05, pz - 0.04], [P], 0.2);
  assert.ok(h && h.lines[0].kind === "perpendicular", "perpendicular line expected");
  assert.ok(Math.abs((h.point[0] - 0) * Math.cos(d) + (h.point[1] - 0) * Math.sin(d)) < 1e-9, "result is square to the wall");
});

t("nothing within tolerance -> no snap", () => {
  assert.strictEqual(computeTracking([5, 3], [A, B, C], 0.15), null);
});

t("right on an anchor is left to the normal endpoint snap", () => {
  assert.strictEqual(computeTracking([10.05, 6.02], [C], 0.15), null);
});

t("tolerance scales: tighter tolerance does not capture", () => {
  assert.ok(computeTracking([4, 6.1], [C], 0.15)); assert.strictEqual(computeTracking([4, 6.1], [C], 0.05), null);
});

t("dense models stay fast", () => {
  const many = Array.from({ length: 20000 }, (_, i) => ({ x: (i % 200) * 3, z: Math.floor(i / 200) * 3, dirs: [0] }));
  const t0 = Date.now(); for (let i = 0; i < 20; i++) computeTracking([100.4, 50.2], many, 0.15);
  assert.ok(Date.now() - t0 < 1500, "took " + (Date.now() - t0) + " ms");
});

console.log(`reference-tracking: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
