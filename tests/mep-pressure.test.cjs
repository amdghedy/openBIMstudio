/**
 * tests/mep-pressure.test.cjs
 *
 * Unit tests for the MEP pressure-loss engine (src/modules/mep/pressure.ts).
 * Values are checked against ASHRAE friction-chart order-of-magnitude
 * figures and exact laminar/fitting closed forms.
 *
 * Run: `node tests/mep-pressure.test.cjs`
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

function near(a, b, tol = 1e-4) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}

function between(v, lo, hi, label) {
  if (!(v >= lo && v <= hi)) {
    throw new Error(`${label || "value"} ${v} outside [${lo}, ${hi}]`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-pressure-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/pressure.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const p = require(path.join(tmpOut, "modules/mep/pressure.js"));

// ── 1. Hydraulic diameter ───────────────────────────────────────────────────
t("hydraulic diameter: round and rectangular", () => {
  near(p.hydraulicDiameter({ diameter: 0.35 }), 0.35, 1e-9);
  near(p.hydraulicDiameter({ width: 0.5, height: 0.25 }), (2 * 0.5 * 0.25) / (0.5 + 0.25), 1e-9);
  let threw = false;
  try { p.hydraulicDiameter({}); } catch { threw = true; }
  assert(threw, "missing dimensions should throw");
});

// ── 2. Turbulent duct vs ASHRAE friction chart ──────────────────────────────
t("duct friction rate matches ASHRAE chart band (0.3 m³/s in Ø350)", () => {
  // v = 3.12 m/s, Re ≈ 7.3e4, f ≈ 0.0195 → ~0.33 Pa/m
  const r = p.ductPressureDrop({ length: 10, flow: 0.3, diameter: 0.35 });
  between(r.frictionRate, 0.25, 0.42, "friction rate Pa/m");
  near(r.dpFriction, r.frictionRate * 10, 1e-9);
  near(r.velocity, 0.3 / (Math.PI * 0.35 * 0.35 / 4), 1e-6);
});

t("rectangular duct uses hydraulic diameter", () => {
  // Same area as Ø350 round → slightly higher Dh-driven drop difference is
  // expected; just verify it computes and sits in a sane band.
  const r = p.ductPressureDrop({ length: 10, flow: 0.3, width: 0.45, height: 0.25 });
  between(r.frictionRate, 0.2, 0.8, "rect friction rate");
  near(r.hydraulicDiameter, (2 * 0.45 * 0.25) / (0.7), 1e-9);
});

// ── 3. Laminar exact solution f = 64/Re ─────────────────────────────────────
t("laminar flow returns f = 64/Re exactly", () => {
  // Air at very low velocity: v = 0.05, D = 0.02 → Re ≈ 66
  const r = p.ductPressureDrop({ length: 1, flow: Math.PI * 0.01 * 0.01 * 0.05, diameter: 0.02 });
  near(r.frictionFactor, 64 / r.reynolds, 1e-9);
  assert(r.reynolds < 2300, `expected laminar, Re=${r.reynolds}`);
});

// ── 4. Fitting losses ───────────────────────────────────────────────────────
t("fitting C coefficients produce velocity-head losses", () => {
  const seg = { length: 0, flow: 0.3, diameter: 0.35, fittings: [{ kind: "elbow-90-radius", count: 3 }] };
  const r = p.ductPressureDrop(seg);
  const vHead = (1.204 * r.velocity * r.velocity) / 2;
  near(r.dpFittings, 3 * 0.22 * vHead, 1e-6);
  near(r.dpFriction, 0, 1e-9);
  near(r.dpTotal, 3 * 0.22 * vHead, 1e-6);
});

// ── 5. Water pipe head loss vs textbook ─────────────────────────────────────
t("water pipe: 1 L/s in DN50 ≈ 0.005–0.009 m/m", () => {
  const r = p.pipePressureDrop({ length: 100, flow: 0.001, diameter: 0.05 });
  between(r.headLoss / 100, 0.004, 0.009, "head loss m/m");
  near(r.velocity, 0.001 / (Math.PI * 0.0025 / 4), 1e-9);
  // Head loss × ρg reproduces pressure drop
  near(r.headLoss * 998.2 * 9.80665, r.dpTotal, 1e-6);
});

// ── 6. Roughness matters: flex duct much worse than galvanized ──────────────
t("flex duct friction >> galvanized at same size/flow", () => {
  const galv = p.ductPressureDrop({ length: 10, flow: 0.3, diameter: 0.35, material: "galvanized-steel" });
  const flex = p.ductPressureDrop({ length: 10, flow: 0.3, diameter: 0.35, material: "flex-duct" });
  assert(flex.dpFriction > galv.dpFriction * 1.5, `flex ${flex.dpFriction} vs galv ${galv.dpFriction}`);
});

// ── 7. Worst path through a network ─────────────────────────────────────────
t("worstPath finds the critical branch", () => {
  // Source → node A → two branches: short (20 Pa) and long (85 Pa).
  const net = {
    source: "fan",
    edges: [
      { id: "e1", from: "fan", to: "A", dp: 30 },
      { id: "e2", from: "A", to: "zone1", dp: 20 },
      { id: "e3", from: "A", to: "B", dp: 15 },
      { id: "e4", from: "B", to: "zone2", dp: 70 },
    ],
  };
  const w = p.worstPath(net);
  near(w.totalDp, 115, 1e-9); // fan → A → B → zone2
  assert(w.edgeIds.join(",") === "e1,e3,e4", `path ${w.edgeIds}`);
  assert(w.nodes.join(",") === "fan,A,B,zone2", `nodes ${w.nodes}`);
});

// ── 8. Classification bands ─────────────────────────────────────────────────
t("friction-rate classification bands", () => {
  assert(p.classifyFrictionRate(0.2) === "low");
  assert(p.classifyFrictionRate(0.6) === "recommended");
  assert(p.classifyFrictionRate(2.5) === "high");
});

// ── 9. Colebrook continuity across the turbulent range ──────────────────────
t("colebrook: smooth-pipe limit and monotonic roughness growth", () => {
  const smooth = p.colebrook(1e5, 0);
  between(smooth, 0.0175, 0.019, `smooth f ${smooth}`); // Blasius ≈ 0.0179
  const rough = p.colebrook(1e5, 0.01);
  assert(rough > smooth, "rougher must increase f");
  const laminar = p.colebrook(1000, 0.01);
  near(laminar, 64 / 1000, 1e-9);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
