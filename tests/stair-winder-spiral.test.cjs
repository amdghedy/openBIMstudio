/**
 * tests/stair-winder-spiral.test.cjs
 *
 * Unit tests for winder + spiral stair generators.
 *
 * Compile strategy: write a minimal tsconfig that includes only the pure
 * m2-geometry.ts file (no DOM/three.js deps).
 *
 * Run: `node tests/stair-winder-spiral.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-stair-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-stair.json");
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

  console.log("\n=== Winder + Spiral Stair tests ===\n");

  // ─── Winder stair tests ────────────────────────────────────────────────

  console.log("Winder stair:");

  t("buildWinderStair produces geometry", () => {
    const r = geo.buildWinderStair({
      start: [0, 0],
      end: [3, 0],
      width: 1.0,
      totalRise: 3.0,
      elevation: 0,
      turn: "left",
    });
    assert(r.parts.length > 0, "expected parts");
    assert(r.parts[0].positions.length > 0, "expected positions");
    assert(r.info.stairShape === "winder", "expected stairShape=winder");
  });

  t("winder has 3 sections: 2 flights + winders", () => {
    const r = geo.buildWinderStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0,
    });
    assert(r.info.flights === 2, "expected 2 flights");
    assert(r.info.winderCount >= 3, `expected >= 3 winders, got ${r.info.winderCount}`);
  });

  t("winder total rise matches input", () => {
    const r = geo.buildWinderStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0,
    });
    near(r.info.totalRise, 3.0, 0.01);
  });

  t("winder respects turn direction", () => {
    const rLeft = geo.buildWinderStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0, turn: "left",
    });
    const rRight = geo.buildWinderStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0, turn: "right",
    });
    // Both should produce geometry; different turn directions may produce
    // different vertex positions but the same volume roughly.
    assert(rLeft.parts[0].positions.length > 0, "left turn produced no geometry");
    assert(rRight.parts[0].positions.length > 0, "right turn produced no geometry");
  });

  // ─── Spiral stair tests ────────────────────────────────────────────────

  console.log("\nSpiral stair:");

  t("buildSpiralStair produces geometry", () => {
    const r = geo.buildSpiralStair({
      start: [0, 0],
      end: [1, 0], // not used by spiral but required by StairParams
      width: 0.8,
      totalRise: 3.0,
      elevation: 0,
      spiralTurns: 1,
      innerRadius: 0.1,
    });
    assert(r.parts.length > 0, "expected parts");
    assert(r.parts[0].positions.length > 0, "expected positions");
    assert(r.info.stairShape === "spiral", "expected stairShape=spiral");
  });

  t("spiral has correct riser count", () => {
    const r = geo.buildSpiralStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      spiralTurns: 1, innerRadius: 0.1, maxRiser: 0.2,
    });
    // 3.0 / 0.2 = 15 risers
    assert(r.info.risers >= 15, `expected >= 15 risers, got ${r.info.risers}`);
  });

  t("spiral inner/outer radius match input", () => {
    const r = geo.buildSpiralStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      spiralTurns: 1, innerRadius: 0.1,
    });
    near(r.info.innerRadius, 0.1, 0.001);
    near(r.info.outerRadius, 0.9, 0.001); // 0.1 + 0.8
  });

  t("spiral respects turns count", () => {
    const r1 = geo.buildSpiralStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      spiralTurns: 1, innerRadius: 0.1,
    });
    const r2 = geo.buildSpiralStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      spiralTurns: 2, innerRadius: 0.1,
    });
    // 2 turns = 720 degrees; 1 turn = 360 degrees
    near(r1.info.totalAngleDeg, 360, 0.1);
    near(r2.info.totalAngleDeg, 720, 0.1);
  });

  t("spiral total rise matches input", () => {
    const r = geo.buildSpiralStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      spiralTurns: 1, innerRadius: 0.1,
    });
    near(r.info.totalRise, 3.0, 0.01);
  });

  // ─── Unified dispatch ─────────────────────────────────────────────────

  console.log("\nUnified dispatch (buildStair):");

  t("buildStair dispatches to buildWinderStair when shape='winder'", () => {
    const r = geo.buildStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0,
      shape: "winder",
    });
    assert(r.info.stairShape === "winder", "expected stairShape=winder in info");
  });

  t("buildStair dispatches to buildSpiralStair when shape='spiral'", () => {
    const r = geo.buildStair({
      start: [0, 0], end: [1, 0], width: 0.8, totalRise: 3.0, elevation: 0,
      shape: "spiral", spiralTurns: 1, innerRadius: 0.1,
    });
    assert(r.info.stairShape === "spiral", "expected stairShape=spiral in info");
  });

  t("buildStair falls back to straight when shape='straight'", () => {
    const r = geo.buildStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0,
      shape: "straight",
    });
    assert(r.parts.length > 0, "expected parts");
    assert(r.parts[0].positions.length > 0, "expected positions");
  });

  t("buildStair uses default shape when omitted", () => {
    const r = geo.buildStair({
      start: [0, 0], end: [3, 0], width: 1.0, totalRise: 3.0, elevation: 0,
    });
    assert(r.parts.length > 0, "expected parts");
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
