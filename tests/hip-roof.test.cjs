/**
 * tests/hip-roof.test.cjs
 *
 * Unit tests for hip + valley roof geometry generators.
 * Validates:
 *   - Hip roof on a square footprint produces a pyramid (ridge length = 0)
 *   - Hip roof on a rectangular footprint produces a ridge line (ridge length > 0)
 *   - Hip roof rises from eaves to ridge uniformly
 *   - Hip roof is watertight (every undirected edge shared by exactly 2 triangles)
 *   - Valley roof has two perpendicular gable surfaces
 *   - Valley roof ridge height = min of the two gable rises
 *   - Valley roof is watertight
 *
 * Compile strategy: write a minimal tsconfig that includes only the pure
 * m2-geometry.ts file (no DOM/three.js deps). Skip index.ts to avoid the
 * clash-worker-client.ts import.meta issue.
 *
 * Run: `node tests/hip-roof.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-hip-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-hip.json");
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
      path.join(repoRoot, "src/modules/bim-gaps/m2-geometry.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const geo = require(path.join(tmpOut, "modules/bim-gaps/m2-geometry.js"));

  console.log("\n=== Hip + Valley Roof tests ===\n");

  // ─── Hip roof tests ────────────────────────────────────────────────────

  console.log("Hip roof:");

  t("square footprint produces pyramid (ridge length = 0)", () => {
    // 4x4 m square footprint, slope 30 degrees
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
    });
    // Ridge length should be ~0 for a square footprint (degenerate to point)
    assert(r.info.roofType === "hip", "expected roofType=hip");
    near(r.info.ridgeLength, 0, 0.01);
    // Ridge height = elevation + slope * halfShortestSide
    // halfShortestSide = 4/2 = 2, slope = tan(30) ~ 0.577
    // ridge height = 3 + 0.577 * 2 = 4.155
    near(r.info.ridgeHeight, 3 + Math.tan(Math.PI / 6) * 2, 0.01);
  });

  t("rectangular footprint produces ridge line (ridge length > 0)", () => {
    // 6x4 m rectangular footprint (W=4, L=6)
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
    });
    // Ridge length should be L - W = 6 - 4 = 2 m
    assert(r.info.ridgeLength > 0.5, `expected ridge length > 0.5, got ${r.info.ridgeLength}`);
    near(r.info.ridgeLength, 2.0, 0.5);
    // Ridge height = elevation + slope * halfShortestSide = 3 + 0.577 * 2 = 4.155
    near(r.info.ridgeHeight, 3 + Math.tan(Math.PI / 6) * 2, 0.01);
  });

  t("rises uniformly from eaves to ridge", () => {
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 45,
    });
    // At ridge height = 3 + tan(45) * 2 = 3 + 2 = 5 m
    near(r.info.ridgeHeight, 5, 0.01);
    // Rise = 2 m (half shortest side * slope)
    near(r.info.rise, 2, 0.01);
  });

  t("generates watertight mesh for square hip roof", () => {
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
    });
    assert(r.parts.length > 0, "expected parts");
    const positions = r.parts[0].positions;
    assert(positions.length > 0, "expected positions");
    assert(geo.isWatertight(positions), "expected watertight mesh");
    // Volume should be positive (outward-wound)
    const vol = geo.signedVolume(positions);
    assert(vol > 0, `expected positive volume, got ${vol}`);
  });

  t("generates watertight mesh for rectangular hip roof", () => {
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 3,
      thickness: 0.15,
      slopeDeg: 35,
    });
    assert(geo.isWatertight(r.parts[0].positions), "expected watertight mesh");
    assert(geo.signedVolume(r.parts[0].positions) > 0, "expected positive volume");
  });

  t("respects clamped slope (1 to 75 degrees)", () => {
    // Out-of-range slope should be clamped, not throw
    const r = geo.buildHipRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 0,
      thickness: 0.1,
      slopeDeg: 200, // would be clamped to 75
    });
    assert(r.info.ridgeHeight > 0, "expected positive ridge height");
    // tan(75) ~ 3.73, halfShortestSide = 2, so ridge = 0 + 3.73 * 2 = 7.46
    assert(r.info.ridgeHeight < 8, "expected clamped ridge height");
  });

  // ─── Valley roof tests ────────────────────────────────────────────────

  console.log("\nValley roof:");

  t("square footprint produces equal gable rises", () => {
    const r = geo.buildValleyRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
      dirDeg: 0, // first gable direction = +X
    });
    assert(r.info.roofType === "valley", "expected roofType=valley");
    // Two perpendicular gables on a 4x4 square: rise1 = rise2 = tan(30) * 2
    const expected = Math.tan(Math.PI / 6) * 2;
    near(r.info.rise1, expected, 0.01);
    near(r.info.rise2, expected, 0.01);
    near(r.info.ridgeHeight, 3 + expected, 0.01);
  });

  t("rectangular footprint produces unequal gable rises", () => {
    // 6x4 m rectangle, dirDeg=0 means first gable along +X (long axis)
    const r = geo.buildValleyRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 0,
      thickness: 0.1,
      slopeDeg: 30,
      dirDeg: 0,
    });
    // half1 (along +X) = 3, half2 (along +Z) = 2
    // rise1 = tan(30) * 3, rise2 = tan(30) * 2
    const expected1 = Math.tan(Math.PI / 6) * 3;
    const expected2 = Math.tan(Math.PI / 6) * 2;
    near(r.info.rise1, expected1, 0.01);
    near(r.info.rise2, expected2, 0.01);
    // Ridge height = min(rise1, rise2) = rise2 (smaller)
    near(r.info.ridgeHeight, expected2, 0.01);
    near(r.info.rise, expected2, 0.01);
  });

  t("generates watertight mesh", () => {
    const r = geo.buildValleyRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 0,
      thickness: 0.15,
      slopeDeg: 30,
      dirDeg: 0,
    });
    assert(geo.isWatertight(r.parts[0].positions), "expected watertight mesh");
    assert(geo.signedVolume(r.parts[0].positions) > 0, "expected positive volume");
  });

  t("respects dirDeg rotation (rotated 90 degrees gives swapped rises)", () => {
    const r0 = geo.buildValleyRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 0, thickness: 0.1, slopeDeg: 30, dirDeg: 0,
    });
    const r90 = geo.buildValleyRoof({
      polygon: [[0, 0], [6, 0], [6, 4], [0, 4]],
      elevation: 0, thickness: 0.1, slopeDeg: 30, dirDeg: 90,
    });
    // Rotating 90 deg should swap rise1 and rise2
    near(r0.info.rise1, r90.info.rise2, 0.01);
    near(r0.info.rise2, r90.info.rise1, 0.01);
  });

  // ─── Unified buildRoof dispatch ─────────────────────────────────────

  console.log("\nUnified dispatch (buildRoof):");

  t("buildRoof dispatches to buildHipRoof when roofType='hip'", () => {
    const r = geo.buildRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
      roofType: "hip",
    });
    assert(r.info.roofType === "hip", "expected roofType=hip in info");
    near(r.info.ridgeLength, 0, 0.01);
  });

  t("buildRoof dispatches to buildValleyRoof when roofType='valley'", () => {
    const r = geo.buildRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 0,
      thickness: 0.1,
      slopeDeg: 30,
      roofType: "valley",
      dirDeg: 0,
    });
    assert(r.info.roofType === "valley", "expected roofType=valley in info");
  });

  t("buildRoof falls back to gable when roofType='gable'", () => {
    const r = geo.buildRoof({
      polygon: [[0, 0], [4, 0], [4, 4], [0, 4]],
      elevation: 3,
      thickness: 0.2,
      slopeDeg: 30,
      roofType: "gable",
    });
    // Gable doesn't set roofType in info, but should produce geometry
    assert(r.parts.length > 0, "expected parts");
    assert(r.parts[0].positions.length > 0, "expected positions");
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
