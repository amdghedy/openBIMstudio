/**
 * tests/parametric-revolve.test.cjs
 *
 * Revit parity Rank 6, item 1 — revolve hardening. Slice 6 hardened
 * voids/sweeps/lofts and left revolve on THREE.LatheGeometry; this suite
 * proves the hand-built replacement.
 *
 * Measured BEFORE (probe on the merged base, LatheGeometry):
 *   - washer (rect ring x in [1,2], y in [0,1]) full revolve: 9.4096 for
 *     a true 3π ≈ 9.4248 — faceting only, correct to 0.16% at 64 segments.
 *   - the same washer at half/quarter angle: 4.7105 / 2.3560, again the
 *     right value — but the mesh was OPEN: LatheGeometry builds no end
 *     caps, so a partial revolve is not a solid (no closed-solid check,
 *     CSG or IFC export can trust it).
 *   - a circle profile centred on the axis: volume EXACTLY 0.0000 for a
 *     sphere that should be 4/3·π·0.5³ ≈ 0.5236 — the two halves of the
 *     outline cancel exactly, while the bounding box still looks right.
 *   - a rect straddling the axis: volume EXACTLY 0.0000, same cause.
 *   - angle 4π: silently accepted (LatheGeometry wraps phi), producing
 *     a self-overlapping mesh.
 *
 * The builder now rejects axis-crossing profiles and angles outside
 * (0, 2π] with a warning (a sphere is a 0–90° arc sector revolved, not
 * a circle on the axis), and closes partial revolutions with
 * triangulated end caps. Tests assert VOLUMES (signed-tetrahedron,
 * index- and matrix-aware), bounding boxes, and CLOSEDNESS (every
 * non-degenerate edge shared by exactly two triangles in opposite
 * directions) — not just "no throw".
 *
 * Volumes carry the analytic faceting factor for N angular segments,
 * N·sin(2π/N)/2π (0.9984 at N=64, 0.9006 at N=8): the tolerances below
 * are that bound, not fudge.
 *
 * Run: `node tests/parametric-revolve.test.cjs`
 * CI:  `test:parametric-revolve` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-voids-sweeps-lofts.test.cjs), so `three` resolves
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
const tmpOut = fs.mkdtempSync(path.join(root, ".revolve-test-"));
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
const fam = (geometry, parameters = []) => ({
  id: "f", name: "F", category: "generic", ifcEntity: "IfcBuildingElementProxy",
  schemaVersion: 1, builtIn: false, parameters, geometry,
  types: [{ id: "t", name: "T", values: {} }],
});
const build = (geometry, options = {}) => {
  const r = E.buildParametricFamily(fam(geometry), null, options);
  if (!r.object) throw new Error(`build produced no object (errors: ${r.errors.join("; ")}; warnings: ${r.warnings.join("; ")})`);
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
/**
 * Closed-solid check: every non-degenerate triangle edge must be shared
 * by exactly two triangles, in opposite directions. Degenerate
 * (zero-area) triangles — the axis edge of an axis-touching profile,
 * where every section collapses to one segment — are ignored: that
 * segment is interior to the solid, not a boundary edge.
 */
const assertClosed = (obj) => {
  obj.updateMatrixWorld(true);
  const edges = new Map(); // "a|b" (directed) -> count
  const key = (v) => {
    // 1e-6 quantisation with -0 normalised: vertex identity here is
    // topological, and trig at the seam leaves ~1e-16 noise.
    const q = (x) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(6);
    return `${q(v.x)},${q(v.y)},${q(v.z)}`;
  };
  let tris = 0;
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry, p = g.attributes.position, w = m.matrixWorld;
    const idx = g.index ? g.index.array : null;
    const count = idx ? idx.length / 3 : p.count / 3;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const vi = (k) => (idx ? idx[k] : k);
    for (let k = 0; k < count; k++) {
      a.fromBufferAttribute(p, vi(k * 3)).applyMatrix4(w);
      b.fromBufferAttribute(p, vi(k * 3 + 1)).applyMatrix4(w);
      c.fromBufferAttribute(p, vi(k * 3 + 2)).applyMatrix4(w);
      const area2 = b.clone().sub(a).cross(c.clone().sub(a)).length();
      if (area2 < 1e-12) continue; // degenerate axis triangle
      tris++;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const k2 = `${key(u)}|${key(v)}`;
        edges.set(k2, (edges.get(k2) ?? 0) + 1);
      }
    }
  });
  if (!tris) throw new Error("closedness check saw no non-degenerate triangles");
  for (const [k2, n] of edges) {
    const [u, v] = k2.split("|");
    const rev = edges.get(`${v}|${u}`) ?? 0;
    if (n !== 1 || rev !== 1) {
      throw new Error(`edge ${k2} appears ${n} time(s) forward, ${rev} time(s) backward (expected 1/1)`);
    }
  }
};

const washer = { kind: "polygon", points: [[1, 0], [2, 0], [2, 1], [1, 1]] };
const WASHER_FULL = 3 * Math.PI; // π·(2²−1²)·1

// ── R1–R3. Washer at full / half / quarter angle ────────────────────────────
t("R1 washer, full revolve about Y: volume 3π, closed solid", () => {
  const r = build({ kind: "revolve", profile: washer, axis: "y", angle: C(Math.PI * 2), segments: 64 });
  near(volume(r.object), WASHER_FULL, 0.02, "faceting bound at 64 segments is 0.16%");
  boxNear(r.object, [-2, 0, -2, 2, 1, 2]);
  assertClosed(r.object);
  if (r.warnings.length) throw new Error(`unexpected warnings: ${r.warnings.join("; ")}`);
});

