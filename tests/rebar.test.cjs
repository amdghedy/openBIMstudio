/**
 * tests/rebar.test.cjs
 *
 * Unit tests for the rebar detailing module.
 * Validates: shape library, layout engine, geometry generator.
 *
 * Run: `node tests/rebar.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-rebar-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-rebar.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [
      path.join(repoRoot, "src/modules/rebar/types.ts"),
      path.join(repoRoot, "src/modules/rebar/shapes.ts"),
      path.join(repoRoot, "src/modules/rebar/layout.ts"),
      path.join(repoRoot, "src/modules/rebar/geometry.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const types = require(path.join(tmpOut, "modules/rebar/types.js"));
  const shapes = require(path.join(tmpOut, "modules/rebar/shapes.js"));
  const layout = require(path.join(tmpOut, "modules/rebar/layout.js"));
  const geometry = require(path.join(tmpOut, "modules/rebar/geometry.js"));

  console.log("\n=== Rebar Detailing tests ===\n");

  // ─── Types ──────────────────────────────────────────────────────────

  console.log("Types:");
  t("REBAR_DIAMETERS has 9 standard sizes", () => {
    assert(types.REBAR_DIAMETERS.length === 9, `expected 9 diameters, got ${types.REBAR_DIAMETERS.length}`);
    assert(types.REBAR_DIAMETERS.includes(16), "expected D16 in list");
    assert(types.REBAR_DIAMETERS.includes(25), "expected D25 in list");
  });
  t("barArea computes cross-sectional area", () => {
    const area = types.barArea(0.016); // D16
    near(area, Math.PI * 0.016 * 0.016 / 4, 1e-8);
  });
  t("barMass computes mass from length + diameter", () => {
    const mass = types.barMass(1.0, 0.016); // 1m of D16
    const expected = 1.0 * Math.PI * 0.016 * 0.016 / 4 * 7850;
    near(mass, expected, 0.01);
  });
  t("bendRadius = 4 * diameter", () => {
    near(types.bendRadius(0.016), 0.064, 0.001);
  });

  // ─── Shapes ────────────────────────────────────────────────────────

  console.log("\nShapes:");
  t("straightBar produces 1 segment", () => {
    const segs = shapes.straightBar(3.0);
    assert(segs.length === 1, `expected 1 segment, got ${segs.length}`);
    near(segs[0].end.x, 3.0, 0.001);
  });
  t("lBendBar produces 3 segments", () => {
    const segs = shapes.lBendBar(3.0, 0.2, 0.016);
    assert(segs.length === 3, `expected 3 segments, got ${segs.length}`);
  });
  t("doubleLBar produces 5 segments", () => {
    const segs = shapes.doubleLBar(3.0, 0.2, 0.016);
    assert(segs.length === 5, `expected 5 segments, got ${segs.length}`);
  });
  t("uBar produces 4 segments", () => {
    const segs = shapes.uBar(3.0, 0.3, 0.016);
    assert(segs.length === 4, `expected 4 segments, got ${segs.length}`);
  });
  t("rectangularStirrup produces closed loop (8 segments)", () => {
    const segs = shapes.rectangularStirrup(0.3, 0.5, 0.008, true);
    assert(segs.length === 8, `expected 8 segments, got ${segs.length}`);
  });
  t("openStirrup produces open loop (7 segments)", () => {
    const segs = shapes.openStirrup(0.3, 0.5, 0.008);
    assert(segs.length === 7, `expected 7 segments, got ${segs.length}`);
  });
  t("totalBarLength computes sum of segment lengths", () => {
    const segs = shapes.straightBar(3.0);
    near(shapes.totalBarLength(segs), 3.0, 0.001);
  });
  t("translateBar shifts all segments by offset", () => {
    const segs = shapes.straightBar(3.0);
    const translated = shapes.translateBar(segs, { x: 1, y: 2, z: 3 });
    near(translated[0].start.x, 1, 0.001);
    near(translated[0].start.y, 2, 0.001);
    near(translated[0].start.z, 3, 0.001);
  });

  // ─── Layout ────────────────────────────────────────────────────────

  console.log("\nLayout engine:");
  t("layoutBeamRebar produces bars for a beam", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
      mainBarCountBottom: 2, mainBarCountTop: 2,
      stirrupSpacing: 0.2,
    });
    assert(r.bars.length > 0, "expected bars");
    assert(r.totalMass > 0, "expected positive mass");
    assert(r.steelRatio > 0, "expected positive steel ratio");
  });
  t("beam layout has bottom + top main bars", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
      mainBarCountBottom: 3, mainBarCountTop: 2,
    });
    const bottomBars = r.bars.filter((b) => b.role === "main-bottom");
    const topBars = r.bars.filter((b) => b.role === "main-top");
    assert(bottomBars.length === 3, `expected 3 bottom bars, got ${bottomBars.length}`);
    assert(topBars.length === 2, `expected 2 top bars, got ${topBars.length}`);
  });
  t("beam layout has stirrups at spacing", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
      stirrupSpacing: 0.2,
    });
    const stirrups = r.bars.filter((b) => b.role === "stirrup");
    // 4m / 0.2m = 20 stirrups + 1 = 21
    assert(stirrups.length >= 20, `expected >= 20 stirrups, got ${stirrups.length}`);
  });
  t("column layout has vertical bars + links", () => {
    const r = layout.layoutColumnRebar({
      host: {
        type: "column", width: 0.4, depth: 0.4, length: 3.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, cover: 0.04,
      },
      mainBarCountBottom: 4, mainBarCountTop: 0,
    });
    const verticalBars = r.bars.filter((b) => b.role === "main-bottom" || b.role === "main-top");
    const links = r.bars.filter((b) => b.role === "link");
    assert(verticalBars.length === 4, `expected 4 vertical bars, got ${verticalBars.length}`);
    assert(links.length >= 2, `expected >= 2 links, got ${links.length}`);
  });
  t("steel ratio is positive and reasonable (< 5%)", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
    });
    assert(r.steelRatio > 0, "expected positive steel ratio");
    assert(r.steelRatio < 0.05, `expected steel ratio < 5%, got ${(r.steelRatio * 100).toFixed(2)}%`);
  });

  // ─── Geometry ──────────────────────────────────────────────────────

  console.log("\nGeometry generator:");
  t("generateBarMesh produces triangle positions", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
    });
    const bar = r.bars[0];
    const mesh = geometry.generateBarMesh(bar, 8);
    assert(mesh.positions.length > 0, "expected non-empty positions");
    assert(mesh.positions.length % 9 === 0, `expected multiple of 9 (3 vertices * 3 coords), got ${mesh.positions.length}`);
    assert(mesh.triangleCount > 0, "expected positive triangle count");
  });
  t("generateRebarMesh produces mesh for all bars", () => {
    const r = layout.layoutBeamRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
    });
    const mesh = geometry.generateRebarMesh(r.bars, 6, "#475569");
    assert(mesh.positions.length > 0, "expected non-empty positions");
    assert(mesh.triangleCount > 0, "expected positive triangle count");
  });

  // ─── Unified dispatch ─────────────────────────────────────────────

  console.log("\nUnified dispatch:");
  t("layoutRebar dispatches to beam layout", () => {
    const r = layout.layoutRebar({
      host: {
        type: "beam", width: 0.3, depth: 0.5, length: 4.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, cover: 0.04,
      },
    });
    assert(r.bars.length > 0, "expected bars");
  });
  t("layoutRebar dispatches to column layout", () => {
    const r = layout.layoutRebar({
      host: {
        type: "column", width: 0.4, depth: 0.4, length: 3.0, thickness: 0,
        origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, cover: 0.04,
      },
    });
    assert(r.bars.length > 0, "expected bars");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;

} catch (e) {
  console.error("Test setup failed:", e.message);
  console.error(e.stack);
  process.exitCode = 2;
} finally {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
}
