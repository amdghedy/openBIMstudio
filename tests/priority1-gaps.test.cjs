/**
 * Priority 1 BIM / CAD Tooling Gaps Unit Tests
 *
 * Tests:
 * 1. Modify Engine Expansion (AxisAlignCommand, SplitWithGapCommand, WallCornerCommand)
 * 2. 2D Detail Hatching (ANSI31, CONCRETE, EARTH, BRICK, INSULATION)
 * 3. glTF / GLB 3D Exporter (Header magic, binary chunks, PBR materials, extras)
 * 4. Curved / Arc Wall Modeling (3-point arc, geometry resolution, mesh generation, tangent snap)
 *
 * Run: node tests/priority1-gaps.test.cjs
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-p1-gaps-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');

// Compile the pure modules to CJS
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/modify/command.ts src/modules/modify/duplicate.ts src/modules/modify/group2.ts" +
  " src/modules/detail-patterns/hatch-patterns.ts" +
  " src/modules/export/gltf-native-twin.ts" +
  " src/modules/parametric/arc-wall.ts",
  { cwd: root, stdio: "pipe", shell: true }
);

const { AxisAlignCommand, SplitWithGapCommand, WallCornerCommand } = require(path.join(tmpOut, "modules/modify/group2.js"));
const { ANSI31, CONCRETE, EARTH, BRICK, INSULATION, getPattern, listPatterns } = require(path.join(tmpOut, "modules/detail-patterns/hatch-patterns.js"));
const { createBoxGeometry, buildGlbContainer, exportNativeTwinToGlb } = require(path.join(tmpOut, "modules/export/gltf-native-twin.js"));
const {
  threePointArc,
  resolveArcWallGeometry,
  generateArcWallPlanPolyline,
  generateArcWallMesh,
  solveArcTangentSnap,
} = require(path.join(tmpOut, "modules/parametric/arc-wall.js"));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log("  PASS", name);
    pass++;
  } catch (e) {
    console.error("  FAIL", name, e.message);
    fail++;
  }
}

// Minimal in-memory store adapter for Modify commands
function createTestStore(elements) {
  const map = new Map(elements.map(e => [e.id, { ...e }]));
  return {
    get: (id) => map.get(id),
    apply: (id, patch) => {
      const el = map.get(id);
      if (!el) return false;
      Object.assign(el, patch);
      return true;
    },
    insert: (el) => {
      map.set(el.id, { ...el });
    },
    all: () => Array.from(map.values()),
  };
}

console.log("\n=== Priority 1 Gaps Unit Tests ===\n");

// ── 1. Modify Engine Expansion ───────────────────────────────────────────
console.log("1. Modify Engine Expansion (Group 2):");

t("AxisAlignCommand aligns element coordinate along chosen axis", () => {
  const store = createTestStore([
    { id: "wall-1", categoryId: "wall", pinned: false, editable: true, position: [10, 20], rotationZ: 0 },
    { id: "wall-2", categoryId: "wall", pinned: false, editable: true, position: [15, 30], rotationZ: 0 },
  ]);
  const cmd = new AxisAlignCommand({ store });
  cmd.Begin(["wall-1", "wall-2"]);

  // Align to X = 50
  const preview = cmd.UpdatePreview({ type: "align", axis: "x", target: 50, lockAfter: true });
  assert.strictEqual(preview.length, 2);
  assert.strictEqual(preview[0].patch.position[0], 50);
  assert.strictEqual(preview[0].patch.position[1], 20);
  assert.strictEqual(preview[0].patch.reason, "align-locked");

  const commitRes = cmd.Commit();
  assert.strictEqual(commitRes.ok, true);
  assert.strictEqual(commitRes.applied, 2);
  assert.strictEqual(store.get("wall-1").position[0], 50);
  assert.strictEqual(store.get("wall-2").position[0], 50);
});

t("SplitWithGapCommand divides linear element and inserts gap clearance", () => {
  const store = createTestStore([
    {
      id: "wall-linear",
      categoryId: "wall",
      pinned: false,
      editable: true,
      position: [0, 0],
      rotationZ: 0,
      curve: { start: [0, 0], end: [10, 0] },
    },
  ]);
  let idCounter = 1;
  const cmd = new SplitWithGapCommand({ store, allocateId: () => `wall-part-${idCounter++}` });
  cmd.Begin(["wall-linear"]);

  // Split at parameter 0.5 with 0.20m gap (length is 10m, so halfGapParam is 0.1/10 = 0.01)
  const preview = cmd.UpdatePreview({ type: "split-gap", parameter: 0.5, gapDistance: 0.20 });
  assert.strictEqual(preview.length, 2);

  // Part 1: start at 0, end at 5.0 - 0.1 = 4.9
  assert(preview[0].patch.curve);
  assert.strictEqual(preview[0].patch.curve.start[0], 0);
  assert.strictEqual(Math.round(preview[0].patch.curve.end[0] * 10) / 10, 4.9);

  // Part 2: start at 5.0 + 0.1 = 5.1, end at 10.0
  assert(preview[1].newElement);
  assert.strictEqual(Math.round(preview[1].newElement.curve.start[0] * 10) / 10, 5.1);
  assert.strictEqual(preview[1].newElement.curve.end[0], 10);

  const commitRes = cmd.Commit();
  assert.strictEqual(commitRes.ok, true);
  assert(store.get("wall-part-1"));
});

t("WallCornerCommand miters two intersecting walls at intersection point", () => {
  // Wall A along X axis: (0, 0) -> (8, 0)
  // Wall B along Y axis: (10, 5) -> (10, -5), intersecting at (10, 0)
  const store = createTestStore([
    {
      id: "wall-A",
      categoryId: "wall",
      pinned: false,
      editable: true,
      position: [0, 0],
      rotationZ: 0,
      curve: { start: [0, 0], end: [8, 0] },
    },
    {
      id: "wall-B",
      categoryId: "wall",
      pinned: false,
      editable: true,
      position: [10, 0],
      rotationZ: 0,
      curve: { start: [10, 5], end: [10, -5] },
    },
  ]);

  const cmd = new WallCornerCommand({ store });
  cmd.Begin(["wall-A", "wall-B"]);
  const preview = cmd.UpdatePreview({ type: "wall-corner-trim", wallA: "wall-A", wallB: "wall-B", mode: "miter" });

  assert.strictEqual(preview.length, 2);
  // Intersection should be [10, 0]
  assert.strictEqual(preview[0].patch.curve.end[0], 10);
  assert.strictEqual(preview[0].patch.curve.end[1], 0);

  const commitRes = cmd.Commit();
  assert.strictEqual(commitRes.ok, true);
  assert.strictEqual(store.get("wall-A").curve.end[0], 10);
  assert.strictEqual(store.get("wall-A").curve.end[1], 0);
});

// ── 2. 2D Detail Hatching ───────────────────────────────────────────────
console.log("\n2. 2D Detail Hatching:");

t("registry exposes ANSI31, CONCRETE, and EARTH patterns", () => {
  const patterns = listPatterns();
  const ids = patterns.map(p => p.id);
  assert(ids.includes("ANSI31"), "ANSI31 must be registered");
  assert(ids.includes("CONCRETE"), "CONCRETE must be registered");
  assert(ids.includes("EARTH"), "EARTH must be registered");
  assert(ids.includes("BRICK"), "BRICK must be registered");
  assert(ids.includes("INSULATION"), "INSULATION must be registered");
});

t("ANSI31 generates 45-degree diagonal lines within bounds", () => {
  const bounds = { minX: 0, minY: 0, maxX: 50, maxY: 50 };
  const lines = ANSI31.generate(bounds, 1.0, 0);
  assert(lines.length > 5, `Expected multiple lines, got ${lines.length}`);
  for (const l of lines) {
    assert(typeof l.x1 === "number" && typeof l.y1 === "number");
    assert(typeof l.x2 === "number" && typeof l.y2 === "number");
  }
});

t("CONCRETE generates stipple dots and aggregate triangular lines", () => {
  const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  const lines = CONCRETE.generate(bounds, 1.0, 0);
  assert(lines.length > 10, "Concrete pattern should have ample stipple/triangles");
});

t("EARTH generates dual diagonal crosshatch fills (45° + 135°)", () => {
  const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  const lines = EARTH.generate(bounds, 1.0, 0);
  const singleDiagonal = ANSI31.generate(bounds, 4.0 / 3.0, 0);
  assert(lines.length >= singleDiagonal.length * 1.5, "Earth crosshatch must have more segments than single diagonal");
});

// ── 3. glTF / GLB 3D Exporter ───────────────────────────────────────────
console.log("\n3. glTF / GLB 3D Exporter:");

t("createBoxGeometry creates 24 vertices, 36 indices and flat normals", () => {
  const box = createBoxGeometry(2, 3, 4);
  assert.strictEqual(box.positions.length, 24 * 3);
  assert.strictEqual(box.indices.length, 36);
  assert.strictEqual(box.normals.length, 24 * 3);
});

t("buildGlbContainer creates valid glTF 2.0 binary container with magic 0x46546C67", () => {
  const json = { asset: { version: "2.0" }, scenes: [] };
  const bin = new Uint8Array([1, 2, 3, 4]);
  const glb = buildGlbContainer(json, bin);

  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);

  assert.strictEqual(magic, 0x46546C67, "Magic header must be 'glTF'");
  assert.strictEqual(version, 2, "glTF version must be 2");
  assert.strictEqual(totalLength, glb.byteLength, "Header length must match buffer size");
});

t("exportNativeTwinToGlb exports model elements with IFC properties as extras", () => {
  const box = createBoxGeometry(5, 3, 0.2);
  const elements = [
    {
      id: "wall-101",
      name: "Exterior Concrete Wall",
      category: "IfcWall",
      position: [0, 1.5, 0],
      properties: {
        loadBearing: true,
        fireRating: "2hr",
        acousticRating: "STC 50",
      },
      geometry: {
        positions: box.positions,
        indices: box.indices,
        normals: box.normals,
      },
    },
  ];

  const glb = exportNativeTwinToGlb(elements, { generator: "openBIMstudio Test" });
  assert(glb instanceof Uint8Array);
  assert(glb.byteLength > 500, "GLB output must be substantial");

  // Validate JSON chunk content
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLen = view.getUint32(12, true);
  const jsonBytes = glb.subarray(20, 20 + jsonLen);
  const jsonStr = new TextDecoder().decode(jsonBytes).trim();
  const parsed = JSON.parse(jsonStr);

  assert.strictEqual(parsed.asset.version, "2.0");
  assert.strictEqual(parsed.nodes.length, 1);
  assert.strictEqual(parsed.nodes[0].extras.category, "IfcWall");
  assert.strictEqual(parsed.nodes[0].extras.properties.fireRating, "2hr");
});

// ── 4. Curved / Arc Wall Modeling ───────────────────────────────────────
console.log("\n4. Curved / Arc Wall Modeling:");

t("threePointArc determines center, radius, and sweep from 3 points", () => {
  // Arc passing through (5, 0), (0, 5), (-5, 0) -> circle centered at (0,0) radius 5
  const arc = threePointArc([5, 0], [0, 5], [-5, 0]);
  assert(Math.abs(arc.center[0]) < 1e-6);
  assert(Math.abs(arc.center[1]) < 1e-6);
  assert(Math.abs(arc.radius - 5.0) < 1e-6);
  assert.strictEqual(arc.ccw, true);
});

t("resolveArcWallGeometry calculates inner/outer radii, arc length and volume", () => {
  const geom = resolveArcWallGeometry({
    center: [0, 0],
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI / 2, // 90 degrees
    thickness: 0.30,
    height: 3.0,
    justification: "center",
  });

  assert.strictEqual(geom.innerRadius, 9.85);
  assert.strictEqual(geom.outerRadius, 10.15);
  assert(Math.abs(geom.arcLength - (10 * Math.PI / 2)) < 1e-6);
  assert(geom.volume > 0);
});

t("generateArcWallPlanPolyline creates 2D centerline and boundaries", () => {
  const poly = generateArcWallPlanPolyline({
    center: [0, 0],
    radius: 6,
    startAngle: 0,
    endAngle: Math.PI,
    thickness: 0.2,
    height: 3.0,
  }, 10);

  assert.strictEqual(poly.centerline.length, 11);
  assert.strictEqual(poly.innerBoundary.length, 11);
  assert.strictEqual(poly.outerBoundary.length, 11);
});

t("generateArcWallMesh generates 3D cylinder faces, top/bottom caps, and end caps", () => {
  const mesh = generateArcWallMesh({
    center: [0, 0],
    radius: 8,
    startAngle: 0,
    endAngle: Math.PI / 2,
    thickness: 0.25,
    height: 3.5,
    segments: 8,
  });

  assert(mesh.positions.length > 0);
  assert(mesh.indices.length > 0);
  assert(mesh.normals.length === mesh.positions.length);
  // Indices count must be a multiple of 3 (triangles)
  assert.strictEqual(mesh.indices.length % 3, 0);
});

t("solveArcTangentSnap detects tangent vector at arc query point", () => {
  const geom = resolveArcWallGeometry({
    center: [0, 0],
    radius: 5,
    startAngle: 0,
    endAngle: Math.PI,
    thickness: 0.2,
    height: 3.0,
  });

  // Query point near (0, 5) which is at angle π/2
  const snap = solveArcTangentSnap(geom, [0, 5.1], 0.5);
  assert(snap !== null);
  assert(Math.abs(snap.snapPoint[0]) < 1e-4);
  assert(Math.abs(snap.snapPoint[1] - 5.0) < 1e-4);
  // Tangent at top (0, 5) is horizontal pointing along -X: [-1, 0]
  assert(Math.abs(snap.tangentVector[0] - (-1)) < 1e-4);
  assert(Math.abs(snap.tangentVector[1]) < 1e-4);
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
