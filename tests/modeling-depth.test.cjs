/**
 * tests/modeling-depth.test.cjs
 *
 * Modeling & parametric depth pack — closes the gaps flagged in the RVT
 * comparison evaluation:
 *   1. transitive host→child delete cascade (any host type, cycle-safe);
 *   2. vertical (stacked) wall joins across level boundaries;
 *   3. curtain wall depth: mullion profiles, panel types, arc geometry,
 *      corner mullions;
 *   4. sloped floors: per-corner elevations + validation;
 *   5. drift-guards: authoring.ts integration points (arc-length hosting,
 *      cascade wiring) and boot registration stay in place.
 *
 * Run: `node tests/modeling-depth.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function near(a, b, tol = 1e-4) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), got ${a}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the pure module slice ───────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-modeling-depth-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/hosts/cascade.ts" +
  " src/modules/wall-join/vertical-join.ts" +
  " src/modules/curtain-wall/depth.ts" +
  " src/modules/floors/sloped-floor.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const cascade = require(path.join(tmpOut, "modules/hosts/cascade.js"));
const vj = require(path.join(tmpOut, "modules/wall-join/vertical-join.js"));
const cw = require(path.join(tmpOut, "modules/curtain-wall/depth.js"));
const sf = require(path.join(tmpOut, "modules/floors/sloped-floor.js"));

// ════════════════════════════════════════════════════════════════════════════
console.log("\n[1] Transitive host cascade");
// ════════════════════════════════════════════════════════════════════════════

t("wall delete cascades to doors AND windows in one closure", () => {
  const els = [
    { id: "w1", type: "wall" },
    { id: "d1", type: "door", hostId: "w1" },
    { id: "d2", type: "door", hostId: "w1" },
    { id: "win1", type: "window", hostId: "w1" },
    { id: "other", type: "wall" },
  ];
  const r = cascade.collectDeleteCascade(["w1"], els);
  assert(r.dependents.length === 3, `expected 3 dependents, got ${r.dependents.length}`);
  assert(r.seeds.length === 1 && r.seeds[0] === "w1", "seeds must carry the wall");
});

t("cascade is TRANSITIVE (wall → hosted panel → hardware)", () => {
  const els = [
    { id: "wall", type: "wall" },
    { id: "cw", type: "curtain-wall", hostId: "wall" },
    { id: "panel", type: "curtain-panel", hostId: "cw" },
    { id: "lock", type: "hardware", hostId: "panel" },
  ];
  const r = cascade.collectDeleteCascade(["wall"], els);
  assert(r.dependents.length === 3, `expected 3 transitive dependents, got ${r.dependents.length}`);
});

t("cascade works for ANY host type (floor hosts MEP fitting) — old code was wall-only", () => {
  const els = [
    { id: "f1", type: "floor" },
    { id: "drain", type: "fitting", hostId: "f1" },
  ];
  const r = cascade.collectDeleteCascade(["f1"], els);
  assert(r.dependents.length === 1 && r.dependents[0] === "drain", "floor host must cascade");
});

t("cycle-safe: a↔b host loop terminates and deletes the right closure", () => {
  const els = [
    { id: "a", type: "x", hostId: "b" },
    { id: "b", type: "y", hostId: "a" },
    { id: "c", type: "z", hostId: "b" },
  ];
  const r = cascade.collectDeleteCascade(["b"], els);
  assert(r.dependents.length === 2, `expected 2, got ${r.dependents.length}`);
  assert(r.dependents.includes("a") && r.dependents.includes("c"), "both children of b die");
});

t("summary names types and counts", () => {
  const els = [
    { id: "w", type: "wall" },
    { id: "d1", type: "door", hostId: "w" },
    { id: "d2", type: "door", hostId: "w" },
    { id: "win", type: "window", hostId: "w" },
  ];
  const r = cascade.collectDeleteCascade(["w"], els);
  assert(r.summary.includes("2 door") && r.summary.includes("1 window"), `bad summary: ${r.summary}`);
  assert(r.summary.endsWith("dependent element(s) will be deleted"), "summary wording");
});

t("orphan detector finds children with missing hosts", () => {
  const els = [
    { id: "w", type: "wall" },
    { id: "d", type: "door", hostId: "gone" },
  ];
  const o = cascade.findOrphanedHosted(els);
  assert(o.length === 1 && o[0].id === "d" && o[0].hostId === "gone", "orphan not found");
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n[2] Vertical (stacked) wall joins");
// ════════════════════════════════════════════════════════════════════════════

const W = (id, start, end, baseZ, height) => ({ id, start, end, baseZ, height });

t("detects a perfect 2-wall stack across a level boundary", () => {
  const walls = [
    W("l1", [0, 0], [0, 6], 0, 3),
    W("l2", [0, 6], [0, 12], 3, 3),
  ];
  const pairs = vj.detectVerticalStacks(walls);
  assert(pairs.length === 1, `expected 1 pair, got ${pairs.length}`);
  assert(pairs[0].lowerId === "l1" && pairs[0].upperId === "l2", "pair order");
  near(pairs[0].gap, 0, 1e-9);
  assert(pairs[0].collinear, "continuation must be collinear");
});

t("detects a 4-level wall chain (the exact evaluation gap)", () => {
  const walls = [
    W("L1", [0, 0], [0, 6], 0, 3),
    W("L2", [0, 0], [0, 6], 3, 3),
    W("L3", [0, 0], [0, 6], 6, 3),
    W("L4", [0, 0], [0, 6], 9, 3),
  ];
  const pairs = vj.detectVerticalStacks(walls);
  assert(pairs.length === 3, `expected 3 pairs (L1-L2, L2-L3, L3-L4), got ${pairs.length}`);
  const chains = vj.stackChains(pairs);
  assert(chains.length === 1 && chains[0].length === 4, `expected 1 chain of 4, got ${JSON.stringify(chains)}`);
});

t("floating upper wall (gap) is detected and validated", () => {
  const walls = [
    W("l1", [0, 0], [0, 6], 0, 3),
    W("l2", [0, 0], [0, 6], 3.2, 3),
  ];
  const pairs = vj.detectVerticalStacks(walls, { vertTol: 0.3 });
  assert(pairs.length === 1, "pair must be found within loose vertTol");
  const issues = vj.validateStacks(walls, { vertTol: 0.3 });
  assert(issues.some((i) => i.kind === "gap"), `expected gap issue, got ${JSON.stringify(issues)}`);
});

t("folded stack (upper runs opposite) flagged", () => {
  const walls = [
    W("l1", [0, 0], [0, 6], 0, 3),
    W("l2", [0, 6], [0, 0], 3, 3),
  ];
  const issues = vj.validateStacks(walls);
  assert(issues.some((i) => i.kind === "folded"), `expected folded issue, got ${JSON.stringify(issues)}`);
});

t("two walls meeting at an L-corner top are a stack but NOT collinear", () => {
  const walls = [
    W("a", [0, 0], [0, 6], 0, 3),
    W("b", [0, 6], [6, 6], 3, 3),
  ];
  const pairs = vj.detectVerticalStacks(walls);
  assert(pairs.length === 1, "endpoint-touching pair must be found");
  assert(pairs[0].collinear === false, "L-corner is not a collinear continuation");
});

t("walls at different plan positions are NOT stacked", () => {
  const walls = [
    W("a", [0, 0], [0, 6], 0, 3),
    W("b", [10, 10], [10, 16], 3, 3),
  ];
  assert(vj.detectVerticalStacks(walls).length === 0, "no shared endpoint → no stack");
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n[3] Curtain wall depth");
// ════════════════════════════════════════════════════════════════════════════

t("mullion profiles: L/T/I have reduced flange + more legs than rect", () => {
  const rect = cw.mullionProfileDims("rect", 0.06);
  const L = cw.mullionProfileDims("L", 0.06);
  const T = cw.mullionProfileDims("T", 0.06);
  const I = cw.mullionProfileDims("I", 0.06);
  near(rect.legs, 2, 0);
  near(L.legs, 2, 0);
  near(T.legs, 3, 0);
  near(I.legs, 4, 0);
  assert(I.depth > rect.depth, "I-bar must be deeper than rect");
  assert(L.flange < L.width, "L flange thinner than face width");
});

t("panel type grid: default + overrides, out-of-range ignored", () => {
  const grid = cw.resolvePanelTypes(4, 2, "glazed", [
    { col: 1, row: 0, type: "door" },
    { col: 2, row: 1, type: "solid" },
    { col: 9, row: 9, type: "void" }, // out of range
  ]);
  assert(grid[0][1] === "door", "override door");
  assert(grid[1][2] === "solid", "override solid");
  assert(grid[0][0] === "glazed" && grid[1][3] === "glazed", "defaults hold");
  assert(grid.length === 2 && grid[0].length === 4, "grid shape");
});

t("arc math: quarter-circle arc length = r·π/2, points on the circle", () => {
  const arc = { center: [0, 0], radius: 6, startAngle: 0, endAngle: Math.PI / 2 };
  near(cw.arcSpan(arc), Math.PI / 2, 1e-9);
  near(cw.arcLength(arc), 6 * Math.PI / 2, 1e-9);
  const [px, pz] = cw.arcPointAt(arc, 0.5);
  near(px, 6 * Math.cos(Math.PI / 4), 1e-9);
  near(pz, 6 * Math.sin(Math.PI / 4), 1e-9);
  const [tx, tz] = cw.arcTangentAt(arc, 0.5);
  near(tx, -Math.sin(Math.PI / 4), 1e-9);
  near(tz, Math.cos(Math.PI / 4), 1e-9);
});

t("curvedPanelSpecs: panel widths follow TRUE arc length and sum to it", () => {
  const arc = { center: [0, 0], radius: 8, startAngle: 0, endAngle: Math.PI };
  const v = [0, 0.25, 0.5, 0.75, 1];
  const h = [0, 0.5, 1];
  const cells = cw.curvedPanelSpecs(arc, 3.5, v, h);
  assert(cells.length === 4 * 2, `expected 8 cells, got ${cells.length}`);
  const totalW = cells.filter((c) => c.row === 0).reduce((s, c) => s + c.width, 0);
  near(totalW, cw.arcLength(arc), 1e-6);
  // All cell centers sit on the circle
  for (const c of cells) {
    const d = Math.hypot(c.center[0] - arc.center[0], c.center[1] - arc.center[1]);
    near(d, arc.radius, 1e-6);
  }
});

t("curvedMullionSpecs: one transform per grid line, yaws follow the tangent", () => {
  const arc = { center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI / 2 };
  const specs = cw.curvedMullionSpecs(arc, 3.5, [0, 0.5, 1]);
  assert(specs.length === 3, "3 grid lines");
  near(specs[1].position[0], 5 * Math.cos(Math.PI / 4), 1e-9);
});

t("corner mullion: 90° corner → bisector yaw 45° from each wall", () => {
  // Wall A runs +Z ending at (0,6); wall B runs +X starting at (0,6)
  const c = cw.cornerMullionPlacement(
    { end: [0, 6], other: [0, 0] },
    { end: [0, 6], other: [6, 6] },
  );
  near(c.position[0], 0, 1e-9);
  near(c.position[1], 6, 1e-9);
  near(c.interiorAngle, Math.PI / 2, 1e-9);
  // bisector of +Z and +X directions is 45° between them
  const bisAngle = Math.atan2(1, 1); // 45° in plan
  const yawVec = [Math.cos(-c.yaw), -Math.sin(-c.yaw)];
  near(Math.abs(yawVec[0]), Math.abs(Math.cos(bisAngle)), 1e-6);
  near(Math.abs(yawVec[1]), Math.abs(Math.sin(bisAngle)), 1e-6);
});

t("IFC mapping: glazed→IfcPlate, door→IfcDoor, void→IfcOpeningElement, wall→IfcCurtainWall", () => {
  assert(cw.panelIfcEntity("glazed") === "IfcPlate", "glazed");
  assert(cw.panelIfcEntity("solid") === "IfcCovering", "solid");
  assert(cw.panelIfcEntity("door") === "IfcDoor", "door");
  assert(cw.panelIfcEntity("void") === "IfcOpeningElement", "void");
  assert(cw.CURTAIN_WALL_IFC_ENTITY === "IfcCurtainWall", "wall entity");
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n[4] Sloped floors");
// ════════════════════════════════════════════════════════════════════════════

t("2% slope over 10 m gives 0.20 m fall, min at baseElevation", () => {
  const spec = {
    polygon: [[0, 0], [10, 0], [10, 5], [0, 5]],
    thickness: 0.25,
    slopePct: 2,
    directionDeg: 0,
    baseElevation: 4.0,
  };
  const g = sf.slopedFloorGeometry(spec);
  near(g.fall, 0.2, 1e-9);
  near(g.minElevation, 4.0, 1e-9);
  near(g.elevations[0], 4.0, 1e-9);
  near(g.elevations[1], 4.2, 1e-9);
  near(g.elevations[2], 4.2, 1e-9);
  near(g.elevations[3], 4.0, 1e-9);
  near(g.direction[0], 1, 1e-9);
});

t("slope direction 90° falls toward +Z", () => {
  const spec = {
    polygon: [[0, 0], [10, 0], [10, 5], [0, 5]],
    thickness: 0.25,
    slopePct: 2,
    directionDeg: 90,
    baseElevation: 0,
  };
  const g = sf.slopedFloorGeometry(spec);
  near(g.elevations[0], 0, 1e-9);
  near(g.elevations[1], 0, 1e-9); // z=0 edge is the low edge
  near(g.elevations[2], 0.1, 1e-9); // z=5 edge: 5 m × 2% = 0.1
  near(g.elevations[3], 0.1, 1e-9);
});

t("validation catches degenerate polygon, slope range, thin slab", () => {
  const bad = sf.validateSlopedFloor({ polygon: [[0, 0], [1, 1]], thickness: 0.01, slopePct: 40, directionDeg: 0, baseElevation: 0 });
  assert(bad.some((i) => i.kind === "degenerate-polygon"), "polygon");
  assert(bad.some((i) => i.kind === "slope-out-of-range"), "slope");
  assert(bad.some((i) => i.kind === "thickness-too-thin"), "thickness");
  const good = sf.validateSlopedFloor({ polygon: [[0, 0], [4, 0], [4, 3], [0, 3]], thickness: 0.25, slopePct: 2, directionDeg: 0, baseElevation: 0 });
  assert(good.length === 0, `clean spec must validate, got ${JSON.stringify(good)}`);
});

t("bottom elevation is below min top by perpendicular thickness", () => {
  const spec = { polygon: [[0, 0], [10, 0], [10, 5], [0, 5]], thickness: 0.3, slopePct: 2, directionDeg: 0, baseElevation: 4.0 };
  const bottom = sf.slabBottomElevation(spec);
  const g = sf.slopedFloorGeometry(spec);
  const rise = 0.02;
  const cosTheta = 1 / Math.sqrt(1 + rise * rise);
  near(bottom, g.minElevation - 0.3 * cosTheta, 1e-9);
  assert(bottom < g.minElevation, "bottom below top");
});

t("area-weighted average elevation sits between min and max", () => {
  const spec = { polygon: [[0, 0], [10, 0], [10, 5], [0, 5]], thickness: 0.25, slopePct: 2, directionDeg: 0, baseElevation: 4.0 };
  const avg = sf.averageTopElevation(spec);
  const g = sf.slopedFloorGeometry(spec);
  assert(avg > g.minElevation && avg < g.maxElevation, `avg ${avg} must be between ${g.minElevation} and ${g.maxElevation}`);
  near(avg, 4.1, 1e-9); // symmetric rectangle: midpoint of fall
});

// ════════════════════════════════════════════════════════════════════════════
console.log("\n[5] Integration drift-guards");
// ════════════════════════════════════════════════════════════════════════════

const readSrc = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

t("authoring.ts delete path uses the transitive cascade (not the wall-only scan)", () => {
  const src = readSrc("src/features/authoring.ts");
  assert(src.includes('collectDeleteCascade(ids, elements as any)'), "deleteElements must call collectDeleteCascade");
  assert(!/for \(const t of targets\) \{\s*\n\s*if \(t\.type === "wall"\)/.test(src), "old wall-only cascade must be gone");
});

t("authoring.ts hosts openings along the ARC on curved walls", () => {
  const src = readSrc("src/features/authoring.ts");
  assert(src.includes("function wallArcMetrics"), "wallArcMetrics helper exists");
  assert(src.includes("const hostLen = arcM ? arcM.arcLen : L;"), "openingsForWall clamps on arc length");
  assert(src.includes("wallArcMetrics(L, arcH)!"), "hole placement uses arc metrics");
  assert(src.includes("mesh.localToWorld(new THREE.Vector3(lx, ly,"), "arc hole placed via local frame");
});

t("boot registers wall-join, host-cascade and sloped-floors", () => {
  const src = readSrc("src/critical-gaps-boot.ts");
  assert(src.includes("wall-join/setup"), "vertical join boot");
  assert(src.includes("hosts/setup"), "host cascade boot");
  assert(src.includes("floors/setup"), "sloped floors boot");
});

t("curtain-wall.ts exposes the depth API in setup", () => {
  const src = readSrc("src/modules/curtain-wall/curtain-wall.ts");
  assert(src.includes("buildCurvedCurtainWall"), "curved builder");
  assert(src.includes("buildCurtainCorner"), "corner builder");
  assert(src.includes("mullionGeometry"), "profile extrusion");
  const setup = src.slice(src.indexOf("export function setupCurtainWall"));
  assert(setup.length > 0, "setup found");
  assert(setup.includes("buildCurvedCurtainWall") && setup.includes("buildCurtainCorner"), "setup exports depth API");
});

t("package.json + CI manifest dual-register test:modeling-depth", () => {
  const pkg = JSON.parse(readSrc("package.json"));
  assert(pkg.scripts["test:modeling-depth"] === "node tests/modeling-depth.test.cjs", "package.json script");
  const ci = readSrc("scripts/ci-unit-tests.mjs");
  assert(ci.includes('"test:modeling-depth"'), "CI manifest entry");
});

console.log(`\n════════ modeling-depth: ${pass} passed, ${fail} failed ════════`);
process.exit(fail ? 1 : 0);
