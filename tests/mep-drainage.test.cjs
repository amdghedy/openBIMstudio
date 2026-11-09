/**
 * tests/mep-drainage.test.cjs
 *
 * Unit tests for DFU drainage sizing (src/modules/mep/drainage.ts).
 * Expected values are the published rows of IPC Tables 709.1, 710.1(1)
 * and 710.1(2) (verified against the ICC-published tables).
 *
 * Run: `node tests/mep-drainage.test.cjs`
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

function near(a, b, tol = 1e-9) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-drainage-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/drainage.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const m = require(path.join(tmpOut, "modules/mep/drainage.js"));

// ── 1. Fixture DFU weights (IPC Table 709.1) ────────────────────────────────
t("totalDfu sums verified Table 709.1 weights", () => {
  // 6 public WCs (4 DFU) + 8 lavatories (1) + 3 floor drains (2) = 38
  near(m.totalDfu({ "water-closet-public-1.6-gpf": 6, "lavatory": 8, "floor-drain": 3 }), 38);
  near(m.totalDfu({ "bathtub": 1 }), 2);
  near(m.totalDfu({ "drinking-fountain": 2 }), 1);
  near(m.totalDfu({ "water-closet-private-1.6-gpf": 1 }), 3);
  near(m.totalDfu({ "urinal-standard": 1 }), 4);
  near(m.totalDfu({ "urinal-1-gpf-or-less": 1 }), 2);
  near(m.totalDfu({ "shower-over-12.3-to-25.8-gpm": 1 }), 5);
  near(m.totalDfu({}), 0);
});

t("totalDfu flags unknown fixture keys", () => {
  near(m.totalDfu({ "unicorn-trap": 1 }), -1);
});

// ── 2. Building drains (IPC Table 710.1(1)) ─────────────────────────────────
t("building drain at 1/4 in/ft follows the published rows", () => {
  // 20 DFU → 2 in (21); 38 DFU → 3 in (42); 216 → 4 in; 217 → 5 in
  near(m.sizeDrain("building-drain", 20).diameterIn, 2);
  const r38 = m.sizeDrain("building-drain", 38, { servesWaterCloset: true });
  near(r38.diameterIn, 3);
  assert(r38.notes.some((n) => n.includes("water closet")), "footnote (a) noted");
  near(m.sizeDrain("building-drain", 216).diameterIn, 4);
  near(m.sizeDrain("building-drain", 217).diameterIn, 5);
});

t("building drain slope sensitivity matches the table", () => {
  // 30 DFU: 1/4 → 2.5 in (24<30→42? no: 2 in=21<30, 2.5=24<30, 3=42≥30) → 3 in
  near(m.sizeDrain("building-drain", 30, { slopeInFt: 0.25 }).diameterIn, 3);
  // 1/2 in/ft: 2.5 in carries 31 ≥ 30 → 2.5 in
  near(m.sizeDrain("building-drain", 30, { slopeInFt: 0.5 }).diameterIn, 2.5);
  // 1/8: 3 in carries 36 < 40 → 4 in carries 180
  near(m.sizeDrain("building-drain", 40, { slopeInFt: 0.125 }).diameterIn, 4);
  // 1/16: 1400 → 8 in
  near(m.sizeDrain("building-drain", 1400, { slopeInFt: 0.0625 }).diameterIn, 8);
});

t("water-closet minimum bumps small drains to 3 in", () => {
  // 2 DFU would fit 1.5 in (3 DFU capacity); with a WC it must be 3 in minimum.
  const r = m.sizeDrain("building-drain", 2, { servesWaterCloset: true });
  near(r.diameterIn, 3);
  const noWc = m.sizeDrain("building-drain", 2);
  near(noWc.diameterIn, 1.5);
});

// ── 3. Horizontal branches and stacks (IPC Table 710.1(2)) ──────────────────
t("horizontal branch follows the published branch column", () => {
  near(m.sizeDrain("horizontal-branch", 6).diameterIn, 2);
  near(m.sizeDrain("horizontal-branch", 7).diameterIn, 2.5);
  near(m.sizeDrain("horizontal-branch", 20).diameterIn, 3);
  near(m.sizeDrain("horizontal-branch", 21).diameterIn, 4);
  near(m.sizeDrain("horizontal-branch", 160).diameterIn, 4);
  near(m.sizeDrain("horizontal-branch", 161).diameterIn, 5);
});

t("stack sizing respects both the interval total and the one-interval limit", () => {
  // 90 DFU, one interval: 4 in carries exactly 90 → 4 in
  near(m.sizeDrain("stack", 90, { intervals: "1" }).diameterIn, 4);
  // 91 DFU, one interval: 4 in (90) is short → 5 in (200)
  near(m.sizeDrain("stack", 91, { intervals: "1" }).diameterIn, 5);
  // 90 DFU over three intervals: total 240 at 4 in; per-interval 90 at 4 in → 4 in
  near(m.sizeDrain("stack", 90, { intervals: "3-or-less" }).diameterIn, 4);
  // The sizing is conservative on the one-interval limit: a 500 DFU load is
  // assumed able to enter one interval, and 4 in only allows 90 there → 8 in (600).
  near(m.sizeDrain("stack", 500, { intervals: "over-3" }).diameterIn, 8);
  // 501 DFU over >3 intervals: still governed by the one-interval column → 8 in
  near(m.sizeDrain("stack", 501, { intervals: "over-3" }).diameterIn, 8);
  assert(m.sizeDrain("stack", 500, { intervals: "over-3" }).notes.some((n) => n.includes("branch interval")), "per-interval note present");
});

// ── 4. Capacity inverse ─────────────────────────────────────────────────────
t("drainCapacity inverts the tables", () => {
  near(m.drainCapacity("horizontal-branch", 2).capacityDfu, 6);
  near(m.drainCapacity("building-drain", 4, { slopeInFt: 0.125 }).capacityDfu, 180);
  near(m.drainCapacity("stack", 4, { intervals: "3-or-less" }).capacityDfu, 240);
  near(m.drainCapacity("stack", 4, { intervals: "1" }).capacityDfu, 90);
});

// ── 5. Fixture-bag end-to-end ───────────────────────────────────────────────
t("sizeDrainFromFixtures: counts → DFU → building drain", () => {
  const r = m.sizeDrainFromFixtures(
    { "water-closet-public-1.6-gpf": 6, "lavatory": 8, "floor-drain": 3 },
    { servesWaterCloset: true },
  );
  near(r.dfu, 38);
  near(r.drain.diameterIn, 3);
  assert(m.sizeDrainFromFixtures({ "nope": 1 }).error !== undefined, "unknown key surfaces an error");
  assert(m.sizeDrainFromFixtures({}).error !== undefined, "empty bag surfaces an error");
});

// ── 6. Guards ───────────────────────────────────────────────────────────────
t("bad DFU loads throw", () => {
  let threw = 0;
  try { m.sizeDrain("horizontal-branch", 0); } catch { threw++; }
  try { m.sizeDrain("horizontal-branch", -5); } catch { threw++; }
  try { m.sizeDrain("building-drain", 20000, { slopeInFt: 0.25 }); } catch { threw++; }
  try { m.drainCapacity("horizontal-branch", 1.25); } catch { threw++; } // below tabulated branch sizes
  assert(threw === 4, `expected 4 throws, got ${threw}`);
});

console.log(`\nmep-drainage: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
