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
const wall = { px: 0, pz: 0, nx: 0, nz: 1, t: 0 };
t("constrainToWall pushes the body out to the radius and stops motion into the wall", () => {
  const r = w.constrainToWall(0.5, 0.2, 2, -3, wall, 0.32);
  assert.ok(r.hit); near(r.z, 0.32); near(r.x, 0.5); near(r.vx, 2); near(r.vz, 0);
});
t("constrainToWall ignores a walker beyond the wall's reach sideways (doorway next to the wall)", () => {
  const r = w.constrainToWall(3, 0.1, 0, -3, wall, 0.32);
  assert.strictEqual(r.hit, false); near(r.vz, -3);
});
t("constrainToWall leaves a walker that is clear of the wall, or already well behind it", () => {
  assert.strictEqual(w.constrainToWall(0, 1, 0, -3, wall, 0.32).hit, false);
  assert.strictEqual(w.constrainToWall(0, -1, 0, -3, wall, 0.32).hit, false);
});
t("constrainToWall does not cancel motion away from the wall", () => {
  const r = w.constrainToWall(0, 0.2, 0, 2, wall, 0.32);
  near(r.vz, 2); near(r.z, 0.32);
});
t("chaseDistance: free space keeps the full distance", () => near(w.chaseDistance(2.6, null, 2.6, 0.016), 2.6));
t("chaseDistance: a wall behind pulls the camera in at once, with a margin", () => near(w.chaseDistance(2.6, 1.5, 2.6, 0.016), 1.3));
t("chaseDistance: never closer than the minimum (wall right behind the head)", () => near(w.chaseDistance(2.6, 0.2, 2.6, 0.016), 0.45));
t("chaseDistance: moving back out is eased, not instant", () => { const d = w.chaseDistance(2.6, null, 1.0, 0.1); near(d, 1.4); });
t("chaseDistance: easing never overshoots the limit", () => near(w.chaseDistance(2.6, 1.5, 1.29, 1), 1.3));
t("raiseWithCeiling: free space rises by the full step", () => near(w.raiseWithCeiling(1, 0.1, null), 1.1));
t("raiseWithCeiling: stops 0.15 m below a ceiling", () => near(w.raiseWithCeiling(1, 0.1, 0.2), 1.05));
t("raiseWithCeiling: at the clearance it no longer rises", () => near(w.raiseWithCeiling(1, 0.1, 0.15), 1));
t("raiseWithCeiling: a ceiling already too close never pushes the lift down", () => near(w.raiseWithCeiling(1, 0.1, 0.05), 1));
t("raiseWithCeiling: respects the maximum lift", () => near(w.raiseWithCeiling(59.99, 0.1, null), 60));
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
