/**
 * tests/tolerance-policy.test.cjs
 *
 * Regression tests for PE-10 (unified tolerance policy):
 *   - policy values are the single source of truth (tolerance.ts);
 *   - tolerances are scale-relative: they grow with coordinate magnitude
 *     and stay above float64 spacing at 1e9-scale coordinates;
 *   - weldVertices uses the scale-relative default but honours an
 *     explicit tolerance override;
 *   - generalBoolean records sliver drops / degenerate triangles as
 *     diagnostics instead of silently dropping them, and clean
 *     operations record zero diagnostics;
 *   - poly-boolean fails closed with a typed DegenerateInputError on
 *     degenerate input, and reports a legitimately empty result as an
 *     `empty-result` diagnostic instead of a silent [] / null.
 *
 * Run: `node tests/tolerance-policy.test.cjs`
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
function near(a, b, tol) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`); }
function throwsCode(fn, code) {
  try { fn(); } catch (e) {
    if (e && e.code === code) return e;
    throw new Error(`threw wrong error (code=${e && e.code}): ${e && e.message}`);
  }
  throw new Error(`expected throw with code '${code}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-tolerance-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/solid-kernel/index.ts src/modules/cad-viewer/poly-boolean.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const sk = require(path.join(tmpOut, "modules/solid-kernel/index.js"));
const pb = require(path.join(tmpOut, "modules/cad-viewer/poly-boolean.js"));

// ── Helpers ─────────────────────────────────────────────────────────────
const box = (x0, y0, z0, x1, y1, z1) =>
  sk.generateVoid({ kind: "box", center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 }, size: { x: x1 - x0, y: y1 - y0, z: z1 - z0 } });

function shoelace(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
const sq = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];

// ── 1. Policy values ────────────────────────────────────────────────────
t("policy base values are the historical values", () => {
  assert(sk.COINCIDENT_TOLERANCE === 1e-9, "COINCIDENT");
  assert(sk.CLASSIFICATION_TOLERANCE === 1e-9, "CLASSIFICATION");
  assert(sk.SPLIT_TOLERANCE === 1e-9, "SPLIT");
  assert(sk.ON_PLANE_TOLERANCE === 1e-8, "ON_PLANE");
  assert(sk.PROBE_TOLERANCE === 1e-6, "PROBE");
  assert(sk.SLIVER_AREA_TOLERANCE === 1e-12, "SLIVER_AREA");
  assert(sk.TOLERANCE_ULPS === 8, "ULPS");
  // brep re-export keeps the old name working for existing importers.
  assert(sk.COINCIDENT_TOL === sk.COINCIDENT_TOLERANCE, "COINCIDENT_TOL alias");
});

// ── 2. Scale-relative growth ────────────────────────────────────────────
t("floatSpacing at 1e9 is ~2.2e-7 m (above the old 1e-9 epsilon)", () => {
  const s = sk.floatSpacing(1e9);
  assert(s > 1e-7 && s < 3e-7, `spacing(1e9) = ${s}`);
  assert(sk.floatSpacing(1e9) > 1e-9, "old 1e-9 epsilon is below spacing at 1e9");
  near(sk.floatSpacing(1), Number.EPSILON, 1e-18);
});

t("scaledTolerance is the base at ordinary scales and grows past spacing at 1e9", () => {
  assert(sk.scaledTolerance(1e-9, 1) === 1e-9, "base at 1 m");
  assert(sk.scaledTolerance(1e-9, 100) === 1e-9, "base at 100 m");
  const big = sk.scaledTolerance(1e-9, 1e9);
  assert(big > sk.floatSpacing(1e9), `scaled(1e9) = ${big} must exceed spacing`);
  near(big, 1e9 * Number.EPSILON * 8, 1e-9);
  assert(sk.scaledTolerance(1e-9, 1e9) > sk.scaledTolerance(1e-9, 1e6), "monotonic growth");
});

t("scaledAreaTolerance grows as the square of the length tolerance", () => {
  assert(sk.scaledAreaTolerance(1e-12, 1) === 1e-12, "base at 1 m");
  const big = sk.scaledAreaTolerance(1e-12, 1e9);
  assert(big > 1e-12, `scaled area(1e9) = ${big}`);
  near(big, Math.pow(1e9 * Number.EPSILON * 8, 2), 1e-12);
});

t("coincidentTolerance/probeTolerance/sliverAreaTolerance accessors agree with the scalers", () => {
  assert(sk.coincidentTolerance(1) === 1e-9, "coincident base");
  near(sk.coincidentTolerance(1e9), 1e9 * Number.EPSILON * 8, 1e-9);
  assert(sk.probeTolerance(1) === 1e-6, "probe base");
  assert(sk.probeTolerance(1e9) > 1e-6, "probe grows at 1e9");
  assert(sk.sliverAreaTolerance(1) === 1e-12, "sliver base");
});

// ── 3. weldVertices: scale-relative default, explicit override honoured ─
function weldSolid(origin) {
  return {
    id: "w",
    vertices: [
      { x: origin, y: 0, z: 0 },
      { x: origin + 5e-7, y: 0, z: 0 },
      { x: origin, y: 1, z: 0 },
      { x: origin, y: 0, z: 1 },
    ],
    faces: [
      { id: "w:f0", loop: [0, 2, 3], surface: "general" },
      { id: "w:f1", loop: [1, 2, 3], surface: "general" },
    ],
    edges: new Map(),
  };
}

t("weldVertices: 5e-7 m-apart vertices weld at 1e9 scale, not at unit scale", () => {
  const far = sk.weldVertices(weldSolid(1e9));
  assert(far.vertices.length === 3, `far-scale vertices = ${far.vertices.length}, expected 3 (welded)`);
  const nearSolid = sk.weldVertices(weldSolid(0));
  assert(nearSolid.vertices.length === 4, `unit-scale vertices = ${nearSolid.vertices.length}, expected 4 (kept)`);
});

t("weldVertices: explicit tolerance override is honoured exactly", () => {
  const forced = sk.weldVertices(weldSolid(1e9), 1e-9);
  assert(forced.vertices.length === 4, `explicit 1e-9 at 1e9 scale keeps 4 vertices, got ${forced.vertices.length}`);
});

// ── 4. generalBoolean diagnostics ───────────────────────────────────────
t("generalBooleanDetailed: clean overlapping-box union records zero diagnostics", () => {
  const { mesh, diagnostics } = sk.generalBooleanDetailed("union", box(0, 0, 0, 1, 1, 1), box(0.5, 0, 0, 1.5, 1, 1));
  near(sk.meshVolume(sk.weldMesh(mesh)), 1.5, 1e-9);
  assert(Array.isArray(diagnostics) && diagnostics.length === 0, `expected no diagnostics, got ${JSON.stringify(diagnostics)}`);
});

t("generalBooleanDetailed: near-coincident offset drops slivers AND records them", () => {
  // B starts 1e-9 m inside A (exactly at the split tolerance): the split
  // creates fragments below the 1e-12 m² sliver cutoff. The drop must be
  // visible in diagnostics — not silent. NOTE: the resulting volume is
  // NOT pinned here — near-tolerance booleans misclassify on the chain
  // base too (vol 1.333... at this offset, verified identical on
  // df959b2), a pre-existing kernel limit (tangential contact resolved
  // at classification tolerance, not exactly), not a PE-10 regression.
  // Sub-epsilon offsets (e.g. 1e-13 m) are absorbed by the split
  // tolerance itself, so no fragments — and no drops — occur there.
  const { mesh, diagnostics } = sk.generalBooleanDetailed("intersect", box(0, 0, 0, 1, 1, 1), box(1e-9, 0, 0, 1 + 1e-9, 1, 1));
  assert(mesh.faces.length > 0, "result is non-empty");
  const slivers = diagnostics.filter((d) => d.code === "sliver-cell-dropped");
  assert(slivers.length === 1, `expected one aggregated sliver diagnostic, got ${JSON.stringify(diagnostics)}`);
  assert(slivers[0].count >= 1, "sliver count >= 1");
  assert(slivers[0].totalArea2 !== undefined && slivers[0].totalArea2 > 0, "sliver total area recorded");
});

t("generalBooleanDetailed: degenerate input triangles are skipped AND recorded", () => {
  const a = box(0, 0, 0, 1, 1, 1);
  a.faces.push([0, 0, 0]); // degenerate: all three corners the same vertex
  const { mesh, diagnostics } = sk.generalBooleanDetailed("union", a, box(0.5, 0, 0, 1.5, 1, 1));
  near(sk.meshVolume(sk.weldMesh(mesh)), 1.5, 1e-9);
  const degen = diagnostics.filter((d) => d.code === "degenerate-triangle-skipped");
  assert(degen.length >= 1, `expected degenerate-triangle diagnostic, got ${JSON.stringify(diagnostics)}`);
  assert(degen.reduce((n, d) => n + d.count, 0) >= 1, "degenerate count >= 1");
});

// ── 5. poly-boolean fail-closed ─────────────────────────────────────────
t("booleanPoly throws DegenerateInputError on too-few points", () => {
  const e = throwsCode(() => pb.booleanPoly([{ x: 0, y: 0 }, { x: 1, y: 0 }], sq(0, 0, 1, 1), "union"), "degenerate-input");
  assert(e.reason === "too-few-points", `reason = ${e.reason}`);
  assert(e.name === "DegenerateInputError", `name = ${e.name}`);
});

t("booleanPoly throws DegenerateInputError on non-finite coordinates", () => {
  const bad = sq(0, 0, 1, 1);
  bad[1] = { x: NaN, y: 0 };
  throwsCode(() => pb.booleanPoly(bad, sq(2, 0, 3, 1), "union"), "degenerate-input");
});

t("booleanSolid throws DegenerateInputError on non-positive height", () => {
  throwsCode(() => pb.booleanSolid({ ring: sq(0, 0, 1, 1), height: 0 }, { ring: sq(0, 0, 1, 1), height: 1 }, "union"), "degenerate-input");
});

t("booleanPolyDetailed: disjoint intersect is an empty result WITH a diagnostic, not a silent []", () => {
  const { ring, diagnostics } = pb.booleanPolyDetailed(sq(0, 0, 1, 1), sq(5, 5, 6, 6), "intersect");
  assert(ring.length === 0, "disjoint intersect is empty");
  const empty = diagnostics.filter((d) => d.code === "empty-result");
  assert(empty.length === 1, `expected empty-result diagnostic, got ${JSON.stringify(diagnostics)}`);
});

t("booleanPoly: contained square intersects to the exact inner square", () => {
  // NOTE: the partially-overlapping-squares clip is NOT pinned exactly:
  // the lightweight clipper misplaces one crossing vertex on the chain
  // base too (area 0.75 instead of 1 for a 1x1 overlap, verified
  // identical on df959b2) — a pre-existing clipper inaccuracy, out of
  // PE-10 scope. The fully-contained case is exact and is pinned here.
  const ring = pb.booleanPoly(sq(0, 0, 3, 3), sq(1, 1, 2, 2), "intersect");
  assert(ring.length === 4, `intersect ring has ${ring.length} points, expected 4`);
  near(shoelace(ring), 1, 1e-9);
});

t("booleanSolidDetailed: disjoint subtract keeps A and reports no diagnostic", () => {
  const { solid, diagnostics } = pb.booleanSolidDetailed(
    { ring: sq(0, 0, 1, 1), height: 2 },
    { ring: sq(5, 5, 6, 6), height: 2 },
    "subtract",
  );
  assert(solid !== null && solid.height === 2, "disjoint subtract keeps A");
  assert(diagnostics.length === 0, `expected no diagnostics, got ${JSON.stringify(diagnostics)}`);
});

// ── 6. Neighbour: fail-closed profile validation is unchanged ───────────
t("forms.validateProfile still fails closed on an open profile", () => {
  throwsCode(() => sk.validateProfile([{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }]), "open-profile");
});

t("forms.extrude still produces the exact unit-cube volume", () => {
  const ring = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }, { u: 0, v: 0 }];
  near(sk.meshVolume(sk.extrude({ profile: ring, depth: 1 })), 1, 1e-9);
});

console.log(`\n  tolerance-policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
