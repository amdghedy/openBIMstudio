/**
 * tests/mep-convert.test.cjs
 *
 * Unit tests for the MEP conversion module (duct equivalents, ACH, units).
 *
 * Run: `node tests/mep-convert.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-mep-convert-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-convert.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [
      path.join(repoRoot, "src/modules/mep/types.ts"),
      path.join(repoRoot, "src/modules/mep/convert.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const convert = require(path.join(tmpOut, "modules/mep/convert.js"));

  // ── Duct equivalents ──
  t("ASHRAE hydraulic equivalent diameter of 500x250", () => {
    // De = 1.30 (wh)^0.625 / (w+h)^0.25 = 380.7 mm
    near(convert.equivalentDiameter(0.5, 0.25), 0.3807, 0.0005);
  });
  t("equal-area diameter of 500x250", () => {
    near(convert.equalAreaDiameter(0.5, 0.25), Math.sqrt(4 * 0.125 / Math.PI), 1e-6);
  });
  t("round -> rect equivalent recovers 500x250 at 2:1", () => {
    const r = convert.roundToRectEquivalent(0.3807, 2);
    near(r.w, 0.5, 0.002);
    near(r.h, 0.25, 0.002);
  });
  t("round -> rect roundtrip holds across sizes and aspects", () => {
    for (const d of [0.2, 0.5, 1.0]) {
      for (const a of [1, 2, 3]) {
        const { w, h } = convert.roundToRectEquivalent(d, a);
        near(convert.equivalentDiameter(w, h), d, 1e-4);
        near(w / h, a, 1e-6);
      }
    }
  });
  t("degenerate inputs return zero, not NaN", () => {
    assert(convert.equivalentDiameter(0, 1) === 0 && convert.equalAreaDiameter(-1, 1) === 0, "expected 0");
    assert(convert.roundToRectEquivalent(0.5, 0).w === 0, "expected 0 for bad aspect");
  });
  t("snapToStandard rounds up to the next listed size", () => {
    near(convert.snapToStandard(0.25, [0.1, 0.2, 0.3]), 0.3, 1e-9);
    near(convert.snapToStandard(0.2, [0.1, 0.2, 0.3]), 0.2, 1e-9);
    near(convert.snapToStandard(0.35, [0.1, 0.2, 0.3]), 0.35, 1e-9);
  });

  // ── Air changes ──
  t("6 ACH in 120 m^3 -> 0.2 m^3/s", () => {
    near(convert.achToAirflow(120, 6), 0.2, 1e-9);
    near(convert.airflowToAch(0.2, 120), 6, 1e-9);
  });
  t("room volume and airflow from room", () => {
    near(convert.roomVolume(20, 3), 60, 1e-9);
    near(convert.airflowFromRoom(20, 3, 6), 0.1, 1e-9);
  });
  t("ACH helpers guard zero volume", () => {
    assert(convert.airflowToAch(1, 0) === 0 && convert.achToAirflow(0, 6) === 0, "expected 0");
  });

  // ── Units ──
  t("CFM <-> L/s", () => {
    near(convert.cfmToLs(100), 47.19474, 1e-4);
    near(convert.lsToCfm(convert.cfmToLs(100)), 100, 1e-6);
  });
  t("GPM <-> L/s", () => {
    near(convert.gpmToLs(10), 0.630902, 1e-6);
    near(convert.lsToGpm(convert.gpmToLs(10)), 10, 1e-6);
  });
  t("FPM <-> m/s", () => {
    near(convert.fpmToMs(1000), 5.08, 1e-9);
    near(convert.msToFpm(5.08), 1000, 1e-6);
  });
  t("inWG <-> Pa and psi <-> kPa", () => {
    near(convert.inWgToPa(1), 249.0889, 1e-3);
    near(convert.paToInWg(249.0889), 1, 1e-9);
    near(convert.psiToKpa(10), 68.94757, 1e-4);
    near(convert.kpaToPsi(68.94757), 10, 1e-6);
  });
  t("L/min <-> L/s", () => {
    near(convert.lminToLs(60), 1, 1e-9);
    near(convert.lsToLmin(1), 60, 1e-9);
  });
  t("run midpoint", () => {
    const m = convert.runMidpoint({ x: 0, y: 1, z: 0 }, { x: 4, y: 3, z: 10 });
    near(m.x, 2, 1e-9); near(m.y, 2, 1e-9); near(m.z, 5, 1e-9);
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
