/**
 * Regression: mouse-wheel zoom must never change camera orientation.
 *
 * Root cause class: setLookAt / lookAt re-derives quaternion from world-up.
 * Any wheel path that calls those APIs can rotate the view.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log("  PASS " + name);
  } catch (e) {
    fail++;
    console.log("  FAIL " + name + ": " + e.message);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// ── Source guards ──────────────────────────────────────────────────────────

t("wheel-arbiter claims __OBS_WHEEL_AUTHORITY", () => {
  const s = read("src/core/wheel-arbiter.ts");
  assert.ok(s.includes("__OBS_WHEEL_AUTHORITY"), "authority flag missing");
  assert.ok(s.includes("setupWheelArbiter"), "setup export missing");
});

t("wheel-arbiter never calls setLookAt", () => {
  const s = read("src/core/wheel-arbiter.ts");
  // Allow the word only inside comments that ban it.
  const code = s
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
    .join("\n");
  assert.ok(!/\.setLookAt\s*\(/.test(code), "setLookAt call found in wheel-arbiter");
  assert.ok(!/\.lookAt\s*\(/.test(code), "lookAt call found in wheel-arbiter");
});

t("wheel-arbiter uses pure translation helpers", () => {
  const s = read("src/core/wheel-arbiter.ts");
  assert.ok(s.includes("applyPureTranslation"), "applyPureTranslation missing");
  assert.ok(s.includes("setPosition") || s.includes("cam.position.copy"), "position write missing");
});

t("nav-cog-force does not own wheel zoom", () => {
  const s = read("src/features/nav-cog-force.ts");
  assert.ok(
    s.includes("wheel-arbiter") || s.includes("__OBS_WHEEL_AUTHORITY") || s.includes("Intentionally empty"),
    "nav-cog-force should defer wheel to wheel-arbiter",
  );
  // The dangerous pattern: setLookAt toward COG/pivot on a wheel path.
  // Orbit may still use setLookAt — that is intentional. Guard the old
  // zoomAboutPivot name and the wheel listener body.
  assert.ok(!s.includes("function zoomAboutPivot"), "zoomAboutPivot must be removed");
});

t("navigation.ts yields wheel when authority is set", () => {
  const s = read("src/features/navigation.ts");
  assert.ok(s.includes("__OBS_WHEEL_AUTHORITY"), "navigation must check wheel authority");
});

// ── Math invariant: pure view-axis dolly preserves direction ───────────────

function dir(from, to) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

function near(a, b, eps = 1e-9) {
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
}

t("pure view-axis dolly preserves viewing direction", () => {
  const pos = [10, 8, 12];
  const target = [2, 1, 0];
  const fwd = dir(pos, target);
  const dist = Math.hypot(target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]);
  const factor = 1.25; // zoom in
  const newDist = dist / factor;
  const along = dist - newDist;
  // Translate both by along * fwd
  const newPos = [pos[0] + fwd[0] * along, pos[1] + fwd[1] * along, pos[2] + fwd[2] * along];
  const newTarget = [
    target[0] + fwd[0] * along,
    target[1] + fwd[1] * along,
    target[2] + fwd[2] * along,
  ];
  const fwd2 = dir(newPos, newTarget);
  for (let i = 0; i < 3; i++) near(fwd2[i], fwd[i]);
});

t("lateral truck preserves viewing direction", () => {
  const pos = [0, 5, 10];
  const target = [0, 0, 0];
  const fwd = dir(pos, target);
  const truck = [1.5, 0.2, -0.3];
  const newPos = [pos[0] + truck[0], pos[1] + truck[1], pos[2] + truck[2]];
  const newTarget = [target[0] + truck[0], target[1] + truck[1], target[2] + truck[2]];
  const fwd2 = dir(newPos, newTarget);
  for (let i = 0; i < 3; i++) near(fwd2[i], fwd[i]);
});

t("setLookAt-style re-aim DOES change direction (negative control)", () => {
  // Documents why setLookAt(cam, COG) is forbidden on the wheel path.
  const pos = [10, 8, 12];
  const target = [2, 1, 0];
  const cog = [5, 0, -3]; // different point
  const fwdBefore = dir(pos, target);
  const fwdAfter = dir(pos, cog); // same eye, new aim = rotation
  const dot =
    fwdBefore[0] * fwdAfter[0] + fwdBefore[1] * fwdAfter[1] + fwdBefore[2] * fwdAfter[2];
  assert.ok(dot < 0.999, "re-aiming at COG must change direction (test setup)");
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
