/**
 * tests/mep-plumbing.test.cjs
 *
 * Unit tests for the MEP plumbing demand module (Hunter curve + Joukowsky).
 *
 * Approach: compile the pure module with tsc to a temp dir, then require()
 * the compiled output and run assertions.
 *
 * Run: `node tests/mep-plumbing.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-mep-plumbing-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-plumbing.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [path.join(repoRoot, "src/modules/mep/plumbing.ts")],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const plumbing = require(path.join(tmpOut, "modules/mep/plumbing.js"));

  // ── Hunter curve anchor rows (verified against IPC/UPC Table B.5.4) ──
  t("tank curve: 120 WSFU -> 49 gpm (table row)", () => {
    near(plumbing.fixtureUnitsToDemand(120, "tank").gpm, 49, 0.01);
  });
  t("valve curve: 120 WSFU -> 74 gpm (table row)", () => {
    near(plumbing.fixtureUnitsToDemand(120, "valve").gpm, 74, 0.01);
  });
  t("tank curve: 20 WSFU -> 14 gpm", () => {
    near(plumbing.fixtureUnitsToDemand(20, "tank").gpm, 14, 0.01);
  });
  t("valve curve: 20 WSFU -> 35 gpm", () => {
    near(plumbing.fixtureUnitsToDemand(20, "valve").gpm, 35, 0.01);
  });
  t("curves converge at 1000 WSFU -> 210 gpm", () => {
    near(plumbing.fixtureUnitsToDemand(1000, "tank").gpm, 210, 0.01);
    near(plumbing.fixtureUnitsToDemand(1000, "valve").gpm, 210, 0.01);
  });
  t("beyond table: 4000 WSFU -> 525 gpm, extrapolation above is monotonic", () => {
    near(plumbing.fixtureUnitsToDemand(4000, "tank").gpm, 525, 0.01);
    const a = plumbing.fixtureUnitsToDemand(4000, "tank").gpm;
    const b = plumbing.fixtureUnitsToDemand(8000, "tank").gpm;
    assert(b > a, "extrapolation must increase");
    assert(b < a * 1.7, "extrapolation must stay in a sane band");
  });
  t("below first row clamps conservatively", () => {
    near(plumbing.fixtureUnitsToDemand(1, "tank").gpm, 3, 0.01);
  });
  t("L/s conversion uses 0.0630902 L/s per gpm", () => {
    near(plumbing.fixtureUnitsToDemand(120, "tank").ls, 49 * plumbing.GPM_TO_LS, 1e-6);
  });
  t("demand is monotonic over the whole range", () => {
    let prev = 0;
    for (const fu of [3, 10, 40, 120, 500, 1000, 2000, 4000, 10000]) {
      const g = plumbing.fixtureUnitsToDemand(fu, "tank").gpm;
      assert(g > prev, `demand at ${fu} FU (${g}) must exceed previous (${prev})`);
      prev = g;
    }
  });

  // ── Fixture weights & demand-from-fixtures ──
  t("totalWsfu sums known fixture weights", () => {
    near(plumbing.totalWsfu({ "water-closet-flush-valve": 2, "lavatory-public": 4 }), 10 * 2 + 2 * 4, 1e-9);
  });
  t("totalWsfu returns -1 for unknown keys", () => {
    assert(plumbing.totalWsfu({ "flux-capacitor": 1 }) === -1, "expected -1");
  });
  t("demandFromFixtures errors on unknown key and zero load", () => {
    assert(plumbing.demandFromFixtures({ nope: 1 }).error != null, "expected error");
    assert(plumbing.demandFromFixtures({}).error != null, "expected error");
  });
  t("demandFromFixtures happy path", () => {
    const r = plumbing.demandFromFixtures({ "water-closet-flush-valve": 12, "lavatory-public": 24 });
    near(r.wsfu, 10 * 12 + 2 * 24, 1e-9);
    near(r.gpm, plumbing.fixtureUnitsToDemand(r.wsfu, "valve").gpm, 1e-9);
  });

  // ── Joukowsky water hammer ──
  t("rigid pipe: wave speed sqrt(K/rho) ~ 1480 m/s", () => {
    const r = plumbing.waterHammerSurge({ velocityChangeMs: 1 });
    near(r.waveSpeedMs, Math.sqrt(2.19e9 / 1000), 1);
    near(r.surgePressureBar, r.waveSpeedMs * 1000 / 1e5, 0.01);
  });
  t("elastic pipe: thin-wall wave speed correction", () => {
    const r = plumbing.waterHammerSurge({ velocityChangeMs: 1, innerDiameterM: 0.1, wallThicknessM: 0.004 });
    const c0 = Math.sqrt(2.19e9 / 1000);
    const expected = c0 / Math.sqrt(1 + (2.19e9 * 0.1) / (200e9 * 0.004));
    near(r.waveSpeedMs, expected, 1);
    assert(r.waveSpeedMs < c0, "elastic correction must slow the wave");
  });
  t("surge scales linearly with velocity change", () => {
    const a = plumbing.waterHammerSurge({ velocityChangeMs: 1 }).surgePressurePa;
    const b = plumbing.waterHammerSurge({ velocityChangeMs: 3 }).surgePressurePa;
    near(b, 3 * a, 1e-6);
  });
  t("surge margin check passes and fails correctly", () => {
    const ok = plumbing.surgeMarginCheck({ workingPressureBar: 4, surgePressureBar: 5, pipeRatingBar: 16 });
    assert(ok.ok && ok.marginBar === 7, "expected 7 bar margin");
    const bad = plumbing.surgeMarginCheck({ workingPressureBar: 12, surgePressureBar: 5, pipeRatingBar: 16 });
    assert(!bad.ok && bad.marginBar === -1, "expected -1 bar margin");
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
