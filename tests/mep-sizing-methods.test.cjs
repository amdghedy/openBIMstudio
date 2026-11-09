/**
 * tests/mep-sizing-methods.test.cjs
 *
 * Unit tests for the friction-rate and static-regain sizing methods
 * (src/modules/mep/sizing-methods.ts) — RVT's other two sizing methods.
 * Cross-checked against the pressure.ts physics (same Colebrook core).
 *
 * Run: `node tests/mep-sizing-methods.test.cjs`
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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-sizing-methods-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/sizing-methods.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const m = require(path.join(tmpOut, "modules/mep/sizing-methods.js"));
const pr = require(path.join(tmpOut, "modules/mep/pressure.js"));

// ── 1. Rect duct friction sizing ────────────────────────────────────────────
t("rect duct by friction: rate meets target and matches the physics core", () => {
  const r = m.sizeRectDuctByFriction(1.0, 0.8);
  assert(r.frictionRatePaM <= 0.8 + 1e-9, `rate ${r.frictionRatePaM} must be <= 0.8`);
  assert(!r.round, "rect result must not be flagged round");
  // Same physics: a 1 m section of the chosen size must report the same rate.
  const seg = pr.ductPressureDrop({ length: 1, flow: 1.0, width: r.thickness, height: r.height });
  near(seg.frictionRate, r.frictionRatePaM, 1e-6);
  assert(r.velocity <= 6 + 1e-9, "velocity within the default cap");
});

t("rect duct by friction: monotone — more flow never yields a smaller section", () => {
  const a = m.sizeRectDuctByFriction(0.5, 0.8);
  const b = m.sizeRectDuctByFriction(1.5, 0.8);
  assert(b.area >= a.area, `area ${b.area} for 1.5 m³/s must be >= ${a.area} for 0.5 m³/s`);
});

t("rect duct by friction: stricter target gives a larger section", () => {
  const loose = m.sizeRectDuctByFriction(1.0, 1.5);
  const strict = m.sizeRectDuctByFriction(1.0, 0.4);
  assert(strict.area >= loose.area, "0.4 Pa/m target needs >= area of 1.5 Pa/m target");
});

t("round duct by friction: round flag and equal dims", () => {
  const r = m.sizeRoundDuctByFriction(0.8, 0.8);
  assert(r.round, "round flag");
  near(r.thickness, r.height, 1e-12);
  assert(r.frictionRatePaM <= 0.8 + 1e-9, "rate within target");
});

t("friction sizing rejects bad input", () => {
  let threw = 0;
  try { m.sizeRectDuctByFriction(0, 0.8); } catch { threw++; }
  try { m.sizeRectDuctByFriction(1, -1); } catch { threw++; }
  try { m.sizePipeByFriction(0, 150); } catch { threw++; }
  assert(threw === 3, `expected 3 throws, got ${threw}`);
});

// ── 2. Pipe friction sizing ─────────────────────────────────────────────────
t("pipe by friction: DN pick meets target and physics matches", () => {
  const r = m.sizePipeByFriction(5, 150);
  assert(r.frictionRatePaM <= 150 + 1e-6, `rate ${r.frictionRatePaM} <= 150`);
  assert(r.velocity <= 2.5 + 1e-9, "velocity within cap");
  const seg = pr.pipePressureDrop({ length: 1, flow: 5 / 1000, diameter: r.diameter });
  near(seg.frictionRate, r.frictionRatePaM, 1e-3);
  near(r.headLossPer100m, (r.frictionRatePaM * 100) / (998.2 * 9.80665), 1e-6);
});

t("pipe by friction: tighter target upsizes the DN", () => {
  const loose = m.sizePipeByFriction(5, 400);
  const strict = m.sizePipeByFriction(5, 100);
  assert(strict.diameter >= loose.diameter, "100 Pa/m needs >= DN of 400 Pa/m");
});

// ── 3. Static regain series ─────────────────────────────────────────────────
t("static regain: first section by friction, later sections downsize while regain pays", () => {
  const rs = m.staticRegainSeries([
    { flowM3s: 1.0, lengthM: 12 },
    { flowM3s: 0.6, lengthM: 8 },
    { flowM3s: 0.3, lengthM: 6 },
  ], { targetFrictionPaM: 0.8 });
  assert(rs.length === 3, "three results");
  assert(rs[0].sizedBy === "initial-friction", "first is initial-friction");
  near(rs[0].regainAvailablePa, 0, 1e-12);
  for (let i = 1; i < rs.length; i++) {
    const areaOf = (s) => s.thickness * s.height;
    assert(areaOf(rs[i]) <= areaOf(rs[i - 1]) + 1e-12, `section ${i} area must not exceed the previous`);
    assert(rs[i].velocity <= rs[i - 1].velocity + 1e-9, "static regain runs sections slower (or holds) — velocity head falls to pay friction");
    if (rs[i].sizedBy === "regain") {
      assert(rs[i].regainAvailablePa >= rs[i].frictionLossPa - 1e-6,
        `regain ${rs[i].regainAvailablePa} must cover friction ${rs[i].frictionLossPa}`);
    }
  }
});

t("static regain: zero-length section holds the previous size", () => {
  const rs = m.staticRegainSeries([
    { flowM3s: 1.0, lengthM: 10 },
    { flowM3s: 0.9, lengthM: 0 },
  ], {});
  assert(rs[1].sizedBy === "held" || rs[1].thickness === rs[0].thickness, "zero friction need cannot justify a downsize");
});

t("static regain rejects empty and invalid input", () => {
  let threw = 0;
  try { m.staticRegainSeries([], {}); } catch { threw++; }
  try { m.staticRegainSeries([{ flowM3s: -1, lengthM: 1 }], {}); } catch { threw++; }
  assert(threw === 2, `expected 2 throws, got ${threw}`);
});

// ── 4. Dispatch ─────────────────────────────────────────────────────────────
t("sizeByFriction dispatch: air → duct, water → pipe", () => {
  const d = m.sizeByFriction("supply-air", 1.0, 0.8);
  assert(d.kind === "duct", "supply-air dispatches to duct");
  const p = m.sizeByFriction("chilled-water", 5, 150);
  assert(p.kind === "pipe", "chilled-water dispatches to pipe");
  assert(p.result.frictionRatePaM <= 150 + 1e-6, "pipe result honours the target");
});

console.log(`\nmep-sizing-methods: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
