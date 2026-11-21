/**
 * tests/parametric-voids-sweeps-lofts.test.cjs
 *
 * Slice 6 (Revit parity gap 5): real voids and honest sweeps/lofts.
 *
 *   - Void: a `void` part of a `composed` group is now really
 *     subtracted from its siblings with the repo's existing CSG path
 *     (`three-csg-ts`, as used for door/window openings in
 *     authoring.ts — no new dependency). Before this slice the void
 *     was silently dropped by the classic builder (a 2x2x2 box plus a
 *     centred 1x1x1 void measured 8.0, not 7.0 and not 9.0).
 *     `options.preview` still skips the CSG for speed, and a failed
 *     cut keeps the solid and records a warning.
 *   - Sweep: rebuilt by hand with parallel-transport frames along the
 *     polyline path — profile +Y stays as close to world +Y as the
 *     path allows — and mitered corners, instead of ExtrudeGeometry's
 *     Frenet frames over a Catmull-Rom curve, which flipped the
 *     profile on vertical runs and bulged past sharp corners
 *     (an L-path sweep used to reach x=5.288 for a corner at x=4).
 *   - Loft: profiles are resampled to the same point count, uniform
 *     by arc length, so point k corresponds to point k (the old code
 *     paired a 132-point rect with a 33-point circle by index), the
 *     rings' starts are aligned by polar angle about each ring's
 *     centroid so a rect and a circle do not twist against each other,
 *     and consecutive rings are stitched with quads so the solid runs
 *     the full interpolation from the first profile to the last (the
 *     old stepped stack over-estimated a 2x2 -> 1x1 taper at 2.719
 *     for a true 2.333).
 *
 * Tests assert VOLUMES (signed-tetrahedron, index- and
 * matrix-aware) and bounding boxes, not just "no throw".
 *
 * Run: `node tests/parametric-voids-sweeps-lofts.test.cjs`
 * CI:  `test:parametric-voids-sweeps-lofts` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-type-propagation.test.cjs), so `three` resolves
 * from the repo's node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tolOrMsg = 1e-3, msg) => {
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-3;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
};

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".voids-sweeps-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/parametric-engine.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === n) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const E = require(find("parametric-engine.js"));

// ── Helpers ─────────────────────────────────────────────────────────────────
const C = (n) => ({ const: n });
const R = (name) => ({ ref: name });
const fam = (geometry, parameters = []) => ({
  id: "f", name: "F", category: "generic", ifcEntity: "IfcBuildingElementProxy",
  schemaVersion: 1, builtIn: false, parameters, geometry,
  types: [{ id: "t", name: "T", values: {} }],
});
const build = (geometry, options = {}) => {
  const r = E.buildParametricFamily(fam(geometry), null, options);
  if (!r.object) throw new Error(`build produced no object (errors: ${r.errors.join("; ")})`);
  if (r.errors.length) throw new Error(`build errors: ${r.errors.join("; ")}`);
  return r;
};
/** Signed-tetrahedron volume, index- and world-matrix-aware. */
const volume = (obj) => {
  obj.updateMatrixWorld(true);
  let v = 0;
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry, p = g.attributes.position, w = m.matrixWorld;
    const idx = g.index ? g.index.array : null;
    const tris = idx ? idx.length / 3 : p.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const vi = (k) => (idx ? idx[k] : k);
    for (let k = 0; k < tris; k++) {
      a.fromBufferAttribute(p, vi(k * 3)).applyMatrix4(w);
      b.fromBufferAttribute(p, vi(k * 3 + 1)).applyMatrix4(w);
      c.fromBufferAttribute(p, vi(k * 3 + 2)).applyMatrix4(w);
      v += a.dot(b.clone().cross(c)) / 6;
    }
  });
  return Math.abs(v);
};
const boxOf = (obj) => {
  const b = new THREE.Box3().setFromObject(obj);
  return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
};
const boxNear = (obj, expected, tol = 1e-3) => {
  const got = boxOf(obj);
  got.forEach((v, i) => near(v, expected[i], tol, `box[${i}]`));
};
const meshCount = (obj) => {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh) n++; });
  return n;
};

