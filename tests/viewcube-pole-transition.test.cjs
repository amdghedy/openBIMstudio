/**
 * tests/viewcube-pole-transition.test.cjs
 *
 * Regression tests for the ViewCube pole-transition jerk: pressing Top (or
 * Bottom) used to ease out and then visibly re-accelerate — a second jerk /
 * "hang and repeat" at the end of the transition.
 *
 * Root cause: the per-frame pole blend (resolveWorldUp) raced the
 * quaternion slerp. While the slerped basis up was still rotating toward the
 * pole's screen-up, the blend dragged camera.up back to +Y over the final
 * ~1° of the arc, composing into a fast roll burst in the last frames.
 *
 * Fix contract (src/modules/navigation/up-axis.ts):
 *   - resolveLookAtHint passes already-orthonormal transition/drag poses
 *     through unmodified (the slerp is the only motion);
 *   - settled poses still go through resolveWorldUp, so a pole view ends
 *     with camera.up on world +Y (orbit basis sanity) and the tiny
 *     horizontal offset that defines the on-screen up.
 *
 * The transition pipeline is exercised end-to-end against the REAL
 * camera-controls (the same library the viewer uses), driving the REAL
 * NavigationController through its tick loop with the production adapter's
 * lookAt contract.
 *
 * Run: `node tests/viewcube-pole-transition.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-pole-nav-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/navigation/index.ts src/modules/navigation/up-axis.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
process.env.NODE_PATH = path.join(root, "node_modules");
require("node:module").Module._initPaths();

const THREE = require("three");
const CameraControls = require("camera-controls").default;
CameraControls.install({ THREE });
const nav = require(path.join(tmpOut, "modules/navigation/index.js"));
const {
  resolveWorldUp, resolveLookAtHint, screenUp, TOP_EPS,
} = require(path.join(tmpOut, "modules/navigation/up-axis.js"));

if (typeof globalThis.DOMRect === "undefined") {
  globalThis.DOMRect = class {
    constructor(x = 0, y = 0, w = 0, h = 0) {
      this.x = x; this.y = y; this.width = w; this.height = h;
      this.top = y; this.left = x; this.right = x + w; this.bottom = y + h;
    }
  };
}

function stubElement() {
  return {
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { return new DOMRect(0, 0, 800, 600); },
    style: {}, ownerDocument: { pointerLockElement: null },
    isConnected: true,
  };
}

/** Production-identical adapter lookAt (src/features/viewcube.ts) minus the DOM. */
class SimAdapter {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.pendingTarget = new THREE.Vector3();
    this.controlsOutOfSync = false;
  }
  position() { return this.camera.position.clone(); }
  target() {
    const t0 = new THREE.Vector3();
    this.controls.getTarget(t0);
    return t0;
  }
  up() { return this.camera.up.clone(); }
  fovY() { return THREE.MathUtils.degToRad(60); }
  aspect() { return 1.6; }
  orthoHalfHeight() { return 10; }
  setOrthoHalfHeight() {}
  projection() { return "perspective"; }
  setProjection() { return true; }
  lookAt(pos, target, up, animate, settle = true) {
    const cam = this.camera;
    const c = this.controls;
    const r = resolveLookAtHint([pos.x, pos.y, pos.z], [target.x, target.y, target.z], [up.x, up.y, up.z], settle);
    pos = new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]);
    const wantUp = new THREE.Vector3(r.up[0], r.up[1], r.up[2]).normalize();
    const upChanged = cam.up.distanceToSquared(wantUp) > 1e-12;
    this.pendingTarget.copy(target);
    cam.up.copy(wantUp);
    if (settle && (upChanged || this.controlsOutOfSync)) {
      c.updateCameraUp?.();
    }
    c.setLookAt(pos.x, pos.y, pos.z, target.x, target.y, target.z, animate);
    this.controlsOutOfSync = false;
  }
  syncControls() {}
  focusBounds() { return null; }
  sceneBounds() { return new THREE.Box3(new THREE.Vector3(-10, -1, -10), new THREE.Vector3(10, 11, 10)); }
  onUserGesture() { return () => {}; }
}

/** Per-frame swing of the effective screen-up (what the user sees rolling). */
function screenUpSwingDeg(prevCam, cam) {
  const prevPos = prevCam.position, pos = cam.position;
  const u0 = screenUp([prevPos.x, prevPos.y, prevPos.z], [0, 0, 0]);
  const u1 = screenUp([pos.x, pos.y, pos.z], [0, 0, 0]);
  const dot = Math.max(-1, Math.min(1, u0[0] * u1[0] + u0[1] * u1[1] + u0[2] * u1[2]));
  return (Math.acos(dot) * 180) / Math.PI;
}

/** Per-frame rendered-orientation change (degrees) — what the user sees. */
function rotSwingDeg(prevQuat, cam) {
  const dot = Math.max(-1, Math.min(1, Math.abs(prevQuat.dot(cam.quaternion))));
  return (Math.acos(dot) * 180) / Math.PI;
}

