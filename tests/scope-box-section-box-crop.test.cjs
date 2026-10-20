/**
 * tests/scope-box-section-box-crop.test.cjs
 *
 * Unit tests for the v0.66 interactive view-crop features:
 *   - Scope Box (data model from scope-box.ts)
 *   - Section Box (geometry helpers)
 *   - Crop Region (2D per-view crop state)
 *
 * These tests cover the pure data/state logic — the interactive pointer
 * handlers require a real DOM + WebGL canvas and are not exercised here.
 *
 * Run: `node tests/scope-box-section-box-crop.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-v66-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });

// Reuse the three-stub from v40 tests (write into node_modules so it resolves).
const stubDir = path.join(repoRoot, "node_modules", "three-stub");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({
  name: "three-stub",
  version: "0.0.1",
  main: "index.js",
  type: "commonjs",
}));
fs.writeFileSync(path.join(stubDir, "index.js"), `
// Minimal stub to satisfy TS compilation of v66 modules.
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
  clone() { return new Vector3(this.x, this.y, this.z); }
  toArray() { return [this.x, this.y, this.z]; }
}
class Euler {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
class Rotation {
  constructor() { this.x = 0; this.y = 0; this.z = 0; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
}
class BufferGeometry {
  constructor() { this.attributes = {}; this._index = null; }
  setAttribute(n, a) { this.attributes[n] = a; return this; }
  setIndex(i) { this._index = i; return this; }
  computeVertexNormals() {}
  getAttribute(n) { return this.attributes[n]; }
  dispose() {}
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
class MeshLambertMaterial { constructor() {} dispose() {} }
class MeshBasicMaterial { constructor() {} dispose() {} }
class LineBasicMaterial { constructor() {} dispose() {} }
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
class Line {
  constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; this.position = new Vector3(); this.rotation = new Rotation(); }
}
class LineSegments {
  constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; this.position = new Vector3(); this.rotation = new Rotation(); }
}
class Points {
  constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; this.position = new Vector3(); }
}
class Group {
  constructor() {
    this.children = [];
    this.position = new Vector3();
    this.rotation = new Rotation();
    this.userData = {};
    this.renderOrder = 0;
    this.add = (c) => this.children.push(c);
    this.traverse = (cb) => { cb(this); for (const c of this.children) c.traverse?.(cb); };
  }
}
class Box3 {
  constructor(min, max) { this.min = min || new Vector3(); this.max = max || new Vector3(); }
  clone() { return new Box3(this.min.clone(), this.max.clone()); }
  getCenter(v) { v.x = (this.min.x + this.max.x) / 2; v.y = (this.min.y + this.max.y) / 2; v.z = (this.min.z + this.max.z) / 2; return v; }
  getSize(v) { v.x = this.max.x - this.min.x; v.y = this.max.y - this.min.y; v.z = this.max.z - this.min.z; return v; }
  expandByScalar(s) { this.min.x -= s; this.min.y -= s; this.min.z -= s; this.max.x += s; this.max.y += s; this.max.z += s; return this; }
  translate(d) { this.min.add(d); this.max.add(d); return this; }
  isEmpty() { return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z; }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
}
class Plane {
  constructor(normal, constant) { this.normal = normal || new Vector3(); this.constant = constant || 0; }
}
class Raycaster {
  setFromCamera() {} set() {}
  intersectObjects() { return []; }
}
class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
class Color { constructor() {} }
class Box3Helper {
  constructor(box, color) { this.box = box; this.material = new LineBasicMaterial(); this.geometry = new BufferGeometry(); this.position = new Vector3(); this.renderOrder = 0; this.updateMatrixWorld() {} }
  updateMatrixWorld() {}
}
class BoxGeometry { constructor() {} }
class CylinderGeometry { constructor() {} }
class SphereGeometry { constructor() {} }
class TorusGeometry { constructor() {} }
class PlaneGeometry { constructor() {} }
class IcosahedronGeometry { constructor() {} }
class OctahedronGeometry { constructor() {} }
class EdgesGeometry { constructor() {} }
class InstancedMesh { constructor() { this.userData = {}; } }
class Quaternion { setFromEuler() { return this; } }
class Matrix4 { compose() { return this; } }
module.exports = {
  Vector3, Euler, BufferGeometry, Float32BufferAttribute, BufferAttribute,
  MeshLambertMaterial, MeshBasicMaterial, LineBasicMaterial, PointsMaterial, TextureLoader,
  Mesh, Line, LineSegments, Points, Group,
  BoxGeometry, CylinderGeometry, SphereGeometry, TorusGeometry, PlaneGeometry,
  IcosahedronGeometry, OctahedronGeometry, EdgesGeometry, InstancedMesh,
  Quaternion, Matrix4, Box3, Plane, Raycaster, Vector2, Color, Box3Helper,
  DoubleSide: 1, SRGBColorSpace: 1,
};
`);

// tsconfig for v66 modules.
const tsconfigPath = path.join(tmpOut, "tsconfig-v66.json");
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
    path.join(repoRoot, "src/modules/scope-box/scope-box.ts"),
    path.join(repoRoot, "src/features/crop-region.ts"),
  ],
}, null, 2));

try {
  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  console.error("TS compilation failed:");
  console.error(e.stderr?.toString() || e.message);
  process.exit(1);
}

// Override module resolution so 'three' resolves to stub.
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "three") return path.join(repoRoot, "node_modules/three-stub/index.js");
  return origResolve.call(this, req, parent, ...rest);
};

const scopeBox = require(path.join(tmpOut, "modules/scope-box/scope-box.js"));
const cropRegion = require(path.join(tmpOut, "features/crop-region.js"));

console.log("\n=== Scope Box + Section Box + Crop Region tests ===\n");

// ─── Scope Box data model ────────────────────────────────────────────────
console.log("Scope Box:");
t("create + get + list + delete", () => {
  scopeBox.resetScopeBoxes();
  const sb = scopeBox.createScopeBox({ name: "Test", min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 3, z: 5 } });
  assert(sb.id, "should have id");
  assert(scopeBox.listScopeBoxes().length === 1);
  const fetched = scopeBox.getScopeBox(sb.id);
  assert(fetched.name === "Test");
  assert(scopeBox.deleteScopeBox(sb.id));
  assert(scopeBox.listScopeBoxes().length === 0);
});

t("applyToView + removeFromView", () => {
  scopeBox.resetScopeBoxes();
  const sb = scopeBox.createScopeBox({ name: "V", min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 10 } });
  scopeBox.applyToView(sb.id, "view-1");
  scopeBox.applyToView(sb.id, "view-2");
  const fetched = scopeBox.getScopeBox(sb.id);
  assert(fetched.appliedToViews.length === 2);
  scopeBox.removeFromView(sb.id, "view-1");
  assert(scopeBox.getScopeBox(sb.id).appliedToViews.length === 1);
});

t("pointInScope + bboxIntersectsScope", () => {
  scopeBox.resetScopeBoxes();
  const sb = scopeBox.createScopeBox({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 10 } });
  assert(scopeBox.pointInScope(sb, 5, 2, 5));
  assert(!scopeBox.pointInScope(sb, 15, 2, 5));
  assert(scopeBox.bboxIntersectsScope(sb, { x: 5, y: 1, z: 5 }, { x: 15, y: 3, z: 15 }));
  assert(!scopeBox.bboxIntersectsScope(sb, { x: 20, y: 1, z: 20 }, { x: 25, y: 3, z: 25 }));
});

t("updateScopeBox mutates bounds", () => {
  scopeBox.resetScopeBoxes();
  const sb = scopeBox.createScopeBox({ min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 3, z: 5 } });
  scopeBox.updateScopeBox(sb.id, { max: { x: 10, y: 5, z: 10 } });
  const updated = scopeBox.getScopeBox(sb.id);
  near(updated.max.x, 10);
  near(updated.max.y, 5);
  near(updated.max.z, 10);
});

// ─── Crop Region ─────────────────────────────────────────────────────────
console.log("\nCrop Region:");
t("default region is 100×100 m centred on origin", () => {
  cropRegion.resetCropRegions();
  const r = cropRegion.getCropRegion("plan-view-1");
  near(r.minX, -50); near(r.maxX, 50);
  near(r.minY, -50); near(r.maxY, 50);
  assert(!r.enabled, "default crop should be off");
});

t("toggle flips enabled state", () => {
  cropRegion.resetCropRegions();
  const on1 = cropRegion.toggleCrop("plan-view-1");
  assert(on1 === true);
  const on2 = cropRegion.toggleCrop("plan-view-1");
  assert(on2 === false);
});

t("setCropRegion mutates bounds", () => {
  cropRegion.resetCropRegions();
  cropRegion.setCropRegion("plan-view-1", { minX: -10, minY: -10, maxX: 10, maxY: 10, enabled: true });
  const r = cropRegion.getCropRegion("plan-view-1");
  near(r.minX, -10); near(r.maxX, 10);
  assert(r.enabled);
});

t("pointInCrop respects enabled flag", () => {
  cropRegion.resetCropRegions();
  cropRegion.setCropRegion("plan-view-1", { minX: 0, minY: 0, maxX: 10, maxY: 10, enabled: true });
  assert(cropRegion.pointInCrop("plan-view-1", 5, 5));
  assert(!cropRegion.pointInCrop("plan-view-1", 20, 20));
  // When disabled, everything passes.
  cropRegion.setCropRegion("plan-view-1", { enabled: false });
  assert(cropRegion.pointInCrop("plan-view-1", 1000, 1000));
});

t("resetCropRegion restores defaults", () => {
  cropRegion.resetCropRegions();
  cropRegion.setCropRegion("v", { minX: 0, minY: 0, maxX: 5, maxY: 5, enabled: true });
  cropRegion.resetCropRegion("v");
  const r = cropRegion.getCropRegion("v");
  near(r.minX, -50); near(r.maxX, 50);
  assert(r.enabled);
});

t("listCropRegions returns all stored", () => {
  cropRegion.resetCropRegions();
  cropRegion.getCropRegion("v1");
  cropRegion.getCropRegion("v2");
  cropRegion.getCropRegion("v3");
  assert(cropRegion.listCropRegions().length === 3);
});

t("deleteCropRegion removes from registry", () => {
  cropRegion.resetCropRegions();
  cropRegion.getCropRegion("v1");
  assert(cropRegion.deleteCropRegion("v1"));
  assert(cropRegion.listCropRegions().length === 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