// ── V1. Void cuts ───────────────────────────────────────────────────────────
t("V1 centred void is really subtracted: 8 - 1 = 7", () => {
  const r = build({ kind: "composed", parts: [
    { kind: "box", w: C(2), d: C(2), h: C(2) },
    { kind: "void", solid: { kind: "box", w: C(1), d: C(1), h: C(1) } },
  ] });
  near(volume(r.object), 7, 0.05, "box minus centred void");
  boxNear(r.object, [-1, -1, -1, 1, 1, 1]);
  if (meshCount(r.object) !== 1) throw new Error(`expected 1 mesh after the cut, got ${meshCount(r.object)}`);
  if (r.warnings.length) throw new Error(`unexpected warnings: ${r.warnings.join("; ")}`);
});

t("V2 offset void cuts a through-slot; a disjoint void changes nothing", () => {
  const r = build({ kind: "composed", parts: [
    { kind: "box", w: C(4), d: C(2), h: C(2) },
    { kind: "void", solid: { kind: "box", w: C(1), d: C(2), h: C(2) }, transform: { translate: [C(1.5), C(0), C(0)] } },
  ] });
  near(volume(r.object), 12, 0.05, "16 - 4 cut away at x in [1, 2]");
  if (r.warnings.length) throw new Error(`unexpected warnings: ${r.warnings.join("; ")}`);

  const untouched = build({ kind: "composed", parts: [
    { kind: "box", w: C(4), d: C(2), h: C(2) },
    { kind: "void", solid: { kind: "box", w: C(1), d: C(1), h: C(1) }, transform: { translate: [C(10), C(0), C(0)] } },
  ] });
  near(volume(untouched.object), 16, 0.05, "disjoint void leaves the solid alone");
  if (untouched.warnings.length) throw new Error(`unexpected warnings: ${untouched.warnings.join("; ")}`);
});

t("V3 preview skips the CSG: the void stays visible as a solid", () => {
  const r = build({ kind: "composed", parts: [
    { kind: "box", w: C(2), d: C(2), h: C(2) },
    { kind: "void", solid: { kind: "box", w: C(1), d: C(1), h: C(1) } },
  ] }, { preview: true });
  near(volume(r.object), 9, 0.05, "preview keeps both solids (8 + 1)");
  let voids = 0;
  r.object.traverse((o) => { if (o.userData.isVoid) voids++; });
  if (voids === 0) throw new Error("preview should keep the void marked");
});

// ── S1-S2. Sweep straight runs ─────────────────────────────────────────────
t("S1 sweep along X: profile height stays vertical, volume exact", () => {
  const r = build({ kind: "sweep",
    profile: { kind: "rect", w: C(1), h: C(2) },
    path: [[C(0), C(0), C(0)], [C(4), C(0), C(0)]] });
  boxNear(r.object, [0, -1, -0.5, 4, 1, 0.5]);
  near(volume(r.object), 8, 0.01, "1 x 2 profile x 4 length");
});

t("S2 sweep along Y: profile orientation is deterministic, volume exact", () => {
  // Note: a straight vertical run agrees with the old Frenet frame on
  // the bounding box, so this test pins the convention (profile +Y
  // falls back to world +X when the path is vertical, profile +X to
  // world +Z) and its determinism rather than discriminating old from
  // new; S3 pins the orientation for the horizontal run, and S4/S5
  // discriminate the corner treatment.
  const r = build({ kind: "sweep",
    profile: { kind: "rect", w: C(1), h: C(2) },
    path: [[C(0), C(0), C(0)], [C(0), C(4), C(0)]] });
  boxNear(r.object, [-1, 0, -0.5, 1, 4, 0.5]);
  near(volume(r.object), 8, 0.01, "1 x 2 profile x 4 length, vertical");
});

