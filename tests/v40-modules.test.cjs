/**
 * tests/v40-modules.test.cjs
 *
 * Unit tests for v40 modules: ramps, trusses, toposurface, scope-box,
 * view-filters, plan-region, dependent-views, daylighting,
 * structural-loads-ui, model-checker, generative-design.
 *
 * Compile strategy: write a minimal tsconfig that includes only the pure
 * module .ts files (no DOM/three.js deps). Strip three.js imports via a
 * virtual stub.
 *
 * Run: `node tests/v40-modules.test.cjs`
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

function near(a, b, tol = 0.001) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const repoRoot = path.resolve(__dirname, "..");
const tmpOut = path.join(os.tmpdir(), "obs-v40-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });

// Stub three.js so the modules load without bundling.
// Write directly into node_modules/three-stub so it gets resolved by Node naturally.
const stubDir = path.join(repoRoot, "node_modules", "three-stub");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({
  name: "three-stub",
  version: "0.0.1",
  main: "index.js",
  type: "commonjs",
}));
fs.writeFileSync(path.join(stubDir, "index.js"), `
// Minimal stub to satisfy TS compilation of v40 modules.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  applyMatrix4(m) { return this; }
  toArray() { return [this.x, this.y, this.z]; }
}
class Euler {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
class Rotation {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this._euler = new Euler(); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this._index = null; }
  setAttribute(name, attr) { this.attributes[name] = attr; return this; }
  setIndex(idx) { this._index = idx; return this; }
  computeVertexNormals() {}
  getAttribute(name) { return this.attributes[name]; }
}
class Float32BufferAttribute extends Float32Array {
  constructor(arr, n) { super(arr); this.itemSize = n; this.array = arr; this.count = arr.length / n; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
}
class BufferAttribute extends Float32Array {
  constructor(arr, n) { super(arr); this.itemSize = n; this.array = arr; this.count = arr.length / n; }
  getX(i) { return this.array[i * this.itemSize]; }
  getY(i) { return this.array[i * this.itemSize + 1]; }
  getZ(i) { return this.array[i * this.itemSize + 2]; }
}
class MeshLambertMaterial { constructor() { this.color = 0; } }
class MeshBasicMaterial { constructor() { this.color = 0; } }
class LineBasicMaterial { constructor() { this.color = 0; } }
class PointsMaterial { constructor() {} }
class TextureLoader { load() { return {}; } }
class Mesh {
  constructor() {
    this.position = new Vector3();
    this.rotation = new Rotation();
    this.material = {};
    this.userData = {};
    this.geometry = new BufferGeometry();
  }
  lookAt(v) { return this; }
  rotateZ(a) { return this; }
  rotateX(a) { return this; }
  rotateY(a) { return this; }
}
class Line { constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; this.position = new Vector3(); this.rotation = new Rotation(); } }
class Points {
  constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; this.position = new Vector3(); }
}
class Group {
  constructor() {
    this.children = [];
    this.position = new Vector3();
    this.rotation = new Rotation();
    this.userData = {};
    this.add = (c) => this.children.push(c);
  }
}
class BoxGeometry { constructor() { this.parameters = {}; } }
class CylinderGeometry { constructor() {} }
class SphereGeometry { constructor() {} }
class TorusGeometry { constructor() {} }
class PlaneGeometry { constructor() {} }
class IcosahedronGeometry { constructor() {} }
class InstancedMesh {
  constructor(g, m, n) { this.count = n; this.setMatrixAt = () => {}; this.instanceMatrix = { needsUpdate: false }; this.userData = {}; }
}
class Quaternion { setFromEuler() { return this; } }
class Matrix4 { compose() { return this; } }
class Box3 {
  setFromObject() { return this; }
  getSize(v) { v.x = 1; v.y = 1; v.z = 1; return v; }
}
class Color { constructor() {} }
module.exports = {
  Vector3, Euler, BufferGeometry, Float32BufferAttribute, BufferAttribute,
  MeshLambertMaterial, MeshBasicMaterial, LineBasicMaterial, PointsMaterial, TextureLoader,
  Mesh, Line, Points, Group,
  BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, PlaneGeometry,
  IcosahedronGeometry, InstancedMesh, Quaternion, Euler, Matrix4, Box3, Color,
  DoubleSide: 1, SRGBColorSpace: 1,
};
`);

// tsconfig for v40 modules — uses Node module resolution to pick up three stub via paths.
const tsconfigPath = path.join(tmpOut, "tsconfig-v40.json");
fs.writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "commonjs",
    moduleResolution: "node",
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    outDir: tmpOut,
    rootDir: path.join(repoRoot, "src"),
    paths: { "three": ["../node_modules/three-stub/index.js"] },
    baseUrl: ".",
  },
  include: [
    path.join(repoRoot, "src/modules/toposurface/toposurface.ts"),
    path.join(repoRoot, "src/modules/building-pad/building-pad.ts"),
    path.join(repoRoot, "src/modules/property-line/property-line.ts"),
    path.join(repoRoot, "src/modules/site-components/site-components.ts"),
    path.join(repoRoot, "src/modules/ramps/ramps.ts"),
    path.join(repoRoot, "src/modules/trusses/trusses.ts"),
    path.join(repoRoot, "src/modules/structural-connections/structural-connections.ts"),
    path.join(repoRoot, "src/modules/fabrication-parts/fabrication-parts.ts"),
    path.join(repoRoot, "src/modules/scope-box/scope-box.ts"),
    path.join(repoRoot, "src/modules/view-filters/view-filters.ts"),
    path.join(repoRoot, "src/modules/matchline/matchline.ts"),
    path.join(repoRoot, "src/modules/plan-region/plan-region.ts"),
    path.join(repoRoot, "src/modules/dependent-views/dependent-views.ts"),
    path.join(repoRoot, "src/modules/model-checker/model-checker.ts"),
    path.join(repoRoot, "src/modules/daylighting/daylighting.ts"),
    path.join(repoRoot, "src/modules/structural-loads-ui/structural-loads-ui.ts"),
    path.join(repoRoot, "src/modules/generative-design/generative-design.ts"),
    path.join(repoRoot, "src/modules/worksets/worksets.ts"),
  ],
}, null, 2));

try {
  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  console.error("TS compilation failed:");
  console.error(e.stderr?.toString() || e.message);
  process.exit(1);
}

// Override module resolution so 'three' resolves to our stub.
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "three") return path.join(repoRoot, "node_modules/three-stub/index.js");
  return origResolve.call(this, req, parent, ...rest);
};

const toposurface = require(path.join(tmpOut, "modules/toposurface/toposurface.js"));
const buildingPad = require(path.join(tmpOut, "modules/building-pad/building-pad.js"));
const propertyLine = require(path.join(tmpOut, "modules/property-line/property-line.js"));
const siteComponents = require(path.join(tmpOut, "modules/site-components/site-components.js"));
const ramps = require(path.join(tmpOut, "modules/ramps/ramps.js"));
const trusses = require(path.join(tmpOut, "modules/trusses/trusses.js"));
const structuralConnections = require(path.join(tmpOut, "modules/structural-connections/structural-connections.js"));
const fabricationParts = require(path.join(tmpOut, "modules/fabrication-parts/fabrication-parts.js"));
const scopeBox = require(path.join(tmpOut, "modules/scope-box/scope-box.js"));
const viewFilters = require(path.join(tmpOut, "modules/view-filters/view-filters.js"));
const matchline = require(path.join(tmpOut, "modules/matchline/matchline.js"));
const planRegion = require(path.join(tmpOut, "modules/plan-region/plan-region.js"));
const dependentViews = require(path.join(tmpOut, "modules/dependent-views/dependent-views.js"));
const modelChecker = require(path.join(tmpOut, "modules/model-checker/model-checker.js"));
const daylighting = require(path.join(tmpOut, "modules/daylighting/daylighting.js"));
const structuralLoads = require(path.join(tmpOut, "modules/structural-loads-ui/structural-loads-ui.js"));
const generativeDesign = require(path.join(tmpOut, "modules/generative-design/generative-design.js"));
const worksets = require(path.join(tmpOut, "modules/worksets/worksets.js"));

console.log("\n=== v40 modules tests ===\n");

// ─── Toposurface ──────────────────────────────────────────────────────────
console.log("Toposurface:");
t("builds TIN from 3 points (1 triangle)", () => {
  const r = toposurface.buildToposurface({
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
      { x: 0, y: 0, z: 4 },
    ],
  });
  assert(r.triangleCount === 1, `expected 1 triangle, got ${r.triangleCount}`);
  near(r.area, 8, 0.01); // 0.5 * 4 * 4
  near(r.minElevation, 0, 0.001);
  near(r.maxElevation, 0, 0.001);
});

t("builds TIN from 4 coplanar points (2 triangles)", () => {
  const r = toposurface.buildToposurface({
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 1, z: 0 },
      { x: 4, y: 1, z: 4 },
      { x: 0, y: 0, z: 4 },
    ],
  });
  assert(r.triangleCount === 2, `expected 2 triangles, got ${r.triangleCount}`);
  near(r.area, 16, 0.01); // 4x4 square
  near(r.minElevation, 0, 0.001);
  near(r.maxElevation, 1, 0.001);
});

t("boundary clipping drops outside triangles", () => {
  const r = toposurface.buildToposurface({
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 0, y: 0, z: 10 },
      { x: 10, y: 0, z: 10 },
    ],
    boundary: [{ x: 1, z: 1 }, { x: 4, z: 1 }, { x: 4, z: 4 }, { x: 1, z: 4 }],
  });
  assert(r.triangleCount < 2, `clipping should drop triangles; got ${r.triangleCount}`);
});

t("cutFillVolume positive when proposed higher than existing", () => {
  const existing = toposurface.buildToposurface({
    points: [
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
      { x: 0, y: 0, z: 10 }, { x: 10, y: 0, z: 10 },
    ],
  });
  const proposed = toposurface.buildToposurface({
    points: [
      { x: 0, y: 2, z: 0 }, { x: 10, y: 2, z: 0 },
      { x: 0, y: 2, z: 10 }, { x: 10, y: 2, z: 10 },
    ],
  });
  const cf = toposurface.cutFillVolume(existing, proposed);
  assert(cf > 0, "expected positive fill when proposed is higher");
});

// ─── Property Line ─────────────────────────────────────────────────────────
console.log("\nProperty Line:");
t("30×20 m rectangular property line closes correctly", () => {
  const r = propertyLine.buildPropertyLine({
    origin: { x: 0, z: 0 },
    segments: [
      { bearing: 90, distance: 30 },
      { bearing: 180, distance: 20 },
      { bearing: 270, distance: 30 },
      { bearing: 0, distance: 20 },
    ],
  });
  near(r.closureError, 0, 0.001);
  near(r.perimeter, 100, 0.001); // 30+20+30+20
  near(r.area, 600, 0.001); // 30 * 20
  assert(r.metes.length === 4, `expected 4 metes, got ${r.metes.length}`);
});

// ─── Site Components ────────────────────────────────────────────────────────
console.log("\nSite Components:");
t("parking component builds with default size", () => {
  const r = siteComponents.buildSiteComponent({
    type: "parking",
    position: { x: 0, z: 0 },
    elevation: 0,
  });
  assert(r.type === "parking");
  assert(r.object, "object should be defined");
});

t("default size lookup works for all types", () => {
  const types = ["parking", "tree", "shrub", "bench", "lightpole", "firehydrant", "dumpster"];
  for (const ty of types) {
    const s = siteComponents.defaultSize(ty);
    assert(s > 0, `default size for ${ty} should be positive`);
  }
});

// ─── Ramps ─────────────────────────────────────────────────────────────────
console.log("\nRamps:");
t("ramp with 1m rise + 12m run → 8.33% slope", () => {
  const r = ramps.buildRamp({ rise: 1, run: 12, width: 1.5 });
  near(r.slopePercent, 100 / 12, 0.01); // ~8.33%
  assert(r.area > 0, "area should be positive");
});

t("ramp with slopePercent overrides run", () => {
  const r = ramps.buildRamp({ rise: 1.5, width: 1.5, slopePercent: 10 });
  near(r.slopePercent, 10, 0.01);
  // run = rise / (slopePercent/100) = 1.5 / 0.10 = 15
  near(r.actualRun, 15, 0.01);
});

t("ramp with landing produces valid geometry", () => {
  const r = ramps.buildRamp({
    rise: 2, run: 12, width: 1.5, landing: { length: 1.5 },
  });
  assert(r.area > 0, "area should be positive with landing");
});

// ─── Trusses ───────────────────────────────────────────────────────────────
console.log("\nTrusses:");
t("Pratt truss with 6 panels has expected members", () => {
  const r = trusses.buildTruss({ type: "pratt", span: 12, depth: 2, panelCount: 6 });
  // 2 top chord + 1 bottom chord + verticals + diagonals
  assert(r.members.length >= 3, `expected ≥3 members, got ${r.members.length}`);
  near(r.panelLength, 2, 0.001); // 12/6
  assert(r.totalSteelLength > 0, "total steel length should be positive");
});

t("Warren truss has fewer verticals than Pratt", () => {
  const pratt = trusses.buildTruss({ type: "pratt", span: 12, depth: 2, panelCount: 6 });
  const warren = trusses.buildTruss({ type: "warren", span: 12, depth: 2, panelCount: 6 });
  const prattVerts = pratt.members.filter((m) => m.kind === "web-vertical").length;
  const warrenVerts = warren.members.filter((m) => m.kind === "web-vertical").length;
  assert(warrenVerts < prattVerts, `Warren (${warrenVerts}) should have fewer verticals than Pratt (${prattVerts})`);
});

t("Fink truss has diagonals from supports to ridge", () => {
  const r = trusses.buildTruss({ type: "fink", span: 12, depth: 2, panelCount: 6 });
  const diag = r.members.filter((m) => m.kind === "web-diagonal").length;
  assert(diag >= 2, `Fink should have ≥2 diagonals, got ${diag}`);
});

// ─── Structural Connections ─────────────────────────────────────────────────
console.log("\nStructural Connections:");
t("moment flange-plate connection has 2 plates + 8 bolts", () => {
  const r = structuralConnections.buildStructuralConnection({
    type: "moment-flange-plate",
    columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4,
  });
  assert(r.plateCount === 2, `expected 2 plates, got ${r.plateCount}`);
  assert(r.boltCount === 8, `expected 8 bolts, got ${r.boltCount}`);
});

t("base-plate connection has 4 anchor bolts", () => {
  const r = structuralConnections.buildStructuralConnection({
    type: "base-plate", columnSize: 0.2, beamSize: 0.2,
  });
  assert(r.boltCount === 4, `expected 4 bolts, got ${r.boltCount}`);
});

t("splice-plate connection has 4 plates", () => {
  const r = structuralConnections.buildStructuralConnection({
    type: "splice-plate", columnSize: 0.2, beamSize: 0.2,
  });
  assert(r.plateCount === 4, `expected 4 plates, got ${r.plateCount}`);
});

// ─── Fabrication Parts ─────────────────────────────────────────────────────
console.log("\nFabrication Parts:");
t("duct-straight has SMACNA code + positive weight", () => {
  const r = fabricationParts.buildFabricationPart({
    type: "duct-straight", primarySize: 0.4, length: 1.5,
  });
  assert(r.astmCode.startsWith("SMACNA"), `expected SMACNA code, got ${r.astmCode}`);
  assert(r.weightKg > 0, "weight should be positive");
});

t("pipe-valve has ASTM F532 code", () => {
  const r = fabricationParts.buildFabricationPart({
    type: "pipe-valve", primarySize: 0.05,
  });
  assert(r.astmCode.startsWith("ASTM-F532"), `expected ASTM-F532, got ${r.astmCode}`);
});

// ─── Scope Box ──────────────────────────────────────────────────────────────
console.log("\nScope Box:");
t("create + apply to view + check point inside", () => {
  scopeBox.resetScopeBoxes();
  const sb = scopeBox.createScopeBox({
    name: "Building A",
    min: { x: 0, y: 0, z: 0 },
    max: { x: 10, y: 4, z: 10 },
  });
  assert(sb.id, "scope box should have an id");
  scopeBox.applyToView(sb.id, "view-1");
  assert(sb.appliedToViews.includes("view-1"));
  assert(scopeBox.pointInScope(sb, 5, 2, 5), "interior point should be in scope");
  assert(!scopeBox.pointInScope(sb, 11, 2, 5), "exterior point should NOT be in scope");
});

t("bbox intersection logic correct", () => {
  const sb = scopeBox.createScopeBox({
    min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 },
  });
  assert(scopeBox.bboxIntersectsScope(sb, { x: 4, y: 4, z: 4 }, { x: 6, y: 6, z: 6 }));
  assert(!scopeBox.bboxIntersectsScope(sb, { x: 6, y: 6, z: 6 }, { x: 8, y: 8, z: 8 }));
});

// ─── View Filters ──────────────────────────────────────────────────────────
console.log("\nView Filters:");
t("filter matches by category + parameter rule", () => {
  viewFilters.resetViewFilters();
  const vf = viewFilters.createViewFilter({
    name: "Fire-rated Walls",
    categories: ["walls"],
    rules: [{ parameter: "FireRating", operator: "not-equals", value: "0" }],
    overrides: { projectionColor: 0xff0000, cutColor: 0xff0000, lineWeight: 4, surfacePattern: null, cutPattern: null, transparency: 0, halftone: false, visible: true },
  });
  assert(viewFilters.matchesFilter(vf, "walls", { FireRating: "60" }));
  assert(!viewFilters.matchesFilter(vf, "doors", { FireRating: "60" }), "category mismatch should not match");
  assert(!viewFilters.matchesFilter(vf, "walls", { FireRating: "0" }), "rule 'not-equals 0' should reject value '0'");
});

t("filter resolves overrides in view", () => {
  viewFilters.resetViewFilters();
  const vf = viewFilters.createViewFilter({
    name: "All Walls",
    categories: ["walls"],
    rules: [],
    overrides: { projectionColor: 0x00ff00, cutColor: 0x00ff00, lineWeight: 2, surfacePattern: null, cutPattern: null, transparency: 0, halftone: true, visible: true },
  });
  viewFilters.addFilterToView("view-1", vf.id);
  const ov = viewFilters.resolveOverride("view-1", "walls", {});
  assert(ov !== null, "expected override");
  assert(ov.halftone === true, "expected halftone=true");
});

// ─── Plan Region ───────────────────────────────────────────────────────────
console.log("\nPlan Region:");
t("plan region overrides cut plane inside outline", () => {
  const pr = planRegion.buildPlanRegion({
    outline: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }],
    viewCutPlane: 1.0,
    regionCutPlane: 1.8,
  });
  assert(pr.cutPlaneDelta > 0, "cut plane delta should be positive");
  assert(planRegion.pointInRegion(pr.region, 2, 2), "interior point should be in region");
  assert(!planRegion.pointInRegion(pr.region, 6, 6), "exterior point should NOT be in region");
});

t("resolveCutPlane uses region cut when inside, default when outside", () => {
  const region = {
    outline: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }],
    viewCutPlane: 1.0, regionCutPlane: 2.0,
  };
  assert(planRegion.resolveCutPlane([region], 2, 2, 1.0) === 2.0);
  assert(planRegion.resolveCutPlane([region], 10, 10, 1.0) === 1.0);
});

// ─── Dependent Views ───────────────────────────────────────────────────────
console.log("\nDependent Views:");
t("create dependent view from primary", () => {
  dependentViews.resetDependentViews();
  const dv = dependentViews.createDependentView("primary-1", { name: "Dep 1" });
  assert(dv.primaryId === "primary-1");
  const list = dependentViews.listDependents("primary-1");
  assert(list.length === 1, `expected 1 dependent, got ${list.length}`);
});

t("update crop region mutates the dependent", () => {
  dependentViews.resetDependentViews();
  const dv = dependentViews.createDependentView("primary-1", {});
  dependentViews.updateCropRegion(dv.id, { minX: 5, maxX: 10 });
  const updated = dependentViews.getDependentView(dv.id);
  assert(updated.cropRegion.minX === 5);
  assert(updated.cropRegion.maxX === 10);
});

// ─── Model Checker ─────────────────────────────────────────────────────────
console.log("\nModel Checker:");
t("detects duplicate elements", () => {
  const elements = [
    { expressId: 1, type: "IfcWall", bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
    { expressId: 2, type: "IfcWall", bbox: { min: [0, 0, 0], max: [1, 1, 1] } },
    { expressId: 3, type: "IfcWall", bbox: { min: [5, 0, 0], max: [6, 1, 1] } },
  ];
  const report = modelChecker.runModelChecker(elements);
  const dupResults = report.results.filter((r) => r.ruleId === "duplicate-elements");
  assert(dupResults.length >= 1, "should detect at least 1 duplicate");
  assert(report.summary.warnings >= 1, "should have ≥1 warning");
});

t("flags unhosted doors", () => {
  const elements = [
    { expressId: 1, type: "IfcDoor" }, // unhosted
    { expressId: 2, type: "IfcDoor", hostId: 100 },
  ];
  const report = modelChecker.runModelChecker(elements);
  const unhosted = report.results.find((r) => r.ruleId === "unhosted-doors");
  assert(unhosted, "should flag unhosted door");
  assert(unhosted.elementIds.includes(1), "should include element 1");
});

// ─── Daylighting ────────────────────────────────────────────────────────────
console.log("\nDaylighting:");
t("well-glazed room achieves DF ≥ 2%", () => {
  const r = daylighting.runDaylightAnalysis({
    room: { width: 6, depth: 4, height: 3 },
    windowArea: 6,
    visibleTransmittance: 0.7,
    reflectances: { ceiling: 0.8, walls: 0.5, floor: 0.2 },
    workplaneHeight: 0.8,
    gridResolution: 0.5,
    exteriorIlluminance: 10000,
  });
  assert(r.points.length > 0, "should produce grid points");
  assert(r.averageDF >= 0, "average DF should be ≥0");
});

t("classifyDF buckets correctly", () => {
  assert(daylighting.classifyDF(0.5) === "insufficient");
  assert(daylighting.classifyDF(1.5) === "adequate");
  assert(daylighting.classifyDF(3) === "good");
  assert(daylighting.classifyDF(7) === "excellent");
});

// ─── Structural Loads ───────────────────────────────────────────────────────
console.log("\nStructural Loads:");
t("create load case + LRFD combinations", () => {
  structuralLoads.resetLoadCases();
  structuralLoads.createLoadCase({ name: "Dead", category: "dead", magnitude: 24 });
  structuralLoads.createLoadCase({ name: "Live", category: "live", magnitude: 2.5 });
  const combos = structuralLoads.generateDefaultLRFDCombinations();
  assert(combos.length >= 2, `expected ≥2 combos, got ${combos.length}`);
});

t("resolveCombination applies factors", () => {
  structuralLoads.resetLoadCases();
  const dl = structuralLoads.createLoadCase({ name: "Dead", category: "dead", magnitude: 10 });
  const comb = structuralLoads.createLoadCombination({
    name: "1.4D", designMethod: "LRFD", cases: [{ caseId: dl.id, factor: 1.4 }],
  });
  const resolved = structuralLoads.resolveCombination(comb.id);
  assert(resolved.length === 1);
  near(resolved[0].magnitude, 14, 0.001); // 10 * 1.4
});

// ─── Generative Design ──────────────────────────────────────────────────────
console.log("\nGenerative Design:");
t("single-objective study converges", () => {
  const r = generativeDesign.runStudy({
    name: "maximize x",
    variables: [{ name: "x", kind: "continuous", min: 0, max: 10 }],
    objectives: [{ name: "score", direction: "maximize", evaluate: (s) => s.x }],
    populationSize: 12, generations: 8,
  });
  assert(r.paretoFront.length > 0, "should produce Pareto front");
  assert(r.best !== undefined, "should produce best solution");
  assert(r.best.score > 5, `best score should approach max=10; got ${r.best.score}`);
});

t("multi-objective study produces non-dominated set", () => {
  const r = generativeDesign.runStudy({
    name: "tradeoff",
    variables: [
      { name: "a", kind: "continuous", min: 0, max: 10 },
      { name: "b", kind: "continuous", min: 0, max: 10 },
    ],
    objectives: [
      { name: "max-a", direction: "maximize", evaluate: (s) => s.a },
      { name: "max-b", direction: "maximize", evaluate: (s) => s.b },
    ],
    populationSize: 20, generations: 10,
  });
  assert(r.paretoFront.length >= 1, "should produce at least 1 non-dominated solution");
  assert(r.convergence.length === 10, "convergence should track each generation");
});

// ─── Worksets ───────────────────────────────────────────────────────────────
console.log("\nWorksets:");
t("init creates default worksets", () => {
  worksets.resetWorksets();
  worksets.initWorksets();
  const list = worksets.listWorksets();
  assert(list.length >= 2, `expected ≥2 default worksets, got ${list.length}`);
});

t("assign element to workset + borrow + release", () => {
  worksets.resetWorksets();
  worksets.setCurrentUser("alice");
  const ws = worksets.createWorkset("Walls");
  worksets.assignToWorkset(42, ws.id);
  assert(worksets.getWorksetForElement(42)?.id === ws.id);
  // Bob can't borrow (current user is alice)
  assert(worksets.canEdit(42, "alice"));
  worksets.borrowElement(42, "alice");
  assert(!worksets.canEdit(42, "bob"), "bob should NOT be able to edit when alice borrowed");
  worksets.releaseElement(42, "alice");
  assert(worksets.canEdit(42, "bob"), "bob should be able to edit after release");
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
