/**
 * tests/mep-insulation.test.cjs
 *
 * Unit tests for the insulation module (pipe/duct heat loss, takeoff,
 * dew point and condensation screening).
 *
 * Run: `node tests/mep-insulation.test.cjs`
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
  if (Math.abs(a - b) > tol) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const repoRoot = path.resolve(__dirname, "..");
const tmpOut = path.join(os.tmpdir(), "obs-mep-insul-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-insul.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [path.join(repoRoot, "src/modules/mep/insulation.ts")],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const ins = require(path.join(tmpOut, "modules/mep/insulation.js"));

  // ── Pipe: radial conduction + outer film ──
  // OD 60 mm, 25 mm k=0.035 insulation, 60 C fluid, 25 C ambient:
  //   R_cond = ln(55/30)/(2*pi*0.035) = 2.7563 m.K/W
  //   R_conv = 1/(2*pi*0.055*9)       = 0.32153 m.K/W
  //   q'     = 35 / 3.0778            = 11.373 W/m
  t("insulated DN50 pipe loses ~11.4 W/m at 60 C", () => {
    const r = ins.insulatePipe({ outerDiameterM: 0.06, insulationThicknessM: 0.025, conductivityWmK: 0.035, fluidC: 60, ambientC: 25 });
    near(r.heatLossWPerM, 11.373, 0.05);
    near(r.insulatedOuterDiameterM, 0.11, 1e-9);
    near(r.surfaceAreaM2PerM, 2 * Math.PI * 0.055, 1e-9);
    near(r.surfaceTempC, 25 + 11.373 * 0.32153, 0.05);
  });
  t("zero thickness still computes (bare pipe film loss)", () => {
    const r = ins.insulatePipe({ outerDiameterM: 0.06, insulationThicknessM: 0, conductivityWmK: 0.035, fluidC: 60, ambientC: 25 });
    near(r.insulatedOuterDiameterM, 0.06, 1e-9);
    assert(r.heatLossWPerM > 0, "bare pipe still loses heat");
  });
  t("thicker insulation reduces loss monotonically", () => {
    let prev = Infinity;
    for (const thk of [0.01, 0.025, 0.05, 0.1]) {
      const r = ins.insulatePipe({ outerDiameterM: 0.06, insulationThicknessM: thk, conductivityWmK: 0.035, fluidC: 60, ambientC: 25 });
      assert(r.heatLossWPerM < prev, `${thk} m must beat thinner wraps`);
      prev = r.heatLossWPerM;
    }
  });

  // ── Duct: flat wall + outer film ──
  // 500x250, 25 mm k=0.035, 12 C inside, 25 C ambient:
  //   U = 1/(0.025/0.035 + 1/8.3) = 1.198 W/m2.K
  //   perimeter = 2*(0.55+0.30)   = 1.70 m
  //   q' = 1.198*1.70*(-13)       = -26.5 W/m (cold duct gains heat)
  t("insulated supply duct gains ~26.5 W/m in a 25 C ceiling", () => {
    const r = ins.insulateDuct({ widthM: 0.5, heightM: 0.25, insulationThicknessM: 0.025, conductivityWmK: 0.035, internalC: 12, ambientC: 25 });
    near(r.uValueWm2K, 1.198, 0.005);
    near(r.heatLossWPerM, -26.47, 0.2);
    near(r.insulatedWidthM, 0.55, 1e-9);
    near(r.insulatedHeightM, 0.30, 1e-9);
    near(r.surfaceAreaM2PerM, 1.7, 1e-9);
  });

  // ── Takeoff ──
  t("round takeoff: jacket area + material volume", () => {
    const r = ins.runTakeoff(10, { outerDiameterM: 0.06 }, 0.025);
    near(r.areaM2, Math.PI * 0.11 * 10, 1e-9);
    near(r.volumeM3, Math.PI * 0.06 * 10 * 0.025, 1e-9);
  });
  t("rect takeoff: jacket area + material volume", () => {
    const r = ins.runTakeoff(10, { widthM: 0.5, heightM: 0.25 }, 0.025);
    near(r.perimeterM, 1.7, 1e-9);
    near(r.areaM2, 17, 1e-9);
    // Bare perimeter 2*(0.5+0.25)=1.5 m x 10 m x 0.025 m = 0.375 m^3.
    near(r.volumeM3, 1.5 * 10 * 0.025, 1e-9);
  });

  // ── Dew point & condensation ──
  t("dew point of 25 C at 70% RH is ~19.1 C (Magnus)", () => {
    near(ins.dewPointC(25, 70), 19.1, 0.3);
  });
  t("condensation risk verdict", () => {
    const safe = ins.condensationRisk(28.6, 25, 70);
    assert(!safe.risk, "28.6 C surface must be safe at 25 C / 70% RH");
    const sweaty = ins.condensationRisk(15, 25, 70);
    assert(sweaty.risk && sweaty.message.toLowerCase().includes("condensation"), "15 C surface must sweat");
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