/**
 * Run a cube command through the production pipeline:
 * ViewCube pump (dt = min(64, now-last), first frame 16ms) + render loop
 * (controls.update every display frame), 60fps, like the app.
 */
function runTransition({ startPos, command, doubleCommandAtMs = null }) {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 2000);
  camera.position.copy(startPos);
  camera.up.set(0, 1, 0);
  const controls = new CameraControls(camera, stubElement());
  controls.smoothTime = 0.04;
  controls.draggingSmoothTime = 0.02;
  const adapter = new SimAdapter(camera, controls);
  const controller = new nav.NavigationController(adapter, { storage: null, projectId: null, events: {} });
  controls.setLookAt(startPos.x, startPos.y, startPos.z, 0, 0, 0, false);
  controls.update(0.016);

  const FRAME = 1000 / 60;
  const frames = [];
  let now = 0;
  let pumpActive = false;
  let pumpLast = null;
  let commandFired = false;
  let prevQuat = null;

  for (let i = 0; i < 120; i++) {
    now += FRAME;
    if (!commandFired && i >= 1) {
      commandFired = true;
      command(controller);
      if (controller.isTransitioning()) { pumpActive = true; pumpLast = null; }
    }
    if (doubleCommandAtMs != null && now >= doubleCommandAtMs) {
      doubleCommandAtMs = null;
      command(controller);
      if (controller.isTransitioning()) { pumpActive = true; pumpLast = null; }
    }
    if (pumpActive) {
      const dt = pumpLast == null ? 16 : Math.min(64, now - pumpLast);
      pumpLast = now;
      pumpActive = controller.tick(dt);
    }
    controls.update(FRAME / 1000);
    frames.push({
      i,
      t: now,
      pos: camera.position.clone(),
      up: camera.up.clone(),
      quat: camera.quaternion.clone(),
      rotSwing: prevQuat ? rotSwingDeg(prevQuat, camera) : 0,
      transitioning: controller.isTransitioning(),
    });
    prevQuat = camera.quaternion.clone();
  }
  return { frames, camera, controls, controller };
}

const TARGET = new THREE.Vector3(0, 0, 0);
const DIST = 25;

function analyzeSwing(frames) {
  let max = 0, at = -1;
  for (const f of frames) {
    if (f.rotSwing > max) { max = f.rotSwing; at = f.i; }
  }
  return { max, at };
}

/**
 * Detect the reported "shake" at the end of pole transitions.
 *
 * The old pipeline's signature (measured): the roll rate peaks mid-flight
 * (~3.5°/frame), decays, and then the per-frame pole blend REVERSES the roll
 * direction and re-accelerates it beyond the established peak (up to
 * ~4.6°/frame in the final frames) — the horizon visibly wobbles back and
 * forth. A smooth eased slerp never re-accelerates past its mid-flight peak.
 *
 * Detector: the max per-frame rotation rate in the tail (after the 70% mark
 * of the active frames) must not exceed 1.15× the mid-flight peak, and no
 * rate anywhere may exceed 10°/frame at 60fps.
 */
function assertNoEndJerk(frames, label) {
  const active = frames.filter((f) => f.transitioning || f.rotSwing > 0.01);
  if (active.length < 8) throw new Error(`${label}: too few active frames (${active.length})`);
  const midEnd = Math.floor(active.length * 0.7);
  let midPeak = 0;
  for (let k = 0; k < midEnd; k++) midPeak = Math.max(midPeak, active[k].rotSwing);
  let tailMax = 0, tailAt = -1;
  for (let k = midEnd; k < active.length; k++) {
    if (active[k].rotSwing > tailMax) { tailMax = active[k].rotSwing; tailAt = active[k].i; }
  }
  if (tailMax > midPeak * 1.15 + 1e-9) {
    throw new Error(
      `${label}: tail rotation re-accelerated to ${tailMax.toFixed(2)}°/frame (frame ${tailAt}) ` +
      `vs mid-flight peak ${midPeak.toFixed(2)}°/frame — the end-of-transition shake is back`);
  }
  if (midPeak > 10) {
    throw new Error(`${label}: per-frame rotation peaked at ${midPeak.toFixed(2)}°/frame (>10°)`);
  }
}

console.log("— resolveLookAtHint contract —");

t("non-settled orthonormal pose passes through unmodified (no pole correction)", () => {
  const pos = [0, 25, 0];
  const up = [0, 0, -1];
  const r = resolveLookAtHint(pos, [0, 0, 0], up, false);
  assert(r.pos === pos, "position object was replaced on a pass-through pose");
  near(r.up[1], 0, 1e-12);
  near(r.up[2], -1, 1e-12);
});

t("settled pole pose converts to world-up +Y with a single TOP_EPS tilt", () => {
  const pos = [0, 25, 0];
  const r = resolveLookAtHint(pos, [0, 0, 0], [0, 0, -1], true);
  near(r.pos[2], TOP_EPS * 25, 1e-9);
  near(r.up[0], 0, 1e-12);
  near(r.up[1], 1, 1e-12);
  near(r.up[2], 0, 1e-12);
});

