/**
 * tests/selection-box.test.cjs
 *
 * Unit tests for the v0.66 selection-box / crop-to-selection module.
 *
 * Since `selection-box.ts` depends on the live authoring module (which needs
 * a real THREE scene), the tests here exercise the pure geometry helpers
 * (getSelectionWorldBox, getSelectionViewBbox, computeElementsBbox) with
 * mocked element lookup.
 *
 * Run: `node tests/selection-box.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-selbox-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });

// Reuse three-stub.
const stubDir = path.join(repoRoot, "node_modules", "three-stub");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, "package.json"), JSON.stringify({
  name: "three-stub",
  version: "0.0.1",
  main: "index.js",
  type: "commonjs",
}));
fs.writeFileSync(path.join(stubDir, "index.js"), `
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  clone() { return new Vector3(this.x, this.y, this.z); }
}
class Euler { constructor() {} set(x,y,z) { return this; } copy(v) { return this; } }
class Rotation { constructor() { this.x=0; this.y=0; this.z=0; } set(x,y,z) { return this; } copy(v) { return this; } }
class BufferGeometry { constructor() { this.attributes = {}; } setAttribute(n,a) { return this; } setIndex(i) { return this; } computeVertexNormals() {} getAttribute(n) { return this.attributes[n]; } dispose() {} }
class Float32BufferAttribute extends Float32Array { constructor(a,n) { super(a); this.itemSize = n; } }
class BufferAttribute extends Float32Array { constructor(a,n) { super(a); this.itemSize = n; } }
class MeshLambertMaterial { constructor() {} dispose() {} }
class MeshBasicMaterial { constructor() {} dispose() {} }
class LineBasicMaterial { constructor() {} dispose() {} }
class TextureLoader { load() { return {}; } }
class Mesh { constructor() { this.position = new Vector3(); this.rotation = new Rotation(); this.material = {}; this.userData = {}; this.geometry = new BufferGeometry(); } }
class Line { constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.userData = {}; } }
class LineSegments { constructor() { this.geometry = new BufferGeometry(); this.material = {}; this.position = new Vector3(); this.rotation = new Rotation(); } }
class Group { constructor() { this.children = []; this.position = new Vector3(); this.rotation = new Rotation(); this.userData = {}; this.renderOrder = 0; this.add = (c) => this.children.push(c); this.traverse = (cb) => { cb(this); for (const c of this.children) c.traverse?.(cb); }; } }
class Box3 {
  constructor(min, max) {
    this.min = min || new Vector3(Infinity, Infinity, Infinity);
    this.max = max || new Vector3(-Infinity, -Infinity, -Infinity);
  }
  clone() { return new Box3(this.min.clone(), this.max.clone()); }
  getCenter(v) { v.x = (this.min.x + this.max.x) / 2; v.y = (this.min.y + this.max.y) / 2; v.z = (this.min.z + this.max.z) / 2; return v; }
  getSize(v) { v.x = this.max.x - this.min.x; v.y = this.max.y - this.min.y; v.z = this.max.z - this.min.z; return v; }
  expandByScalar(s) { this.min.x -= s; this.min.y -= s; this.min.z -= s; this.max.x += s; this.max.y += s; this.max.z += s; return this; }
  translate(d) { this.min.add(d); this.max.add(d); return this; }
  isEmpty() { return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z; }
  copy(b) { this.min.copy(b.min); this.max.copy(b.max); return this; }
  union(b) {
    this.min.x = Math.min(this.min.x, b.min.x);
    this.min.y = Math.min(this.min.y, b.min.y);
    this.min.z = Math.min(this.min.z, b.min.z);
    this.max.x = Math.max(this.max.x, b.max.x);
    this.max.y = Math.max(this.max.y, b.max.y);
    this.max.z = Math.max(this.max.z, b.max.z);
    return this;
  }
}
class Plane { constructor() {} }
class Raycaster { setFromCamera() {} set() {} intersectObjects() { return []; } }
class Vector2 { constructor() {} }
class Color { constructor() {} }
class Box3Helper { constructor() { this.box = new Box3(); this.material = new LineBasicMaterial(); this.geometry = new BufferGeometry(); } updateMatrixWorld() {} }
class BoxGeometry { constructor() {} }
class CylinderGeometry { constructor() {} }
class SphereGeometry { constructor() {} }
class PlaneGeometry { constructor() {} }
class IcosahedronGeometry { constructor() {} }
class OctahedronGeometry { constructor() {} }
class EdgesGeometry { constructor() {} }
class InstancedMesh { constructor() { this.userData = {}; } }
class Quaternion { setFromEuler() { return this; } }
class Matrix4 { compose() { return this; } }
module.exports = {
  Vector3, Euler, BufferGeometry, Float32BufferAttribute, BufferAttribute,
  MeshLambertMaterial, MeshBasicMaterial, LineBasicMaterial, TextureLoader,
  Mesh, Line, LineSegments, Group,
  BoxGeometry, CylinderGeometry, SphereGeometry, PlaneGeometry,
  IcosahedronGeometry, OctahedronGeometry, EdgesGeometry, InstancedMesh,
  Quaternion, Matrix4, Box3, Plane, Raycaster, Vector2, Color, Box3Helper,
  DoubleSide: 1, SRGBColorSpace: 1,
};
`);

const tsconfigPath = path.join(tmpOut, "tsconfig-selbox.json");

// Strategy: copy the selection-box.ts source to a temp file with all
// type annotations and side-effect imports stripped, so TS only type-checks
// the runtime logic.
const srcPath = path.join(repoRoot, "src/features/selection-box.ts");
let src = fs.readFileSync(srcPath, "utf8");

// Replace imports with runtime stubs.
src = src.replace(/^import\s+\*\s+as\s+THREE\s+from\s+"three";/m, `
class Box3 {
  min: any; max: any;
  constructor() { this.min = { x: Infinity, y: Infinity, z: Infinity }; this.max = { x: -Infinity, y: -Infinity, z: -Infinity }; }
  clone() { const b: any = new Box3(); b.min = { ...this.min }; b.max = { ...this.max }; return b; }
  isEmpty() { return this.max.x < this.min.x; }
  expandByScalar(s: number) { this.min.x -= s; this.min.y -= s; this.min.z -= s; this.max.x += s; this.max.y += s; this.max.z += s; return this; }
  union(b: any) {
    this.min.x = Math.min(this.min.x, b.min.x); this.min.y = Math.min(this.min.y, b.min.y); this.min.z = Math.min(this.min.z, b.min.z);
    this.max.x = Math.max(this.max.x, b.max.x); this.max.y = Math.max(this.max.y, b.max.y); this.max.z = Math.max(this.max.z, b.max.z);
    return this;
  }
}
class Vector3 { x: number; y: number; z: number; constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } }
const THREE: any = { Box3, Vector3 };
`);
src = src.replace(/^import\s+\{[^}]+\}\s+from\s+"\.\.\/core\/context";/m, `const ctx: any = { features: {} };`);
src = src.replace(/^import\s+\{[^}]+\}\s+from\s+"\.\/authoring";/m, `
function getSelectedIds(): string[] { return (globalThis as any).__testSelectedIds ?? []; }
function getElementById(id: string): any { return (globalThis as any).__testElements?.[id] ?? null; }
function getElementWorldBox(el: any): any {
  if (!el?.bbox) return null;
  const b = new Box3();
  b.min = { x: el.bbox.min[0], y: el.bbox.min[1], z: el.bbox.min[2] };
  b.max = { x: el.bbox.max[0], y: el.bbox.max[1], z: el.bbox.max[2] };
  return b;
}
`);
src = src.replace(/^import\s+\{[\s\S]+?\}\s+from\s+"\.\/section-box";/m, `
function enableSectionBox(padding?: number): void {} function disableSectionBox(): void {}
function isSectionBoxActive(): boolean { return false; }
function growSectionBox(amount: number): void {}
function enableSectionBoxWithBox(b: any): void { (globalThis as any).__testBoxSet = b; }
`);
src = src.replace(/^import\s+\{[^}]+\}\s+from\s+"\.\/crop-region";/m, `
function getCropRegion(v: string): any { return { enabled: false, minX: -50, maxX: 50, minY: -50, maxY: 50, rotation: 0, viewId: v }; }
function setCropRegion(viewId: string, region: any): any { (globalThis as any).__testLastCrop = { viewId, region }; }
function setActiveView(viewId: string): void { (globalThis as any).__testActiveView = viewId; }
`);
src = src.replace(/^import\s+\{\s*fitAll,\s*focusOnBox\s*\}\s+from\s+"\.\/camera-tools";/m, `function fitAll(): void {} function focusOnBox(b: any): void { (globalThis as any).__testFocused = b; }`);

// Replace THREE.Box3 references with our local Box3 class (since we made THREE = { Box3, Vector3 }).
src = src.replace(/THREE\.Box3/g, "Box3");
src = src.replace(/THREE\.Vector3/g, "Vector3");

const strippedDir = path.join(tmpOut, "src");
fs.mkdirSync(strippedDir, { recursive: true });
const strippedPath = path.join(strippedDir, "selection-box-stripped.ts");
fs.writeFileSync(strippedPath, src);

fs.writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "es2022",
    moduleResolution: "node",
    strict: false,
    skipLibCheck: true,
    esModuleInterop: true,
    outDir: path.join(tmpOut, "out"),
    rootDir: strippedDir,
    types: [],
    lib: ["ES2022", "DOM"],
  },
  include: [strippedPath],
}, null, 2));

try {
  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  console.error("TS compilation failed:");
  console.error(e.stderr?.toString() || e.message);
  process.exit(1);
}

// ESM imports need file extensions. Use dynamic import via require + .js.
// Override module resolution so 'three' resolves to stub.
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === "three") return path.join(repoRoot, "node_modules/three-stub/index.js");
  return origResolve.call(this, req, parent, ...rest);
};

// The TS compiler emits ESM .js files. The stripped version has all
// imports inlined, so we can import it directly without any module
// override.
const selBoxP = (async () => {
  const out = path.join(tmpOut, "out/selection-box-stripped.js");
  return await import("file://" + out);
})();

selBoxP.then((selBox) => {
  // Polyfill `window`, `CustomEvent`, and `dispatchEvent` for the stripped module.
  globalThis.window = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
  };
  runTests(selBox);
}).catch((err) => {
  console.error("Module load failed:", err);
  process.exit(1);
});

function runTests(selBox) {
console.log("\n=== Selection Box tests ===\n");

t("getSelectionWorldBox returns null when no selection", () => {
  global.__testSelectedIds = [];
  global.__testElements = {};
  const b = selBox.getSelectionWorldBox();
  assert(b === null, "expected null for empty selection");
});

t("getSelectionWorldBox returns union bbox of selected elements", () => {
  global.__testSelectedIds = ["e1", "e2"];
  global.__testElements = {
    e1: { id: "e1", bbox: { min: [0, 0, 0], max: [2, 2, 2] } },
    e2: { id: "e2", bbox: { min: [3, 0, 0], max: [5, 1, 1] } },
  };
  const b = selBox.getSelectionWorldBox();
  assert(b !== null);
  near(b.min.x, 0); near(b.min.y, 0); near(b.min.z, 0);
  near(b.max.x, 5); near(b.max.y, 2); near(b.max.z, 2);
});

t("getSelectionViewBbox extracts XZ plane from world bbox", () => {
  global.__testSelectedIds = ["e1"];
  global.__testElements = {
    e1: { id: "e1", bbox: { min: [1, 0, 2], max: [4, 3, 6] } },
  };
  const bb = selBox.getSelectionViewBbox();
  assert(bb !== null);
  near(bb.minX, 1); near(bb.maxX, 4);
  near(bb.minZ, 2); near(bb.maxZ, 6);
});

t("computeElementsBbox unions multiple explicit IDs", () => {
  global.__testSelectedIds = [];
  global.__testElements = {
    a: { id: "a", bbox: { min: [-1, -1, -1], max: [1, 1, 1] } },
    b: { id: "b", bbox: { min: [2, 0, 0], max: [4, 2, 2] } },
    c: { id: "c", bbox: { min: [-3, 0, 0], max: [-2, 1, 1] } },
  };
  const b = selBox.computeElementsBbox(["a", "b", "c"]);
  assert(b !== null);
  near(b.min.x, -3); near(b.min.y, -1); near(b.min.z, -1);
  near(b.max.x, 4); near(b.max.y, 2); near(b.max.z, 2);
});

t("showSelectionBox returns false + warns when nothing selected", () => {
  global.__testSelectedIds = [];
  global.__testElements = {};
  const ok = selBox.showSelectionBox({ padding: 0.5 });
  assert(ok === false, "should return false for empty selection");
});

t("cropToSelection returns false when nothing selected", () => {
  global.__testSelectedIds = [];
  global.__testElements = {};
  const ok = selBox.cropToSelection({ padding: 1.0 });
  assert(ok === false);
});

t("cropToSelection sets crop region with padding around selection", () => {
  global.__testSelectedIds = ["e1"];
  global.__testElements = {
    e1: { id: "e1", bbox: { min: [10, 0, 20], max: [15, 3, 25] } },
  };
  global.__testLastCrop = null;
  global.__testActiveView = null;
  const ok = selBox.cropToSelection({ padding: 1.0 });
  assert(ok === true);
  assert(global.__testLastCrop !== null, "crop region should have been set");
  near(global.__testLastCrop.region.minX, 9);   // 10 - 1
  near(global.__testLastCrop.region.maxX, 16);   // 15 + 1
  near(global.__testLastCrop.region.minY, 19);  // 20 - 1
  near(global.__testLastCrop.region.maxY, 26);  // 25 + 1
  assert(global.__testLastCrop.region.enabled === true);
  assert(global.__testActiveView === "plan-view-1");
});

t("cropToSelection accepts custom viewId", () => {
  global.__testSelectedIds = ["e1"];
  global.__testElements = {
    e1: { id: "e1", bbox: { min: [0, 0, 0], max: [5, 3, 5] } },
  };
  global.__testLastCrop = null;
  const ok = selBox.cropToSelection({ padding: 0.5, viewId: "section-1" });
  assert(ok === true);
  assert(global.__testLastCrop.viewId === "section-1");
});

console.log(`\n=== Summary: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
}

