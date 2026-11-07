/**
 * tests/mep-electrical-calc.test.cjs
 *
 * Unit tests for the electrical quick-engineering module
 * (voltage drop, conductor selection, coordination check).
 *
 * Run: `node tests/mep-electrical-calc.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-mep-elcalc-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-elcalc.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [path.join(repoRoot, "src/modules/mep/electrical-calc.ts")],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const el = require(path.join(tmpOut, "modules/mep/electrical-calc.js"));

  // ── Conductor resistance (IEC 60228 + temperature correction) ──
  t("25 mm2 Cu at 20 C is 0.727 ohm/km; at 70 C it is corrected", () => {
    near(el.conductorResistanceOhmKm(25, "cu", 20), 0.727, 1e-9);
    near(el.conductorResistanceOhmKm(25, "cu", 70), 0.727 * (1 + 0.00393 * 50), 1e-9);
  });
  t("aluminium is copper x 1.64 at the same temperature", () => {
    // Aluminium also has its own temperature coefficient (0.00403 /K).
    const expected = 0.727 * (1 + el.ALPHA_AL * 50) * el.AL_RESISTANCE_FACTOR;
    near(el.conductorResistanceOhmKm(25, "al", 70), expected, 1e-9);
  });
  t("unknown size returns 0", () => {
    assert(el.conductorResistanceOhmKm(999) === 0, "expected 0");
  });
  t("conductor sizes table is ascending", () => {
    for (let i = 1; i < el.CONDUCTOR_SIZES.length; i++) {
      assert(el.CONDUCTOR_SIZES[i] > el.CONDUCTOR_SIZES[i - 1], "must ascend");
    }
  });

  // ── Voltage drop ──
  t("3-phase drop: 400 V, 100 A, 50 m, 25 mm2, pf 0.9 -> ~7.09 V (1.77%)", () => {
    const r = el.voltageDrop({ phase: 3, voltageV: 400, currentA: 100, lengthM: 50, conductorMm2: 25, powerFactor: 0.9 });
    near(r.dropV, 7.086, 0.01);
    near(r.dropPercent, 1.7715, 0.005);
    assert(r.pathFactor === Math.sqrt(3), "3-phase uses sqrt(3)");
  });
  t("1-phase drop doubles the path", () => {
    const r = el.voltageDrop({ phase: 1, voltageV: 230, currentA: 100, lengthM: 50, conductorMm2: 25, powerFactor: 1 });
    const rOhmKm = el.conductorResistanceOhmKm(25, "cu", 70);
    near(r.dropV, 100 * 2 * 0.05 * rOhmKm, 1e-6);
    near(r.dropPercent, (r.dropV / 230) * 100, 1e-9);
  });
  t("reactance only enters through the power factor", () => {
    const pf1 = el.voltageDrop({ phase: 3, voltageV: 400, currentA: 100, lengthM: 50, conductorMm2: 25, powerFactor: 1 });
    const pf07 = el.voltageDrop({ phase: 3, voltageV: 400, currentA: 100, lengthM: 50, conductorMm2: 25, powerFactor: 0.7 });
    near(pf1.reactanceOhm, pf07.reactanceOhm, 1e-9);
    const rOhmKm = el.conductorResistanceOhmKm(25, "cu", 70);
    // At pf 0.7 the resistive term alone is I*sqrt(3)*L*R'*0.7 — the measured
    // drop must exceed it (reactance is doing work) while staying below the
    // pf=1 drop for this R>>X cable.
    const resistiveOnly = 100 * Math.sqrt(3) * 0.05 * rOhmKm * 0.7;
    assert(pf07.dropV > resistiveOnly, "reactance must add to the 0.7 pf drop");
    assert(pf07.dropV < pf1.dropV, "R>>X cable drops most at unity pf");
  });

  // ── Max length ──
  t("maxCableLengthForDrop inverts voltageDrop exactly", () => {
    const L = el.maxCableLengthForDrop({ phase: 3, voltageV: 400, currentA: 100, conductorMm2: 25, maxDropPercent: 3, powerFactor: 0.9 });
    const back = el.voltageDrop({ phase: 3, voltageV: 400, currentA: 100, lengthM: L, conductorMm2: 25, powerFactor: 0.9 });
    near(back.dropPercent, 3, 1e-6);
  });

  // ── Conductor selection ──
  t("selectConductor picks 25 mm2 for 100 A (101 A ref)", () => {
    const r = el.selectConductor(100);
    assert(r != null && r.mm2 === 25, "expected 25 mm2");
    near(r.ampacityA, 101, 1e-9);
  });
  t("selectConductor steps up across boundaries; null when exhausted", () => {
    assert(el.selectConductor(24).mm2 === 2.5, "24 A -> 2.5 mm2");
    assert(el.selectConductor(24.1).mm2 === 4, "24.1 A -> 4 mm2");
    assert(el.selectConductor(500) === null, "500 A exceeds the table");
  });
  t("aluminium selection derates by 0.78", () => {
    assert(el.selectConductor(100, "al").mm2 === 50, "100 A Al needs 50 mm2");
  });

  // ── Coordination check ──
  t("conductorCheck passes a healthy circuit", () => {
    const r = el.conductorCheck({ designCurrentA: 90, breakerRatingA: 100, conductorMm2: 25 });
    assert(r.ok && r.findings.length === 0, "expected clean: " + r.findings.join("; "));
    assert(r.dropPercent === null, "no length given -> no drop report");
  });
  t("conductorCheck flags breaker above cable ampacity", () => {
    const r = el.conductorCheck({ designCurrentA: 60, breakerRatingA: 100, conductorMm2: 16 });
    assert(!r.ok && r.findings.some((f) => f.includes("In \u2264 Iz")), "expected In<=Iz finding");
  });
  t("conductorCheck flags design current above breaker", () => {
    const r = el.conductorCheck({ designCurrentA: 120, breakerRatingA: 100, conductorMm2: 25 });
    assert(!r.ok && r.findings.some((f) => f.includes("exceeds the 100 A breaker")), "expected breaker finding");
  });
  t("conductorCheck advisory voltage drop on length", () => {
    // No pf supplied -> resistive (pf 1) advisory: 100 A, 50 m, 25 mm2, 3ph.
    const r = el.conductorCheck({ designCurrentA: 100, breakerRatingA: 100, conductorMm2: 25, lengthM: 50, voltageV: 400, phase: 3 });
    near(r.dropPercent, 1.8833, 0.005);
    assert(r.ok, "1.88% drop is within the 3% default");
    const withPf = el.conductorCheck({ designCurrentA: 100, breakerRatingA: 100, conductorMm2: 25, lengthM: 50, voltageV: 400, phase: 3, powerFactor: 0.9 });
    near(withPf.dropPercent, 1.7715, 0.005);
    const bad = el.conductorCheck({ designCurrentA: 100, breakerRatingA: 100, conductorMm2: 4, lengthM: 100, voltageV: 230, phase: 1, maxDropPercent: 3 });
    assert(!bad.ok && bad.findings.some((f) => f.includes("Voltage drop")), "expected drop finding");
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