t("non-orthogonal up always falls back to resolveWorldUp", () => {
  const pos = [12, 20, 16];
  const a = resolveLookAtHint(pos, [0, 0, 0], [0, 1, 0], false);
  const b = resolveWorldUp(pos, [0, 0, 0], [0, 1, 0]);
  for (let k = 0; k < 3; k++) {
    near(a.pos[k], b.pos[k], 0);
    near(a.up[k], b.up[k], 0);
  }
});

t("settled non-pole pose is untouched by the hint resolver", () => {
  const pos = [12, 20, 16];
  const up = [0, 1, 0];
  const r = resolveLookAtHint(pos, [0, 0, 0], up, true);
  near(r.pos[1], 20, 1e-12);
  near(r.up[1], 1, 1e-12);
});

console.log("\n— Top transition pipeline (real camera-controls) —");

const ISO_START = new THREE.Vector3(1.2, 0.7, 1.2).normalize().multiplyScalar(DIST);

t("Top snap: orientation eases out monotonically (no end-of-transition roll burst)", () => {
  const { frames } = runTransition({
    startPos: ISO_START,
    command: (c) => c.navigateToFace("top"),
  });
  assertNoEndJerk(frames, "Top snap");
});

t("Top snap: no mid-transition motion stall (no hang)", () => {
  const { frames } = runTransition({
    startPos: ISO_START,
    command: (c) => c.navigateToFace("top"),
  });
  const active = frames.filter((f) => f.transitioning);
  assert(active.length >= 20, `transition too short: ${active.length} frames`);
  let stalled = 0, maxStall = 0;
  for (let k = 1; k < active.length; k++) {
    const d = active[k].pos.distanceTo(active[k - 1].pos);
    if (d < 1e-5) { stalled++; maxStall = Math.max(maxStall, stalled); } else stalled = 0;
  }
  assert(maxStall === 0, `camera stalled for ${maxStall} consecutive frame(s) mid-transition`);
});

t("Top snap: lands exactly on the resolved pole pose with world +Y camera.up", () => {
  const { frames, camera, controls } = runTransition({
    startPos: ISO_START,
    command: (c) => c.navigateToFace("top"),
  });
  const settledTarget = new THREE.Vector3();
  controls.getTarget(settledTarget);
  vecNear(settledTarget, 0, 0, 0, 1e-6);
  // Endpoint: tilted top direction (TOP_EPS toward the spec-up horizontal) at the orbit distance.
  const expected = new THREE.Vector3(0, DIST, TOP_EPS * DIST);
  near(camera.position.distanceTo(expected), 0, 2.5 * TOP_EPS * DIST);
  near(camera.up.y, 1, 1e-9);
  // Screen-up must match the Top spec's up direction (−Z for the default mapping).
  const su = screenUp([camera.position.x, camera.position.y, camera.position.z], [0, 0, 0]);
  near(su[0], 0, 1e-6);
  assert(su[2] < -0.999, `screen-up should face −Z, got (${su.join(",")})`);
  assert(!frames.at(-1).transitioning, "transition did not settle");
});

t("Bottom snap: same smoothness and endpoint guarantees", () => {
  const { frames, camera } = runTransition({
    startPos: ISO_START,
    command: (c) => c.navigateToFace("bottom"),
  });
  assertNoEndJerk(frames, "Bottom snap");
  const expected = new THREE.Vector3(0, -DIST, TOP_EPS * DIST);
  near(camera.position.distanceTo(expected), 0, 2.5 * TOP_EPS * DIST);
  near(camera.up.y, 1, 1e-9);
  const su = screenUp([camera.position.x, camera.position.y, camera.position.z], [0, 0, 0]);
  assert(su[2] > 0.999, `bottom screen-up should face +Z, got (${su.join(",")})`);
});

t("Top snap from exact Front (pure pole pitch) stays smooth", () => {
  const { frames } = runTransition({
    startPos: new THREE.Vector3(0, 0, DIST),
    command: (c) => c.navigateToFace("top"),
  });
  assertNoEndJerk(frames, "Front→Top snap");
});

t("repeated Top command mid-flight still settles smoothly", () => {
  const { frames, camera } = runTransition({
    startPos: ISO_START,
    command: (c) => c.navigateToFace("top"),
    doubleCommandAtMs: 150,
  });
  assertNoEndJerk(frames, "repeated Top snap");
  near(camera.position.y, DIST, 0.01);
  near(camera.up.y, 1, 1e-9);
  assert(!frames.at(-1).transitioning, "transition did not settle after the repeat");
});

t("camera.up is back on world +Y after every settled pole view (orbit-basis sanity)", () => {
  for (const face of ["top", "bottom"]) {
    const { camera } = runTransition({
      startPos: ISO_START,
      command: (c) => c.navigateToFace(face),
    });
    near(camera.up.y, 1, 1e-9);
    near(camera.up.x, 0, 1e-9);
    near(camera.up.z, 0, 1e-9);
  }
});

function vecNear(v, x, y, z, tol = 1e-6) {
  near(v.x, x, tol); near(v.y, y, tol); near(v.z, z, tol);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
