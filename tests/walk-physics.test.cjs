const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "walk-"));
execSync(`npx tsc src/features/walk-physics.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit" });
const w = require(path.join(out, "walk-physics.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

t("slide along wall removes the into-wall component", () => {
  const [vx, vz] = w.slideVelocity(1, 1, -1, 0);
  near(vx, 0); near(vz, 1);
});
t("normal facing away still slides (flipped)", () => {
  const [vx, vz] = w.slideVelocity(1, 0, 1, 0);
  near(vx, 0); near(vz, 0);
});
t("any motion along the normal is removed (caller only invokes it for blocking hits)", () => {
  const [vx, vz] = w.slideVelocity(-1, 0.5, -1, 0);
  near(vx, 0); near(vz, 0.5);
});
t("blocking hit rules", () => {
  assert.ok(w.isBlockingHit(0.3, 0, 0.3, 0.1));
  assert.ok(!w.isBlockingHit(0.6, 0, 0.3, 0.1));
  assert.ok(!w.isBlockingHit(0.1, 0.95, 0.3, 0.1));
});
t("speed factor clamps", () => { near(w.clampSpeedFactor(10), 4); near(w.clampSpeedFactor(0.01), 0.25); });
t("yaw matches movement basis", () => {
  near(w.yawFromDirection(0, -1), 0);
  near(w.yawFromDirection(1, 0), -Math.PI / 2);
  assert.strictEqual(w.yawFromDirection(0, 0), null);
});
t("level stepping", () => {
  const L = [0, 3, 6];
  near(w.nextLevelElevation(L, 0, 1), 3);
  near(w.nextLevelElevation(L, 3, -1), 0);
  assert.strictEqual(w.nextLevelElevation(L, 6, 1), null);
  assert.strictEqual(w.nextLevelElevation(L, 0, -1), null);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
