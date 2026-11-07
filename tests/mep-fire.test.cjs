/**
 * tests/mep-fire.test.cjs
 *
 * Unit tests for the sprinkler hydraulics module (K-factor, density/area).
 *
 * Run: `node tests/mep-fire.test.cjs`
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
const tmpOut = path.join(os.tmpdir(), "obs-mep-fire-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-fire.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "commonjs", moduleResolution: "node",
      strict: true, skipLibCheck: true, esModuleInterop: true,
      outDir: tmpOut, rootDir: path.join(repoRoot, "src"),
    },
    include: [path.join(repoRoot, "src/modules/mep/fire.ts")],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const fire = require(path.join(tmpOut, "modules/mep/fire.js"));

  // ── K-factor law Q = K·sqrt(P) ──
  t("K80 @ 0.5 bar -> 56.57 L/min", () => {
    near(fire.headFlowLmin(80, 0.5), 80 * Math.sqrt(0.5), 1e-9);
  });
  t("pressure roundtrip from flow", () => {
    const p = fire.minHeadPressureBar(80, fire.headFlowLmin(80, 0.5));
    near(p, 0.5, 1e-9);
  });
  t("zero/negative inputs return zero", () => {
    assert(fire.headFlowLmin(80, -1) === 0 && fire.headFlowLmin(0, 1) === 0, "expected 0");
    assert(fire.minHeadPressureBar(80, -5) === 0, "expected 0");
  });

  // ── Density / area ──
  t("density flow: 4.1 L/min.m2 x 12 m2 = 49.2 L/min", () => {
    near(fire.densityFlowLmin(4.1, 12), 49.2, 1e-9);
  });
  t("end-head pressure for light hazard, K80, 12 m2 coverage", () => {
    near(fire.headPressureForDensity(80, 4.1, 12), Math.pow(49.2 / 80, 2), 1e-9);
  });

  // ── Hazard presets ──
  t("preset lookup: light -> 4.1 L/min.m2, 20.9 m2, 378 L/min hose", () => {
    const h = fire.hazardPreset("light");
    assert(h != null, "expected preset");
    near(h.densityLminM2, 4.1, 1e-9);
    near(h.maxCoverageM2, 20.9, 1e-9);
    near(h.hoseAllowanceLmin, 378, 1e-9);
  });
  t("preset lookup is case-insensitive; unknown returns null", () => {
    assert(fire.hazardPreset("Light") != null, "expected preset");
    assert(fire.hazardPreset("vault") === null, "expected null");
  });

  // ── Design demand ──
  t("light hazard full design demand", () => {
    const r = fire.designDemand({ hazardId: "light", designAreaM2: 139, headCoverageM2: 12, kFactor: 80 });
    assert(r.headCount === Math.ceil(139 / 12), "head count = ceil(area/coverage)");
    near(r.endHeadFlowLmin, 49.2, 1e-9);
    near(r.sprinklerDemandLmin, 49.2 * r.headCount, 1e-9);
    near(r.hoseAllowanceLmin, 378, 1e-9);
    near(r.totalDemandLmin, 49.2 * r.headCount + 378, 1e-9);
    assert(r.durationMin === 30, "light hazard duration 30 min");
    assert(r.warnings.length === 0, "expected no warnings, got: " + r.warnings.join("; "));
  });
  t("explicit head count is honoured", () => {
    const r = fire.designDemand({ hazardId: "light", designAreaM2: 139, headCoverageM2: 12, kFactor: 80, headCount: 15 });
    assert(r.headCount === 15, "expected 15 heads");
    near(r.sprinklerDemandLmin, 49.2 * 15, 1e-9);
  });
  t("coverage above the preset max warns", () => {
    const r = fire.designDemand({ hazardId: "light", designAreaM2: 139, headCoverageM2: 25, kFactor: 80 });
    assert(r.warnings.some((w) => w.includes("20.9")), "expected coverage warning");
  });
  t("low end-head pressure warns", () => {
    const r = fire.designDemand({ hazardId: "light", designAreaM2: 139, headCoverageM2: 4, kFactor: 200 });
    assert(r.endHeadPressureBar < 0.35, "expected sub-0.35 bar pressure");
    assert(r.warnings.some((w) => w.includes("0.35")), "expected pressure warning");
  });
  t("no hazard and no density warns", () => {
    const r = fire.designDemand({ designAreaM2: 139, headCoverageM2: 12, kFactor: 80 });
    assert(r.warnings.some((w) => w.includes("density")), "expected density warning");
  });

  // ── Velocity check ──
  t("pipe velocity check passes and fails", () => {
    const ok = fire.pipeVelocityCheck(600, 0.08);   // 600 L/min in DN80
    assert(ok.ok && ok.velocityMs > 0 && ok.velocityMs <= 6.1, `expected pass, got ${ok.velocityMs}`);
    const bad = fire.pipeVelocityCheck(600, 0.027); // same flow in 27 mm ID
    assert(!bad.ok && bad.velocityMs > 6.1, "expected fail");
    assert(fire.SPRINKLER_MAX_VELOCITY_MS === 6.1, "practice limit 6.1 m/s");
  });

  // ── K-factor catalogue ──
  t("K-factor catalogue includes K80/K5.6", () => {
    const k80 = fire.K_FACTORS.find((k) => k.k === 80);
    assert(k80 != null && k80.imperial === "K5.6", "expected K80 with imperial twin");
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
