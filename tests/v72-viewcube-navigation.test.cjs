/**
 * tests/v72-viewcube-navigation.test.cjs
 *
 * ViewCube / Navigation / Home controls acceptance tests (docs/NAVIGATION_V72.md).
 *
 * Verified against closed forms:
 *   Face mapping    front=+Z · back=−Z · right=up×dir · top=+Y · bottom=−Y
 *   Edges           dir = normalize(a+b), up = orthogonalized ring/face up
 *   Corners         dir = normalize(a+b+c)
 *   Spin/pitch      Rodrigues rotation of dir and up (roll rides along);
 *                   90° steps land exactly on canonical face specs
 *   Transitions     quaternion slerp (shortest arc), pos = target + dir·dist
 *   Framing         dist = r/sin(min(fovY,fovX)/2), ortho halfH = r/min(1,aspect)
 *
 * Run: `node tests/v72-viewcube-navigation.test.cjs`
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
function vecNear(v, x, y, z, tol = 1e-6) {
  near(v.x, x, tol); near(v.y, y, tol); near(v.z, z, tol);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v72-nav-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/navigation/index.ts src/features/viewcube-geometry.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

// The compiled modules live outside the repo, so teach Node to resolve
// "three" (and any other runtime dep) from the repo's node_modules.
process.env.NODE_PATH = path.join(root, "node_modules");
require("node:module").Module._initPaths();

const nav = require(path.join(tmpOut, "modules/navigation/index.js"));
const geo = require(path.join(tmpOut, "features/viewcube-geometry.js"));
const THREE = require("three");

function memoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/** Recording camera adapter for controller-level tests. */
function makeAdapter(opts = {}) {
  const state = {
    pos: new THREE.Vector3(0, 0, 20),
    target: new THREE.Vector3(0, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    projection: "perspective",
    fovY: Math.PI / 3,
    aspect: 2,
    orthoHalfHeight: 10,
    sceneBox: opts.sceneBox ?? null,
    selectionBox: opts.selectionBox ?? null,
  };
  const log = { lookAts: [], setProjectionCalls: [], gestures: [] };
  const listeners = new Set();
  const adapter = {
    position: () => state.pos.clone(),
    target: () => state.target.clone(),
    up: () => state.up.clone(),
    fovY: () => state.fovY,
    aspect: () => state.aspect,
    orthoHalfHeight: () => state.orthoHalfHeight,
    setOrthoHalfHeight: (h) => { state.orthoHalfHeight = h; },
    projection: () => state.projection,
    setProjection: (m) => { log.setProjectionCalls.push(m); state.projection = m; return true; },
    lookAt: (pos, target, up) => {
      log.lookAts.push({ pos: pos.clone(), target: target.clone(), up: up.clone() });
      state.pos.copy(pos); state.target.copy(target); state.up.copy(up);
    },
    focusBounds: () => state.selectionBox ?? state.sceneBox,
    sceneBounds: () => state.sceneBox,
    onUserGesture: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    // test hooks
    _state: state,
    _log: log,
    _fireGesture: () => { for (const cb of listeners) cb(); },
  };
  return adapter;
}

function finish(controller, totalMs = 2000, dt = 50) {
  let guard = 0;
  while (controller.isTransitioning() && guard++ < totalMs / dt) controller.tick(dt);
  assert(!controller.isTransitioning(), "transition did not finish");
}

function camDir(adapter) {
  return adapter._state.pos.clone().sub(adapter._state.target).normalize();
}
function camUp(adapter) {
  return adapter._state.up.clone().normalize();
}

/* ════════════════════════════════════════════════════════════════════════
   1. Orientation mapping (closed-form face table)
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Orientation mapping —");

t("default faces match the gotoExactView table exactly", () => {
  const f = nav.deriveFaces(nav.defaultOrientation());
  vecNear(f.front.dir, 0, 0, 1); vecNear(f.front.up, 0, 1, 0);
  vecNear(f.back.dir, 0, 0, -1); vecNear(f.back.up, 0, 1, 0);
  vecNear(f.right.dir, 1, 0, 0); vecNear(f.right.up, 0, 1, 0);
  vecNear(f.left.dir, -1, 0, 0); vecNear(f.left.up, 0, 1, 0);
  vecNear(f.top.dir, 0, 1, 0); vecNear(f.top.up, 0, 0, -1);
  vecNear(f.bottom.dir, 0, -1, 0); vecNear(f.bottom.up, 0, 0, 1);
});

t("all 12 edge specs are unit, orthogonal and correctly summed", () => {
  const d = nav.deriveOrientation(nav.defaultOrientation());
  for (const e of nav.CUBE_EDGES) {
    const s = d.edges[e];
    near(s.dir.length(), 1, 1e-9);
    near(Math.abs(s.dir.dot(s.up)), 0, 1e-9);
  }
  vecNear(d.edges["front-right"].dir, Math.SQRT1_2, 0, Math.SQRT1_2);
  vecNear(d.edges["top-front"].dir, 0, Math.SQRT1_2, Math.SQRT1_2);
  // Ring edges keep the ring up (no roll)
  vecNear(d.edges["front-right"].up, 0, 1, 0);
  // Vertical edge up is orthogonalized front.up
  const tf = d.edges["top-front"];
  near(tf.up.y, Math.SQRT1_2, 1e-9); // Y minus its component along dir
});

t("all 8 corner specs are unit, orthogonal and correctly summed", () => {
  const d = nav.deriveOrientation(nav.defaultOrientation());
  for (const c of nav.CUBE_CORNERS) {
    const s = d.corners[c];
    near(s.dir.length(), 1, 1e-9);
    near(Math.abs(s.dir.dot(s.up)), 0, 1e-9);
  }
  const r3 = 1 / Math.sqrt(3);
  vecNear(d.corners["top-front-right"].dir, r3, r3, r3);
  vecNear(d.corners["bottom-back-left"].dir, -r3, -r3, -r3);
});

t("up vectors can never be parallel to dir for any of the 26 targets", () => {
  const d = nav.deriveOrientation(nav.defaultOrientation());
  for (const f of nav.CUBE_FACES) assert(Math.abs(d.faces[f].dir.dot(d.faces[f].up)) < 1e-9);
  for (const e of nav.CUBE_EDGES) assert(Math.abs(d.edges[e].dir.dot(d.edges[e].up)) < 1e-9);
  for (const c of nav.CUBE_CORNERS) assert(Math.abs(d.corners[c].dir.dot(d.corners[c].up)) < 1e-9);
});

t("custom front rotates the whole ring consistently", () => {
  const m = nav.defaultOrientation();
  m.front = { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0) };
  assert(nav.isValidMapping(m));
  const f = nav.deriveFaces(m);
  vecNear(f.back.dir, 1, 0, 0);
  // right = up × dir = Y × (−X) = +Z
  vecNear(f.right.dir, 0, 0, 1);
  vecNear(f.left.dir, 0, 0, -1);
  const d = nav.deriveOrientation(m);
  // front-right edge now = normalize(−X + Z)
  const fr = d.edges["front-right"];
  vecNear(fr.dir, -Math.SQRT1_2, 0, Math.SQRT1_2);
});

t("custom top re-derives poles without degeneracy", () => {
  const m = nav.defaultOrientation();
  m.top = { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, -1) };
  assert(nav.isValidMapping(m));
  const d = nav.deriveOrientation(m);
  vecNear(d.faces.top.dir, 1, 0, 0);
  vecNear(d.faces.bottom.dir, -1, 0, 0);
  for (const c of nav.CUBE_CORNERS) {
    assert(Number.isFinite(d.corners[c].dir.x), `corner ${c} degenerated`);
    near(Math.abs(d.corners[c].dir.dot(d.corners[c].up)), 0, 1e-9);
  }
});

t("nearestOrientation identifies faces, edges and corners", () => {
  const d = nav.deriveOrientation(nav.defaultOrientation());
  const hitF = nav.nearestOrientation(new THREE.Vector3(0, 0, 1), d);
  assert(hitF.kind === "face" && hitF.id === "front" && hitF.label === "Front");
  const hitE = nav.nearestOrientation(new THREE.Vector3(1, 0, 1), d);
  assert(hitE.kind === "edge" && hitE.id === "front-right", `${hitE.kind}/${hitE.id}`);
  const hitC = nav.nearestOrientation(new THREE.Vector3(1, 1, 1), d);
  assert(hitC.kind === "corner" && hitC.id === "top-front-right", `${hitC.kind}/${hitC.id}`);
  assert(Math.abs(hitC.angle) < 1e-9);
});

t("invalid mappings are rejected", () => {
  assert(!nav.isValidMapping(null));
  const bad1 = nav.defaultOrientation();
  bad1.front = { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 0, 1) }; // up ∥ dir
  assert(!nav.isValidMapping(bad1));
  const bad2 = nav.defaultOrientation();
  bad2.top = { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) }; // top ∥ front
  assert(!nav.isValidMapping(bad2));
});

/* ════════════════════════════════════════════════════════════════════════
   2. Rotation primitives (Rodrigues, closed form)
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Rotation primitives —");

t("spin +90 lands exactly on the right face (ccw, right-hand rule)", () => {
  const out = nav.spinSpec({ dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) }, 90);
  vecNear(out.dir, 1, 0, 0);
  vecNear(out.up, 0, 1, 0);
});

t("spin −90 lands exactly on the left face", () => {
  const out = nav.spinSpec({ dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) }, -90);
  vecNear(out.dir, -1, 0, 0);
});

t("pitch +90 from front lands exactly on the canonical top spec", () => {
  const out = nav.pitchSpec({ dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) }, 90);
  vecNear(out.dir, 0, 1, 0);
  vecNear(out.up, 0, 0, -1);
});

t("pitch is clamped at the poles (no flip-over)", () => {
  const top = { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) };
  assert(nav.pitchSpec(top, 90) === null, "pitch past the top pole must refuse");
  const bottom = { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) };
  assert(nav.pitchSpec(bottom, -90) === null, "pitch past the bottom pole must refuse");
});

t("spin refuses at the pole (dir ∥ world up)", () => {
  const top = { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) };
  assert(nav.spinSpec(top, 90) === null);
});

/* ════════════════════════════════════════════════════════════════════════
   3. Transitions (quaternion slerp)
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Transitions —");

t("endpoints are exact; midpoint is on the slerp arc", () => {
  const from = nav.endpointFrom(
    new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
  const tr = nav.CameraTransition.fromSpec(
    from,
    { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
    new THREE.Vector3(0, 0, 0), 20, 1000,
  );
  const s0 = tr.advance(0);
  vecNear(s0.pos, 0, 0, 20); vecNear(s0.up, 0, 1, 0); assert(!s0.done);
  const s1 = tr.advance(500);
  // Midpoint: dir halfway between +Z and +Y on the great circle.
  const midDir = new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2);
  const actualDir = s1.pos.clone().normalize();
  near(actualDir.dot(midDir), 1, 1e-6);
  near(s1.pos.length(), 20, 1e-6);
  assert(!s1.done);
  const s2 = tr.advance(500);
  vecNear(s2.pos, 0, 20, 0); vecNear(s2.up, 0, 0, -1); assert(s2.done);
});

t("slerp takes the shortest arc (no Euler discontinuity / flip)", () => {
  // top → bottom: a naive Euler lerp would tumble through the horizon;
  // slerp rotates 180° monotonically.
  const from = nav.endpointFrom(
    new THREE.Vector3(0, 20, 0), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
  const tr = nav.CameraTransition.fromSpec(
    from, { dir: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
    new THREE.Vector3(), 20, 1000);
  let prevDir = new THREE.Vector3(0, 1, 0);
  let steps = 0;
  for (;;) {
    const s = tr.advance(50);
    const d = s.pos.clone().normalize();
    const step = Math.acos(THREE.MathUtils.clamp(prevDir.dot(d), -1, 1));
    assert(step < Math.PI / 2 + 1e-6, "single step rotated more than 90°");
    prevDir = d;
    if (s.done) break;
    assert(++steps < 100, "transition never finished");
  }
  assert(steps === 19, `expected 20 samples for 1000ms/50ms, got ${steps + 1}`);
});

t("cancel finishes immediately; replacement works", () => {
  const from = nav.endpointFrom(new THREE.Vector3(0, 0, 20), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const tr = nav.CameraTransition.fromSpec(
    from, { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1) },
    new THREE.Vector3(), 20, 1000);
  tr.advance(100);
  tr.cancel();
  const s = tr.advance(10);
  assert(s.done);
  assert(tr.isCancelled());
});

t("distance interpolates monotonically", () => {
  const from = nav.endpointFrom(new THREE.Vector3(0, 0, 10), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const tr = nav.CameraTransition.fromSpec(
    from, { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
    new THREE.Vector3(), 30, 1000);
  let prev = 10;
  for (;;) {
    const s = tr.advance(100);
    const d = s.pos.length();
    assert(d >= prev - 1e-9, `distance shrank mid-transition: ${prev} -> ${d}`);
    prev = d;
    if (s.done) break;
  }
  near(prev, 30, 1e-9);
});

t("quaternionForSpec builds the expected look-at basis", () => {
  const q = nav.quaternionForSpec({ dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) });
  const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  vecNear(dir, 0, 0, 1);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  vecNear(up, 0, 1, 0);
});

/* ════════════════════════════════════════════════════════════════════════
   4. Framing (closed form)
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Framing —");

t("frameBox: distance = r/sin(f/2) with the closed form", () => {
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 2, 2));
  const r = box.getSize(new THREE.Vector3()).length() / 2; // √3
  const res = nav.frameBox(box, {
    fovY: (60 * Math.PI) / 180, aspect: 2, padding: 1, minDistance: 0.5,
  });
  near(res.radius, Math.sqrt(3), 1e-9);
  // aspect 2 > 1 → vertical fov binds: f = 30°, sin = 0.5 → dist = 2r
  near(res.distance, 2 * Math.sqrt(3), 1e-9);
  near(res.orthoHalfHeight, Math.sqrt(3), 1e-9); // aspect >= 1 → height binds
  vecNear(res.target, 1, 1, 1);
});

t("frameBox: portrait aspect binds width", () => {
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const r = Math.sqrt(3);
  const res = nav.frameBox(box, {
    fovY: (60 * Math.PI) / 180, aspect: 0.5, padding: 1, minDistance: 0.5,
  });
  near(res.orthoHalfHeight, 2 * r, 1e-9); // r / min(1, 0.5)
});

t("frameBox rejects empty, NaN and exploded bounds", () => {
  const empty = new THREE.Box3();
  assert(nav.frameBox(empty, { fovY: 1, aspect: 1, padding: 1, minDistance: 1 }) === null);
  const nan = new THREE.Box3(new THREE.Vector3(0, 0, NaN), new THREE.Vector3(1, 1, 1));
  assert(nav.frameBox(nan, { fovY: 1, aspect: 1, padding: 1, minDistance: 1 }) === null);
  const huge = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1e12, 1e12, 1e12));
  assert(nav.frameBox(huge, { fovY: 1, aspect: 1, padding: 1, minDistance: 1 }) === null);
});

t("frameBox respects minDistance and padding", () => {
  const tiny = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.001, 0.001, 0.001));
  const res = nav.frameBox(tiny, { fovY: 1, aspect: 1, padding: 1, minDistance: 5 });
  assert(res.distance >= 5, "minDistance floor violated");
  const res2 = nav.frameBox(tiny, { fovY: 1, aspect: 1, padding: 2, minDistance: 0.1 });
  assert(res2.orthoHalfHeight > 0);
});

t("defaultHomePlacement degrades safely with no bounds", () => {
  const p = nav.defaultHomePlacement(null, 1);
  vecNear(p.target, 0, 0, 0);
  near(p.distance, 28);
  near(p.dir.length(), 1, 1e-9);
  const box = new THREE.Box3(new THREE.Vector3(10, 0, 10), new THREE.Vector3(20, 10, 20));
  const p2 = nav.defaultHomePlacement(box, 1);
  vecNear(p2.target, 15, 5, 15);
  assert(p2.distance > 0);
});

/* ════════════════════════════════════════════════════════════════════════
   5. Home state validation + persistence
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Home state —");

const VALID_HOME = {
  pos: [1, 2, 3], target: [0, 0, 0], up: [0, 1, 0],
  projection: "perspective", navigationMode: "perspective",
  fov: 60, orthoHalfHeight: 10, savedAt: 1700000000000,
};

t("valid home round-trips through serialize/parse", () => {
  const parsed = nav.parseHome(JSON.stringify(VALID_HOME));
  assert(parsed);
  vecNear(new THREE.Vector3(...parsed.pos), 1, 2, 3);
  assert(parsed.projection === "perspective");
  assert(parsed.navigationMode === "perspective");
  near(parsed.fov, 60);
  near(parsed.up[1], 1);
});

t("up vector is normalized on load", () => {
  const parsed = nav.parseHome(JSON.stringify({ ...VALID_HOME, up: [0, 5, 0] }));
  near(parsed.up[1], 1, 1e-12);
});

t("corrupt payloads are rejected, not thrown", () => {
  assert(nav.parseHome(null) === null);
  assert(nav.parseHome("") === null);
  assert(nav.parseHome("{not json") === null);
  assert(nav.parseHome("123") === null);
  assert(nav.parseHome("{}") === null);
  assert(nav.parseHome("x".repeat(100000)) === null);
});

t("invalid camera states are rejected field by field", () => {
  assert(nav.parseHome({ ...VALID_HOME, projection: "isometric" }) === null, "bad projection");
  assert(nav.parseHome({ ...VALID_HOME, pos: [0, NaN, 0] }) === null, "NaN pos");
  assert(nav.parseHome({ ...VALID_HOME, pos: "nope" }) === null, "non-array pos");
  assert(nav.parseHome({ ...VALID_HOME, pos: [0, 0, 0], target: [0, 0, 0] }) === null, "pos == target");
  assert(nav.parseHome({ ...VALID_HOME, up: [0, 0, 0] }) === null, "zero up");
  assert(nav.parseHome({ ...VALID_HOME, fov: 5000 }) === null, "absurd fov");
  assert(nav.parseHome({ ...VALID_HOME, orthoHalfHeight: -1 }) === null, "negative ortho");
  assert(nav.parseHome({ ...VALID_HOME, navigationMode: "fancy" }) === null, "bad mode");
  assert(nav.parseHome({ ...VALID_HOME, savedAt: "yesterday" }) === null, "bad savedAt");
  // missing optional fields are fine
  const { up, fov, orthoHalfHeight, navigationMode, ...minimal } = VALID_HOME;
  assert(nav.parseHome(minimal) !== null, "minimal valid state");
});

t("load/save/clear home against a key-value store", () => {
  const store = memoryStore();
  const key = nav.homeStorageKey("proj-1");
  assert(key === "obs.navigation.home.proj-1");
  assert(nav.loadHome(store, key) === null);
  nav.saveHome(store, key, VALID_HOME);
  assert(nav.loadHome(store, key) !== null);
  nav.clearHome(store, key);
  assert(nav.loadHome(store, key) === null);
  assert(nav.homeStorageKey(null) === "obs.navigation.home.__global__");
});

t("orientation mapping persists and validates", () => {
  const store = memoryStore();
  const key = nav.orientationStorageKey("p");
  const custom = nav.defaultOrientation();
  custom.front = { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) };
  nav.saveOrientationMapping(store, key, custom);
  const loaded = nav.loadOrientationMapping(store, key);
  assert(loaded && nav.isValidMapping(loaded));
  vecNear(loaded.front.dir, 1, 0, 0);
  // Corrupted store value → null
  store.setItem(key, "{oops");
  assert(nav.loadOrientationMapping(store, key) === null);
  // Parallel anchors → null
  store.setItem(key, JSON.stringify({
    front: { dir: [0, 0, 1], up: [0, 1, 0] },
    top: { dir: [0, 0, 1], up: [0, 1, 0] },
  }));
  assert(nav.loadOrientationMapping(store, key) === null);
});

/* ════════════════════════════════════════════════════════════════════════
   6. Controller — cube navigation, rotation, transitions
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Controller: cube navigation —");

function freshController(opts = {}, storeOverride = null) {
  const adapter = makeAdapter(opts);
  const controller = new nav.NavigationController(adapter, {
    storage: storeOverride ?? memoryStore(),
    projectId: "test",
    config: { transitionMs: 550 },
  });
  return { adapter, controller };
}

t("navigateToFace(front) ends at dir +Z with up +Y", () => {
  const { adapter, controller } = freshController();
  const out = controller.navigateToFace("front");
  assert(out.ok, out.reason);
  finish(controller);
  vecNear(camDir(adapter), 0, 0, 1, 1e-6);
  vecNear(camUp(adapter), 0, 1, 0, 1e-6);
});

t("navigateToFace(top) from front: no flip, stable up, exact endpoint", () => {
  const { adapter, controller } = freshController();
  controller.navigateToFace("top");
  finish(controller);
  vecNear(camDir(adapter), 0, 1, 0, 1e-6);
  vecNear(camUp(adapter), 0, 0, -1, 1e-6);
});

t("navigateToEdge(front-right) goes to the exact diagonal", () => {
  const { adapter, controller } = freshController();
  controller.navigateToEdge("front-right");
  finish(controller);
  vecNear(camDir(adapter), Math.SQRT1_2, 0, Math.SQRT1_2, 1e-6);
});

t("navigateToCorner(top-front-right) goes to the exact triagonal", () => {
  const { adapter, controller } = freshController();
  controller.navigateToCorner("top-front-right");
  finish(controller);
  const r3 = 1 / Math.sqrt(3);
  vecNear(camDir(adapter), r3, r3, r3, 1e-6);
});

t("opposite-face switch animates without flipping (roll stays sane)", () => {
  const { adapter, controller } = freshController();
  controller.navigateToFace("top");
  finish(controller);
  controller.navigateToFace("bottom");
  // Sample the roll during the flight
  let steps = 0;
  while (controller.isTransitioning() && steps++ < 40) {
    controller.tick(30);
    const u = camUp(adapter);
    assert(Number.isFinite(u.x) && u.length() > 0.9, "up collapsed mid-flight");
  }
  finish(controller);
  vecNear(camDir(adapter), 0, -1, 0, 1e-6);
});

t("rapid repeated commands replace the active transition", () => {
  const { adapter, controller } = freshController();
  controller.navigateToFace("front");
  controller.navigateToFace("back");
  assert(controller.isTransitioning());
  finish(controller);
  vecNear(camDir(adapter), 0, 0, -1, 1e-6);
});

t("user gesture cancels the active transition", () => {
  const { adapter, controller } = freshController();
  controller.navigateToFace("back");
  assert(controller.isTransitioning());
  adapter._fireGesture();
  assert(!controller.isTransitioning(), "gesture did not cancel");
});

t("orbit distance is preserved by face navigation", () => {
  const { adapter, controller } = freshController();
  const before = adapter._state.pos.length();
  controller.navigateToFace("front");
  finish(controller);
  near(adapter._state.pos.length(), before, 1e-6);
});

console.log("\n— Controller: rotation arrows —");

t("rotateLeft (ccw) from front lands on the right face dir", () => {
  const { adapter, controller } = freshController();
  controller.rotateLeft();
  finish(controller);
  vecNear(camDir(adapter), 1, 0, 0, 1e-6);
  vecNear(camUp(adapter), 0, 1, 0, 1e-6);
});

t("rotateRight (cw) from front lands on the left face dir", () => {
  const { adapter, controller } = freshController();
  controller.rotateRight();
  finish(controller);
  vecNear(camDir(adapter), -1, 0, 0, 1e-6);
});

t("rotateUp arcs over the model to Top; rotateDown returns to Front", () => {
  const { adapter, controller } = freshController();
  controller.rotateUp();
  finish(controller);
  vecNear(camDir(adapter), 0, 1, 0, 1e-6);
  vecNear(camUp(adapter), 0, 0, -1, 1e-6);
  controller.rotateDown();
  finish(controller);
  vecNear(camDir(adapter), 0, 0, 1, 1e-6);
  vecNear(camUp(adapter), 0, 1, 0, 1e-6);
});

t("rotateUp at the top pole is rejected with at-pole", () => {
  const { controller } = freshController();
  controller.navigateToFace("top");
  finish(controller);
  const out = controller.rotateUp();
  assert(!out.ok && out.reason === "at-pole", JSON.stringify(out));
});

console.log("\n— Controller: projection modes —");

t("setProjectionMode switches the core camera genuinely", () => {
  const { adapter, controller } = freshController();
  assert(controller.setProjectionMode("orthographic"));
  assert(adapter._state.projection === "orthographic");
  assert(controller.projectionMode() === "orthographic");
  assert(controller.setProjectionMode("perspective"));
  assert(adapter._state.projection === "perspective");
});

t("Perspective with Ortho Faces: snaps go ortho, free orbit returns to perspective", () => {
  const { adapter, controller } = freshController();
  assert(controller.setProjectionMode("perspective-ortho-faces"));
  assert(adapter._state.projection === "perspective");
  controller.navigateToFace("front");
  finish(controller);
  // face snap switched the core camera to orthographic
  assert(adapter._log.setProjectionCalls.includes("orthographic"), "snap did not switch to ortho");
  assert(adapter._state.projection === "orthographic");
  assert(controller.projectionMode() === "perspective-ortho-faces", "mode must stay PwOF");
  // free rotation returns to perspective
  adapter._log.setProjectionCalls.length = 0;
  controller.rotateLeft();
  finish(controller);
  assert(adapter._log.setProjectionCalls.includes("perspective"), "orbit did not restore perspective");
  assert(adapter._state.projection === "perspective");
});

t("orthographic face navigation preserves ortho zoom", () => {
  const { adapter, controller } = freshController();
  controller.setProjectionMode("orthographic");
  adapter.setOrthoHalfHeight(7.5);
  controller.navigateToFace("left");
  finish(controller);
  near(adapter.orthoHalfHeight(), 7.5, 1e-9);
  vecNear(camDir(adapter), -1, 0, 0, 1e-6);
});

console.log("\n— Controller: Home —");

t("Set current view as Home → Go Home restores the exact view", () => {
  const { adapter, controller } = freshController();
  adapter._state.pos.set(7, 8, 9);
  adapter._state.target.set(1, 2, 3);
  adapter._state.up.set(0, 1, 0);
  assert(controller.setCurrentViewAsHome().ok);
  assert(controller.hasHome());
  // Move far away
  adapter._state.pos.set(-50, 30, 12);
  adapter._state.target.set(0, 0, 0);
  assert(controller.goHome().ok);
  finish(controller);
  vecNear(adapter._state.pos, 7, 8, 9, 1e-6);
  vecNear(adapter._state.target, 1, 2, 3, 1e-6);
});

t("Home persists across controller instances (per-project key)", () => {
  const store = memoryStore();
  const adapter = makeAdapter();
  const c1 = new nav.NavigationController(adapter, { storage: store, projectId: "A" });
  adapter._state.pos.set(3, 4, 5);
  c1.setCurrentViewAsHome();
  // New controller on the same project: hasHome, restores.
  adapter._state.pos.set(0, 0, 20);
  const c2 = new nav.NavigationController(adapter, { storage: store, projectId: "A" });
  assert(c2.hasHome(), "home not loaded from store");
  c2.goHome();
  finish(c2);
  vecNear(adapter._state.pos, 3, 4, 5, 1e-6);
  // Different project: no home
  const c3 = new nav.NavigationController(adapter, { storage: store, projectId: "B" });
  assert(!c3.hasHome(), "home leaked across projects");
});

t("corrupted stored Home degrades to the safe default", () => {
  const store = memoryStore();
  store.setItem("obs.navigation.home.T", "{corrupt");
  const adapter = makeAdapter();
  const c = new nav.NavigationController(adapter, { storage: store, projectId: "T" });
  assert(!c.hasHome());
  assert(c.goHome().ok);
  finish(c);
  // No scene bounds → documented fallback: origin, distance 28
  near(adapter._state.pos.length(), 28, 1e-6);
});

t("Go Home restores the projection mode", () => {
  const store = memoryStore();
  const adapter = makeAdapter();
  const c = new nav.NavigationController(adapter, { storage: store, projectId: "A" });
  c.setProjectionMode("orthographic");
  c.setCurrentViewAsHome();
  c.setProjectionMode("perspective");
  c.goHome();
  finish(c);
  assert(adapter._state.projection === "orthographic", "projection not restored");
});

t("Focus and set as Home frames the injected selection bounds", () => {
  const { adapter, controller } = freshController();
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  const out = controller.focusAndSetHome(box);
  assert(out.ok, out.reason);
  finish(controller);
  const expected = nav.frameBox(box, {
    fovY: Math.PI / 3, aspect: 2, padding: 1.15, minDistance: 1,
  });
  near(adapter._state.pos.distanceTo(adapter._state.target), expected.distance, 1e-6);
  vecNear(adapter._state.target, 0, 0, 0, 1e-6);
  // Home was saved at the framed position
  assert(controller.hasHome());
});

t("Focus and set as Home with no model refuses cleanly", () => {
  const { controller } = freshController({ sceneBox: null });
  const out = controller.focusAndSetHome(null);
  assert(!out.ok && out.reason === "no-model", JSON.stringify(out));
});

t("Focus falls back to the whole scene when no bounds are injected", () => {
  const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10));
  const { adapter, controller } = freshController({ sceneBox: box });
  const out = controller.focusAndSetHome(undefined);
  assert(out.ok, out.reason);
  finish(controller);
  near(adapter._state.target.x, 5, 1e-6);
  near(adapter._state.target.y, 5, 1e-6);
  near(adapter._state.target.z, 5, 1e-6);
});

t("Reset Home restores the default and re-persists it", () => {
  const store = memoryStore();
  const box = new THREE.Box3(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 10, 5));
  const { adapter, controller } = freshController({ sceneBox: box }, store);
  // Make a custom home first
  adapter._state.pos.set(1, 1, 1);
  controller.setCurrentViewAsHome();
  assert(controller.hasHome());
  const out = controller.resetHome();
  assert(out.ok);
  finish(controller);
  vecNear(adapter._state.target, 0, 5, 0, 1e-6);
  // Default was persisted (so reload keeps a consistent Home)
  const reloaded = new nav.NavigationController(adapter, { storage: store, projectId: "test" });
  assert(reloaded.hasHome(), "default home was not persisted");
  reloaded.goHome();
  finish(reloaded);
  vecNear(adapter._state.target, 0, 5, 0, 1e-6);
});

t("Go Home with empty scene still lands on a valid camera", () => {
  const { adapter, controller } = freshController({ sceneBox: null });
  assert(controller.goHome().ok);
  finish(controller);
  assert(Number.isFinite(adapter._state.pos.x));
  assert(adapter._state.pos.length() > 0.5, "camera collapsed into the target");
});

console.log("\n— Controller: orientation customization —");

t("Set current view as Front remaps the cube", () => {
  const { adapter, controller } = freshController();
  // Look from an oblique direction
  adapter._state.pos.set(3, 0, 6);
  adapter._state.target.set(0, 0, 0);
  adapter._state.up.set(0, 1, 0);
  assert(controller.setCurrentViewAsFront().ok);
  controller.navigateToFace("front");
  finish(controller);
  const dir = camDir(adapter);
  const expected = new THREE.Vector3(3, 0, 6).normalize();
  near(dir.dot(expected), 1, 1e-6);
  // Back follows
  controller.navigateToFace("back");
  finish(controller);
  near(camDir(adapter).dot(expected), -1, 1e-6);
});

t("Set current view as Top that is parallel to Front is rejected", () => {
  const { controller } = freshController();
  controller.navigateToFace("front");
  finish(controller);
  const before = JSON.stringify(controller.orientationMapping().front.dir);
  const out = controller.setCurrentViewAsTop();
  assert(!out.ok && out.reason === "degenerate-orientation", JSON.stringify(out));
  assert(JSON.stringify(controller.orientationMapping().front.dir) === before, "front changed unexpectedly");
});

t("Reset orientation restores the default mapping", () => {
  const fc = freshController();
  fc.adapter._state.pos.set(3, 0, 6);
  fc.controller.setCurrentViewAsFront();
  assert(!fc.controller.orientationMapping().front.dir.equals(new THREE.Vector3(0, 0, 1)));
  fc.controller.resetOrientation();
  const m = fc.controller.orientationMapping();
  vecNear(m.front.dir, 0, 0, 1, 1e-9);
  vecNear(m.top.dir, 0, 1, 0, 1e-9);
});

t("Reset orientation persists across instances", () => {
  const store = memoryStore();
  const a1 = makeAdapter();
  const c1 = new nav.NavigationController(a1, { storage: store, projectId: "P" });
  a1._state.pos.set(3, 0, 6);
  c1.setCurrentViewAsFront();
  const c2 = new nav.NavigationController(a1, { storage: store, projectId: "P" });
  near(c2.orientationMapping().front.dir.dot(new THREE.Vector3(3, 0, 6).normalize()), 1, 1e-6);
  c2.resetOrientation();
  const c3 = new nav.NavigationController(a1, { storage: store, projectId: "P" });
  vecNear(c3.orientationMapping().front.dir, 0, 0, 1, 1e-9);
});

t("setProjectId re-keys persistence", () => {
  const store = memoryStore();
  const adapter = makeAdapter();
  const c = new nav.NavigationController(adapter, { storage: store, projectId: "A" });
  adapter._state.pos.set(5, 0, 0);
  c.setCurrentViewAsHome();
  c.setProjectId("B");
  assert(!c.hasHome(), "project A home visible after switch");
  c.setProjectId("A");
  assert(c.hasHome(), "project A home lost after round trip");
});

console.log("\n— Controller: tick / engine hygiene —");

t("tick is a no-op without an active transition", () => {
  const { controller } = freshController();
  assert(controller.tick(16) === false);
});

t("currentOrientation reports the nearest target", () => {
  const { adapter, controller } = freshController();
  adapter._state.pos.set(0, 0, 9);
  const cur = controller.currentOrientation();
  assert(cur.kind === "face" && cur.id === "front", JSON.stringify(cur));
  adapter._state.pos.set(5, 5, 5);
  const cur2 = controller.currentOrientation();
  assert(cur2.kind === "corner", JSON.stringify(cur2));
});

t("orientation label helper", () => {
  assert(nav.orientationLabel("face", "front") === "Front");
  assert(nav.orientationLabel("edge", "top-front") === "Top front");
  assert(nav.orientationLabel("corner", "bottom-back-left") === "Bottom Back Left");
});

/* ════════════════════════════════════════════════════════════════════════
   7. ViewCube geometry (SVG widget math)
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— ViewCube geometry —");

t("cube graph has 6 faces × 4 verts, 12 edges × 2 verts, 8 corners", () => {
  for (const f of Object.keys(geo.CUBE_GRAPH.faces)) {
    assert(geo.CUBE_GRAPH.faces[f].vertices.length === 4, `face ${f}`);
  }
  const edgeCount = Object.keys(geo.CUBE_GRAPH.edges).length;
  assert(edgeCount === 12, `edges: ${edgeCount}`);
  const cornerCount = Object.keys(geo.CUBE_GRAPH.corners).length;
  assert(cornerCount === 8, `corners: ${cornerCount}`);
});

t("identity camera: front face visible, back hidden, screen coords sane", () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const pc = geo.projectCube({ qInv: identity, scale: 10, cx: 50, cy: 50 });
  assert(pc.visible.front === true);
  assert(pc.visible.back === false);
  assert(pc.visible.top === false);
  // Front face vertices at z=+1 project to y = 50 - 10 = 40 (above center? no: y up → screen up)
  // With identity camera looking at the cube from +Z, up is +Y: front face top edge at screen y 40.
  const [, y] = pc.screen["-1,1,1"];
  near(y, 40, 1e-9);
  // Right face normal points to +X → screen right, facing = 0 (edge-on)
  near(pc.facing.right, 0, 1e-9);
  assert(pc.visible.right === false, "edge-on face must not be interactive-visible");
});

t("camera rotated 90° ccw around Y: right face becomes front", () => {
  // Camera looks from +X: inverse rotation maps +X to +Z (toward viewer).
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const qInv = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
  const pc = geo.projectCube({ qInv, scale: 10, cx: 50, cy: 50 });
  assert(pc.visible.right === true, "right face must face the viewer");
  near(pc.facing.right, 1, 1e-6);
  assert(pc.visible.front === false);
});

t("edge strip is a quad with the requested width", () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const pc = geo.projectCube({ qInv: identity, scale: 10, cx: 50, cy: 50 });
  const pts = geo.edgeStripPoints(pc, "top-front", 6).split(" ").map((p) => p.split(",").map(Number));
  assert(pts.length === 4, "strip must have 4 points");
  // Vertical edge from (-1,1,1)→(1,1,1) in world = horizontal on screen at y=40, x from 40 to 60
  // width 6 → strip spans y 37..43
  const ys = pts.map((p) => p[1]);
  near(Math.min(...ys), 37, 1e-6);
  near(Math.max(...ys), 43, 1e-6);
});

t("compass position: N of the identity camera sits at the top of the ring", () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  // Looking from +Z at the cube: world +Z points AT the viewer → planar ≈ 0.
  const at = geo.compassScreenPos({ x: 0, y: 0, z: 1 }, { qInv: identity, cx: 50, cy: 50 }, 40);
  near(Math.hypot(at.x - 50, at.y - 50), 0, 1e-9);
  near(at.behind, 1, 1e-9);
  // East (+X) is to the right of the ring.
  const e = geo.compassScreenPos({ x: 1, y: 0, z: 0 }, { qInv: identity, cx: 50, cy: 50 }, 40);
  near(e.x, 90, 1e-9);
  near(e.y, 50, 1e-9);
});

t("facePoints emits 4 coordinate pairs", () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const pc = geo.projectCube({ qInv: identity, scale: 10, cx: 50, cy: 50 });
  const pts = geo.facePoints(pc, "front").split(" ");
  assert(pts.length === 4);
  for (const p of pts) assert(/^-?\d+\.\d{2},-?\d+\.\d{2}$/.test(p), `bad point ${p}`);
});

/* ════════════════════════════════════════════════════════════════════════
   8. Performance budgets
   ════════════════════════════════════════════════════════════════════════ */

console.log("\n— Performance —");

t("projectCube renders 1000 frames well under the widget budget", () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 };
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) geo.projectCube({ qInv: identity, scale: 31, cx: 70, cy: 70 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(ms < 500, `1000 projections took ${ms.toFixed(1)}ms (budget 500ms)`);
});

t("full navigation transition completes within the animation budget", () => {
  const { controller } = freshController();
  const t0 = process.hrtime.bigint();
  controller.navigateToCorner("top-back-left");
  finish(controller);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert(ms < 200, `transition simulation took ${ms.toFixed(1)}ms (budget 200ms)`);
});

/* ── Summary ───────────────────────────────────────────────────────────── */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
