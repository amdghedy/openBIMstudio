/**
 * tests/mep-router.test.cjs
 *
 * Unit tests for the MEP auto-routing module.
 *
 * Approach: write a minimal tsconfig.json that includes only the mep/
 * directory + compile to CommonJS in a temp dir. Then require() the
 * compiled output and run the tests.
 *
 * Run: `node tests/mep-router.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-mep-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  // Write a minimal tsconfig that includes ONLY the pure mep files
  // (types.ts, sizing.ts, router.ts - no ctx/window imports).
  // Skip index.ts because it pulls in the full ServiceMap which transitively
  // imports clash-worker-client.ts (which uses import.meta).
  const tsconfigPath = path.join(tmpOut, "tsconfig-mep.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      outDir: tmpOut,
      rootDir: path.join(repoRoot, "src"),
    },
    include: [
      path.join(repoRoot, "src/modules/mep/types.ts"),
      path.join(repoRoot, "src/modules/mep/sizing.ts"),
      path.join(repoRoot, "src/modules/mep/router.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const mepRouter = require(path.join(tmpOut, "modules/mep/router.js"));
  const mepSizing = require(path.join(tmpOut, "modules/mep/sizing.js"));

  console.log("\n=== MEP Auto-Routing tests ===\n");

  // ─── Sizing tests ──────────────────────────────────────────────────────

  console.log("Sizing (ASHRAE rules):");

  t("sizeDuct picks the smallest standard size for low flow", () => {
    const r = mepSizing.sizeForSystem("supply-air", 0.1, 4.5);
    assert(r.size.thickness >= 0.1, "width too small");
    assert(r.size.height >= 0.1, "height too small");
    assert(r.size.area >= 0.0222, "area too small");
    near(r.size.velocity, 0.1 / r.size.area, 0.01);
  });

  t("sizeDuct escalates to larger size for high flow", () => {
    const r = mepSizing.sizeForSystem("supply-air", 1.0, 4.5);
    // 1.0 m^3/s at 4.5 m/s = 0.222 m^2 required.
    // Sizing picks 0.45 x 0.5 = 0.225 m^2 (or similar).
    assert(r.size.area >= 0.222, "area too small");
    assert(r.size.thickness >= 0.4, "expected larger duct");
  });

  t("sizePipe picks the smallest DN for low flow", () => {
    const r = mepSizing.sizeForSystem("domestic-cold", 0.5, 1.5);
    assert(r.size.thickness >= 0.02, "diameter too small");
    assert(r.size.area >= 0.000333, "area too small");
  });

  t("sizePipe escalates to larger DN for high flow", () => {
    const r = mepSizing.sizeForSystem("chilled-water", 50, 2.0);
    assert(r.size.thickness >= 0.15, "expected larger pipe");
    assert(r.size.area >= 0.025, "area too small");
  });

  t("validateSize warns when velocity exceeds max", () => {
    const size = {
      thickness: 0.1, height: 0.1, area: 0.01,
      velocity: 8.0, rule: "test",
    };
    const warnings = mepSizing.validateSize(size, "supply-air");
    assert(warnings.length > 0, "expected warnings");
    assert(/exceeds/.test(warnings[0]), "expected 'exceeds' in warning");
  });

  t("validateSize passes when velocity is below max", () => {
    const size = {
      thickness: 0.3, height: 0.3, area: 0.09,
      velocity: 3.0, rule: "test",
    };
    const warnings = mepSizing.validateSize(size, "supply-air");
    assert(warnings.length === 0, "expected no warnings, got: " + JSON.stringify(warnings));
  });

  // ─── Routing tests ─────────────────────────────────────────────────────

  console.log("\nRouting (A* over 3D voxel grid):");

  t("routeSimple finds a straight-line path with no obstacles", () => {
    const r = mepRouter.routeSimple(
      { x: 0, y: 2.7, z: 0 },
      { x: 5, y: 2.7, z: 0 },
      "supply-air",
      0.5,
    );
    assert(r !== null, "expected route");
    assert(r.legs.length >= 1, "expected at least 1 leg");
    near(r.totalLength, 5.0, 0.5);
    assert(r.bendCount === 0, "expected 0 bends on straight path, got " + r.bendCount);
  });

  t("routeSimple finds an L-shaped path around an obstacle", () => {
    const obstacle = {
      min: { x: 2, y: 2.0, z: -1 },
      max: { x: 3, y: 3.4, z: 1 },
    };
    const r = mepRouter.routeSimple(
      { x: 0, y: 2.7, z: 0 },
      { x: 5, y: 2.7, z: 0 },
      "supply-air",
      0.5,
      [obstacle],
    );
    assert(r !== null, "expected route");
    assert(r.bendCount >= 1, "expected at least 1 bend to go around obstacle");
    assert(r.totalLength > 5.0, "expected path longer than straight line");
  });

  t("routeSimple respects via waypoints", () => {
    const r = mepRouter.route({
      start: { x: 0, y: 2.7, z: 0 },
      end: { x: 5, y: 2.7, z: 5 },
      system: "supply-air",
      flowRate: 0.5,
      via: [{ x: 2.5, y: 2.7, z: 2.5 }],
    });
    assert(r !== null, "expected route");
    assert(r.legs.length >= 2, "expected at least 2 legs with via waypoint, got " + (r ? r.legs.length : 0));
  });

  t("route includes sized dimensions in result", () => {
    const r = mepRouter.routeSimple(
      { x: 0, y: 2.7, z: 0 },
      { x: 3, y: 2.7, z: 0 },
      "supply-air",
      0.5,
    );
    assert(r !== null, "expected route");
    assert(typeof r.size.thickness === "number", "expected thickness");
    assert(typeof r.size.height === "number", "expected height");
    assert(typeof r.size.velocity === "number", "expected velocity");
    assert(r.size.thickness > 0, "expected positive thickness");
  });

  t("routeSimple respects voxelSize parameter", () => {
    const r1 = mepRouter.routeSimple(
      { x: 0, y: 2.7, z: 0 },
      { x: 2, y: 2.7, z: 0 },
      "supply-air",
      0.5,
    );
    const r2 = mepRouter.route({
      start: { x: 0, y: 2.7, z: 0 },
      end: { x: 2, y: 2.7, z: 0 },
      system: "supply-air",
      flowRate: 0.5,
      voxelSize: 0.5,
    });
    assert(r1 !== null && r2 !== null, "expected both routes");
    assert(r1.voxelSize === 0.25, "expected default voxel size");
    assert(r2.voxelSize === 0.5, "expected 0.5 voxel size");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;

} catch (e) {
  console.error("Test setup failed:", e.message);
  console.error(e.stack);
  process.exitCode = 2;
} finally {
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch { /* */ }
}
