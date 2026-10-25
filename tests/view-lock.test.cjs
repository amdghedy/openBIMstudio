const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "vl-"));
execSync(`npx tsc src/core/view-lock.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit" });
const v = require(path.join(out, "view-lock.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const dir = (p, q) => { const d = [q[0]-p[0], q[1]-p[1], q[2]-p[2]]; const l = Math.hypot(...d); return d.map((x) => x / l); };

t("targetAhead keeps the view direction after translating the eye", () => {
  const fwd = dir([0, 0, 0], [1, -1, -2]);
  const pos2 = [5, 3, 1];
  const tgt = v.targetAhead(pos2, fwd, 7);
  const d2 = dir(pos2, tgt);
  for (let i = 0; i < 3; i++) near(d2[i], fwd[i]);
});
t("axisDistance projects an off-axis target and clamps", () => {
  near(v.axisDistance([0, 0, 0], [3, 4, 10], [0, 0, 1]), 10);
  near(v.axisDistance([0, 0, 0], [0, 0, -5], [0, 0, 1], 0.5), 0.5);
});
t("dollyTowards moves along the ray without passing the focus", () => {
  const p = v.dollyTowards([0, 0, 10], [0, 0, 0], 2);
  near(p[2], 5);
  const q = v.dollyTowards([0, 0, 10], [0, 0, 0], 1e6, 0.05);
  assert.ok(q[2] >= 0.05 - 1e-9);
  const o = v.dollyTowards([0, 0, 10], [0, 0, 0], 0.5);
  near(o[2], 20);
});
t("zoom is pure translation (direction preserved with off-centre focus)", () => {
  const pos = [0, 5, 10], fwd = dir(pos, [2, 0, 0]);
  const focus = [4, 0, -3];
  const np = v.dollyTowards(pos, focus, 1.5);
  const nt = v.targetAhead(np, fwd, 8);
  const d2 = dir(np, nt);
  for (let i = 0; i < 3; i++) near(d2[i], fwd[i]);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
