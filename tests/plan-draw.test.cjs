const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pd-"));
execSync(`npx tsc src/features/plan-draw-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreConfig --ignoreDeprecations 6.0`, { stdio: "inherit" });
const m = require(path.join(out, "plan-draw-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
t("ortho locks to dominant axis", () => {
  assert.deepStrictEqual(m.constrainOrtho({ x: 0, z: 0 }, { x: 5, z: 1 }), { x: 5, z: 0 });
  assert.deepStrictEqual(m.constrainOrtho({ x: 0, z: 0 }, { x: -1, z: -4 }), { x: 0, z: -4 });
});
t("pointAtLength follows the cursor direction", () => {
  const p = m.pointAtLength({ x: 1, z: 1 }, { x: 1, z: 11 }, 3);
  near(p.x, 1); near(p.z, 4);
  const d = m.pointAtLength({ x: 0, z: 0 }, { x: 0, z: 0 }, 2);
  near(d.x, 2); near(d.z, 0);
});
t("angle is CCW from east, north up", () => {
  near(m.angleDeg({ x: 0, z: 0 }, { x: 1, z: 0 }), 0);
  near(m.angleDeg({ x: 0, z: 0 }, { x: 0, z: 1 }), 90);
  near(m.angleDeg({ x: 0, z: 0 }, { x: -1, z: 0 }), 180);
  near(m.angleDeg({ x: 0, z: 0 }, { x: 0, z: -1 }), 270);
});
t("parseLength units", () => {
  near(m.parseLength("3.5"), 3.5); near(m.parseLength("3,5"), 3.5);
  near(m.parseLength("3500mm"), 3.5); near(m.parseLength("350 cm"), 3.5); near(m.parseLength("2m"), 2);
  assert.strictEqual(m.parseLength(""), null);
  assert.strictEqual(m.parseLength("abc"), null);
  assert.strictEqual(m.parseLength("0"), null);
  assert.strictEqual(m.parseLength("-2"), null);
});
t("length chars", () => { assert.ok(m.isLengthChar("5")); assert.ok(m.isLengthChar("m")); assert.ok(!m.isLengthChar("w")); });
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
