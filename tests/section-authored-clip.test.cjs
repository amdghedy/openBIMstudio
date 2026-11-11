/**
 * Authored-mesh section cut unit tests — pure maths from
 * src/features/section-authored-clip-math.ts. Compile with tsc and require
 * (house test pattern). These cover the bridge that makes 3D section cuts
 * work on authored (non-IFC) geometry: plane extraction from Clipper item
 * shapes, change detection, face-normal transforms and camera-facing flips.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "secauth-"));
execSync(
  `npx tsc src/features/section-authored-clip-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "section-authored-clip-math.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < (eps ?? 1e-9), `${a} != ${b}`);
const N = (x, y, z) => ({ x, y, z });
const P = (nx, ny, nz, c) => ({ normal: N(nx, ny, nz), constant: c });

// ── extractClipperPlanes ────────────────────────────────────────────────
t("extracts a bare plane item", () => {
  const ps = m.extractClipperPlanes([P(0, 1, 0, -2)]);
  assert.strictEqual(ps.length, 1);
  near(ps[0].constant, -2);
});
t("extracts { plane }, { three: { plane } } and { three: plane } shapes", () => {
  const ps = m.extractClipperPlanes([
    { plane: P(1, 0, 0, -1) },
    { three: { plane: P(0, 1, 0, -2) } },
    { three: P(0, 0, 1, -3) },
  ]);
  assert.strictEqual(ps.length, 3);
  assert.deepStrictEqual(ps.map(p => p.constant), [-1, -2, -3]);
});
t("extracts from { planes: [...] } and flattens nesting", () => {
  const ps = m.extractClipperPlanes([
    { planes: [P(1, 0, 0, -1), { plane: P(0, 1, 0, -2) }] },
    { three: { three: { plane: P(0, 0, 1, -4) } } },
  ]);
  assert.strictEqual(ps.length, 3);
});
t("skips junk, non-plane objects and malformed normals", () => {
  const ps = m.extractClipperPlanes([
    null, undefined, 42, "plane",
    { normal: N(1, 0, 0) },                       // no constant
    { constant: -1 },                             // no normal
    { normal: N(NaN, 0, 0), constant: -1 },       // bad component
    { three: { plane: { normal: "x", constant: 0 } } },
  ]);
  assert.strictEqual(ps.length, 0);
});
t("empty input → empty output", () => {
  assert.deepStrictEqual(m.extractClipperPlanes([]), []);
});

// ── planesKey ───────────────────────────────────────────────────────────
t("key is stable for identical planes", () => {
  assert.strictEqual(m.planesKey([P(0, 1, 0, -2)]), m.planesKey([P(0, 1, 0, -2)]));
});
t("key changes when the plane moves", () => {
  assert.notStrictEqual(m.planesKey([P(0, 1, 0, -2)]), m.planesKey([P(0, 1, 0, -2.5)]));
});
t("key is order-insensitive (set equality)", () => {
  const a = m.planesKey([P(1, 0, 0, -1), P(0, 1, 0, -2)]);
  const b = m.planesKey([P(0, 1, 0, -2), P(1, 0, 0, -1)]);
  assert.strictEqual(a, b);
});
t("sub-millimetre drift is ignored (3 dp)", () => {
  const a = m.planesKey([P(0, 1, 0, -2.0001)]);
  const b = m.planesKey([P(0, 1, 0, -2.0002)]);
  assert.strictEqual(a, b);
});

// ── worldFaceNormal ─────────────────────────────────────────────────────
const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
t("identity matrix keeps the normal", () => {
  const w = m.worldFaceNormal(N(0, 0, 1), IDENT);
  near(w.x, 0); near(w.y, 0); near(w.z, 1);
});
t("90° Y rotation maps +X to +Z (column-major)", () => {
  // THREE rotationY(π/2) column-major: col0=(0,0,1), col1=(0,1,0), col2=(-1,0,0)
  const ry = [0,0,1,0, 0,1,0,0, -1,0,0,0, 0,0,0,1];
  const w = m.worldFaceNormal(N(1, 0, 0), ry);
  near(w.x, 0, 1e-9); near(w.y, 0); near(w.z, 1, 1e-9);
});
t("uniform scale ×2 keeps direction (normalized)", () => {
  const s2 = [2,0,0,0, 0,2,0,0, 0,0,2,0, 0,0,0,1];
  const w = m.worldFaceNormal(N(0, 1, 0), s2);
  near(w.y, 1);
});
t("non-uniform scale corrects the normal (inverse-transpose)", () => {
  // Scale (2,1,1) on the XZ plane normal of a sheared face: the normal of a
  // 45° chamfer under X stretch bends toward X — the classic hard case.
  // Plane x + z = 1 scaled by 2 in x becomes x/2 + z = 1 → normal (1/2,0,1).
  const sx = [2,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const w = m.worldFaceNormal(N(1, 0, 1), sx);
  near(w.x, 0.5 / Math.sqrt(0.25 + 1), 1e-9);
  near(w.z, 1 / Math.sqrt(0.25 + 1), 1e-9);
});
t("degenerate matrix falls back to the input direction", () => {
  const zero = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1];
  const w = m.worldFaceNormal(N(0, 1, 0), zero);
  near(w.y, 1);
});

// ── flipTowardCamera ────────────────────────────────────────────────────
t("normal facing the camera direction is negated", () => {
  const f = m.flipTowardCamera(N(1, 0, 0), N(1, 0, 0));
  near(f.x, -1);
});
t("normal facing away from the camera is kept", () => {
  const f = m.flipTowardCamera(N(-1, 0, 0), N(1, 0, 0));
  near(f.x, -1);
});
t("perpendicular normal is kept", () => {
  const f = m.flipTowardCamera(N(0, 1, 0), N(1, 0, 0));
  near(f.y, 1);
});

// ── planeThroughPoint ───────────────────────────────────────────────────
t("plane through a point holds that point on the kept side (n·p + c = 0)", () => {
  const p = m.planeThroughPoint(N(0, 1, 0), N(3, 2, 5));
  near(p.normal.y, 1);
  near(p.constant, -2);
  // kept side: a point above the plane keeps n·p + c > 0
  assert.ok((p.normal.y * 4 + p.constant) > 0);
});
t("camera-facing plane keeps the camera side", () => {
  // camera at origin looking down -Z; plane through (0,0,-5) facing camera
  const n = m.flipTowardCamera(N(0, 0, -1), N(0, 0, -1)); // facing cam → flip → (0,0,1)
  const p = m.planeThroughPoint(n, N(0, 0, -5));
  near(p.constant, 5);
  // camera origin must be kept: n·(0,0,0) + c = 5 > 0
  assert.ok(p.constant > 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