// ── S3. Sweep orientation pinned with an asymmetric profile ────────────────
t("S3 asymmetric triangle profile pins the orientation convention", () => {
  const r = build({ kind: "sweep",
    profile: { kind: "polygon", points: [[0, 0], [2, 0], [0, 1]] },
    path: [[C(0), C(0), C(0)], [C(4), C(0), C(0)]] });
  // Profile +Y stays world +Y, profile +X maps to world -Z.
  boxNear(r.object, [0, 0, -2, 4, 1, 0]);
  near(volume(r.object), 4, 0.01, "triangle area 1 x length 4");
});

// ── S4-S5. Sweep corners ────────────────────────────────────────────────────
t("S4 L-path sweep is mitered: no bulge past the corner, no double-count", () => {
  const r = build({ kind: "sweep",
    profile: { kind: "rect", w: C(1), h: C(2) },
    path: [[C(0), C(0), C(0)], [C(4), C(0), C(0)], [C(4), C(0), C(4)]] });
  boxNear(r.object, [0, -1, -0.5, 4.5, 1, 4]);
  // Each leg is 8: the corner ring is the leg prism's intersection
  // with the miter plane, so the leg extends to the full diagonal and
  // the two legs touch exactly at that plane (no overlap, no gap).
  // A box cut by the miter plane would give 15.5 and a chamfered
  // outer corner instead of the sharp corner at (4.5, -0.5).
  near(volume(r.object), 16, 0.05, "two 8-volume legs meeting at the miter plane");
});

t("S5 closed square loop sweep: picture frame, volume exact", () => {
  const r = build({ kind: "sweep",
    profile: { kind: "rect", w: C(1), h: C(2) },
    path: [[C(0), C(0), C(0)], [C(4), C(0), C(0)], [C(4), C(0), C(4)], [C(0), C(0), C(4)]],
    closed: true });
  boxNear(r.object, [-0.5, -1, -0.5, 4.5, 1, 4.5]);
  near(volume(r.object), 32, 0.05, "frame plan area 16 x height 2");
});

// ── L1-L3. Lofts ────────────────────────────────────────────────────────────
t("L1 loft 2x2 -> 1x1 is a true linear taper, not a stepped stack", () => {
  const r = build({ kind: "loft",
    profiles: [{ kind: "rect", w: C(2), h: C(2) }, { kind: "rect", w: C(1), h: C(1) }],
    segments: 4 });
  boxNear(r.object, [-1, -1, 0, 1, 1, 1]);
  near(volume(r.object), 7 / 3, 0.05, "frustum volume (4 + 1 + sqrt(4)) / 3");
});

t("L2 loft rect -> circle lands between the two prism volumes", () => {
  const r = build({ kind: "loft",
    profiles: [{ kind: "rect", w: C(2), h: C(2) }, { kind: "circle", r: C(1) }],
    segments: 8 });
  const v = volume(r.object);
  if (!(v > 3.3 && v < 4)) throw new Error(`rect->circle loft volume ${v} is outside (3.3, 4)`);
  boxNear(r.object, [-1, -1, 0, 1, 1, 1]);
});

t("L3 loft with three profiles tapers down and back up", () => {
  const r = build({ kind: "loft",
    profiles: [
      { kind: "rect", w: C(2), h: C(2) },
      { kind: "rect", w: C(1), h: C(1) },
      { kind: "rect", w: C(2), h: C(2) },
    ],
    segments: 4 });
  // Each profile pair spans 1/(profiles - 1) = 1/2 of the height, so
  // each frustum is 7/6, not 7/3: (0.5/3) x (4 + 1 + sqrt(4)).
  // (The old stepped stack happens to land within tolerance here —
  // its errors cancel on the symmetric taper — so L1, not L3, is the
  // discriminator for the loft fix; L3 pins the multi-profile value.)
  near(volume(r.object), 2 * (7 / 6), 0.1, "two half-height frustums");
  boxNear(r.object, [-1, -1, 0, 1, 1, 1]);
});

console.log(`\nparametric-voids-sweeps-lofts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
