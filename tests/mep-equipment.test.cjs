/**
 * tests/mep-equipment.test.cjs
 *
 * Unit tests for fan & pump duty selection (src/modules/mep/equipment.ts).
 * Values verified by hand-calculation of the documented formulas.
 *
 * Run: `node tests/mep-equipment.test.cjs`
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

function near(a, b, tol = 1e-3) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-equipment-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/equipment.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const m = require(path.join(tmpOut, "modules/mep/equipment.js"));

// ── 1. Motor frames ─────────────────────────────────────────────────────────
t("nextMotorFrame picks the standard frame at or above", () => {
  near(m.nextMotorFrame(0.2), 0.37);
  near(m.nextMotorFrame(0.37), 0.37);
  near(m.nextMotorFrame(1.62), 2.2);
  near(m.nextMotorFrame(250), 250);
  near(m.nextMotorFrame(300), 300, 1e-9); // ceil fallback
});

// ── 2. Fan selection ────────────────────────────────────────────────────────
t("fan duty: total = 1.1·system + exit head; static excludes exit head", () => {
  const r = m.fanSelection({ worstPathDpPa: 320, flowM3s: 2.5, exitVelocityMs: 6 });
  const exitHead = 0.5 * 1.204 * 36; // 21.672 Pa
  near(r.exitVelocityHeadPa, exitHead, 1e-6);
  near(r.fanTotalPressurePa, 320 * 1.1 + exitHead, 1e-6);
  near(r.fanStaticPressurePa, 320 * 1.1, 1e-6);
  // Power chain
  near(r.airPowerW, 2.5 * (320 * 1.1 + exitHead), 1e-3);
  near(r.shaftPowerW, r.airPowerW / 0.65, 1e-3);
  near(r.motorPowerW, r.shaftPowerW / 0.92, 1e-3);
  near(r.recommendedMotorKw, m.nextMotorFrame(r.motorPowerW / 1000), 1e-9);
});

t("fan duty: zero exit velocity keeps static equal to total", () => {
  const r = m.fanSelection({ worstPathDpPa: 500, flowM3s: 1 });
  near(r.fanStaticPressurePa, r.fanTotalPressurePa, 1e-9);
  near(r.fanTotalPressurePa, 550, 1e-6);
});

t("fan duty warns on optimistic efficiency and rejects bad input", () => {
  const r = m.fanSelection({ worstPathDpPa: 100, flowM3s: 1, mechanicalEfficiency: 0.85 });
  assert(r.warnings.some((w) => w.includes("0.8")), "efficiency warning expected");
  let threw = 0;
  try { m.fanSelection({ worstPathDpPa: -1, flowM3s: 1 }); } catch { threw++; }
  try { m.fanSelection({ worstPathDpPa: 100, flowM3s: 0 }); } catch { threw++; }
  try { m.fanSelection({ worstPathDpPa: 100, flowM3s: 1, mechanicalEfficiency: 1.2 }); } catch { threw++; }
  assert(threw === 3, `expected 3 throws, got ${threw}`);
});

// ── 3. Pump selection ───────────────────────────────────────────────────────
t("pump duty: head = (loss+lift+residual)·safety, powers chain to IEC frame", () => {
  const r = m.pumpSelection({
    worstPathHeadLossM: 6, staticLiftM: 12, terminalResidualHeadM: 3, flowLs: 5,
  });
  near(r.dutyHeadM, 23.1, 1e-9);
  near(r.dutyHeadKPa, (23.1 * 998.2 * 9.80665) / 1000, 1e-3);
  near(r.dutyHeadBar, r.dutyHeadKPa / 100, 1e-6);
  near(r.hydraulicPowerW, 998.2 * 9.80665 * 0.005 * 23.1, 1e-3);
  near(r.shaftPowerW, r.hydraulicPowerW / 0.7, 1e-3);
  near(r.motorPowerW, r.shaftPowerW / 0.92, 1e-3);
  near(r.recommendedMotorKw, m.nextMotorFrame(r.motorPowerW / 1000), 1e-9);
});

t("pump duty: defaults omit lift/residual; warns on optimistic efficiency", () => {
  const r = m.pumpSelection({ worstPathHeadLossM: 10, flowLs: 2 });
  near(r.dutyHeadM, 11, 1e-9);
  const opt = m.pumpSelection({ worstPathHeadLossM: 10, flowLs: 2, pumpEfficiency: 0.9 });
  assert(opt.warnings.some((w) => w.includes("0.85")), "efficiency warning expected");
});

t("pump duty rejects bad input", () => {
  let threw = 0;
  try { m.pumpSelection({ worstPathHeadLossM: -5, flowLs: 1 }); } catch { threw++; }
  try { m.pumpSelection({ worstPathHeadLossM: 5, flowLs: -1 }); } catch { threw++; }
  try { m.pumpSelection({ worstPathHeadLossM: 5, flowLs: 1, pumpEfficiency: 0 }); } catch { threw++; }
  assert(threw === 3, `expected 3 throws, got ${threw}`);
});

console.log(`\nmep-equipment: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