t("R2 washer, half revolve: volume 3π/2 and the end caps really close it", () => {
  // Discriminator: on LatheGeometry the volume already measured right
  // (4.7105) because the missing caps lie in planes through the axis,
  // but the mesh was open. assertClosed is what catches the old code.
  const r = build({ kind: "revolve", profile: washer, axis: "y", angle: C(Math.PI), segments: 64 });
  near(volume(r.object), WASHER_FULL / 2, 0.02, "half of 3π");
  boxNear(r.object, [0, 0, -2, 2, 1, 2]);
  assertClosed(r.object);
  if (r.warnings.length) throw new Error(`unexpected warnings: ${r.warnings.join("; ")}`);
});

t("R3 washer, quarter revolve: volume 3π/4, closed", () => {
  const r = build({ kind: "revolve", profile: washer, axis: "y", angle: C(Math.PI / 2), segments: 64 });
  near(volume(r.object), WASHER_FULL / 4, 0.02, "quarter of 3π");
  boxNear(r.object, [0, 0, 0, 2, 1, 2]);
  assertClosed(r.object);
});

// ── R4. Axis handling ───────────────────────────────────────────────────────
t("R4 washer about X and Z: same volume as about Y (rotation only)", () => {
  const rx = build({ kind: "revolve", profile: washer, axis: "x", angle: C(Math.PI * 2), segments: 64 });
  near(volume(rx.object), WASHER_FULL, 0.02, "x-axis volume");
  boxNear(rx.object, [-1, -2, -2, 0, 2, 2]);
  assertClosed(rx.object);
  const rz = build({ kind: "revolve", profile: washer, axis: "z", angle: C(Math.PI * 2), segments: 64 });
  near(volume(rz.object), WASHER_FULL, 0.02, "z-axis volume");
  boxNear(rz.object, [-2, -2, 0, 2, 2, 1]);
  assertClosed(rz.object);
});

// ── R5–R7. Rejections ───────────────────────────────────────────────────────
t("R5 circle profile centred on the axis is rejected, not a zero-volume mesh", () => {
  // Before: volume exactly 0.0000 for a sphere that should be 0.5236.
  const r = E.buildParametricFamily(fam({ kind: "revolve", profile: { kind: "circle", r: C(0.5) }, axis: "y", angle: C(Math.PI * 2), segments: 64 }), null, {});
  if (r.object) throw new Error(`axis-centred circle revolve built a mesh (volume ${volume(r.object).toFixed(4)}) instead of rejecting`);
  if (!r.warnings.some((w) => /axis/i.test(w))) throw new Error(`expected an axis warning, got: ${r.warnings.join("; ")}`);
});

t("R6 rect straddling the axis is rejected, not a zero-volume mesh", () => {
  const r = E.buildParametricFamily(fam({ kind: "revolve", profile: { kind: "polygon", points: [[-1, 0], [1, 0], [1, 1], [-1, 1]] }, axis: "y", angle: C(Math.PI * 2), segments: 64 }), null, {});
  if (r.object) throw new Error(`axis-straddling rect revolve built a mesh (volume ${volume(r.object).toFixed(4)}) instead of rejecting`);
  if (!r.warnings.some((w) => /axis/i.test(w))) throw new Error(`expected an axis warning, got: ${r.warnings.join("; ")}`);
});

t("R7 angles outside (0, 2π] are rejected with a warning", () => {
  for (const a of [0, -1, Math.PI * 4]) {
    const r = E.buildParametricFamily(fam({ kind: "revolve", profile: washer, axis: "y", angle: C(a), segments: 64 }), null, {});
    if (r.object) throw new Error(`angle ${a} built a mesh instead of rejecting`);
    if (!r.warnings.some((w) => /angle/i.test(w))) throw new Error(`angle ${a}: expected an angle warning, got: ${r.warnings.join("; ")}`);
  }
});

// ── R8–R10. Axis-touching profiles and segment quality ─────────────────────
t("R8 arc sector 0–90° revolved is a hemisphere: volume (2/3)πr³", () => {
  // The supported sphere path: a 0–90° sector stays on one side of the
  // axis (its radii run along the axis and the equator), so the revolve
  // is a solid hemisphere. A full circle cannot be the profile — R5.
  const r = build({ kind: "revolve", profile: { kind: "arc", r: C(0.5), startAngle: C(0), endAngle: C(90) }, axis: "y", angle: C(Math.PI * 2), segments: 64 });
  near(volume(r.object), (2 / 3) * Math.PI * Math.pow(0.5, 3), 0.01, "hemisphere volume");
  boxNear(r.object, [-0.5, 0, -0.5, 0.5, 0.5, 0.5]);
  assertClosed(r.object);
});

t("R9 coarse segments follow the analytic faceting bound, not an arbitrary error", () => {
  // N=8: the circular path is an octagon, so the volume is the exact
  // volume times 8·sin(2π/8)/2π ≈ 0.9006. This pins that `segments`
  // controls quality deterministically.
  const r = build({ kind: "revolve", profile: washer, axis: "y", angle: C(Math.PI * 2), segments: 8 });
  const bound = (8 * Math.sin(2 * Math.PI / 8)) / (2 * Math.PI);
  near(volume(r.object), WASHER_FULL * bound, 0.05, "octagon faceting bound");
});

t("R10 rect touching the axis revolves to a solid cylinder: volume π", () => {
  const r = build({ kind: "revolve", profile: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, axis: "y", angle: C(Math.PI * 2), segments: 64 });
  near(volume(r.object), Math.PI, 0.02, "cylinder π·1²·1");
  boxNear(r.object, [-1, 0, -1, 1, 1, 1]);
  assertClosed(r.object);
});

console.log(`\nparametric-revolve: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
