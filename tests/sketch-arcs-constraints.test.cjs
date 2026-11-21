/**
 * tests/sketch-arcs-constraints.test.cjs
 *
 * Slice 5 (Revit parity gap 5): sketch arcs, dimension-driven sketch
 * constraints, and reference planes.
 *
 *   - Arc profile kind: `ProfileSpec` gains `{ kind: "arc", r,
 *     startAngle, endAngle }` (angles in degrees, sector / pie slice
 *     centred on the profile origin); both `profileToShape`
 *     implementations build it, and `sketch-core` gains `arcPoints` /
 *     `sectorPoints` / `validateArc` plus an "arc" shape in
 *     `addShapeToFamily` (radius + start/end angles become sketch
 *     parameters, so the sector reshapes when they change).
 *   - Sketch constraints: `validateSketchConstraints` /
 *     `solveSketchDimensions` run a constraint set over a family's
 *     sketch parameters through the family constraint graph; the
 *     solved values feed `buildParametricFamily` (whose options
 *     already solve constraints after formulas), so a driven sketch
 *     dimension follows its driver.
 *   - Reference planes: named datum lines (`plane_<id>` offsets) that
 *     constraints can solve against — e.g. a `symmetric` constraint
 *     mirroring two sketch dimensions about a centreline.
 *
 * Tests (fast-check properties use fixed seeds, printed on run):
 *   P1. Property: random arc radius / angles — sector area is
 *       ½·r²·sweep, arc points lie on the circle, the sector outline
 *       validates.
 *   P2. Property: invalid arcs (non-positive radius, sweep <= 0 or
 *       > 360°) are rejected.
 *   T3. An arc sector sketched into a family builds real geometry:
 *       bounding box follows the sector, and changing the radius /
 *       end-angle parameters rebuilds it.
 *   T4. Dimension-driven: a ratio constraint drives sketchWidth from
 *       sketchLength, proven by the solved values and by the rebuilt
 *       bounding box; unknown parameters and cycles are reported.
 *   T5. Reference planes: a symmetric constraint mirrors two sketch
 *       dimensions about a centreline plane, and moving the plane
 *       re-solves them; the mirror helper is an involution (property).
 *
 * Run: `node tests/sketch-arcs-constraints.test.cjs`
 * CI:  `test:sketch-arcs-constraints` (package.json +
 *       scripts/ci-unit-tests.mjs).
 *
 * The modules under test are compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-type-propagation.test.cjs), so `three` resolves from
 * the repo's node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const fc = require("fast-check");
const THREE = require("three");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
const near = (a, b, tolOrMsg = 1e-6, msg) => {
  const tol = typeof tolOrMsg === "number" ? tolOrMsg : 1e-6;
  const label = typeof tolOrMsg === "string" ? tolOrMsg : msg;
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})${label ? ": " + label : ""}`);
};

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".sketch-arcs-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/families/sketch-core.ts src/modules/families/constraint-graph.ts src/modules/families/parametric-engine.ts"
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
const S = require(find("sketch-core.js"));
const E = require(find("parametric-engine.js"));

const SEEDS = [1, 7, 42, 1337, 20261121];
console.log(`  fast-check seeds: ${SEEDS.join(", ")} (25 runs each)`);

const boxOf = (obj) => {
  const box = new THREE.Box3().setFromObject(obj);
  return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
};
const sizeOf = (box) => [box[3] - box[0], box[4] - box[1], box[5] - box[2]];

// ── P1. Arc properties ──────────────────────────────────────────────────────
t("P1 random arcs: sector area, points on the circle, outline validates", () => {
  fc.assert(fc.property(
    fc.double({ min: 0.1, max: 5, noNaN: true }),
    fc.double({ min: 0, max: 350, noNaN: true }),
    fc.double({ min: 10, max: 360, noNaN: true }),
    (r, start, sweep) => {
      const end = start + sweep;
      const v = S.validateArc(0, 0, r, start, end);
      if (!v.ok) throw new Error(`valid arc rejected: ${v.errors.join("; ")}`);
      near(v.area, 0.5 * r * r * (sweep * Math.PI / 180), 1e-9, "sector area");
      near(v.sweepDeg, sweep, 1e-9, "sweep");
      for (const [x, y] of S.arcPoints(0, 0, r, start, end, 24)) {
        near(Math.hypot(x, y), r, 1e-9, "arc point on the circle");
      }
      const outline = S.validateSketch(v.points);
      if (!outline.ok) throw new Error(`sector outline invalid: ${outline.errors.join("; ")}`);
      // The outline is a polyline approximation: its exact area is the
      // fan of n triangles, (n/2)·r²·sin(Δ), Δ = sweep/n — slightly
      // less than the true sector area by the chord error.
      const nSeg = 48, dRad = (sweep * Math.PI / 180) / nSeg;
      near(outline.area, (nSeg / 2) * r * r * Math.sin(dRad), 1e-9, "outline area matches the fan-triangle area");
    },
  ), { seed: SEEDS[2], numRuns: 25 });
});

// ── P2. Invalid arcs ────────────────────────────────────────────────────────
t("P2 invalid arcs are rejected", () => {
  fc.assert(fc.property(
    fc.oneof(
      fc.record({ r: fc.double({ min: -5, max: 0, noNaN: true }), start: fc.constant(0), end: fc.constant(90) }),
      fc.record({ r: fc.constant(1), start: fc.constant(90), end: fc.constant(90) }),
      fc.record({ r: fc.constant(1), start: fc.constant(90), end: fc.constant(30) }),
      fc.record({ r: fc.constant(1), start: fc.constant(0), end: fc.constant(361) }),
    ),
    ({ r, start, end }) => {
      if (S.validateArc(0, 0, r, start, end).ok) {
        throw new Error(`invalid arc accepted: r=${r} start=${start} end=${end}`);
      }
    },
  ), { seed: SEEDS[0], numRuns: 25 });
  if (S.validateArc(0, 0, 1, 0, 360).ok !== true) throw new Error("a full 360-degree sector must be valid");
  if (S.addShapeToFamily(
    { id: "f", name: "F", category: "generic", ifcEntity: "IfcBuildingElementProxy", schemaVersion: 1, parameters: [], geometry: { kind: "custom", builder: "" }, types: [], builtIn: false },
    { kind: "arc", cx: 0, cy: 0, radius: -1, startAngle: 0, endAngle: 90 },
    { depth: 0.5 },
  ).ok) throw new Error("negative-radius arc shape must be refused");
});

// ── T3. Arc sector builds real geometry ─────────────────────────────────────
t("T3 arc sector sketched into a family builds geometry that follows its parameters", () => {
  const r = S.newFamilyFromSketch({
    id: "u.arc", name: "Arc Plinth",
    shape: { kind: "arc", cx: 0, cy: 0, radius: 2, startAngle: 0, endAngle: 90 },
    depth: 0.5,
  });
  if (!r.ok) throw new Error(`arc family build failed: ${r.errors.join("; ")}`);
  if (r.family.geometry.profile.kind !== "arc") throw new Error("extrusion profile is not an arc");
  if (!r.sizeParams.includes("sketchRadius") || !r.sizeParams.includes("sketchEndAngle")) {
    throw new Error(`arc size params missing: ${r.sizeParams.join(", ")}`);
  }
  near(r.area, 0.5 * 4 * (Math.PI / 2), 1e-9, "sector area reported by the sketch");

  const type = r.family.types[0];
  const build = (overrides) => {
    const b = E.buildParametricFamily(r.family, type, { overrides });
    if (!b.object) throw new Error(`build produced no object (errors: ${b.errors.join("; ")})`);
    if (b.errors.length) throw new Error(`build errors: ${b.errors.join("; ")}`);
    return b;
  };
  const box = boxOf(build().object);
  const size = sizeOf(box);
  near(size[0], 2, 1e-6, "90-degree sector spans the radius in X");
  near(size[2], 2, 1e-6, "90-degree sector spans the radius in Z");
  near(size[1], 0.5, 1e-6, "extrusion depth is the Y size");
  near(box[1], 0, 1e-6, "base sits at elevation 0");

  const bigger = boxOf(build({ sketchRadius: 3 }).object);
  near(sizeOf(bigger)[0], 3, 1e-6, "radius parameter rebuilds the sector in X");
  near(sizeOf(bigger)[2], 3, 1e-6, "radius parameter rebuilds the sector in Z");

  const half = boxOf(build({ sketchEndAngle: 180 }).object);
  near(sizeOf(half)[0], 4, 1e-6, "180-degree sector spans the diameter in X");
  near(sizeOf(half)[2], 2, 1e-6, "180-degree sector spans the radius in Z");
});

// ── T4. Dimension-driven sketch constraints ─────────────────────────────────
t("T4 a ratio constraint drives a sketch dimension; bad constraints are reported", () => {
  const r = S.newFamilyFromSketch({
    id: "u.rect", name: "Driven Rect",
    shape: { kind: "rect", cx: 0, cy: 0, width: 1, length: 2 },
    depth: 0.5,
  });
  if (!r.ok) throw new Error(`rect family build failed: ${r.errors.join("; ")}`);
  const family = r.family;
  const set = { constraints: [{ kind: "ratio", a: "sketchWidth", b: "sketchLength", k: 2 }] };
  const bad = S.validateSketchConstraints(family, set);
  if (bad.length) throw new Error(`valid constraint set rejected: ${bad.join("; ")}`);
  const solved = S.solveSketchDimensions(family, set, { sketchLength: 2 });
  if (solved.errors.length) throw new Error(`solve errors: ${solved.errors.join("; ")}`);
  near(solved.values.sketchWidth, 4, 1e-9, "width driven to twice the length");

  // The engine path: the same constraints solved at build time.
  const built = E.buildParametricFamily(family, family.types[0], { constraints: set.constraints });
  if (built.errors.length) throw new Error(`build errors: ${built.errors.join("; ")}`);
  near(built.params.sketchWidth, 4, 1e-9, "built width follows the constraint");
  near(sizeOf(boxOf(built.object))[0], 4, 1e-6, "rebuilt box follows the driven width");

  const unknown = S.validateSketchConstraints(family, { constraints: [{ kind: "ratio", a: "sketchWidth", b: "nope", k: 2 }] });
  if (!unknown.some((e) => /unknown parameter 'nope'/.test(e))) throw new Error("unknown parameter not reported");
  const cyclic = S.solveSketchDimensions(family, { constraints: [
    { kind: "ratio", a: "sketchWidth", b: "sketchLength", k: 2 },
    { kind: "ratio", a: "sketchLength", b: "sketchWidth", k: 2 },
  ] });
  if (!cyclic.errors.some((e) => /cyclic/.test(e))) throw new Error("cyclic constraints not reported");
});

// ── T5. Reference planes ────────────────────────────────────────────────────
t("T5 a symmetric constraint mirrors sketch dimensions about a centreline plane", () => {
  const family = {
    id: "f", name: "F", category: "generic", ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1, builtIn: false,
    parameters: [
      { name: "xLeft", type: "length", scope: "type", default: -1, editable: true },
      { name: "xRight", type: "length", scope: "type", default: 1, editable: true },
    ],
    geometry: { kind: "box", w: { const: 1 }, d: { const: 1 }, h: { const: 1 } },
    types: [{ id: "t", name: "T", values: {} }],
  };
  const centreline = { id: "centreline", name: "Centreline", axis: "x", offset: 0 };
  if (S.validateReferencePlane(centreline).length) throw new Error("valid plane rejected");
  if (S.validateReferencePlane({ id: "bad id", name: "X", axis: "x", offset: 0 }).length === 0) {
    throw new Error("plane id with a space must be rejected");
  }
  const set = {
    constraints: [{ kind: "symmetric", a: "xLeft", b: "xRight", center: "plane_centreline" }],
    referencePlanes: [centreline],
  };
  const bad = S.validateSketchConstraints(family, set);
  if (bad.length) throw new Error(`plane constraint set rejected: ${bad.join("; ")}`);
  const solved = S.solveSketchDimensions(family, set, { xRight: 1.5 });
  if (solved.errors.length) throw new Error(`solve errors: ${solved.errors.join("; ")}`);
  near(solved.values.xLeft, -1.5, 1e-9, "left mirrors right about the centreline at 0");

  // Moving the plane re-solves both sides.
  const moved = S.solveSketchDimensions(family, {
    constraints: [{ kind: "symmetric", a: "xLeft", b: "xRight", center: "plane_centreline" }],
    referencePlanes: [{ ...centreline, offset: 1 }],
  }, { xRight: 1.5 });
  near(moved.values.xLeft, 0.5, 1e-9, "left mirrors right about the moved centreline at 1");

  // Mirror helper property: mirroring twice is the identity, and the
  // distance to the plane is preserved.
  fc.assert(fc.property(
    fc.double({ min: -10, max: 10, noNaN: true }),
    fc.double({ min: -10, max: 10, noNaN: true }),
    fc.double({ min: -5, max: 5, noNaN: true }),
    fc.constantFrom("x", "y"),
    (x, y, offset, axis) => {
      const plane = { id: "p", name: "P", axis, offset };
      const p = [x, y];
      const twice = S.mirrorPointAcrossPlane(S.mirrorPointAcrossPlane(p, plane), plane);
      near(twice[0], p[0], 1e-9, "mirror involution x");
      near(twice[1], p[1], 1e-9, "mirror involution y");
      near(S.distanceToPlane(S.mirrorPointAcrossPlane(p, plane), plane), S.distanceToPlane(p, plane), 1e-9, "distance preserved");
    },
  ), { seed: SEEDS[3], numRuns: 25 });
});

console.log(`\nsketch-arcs-constraints: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
