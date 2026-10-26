/**
 * tests/v70-deep-modeling.test.cjs
 *
 * Unit tests for the v0.70 deep-modeling wave:
 *   - general boolean kernel (src/modules/solid-kernel/general-csg.ts):
 *     union / intersect / subtract on ARBITRARY closed meshes — the
 *     v0.68 deviation D-3 (convex-operand restriction) is closed.
 *   - shell / hollow technique (shell.ts): miter ring offset +
 *     hollow extrusion with the exact volume identity
 *     V = depth * (A_outer - A_inner).
 *   - multi-section loft (loft.ts): N-section ruled loft, 2-section
 *     volume-identical to blend().
 *
 * All volumes are verified against closed forms to 1e-9 or better;
 * watertightness is asserted through validateMeshDiagnostics
 * (non-manifold-edge count == 0 after vertex welding).
 *
 * Run: `node tests/v70-deep-modeling.test.cjs`
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
function near(a, b, tol = 1e-6) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v70-deep-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/solid-kernel/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const sk = require(path.join(tmpOut, "modules/solid-kernel/index.js"));

// ── Helpers ─────────────────────────────────────────────────────────────
const rect = (w, h) => [{ u: 0, v: 0 }, { u: w, v: 0 }, { u: w, v: h }, { u: 0, v: h }, { u: 0, v: 0 }];
const box = (x0, y0, z0, x1, y1, z1) =>
  sk.generateVoid({ kind: "box", center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 }, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } });

function nonManifoldCount(mesh) {
  // Boolean output is a geometrically-watertight polygon soup; weld
  // coincident vertices first (platform convention, v68 three-
  // representation rule) before counting edge uses on raw indices.
  return sk.validateMeshDiagnostics(sk.weldMesh(mesh))
    .filter((d) => d.code === "non-manifold-edge").length;
}
function errorCount(mesh) {
  return sk.validateMeshDiagnostics(sk.weldMesh(mesh))
    .filter((d) => d.severity === "error").length;
}

console.log("== tests/v70-deep-modeling.test.cjs");

// ═══ 1. General boolean kernel — union ══════════════════════════════════

t("general union: overlapping boxes with coplanar tops -> exact L-shape volume 1.75, watertight", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(0.5, 0.5, 0, 1.5, 1.5, 1); // tops coplanar at z=1, volumes overlap
  const u = sk.generalBoolean("union", A, B);
  near(sk.meshVolume(u), 1 + 1 - 0.25, 1e-9);
  assert(nonManifoldCount(u) === 0, `non-manifold edges: ${nonManifoldCount(u)}`);
  assert(errorCount(u) === 0, `error diagnostics: ${errorCount(u)}`);
});

t("general union: stacked boxes (opposite-facing coplanar contact) -> 2.0, no interior skin", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(0, 0, 1, 1, 1, 2);
  const u = sk.generalBoolean("union", A, B);
  near(sk.meshVolume(u), 2, 1e-9);
  assert(nonManifoldCount(u) === 0, `non-manifold edges: ${nonManifoldCount(u)}`);
});

t("general union: glued side-by-side (full-face contact) -> 2.0, watertight", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(1, 0, 0, 2, 1, 1);
  const u = sk.generalBoolean("union", A, B);
  near(sk.meshVolume(u), 2, 1e-9);
  assert(nonManifoldCount(u) === 0, `non-manifold edges: ${nonManifoldCount(u)}`);
});

t("general union: disjoint boxes -> volumes add (two shells), 2.0", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(5, 5, 5, 6, 6, 6);
  const u = sk.generalBoolean("union", A, B);
  near(sk.meshVolume(u), 2, 1e-9);
});

t("general union is volume-symmetric: union(A,B) == union(B,A)", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(0.5, 0.5, 0, 1.5, 1.5, 1);
  near(sk.meshVolume(sk.generalBoolean("union", A, B)),
       sk.meshVolume(sk.generalBoolean("union", B, A)), 1e-9);
});

t("general intersect: overlapping boxes -> exact overlap 0.5, watertight", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(0.5, 0, 0, 1.5, 1, 1);
  const i = sk.generalBoolean("intersect", A, B);
  near(sk.meshVolume(i), 0.5, 1e-9);
  assert(nonManifoldCount(i) === 0, `non-manifold edges: ${nonManifoldCount(i)}`);
});

t("general intersect: box ∩ NON-CONVEX L (chained union output) -> two notch corners cut exactly", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(0.5, 0.5, 0, 1.5, 1.5, 1);
  const L = sk.generalBoolean("union", A, B); // non-convex mesh as INPUT
  // Probe square loses BOTH notch corners:
  // [0.25,0.5]x[1,1.25] and [1,1.25]x[0.25,0.5]: V = 1 - 0.125 = 0.875
  const probe = box(0.25, 0.25, 0, 1.25, 1.25, 1);
  const i = sk.generalBoolean("intersect", probe, L);
  near(sk.meshVolume(i), 1 - 2 * 0.0625, 1e-9); // two notch corners
});

t("general subtract: box minus NON-CONVEX L cutter -> 0.75", () => {
  const wall = box(0, 0, 0, 1, 1, 1);
  const leg1 = box(0.5, 0.5, 0, 1.5, 1, 1);
  const leg2 = box(0.5, 1, 0, 1, 1.5, 1);
  const Lcutter = sk.generalBoolean("union", leg1, leg2); // non-convex cutter
  const s = sk.generalBoolean("subtract", wall, Lcutter);
  near(sk.meshVolume(s), 1 - 0.25, 1e-9);
});

t("general subtract: interior non-convex cavity fully inside -> exact volume, watertight", () => {
  const host = box(0, 0, 0, 2, 2, 2);
  const leg1 = box(0.5, 0.5, 0.5, 1.5, 1, 1.5);
  const leg2 = box(0.5, 1, 0.5, 1, 1.5, 1.5);
  const cavity = sk.generalBoolean("union", leg1, leg2);
  const s = sk.generalBoolean("subtract", host, cavity);
  near(sk.meshVolume(s), 8 - 0.75, 1e-9);
  assert(nonManifoldCount(s) === 0, `non-manifold edges: ${nonManifoldCount(s)}`);
});

t("general subtract: flush through-opening (window in wall) reproduces v0.68 semantics", () => {
  // Wall 8 x 0.2 x 3 (x, y, z); window void with its BACK face flush with
  // the wall's back face — the coplanar through-opening case.
  const wall = sk.extrude({ profile: rect(8, 0.2), depth: 3 });
  const win = box(-2 + 4, -0.1, 0.9, -2 + 4 + 1.5, 0.3, 0.9 + 1.2); // y: -0.1..0.3 (flush back at -0.1)
  const s = sk.generalBoolean("subtract", wall, win);
  near(sk.meshVolume(s), 8 * 0.2 * 3 - 1.5 * 1.2 * 0.2, 1e-9);
  assert(nonManifoldCount(s) === 0, `non-manifold edges: ${nonManifoldCount(s)}`);
});

t("general intersect: disjoint solids throw a precise empty-result error", () => {
  const A = box(0, 0, 0, 1, 1, 1);
  const B = box(5, 5, 5, 6, 6, 6);
  throws(() => sk.generalBoolean("intersect", A, B), "empty");
});

t("fuseAll: chain of 3 overlapping boxes -> exact closed form 2.5", () => {
  const b1 = box(0, 0, 0, 1, 1, 1);
  const b2 = box(0.75, 0, 0, 1.75, 1, 1);
  const b3 = box(1.5, 0, 0, 2.5, 1, 1);
  const f = sk.fuseAll([b1, b2, b3]);
  near(sk.meshVolume(f), 1 + 1 + 1 - 0.25 - 0.25, 1e-9);
});

t("fuseAll: single solid passthrough, empty list throws", () => {
  const b1 = box(0, 0, 0, 1, 1, 1);
  near(sk.meshVolume(sk.fuseAll([b1])), 1, 1e-9);
  throws(() => sk.fuseAll([]), "at least one");
});

// ═══ 2. Shell / hollow ══════════════════════════════════════════════════

t("offsetClosedRing: square inward 0.2 -> exact inner ring, same vertex count", () => {
  const ring = rect(2, 2);
  const inner = sk.offsetClosedRing(ring, 0.2);
  assert(inner.length === 4, `expected 4 vertices after collinear cleanup, got ${inner.length}`);
  near(sk.profileSignedArea(inner), 1.6 * 1.6, 1e-9);
  // First inner vertex at (0.2, 0.2) for the miter of a square.
  near(inner[0].u, 0.2, 1e-9);
  near(inner[0].v, 0.2, 1e-9);
});

t("offsetClosedRing: outward offset grows the ring exactly", () => {
  const ring = rect(2, 2);
  const outer = sk.offsetClosedRing(ring, -0.3);
  near(sk.profileSignedArea(outer), 2.6 * 2.6, 1e-9);
});

t("offsetClosedRing: collapsing offsets throw precise errors", () => {
  // d = s/2 collapses the square to a point -> collapsed-edge error fires first
  throws(() => sk.offsetClosedRing(rect(2, 2), 1.0), "collapses");
  throws(() => sk.offsetClosedRing(rect(2, 2), 0), "non-zero");
});

t("hollowExtrusion: rect shell -> exact volume depth*(Ao-Ai), watertight", () => {
  const m = sk.hollowExtrusion({ profile: rect(2, 2), depth: 3, thickness: 0.25 });
  near(sk.meshVolume(m), 3 * (4 - 1.5 * 1.5), 1e-9);
  assert(nonManifoldCount(m) === 0, `non-manifold edges: ${nonManifoldCount(m)}`);
  assert(errorCount(m) === 0, `error diagnostics: ${errorCount(m)}`);
});

t("hollowExtrusion: L-profile shell -> volume identity holds exactly", () => {
  const L = [
    { u: 0, v: 0 }, { u: 2, v: 0 }, { u: 2, v: 0.5 },
    { u: 0.5, v: 0.5 }, { u: 0.5, v: 2 }, { u: 0, v: 2 }, { u: 0, v: 0 },
  ];
  const depth = 1.2, th = 0.15;
  const m = sk.hollowExtrusion({ profile: L, depth, thickness: th });
  const metrics = sk.hollowMetrics(L, depth, th);
  near(sk.meshVolume(m), metrics.expectedVolume, 1e-9);
  near(metrics.outerArea, 2 * 0.5 + 1.5 * 0.5, 1e-9); // 1.375
  assert(nonManifoldCount(m) === 0, `non-manifold edges: ${nonManifoldCount(m)}`);
});

t("hollowExtrusion: thickness too large throws", () => {
  throws(() => sk.hollowExtrusion({ profile: rect(2, 2), depth: 3, thickness: 1.0 }), "collapses");
});

// ═══ 3. Multi-section loft ══════════════════════════════════════════════

t("loftSections: 3 identical squares -> exact prism volume, watertight", () => {
  const sq = rect(1, 1);
  const m = sk.loftSections({ sections: [sq, sq, sq], height: 3 });
  near(sk.meshVolume(m), 1 * 3, 1e-9);
  assert(nonManifoldCount(m) === 0, `non-manifold edges: ${nonManifoldCount(m)}`);
  assert(errorCount(m) === 0, `error diagnostics: ${errorCount(m)}`);
});

t("loftSections: 2 sections volume-identical to blend (shared correspondence path)", () => {
  const s1 = rect(2, 2);
  const s2 = [{ u: 0, v: -0.5 }, { u: 0.5, v: 0 }, { u: 0, v: 0.5 }, { u: -0.5, v: 0 }, { u: 0, v: -0.5 }];
  const h = 2.5;
  const loft = sk.loftSections({ sections: [s1, s2], height: h });
  const bl = sk.blend({ startProfile: s1, endProfile: s2, height: h });
  near(sk.meshVolume(loft), sk.meshVolume(bl), 1e-9);
});

t("loftSections: explicit levels honored (prismatic volume uses the level span)", () => {
  const sq = rect(1, 1);
  const m = sk.loftSections({ sections: [sq, sq, sq], height: 99, levels: [1, 1.5, 4] });
  near(sk.meshVolume(m), 1 * (4 - 1), 1e-9);
  const zs = m.vertices.map((v) => v.z);
  near(Math.min(...zs), 1, 1e-12);
  near(Math.max(...zs), 4, 1e-12);
});

t("loftSections: rejects single section and non-increasing levels", () => {
  throws(() => sk.loftSections({ sections: [rect(1, 1)], height: 1 }), ">= 2 sections");
  throws(
    () => sk.loftSections({ sections: [rect(1, 1), rect(1, 1)], levels: [1, 1] }),
    "strictly increasing",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
