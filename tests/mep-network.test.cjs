/**
 * tests/mep-network.test.cjs
 *
 * Unit tests for the model-native MEP network audit
 * (src/modules/mep/network.ts) — flow accumulation, section sizing,
 * per-section losses, critical path and equipment duty.
 *
 * Run: `node tests/mep-network.test.cjs`
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

function near(a, b, tol = 1e-6) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-network-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/network.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const m = require(path.join(tmpOut, "modules/mep/network.js"));

const SAMPLE_SEGMENTS = [
  { id: "s1", from: "ahu1", to: "j1", lengthM: 15, system: "supply-air", width: 0.5, height: 0.3, fittings: [{ kind: "elbow-90-radius", count: 2 }] },
  { id: "s2", from: "j1", to: "t1", lengthM: 8, system: "supply-air", width: 0.35, height: 0.25, fittings: [{ kind: "diffuser" }] },
  { id: "s3", from: "j1", to: "j2", lengthM: 10, system: "supply-air", width: 0.4, height: 0.25 },
  { id: "s4", from: "j2", to: "t2", lengthM: 7, system: "supply-air", width: 0.3, height: 0.2, fittings: [{ kind: "diffuser" }] },
  { id: "s5", from: "j2", to: "t3", lengthM: 9, system: "supply-air", width: 0.3, height: 0.2, fittings: [{ kind: "diffuser" }] },
];
const SAMPLE_TERMINALS = { t1: 0.4, t2: 0.35, t3: 0.25 };

// ── 1. Flow accumulation ────────────────────────────────────────────────────
t("accumulates terminal flows up the tree", () => {
  const r = m.auditNetwork(SAMPLE_SEGMENTS, SAMPLE_TERMINALS, "ahu1");
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  near(byId.get("s1").flowNative, 1.0);
  near(byId.get("s2").flowNative, 0.4);
  near(byId.get("s3").flowNative, 0.6);
  near(byId.get("s4").flowNative, 0.35);
  near(byId.get("s5").flowNative, 0.25);
  near(r.sourceFlowNative, 1.0);
  assert(r.rows.length === 5, "all five segments audited");
  assert(r.diagnostics.length === 0, `no diagnostics expected, got: ${r.diagnostics.join("; ")}`);
});

t("water networks accumulate L/s and produce pump duty", () => {
  const segs = [
    { id: "p1", from: "pump", to: "j", lengthM: 20, system: "chilled-water", diameter: 0.065 },
    { id: "p2", from: "j", to: "fcu1", lengthM: 12, system: "chilled-water", diameter: 0.032 },
    { id: "p3", from: "j", to: "fcu2", lengthM: 10, system: "chilled-water", diameter: 0.032 },
  ];
  const r = m.auditNetwork(segs, { fcu1: 0.4, fcu2: 0.6 }, "pump", { staticLiftM: 8, terminalResidualHeadM: 2 });
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  near(byId.get("p1").flowNative, 1.0);
  near(byId.get("p1").flowM3s, 0.001);
  near(r.sourceFlowNative, 1.0);
  assert(r.pump !== null, "pump duty present for water systems");
  assert(r.fan === null, "no fan duty for water systems");
  assert(r.pump.dutyHeadM >= (8 + 2) * 1.1 - 1e-9, "duty head covers lift + residual at minimum");
  assert(r.pump.recommendedMotorKw > 0, "motor frame recommended");
});

// ── 2. Critical path and duty ───────────────────────────────────────────────
t("critical path starts at the source and carries the worst drop", () => {
  const r = m.auditNetwork(SAMPLE_SEGMENTS, SAMPLE_TERMINALS, "ahu1");
  assert(r.criticalPathSegmentIds[0] === "s1", "the trunk is always on the critical path");
  assert(r.criticalPathNodeIds[0] === "ahu1", "path starts at the source");
  assert(r.worstPathDpPa > 0, "drop positive");
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  const pathDp = r.criticalPathSegmentIds.reduce((s, id) => s + byId.get(id).dpTotal, 0);
  near(pathDp, r.worstPathDpPa, 1e-6);
  assert(r.fan !== null, "fan duty for air");
  assert(r.fan.fanTotalPressurePa >= r.worstPathDpPa * 1.1 - 1e-6, "fan total covers worst path × safety");
});

// ── 3. Sizing behaviour ─────────────────────────────────────────────────────
t("unsized sections are sized; undersized sections are re-sized", () => {
  const segs = [
    { id: "a", from: "src", to: "t1", lengthM: 10, system: "supply-air" },
    { id: "b", from: "src", to: "t2", lengthM: 10, system: "supply-air", width: 0.1, height: 0.1 },
  ];
  const r = m.auditNetwork(segs, { t1: 0.5, t2: 0.5 }, "src");
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  const a = byId.get("a");
  const b = byId.get("b");
  assert(a.sizedNow, "missing size filled in");
  assert(a.size.area > 0 && a.velocity > 0, "sized from accumulated flow");
  assert(b.resized, "undersized section re-sized");
  assert(b.velocity <= 6 + 1e-9, "re-sized section respects the velocity cap");
  assert(b.warnings.some((w) => w.includes("re-sizing")), "re-size warning surfaced");
});

t("friction method sizes to the target rate", () => {
  const segs = [
    { id: "a", from: "src", to: "t1", lengthM: 10, system: "supply-air" },
    { id: "b", from: "src", to: "t2", lengthM: 10, system: "chilled-water" },
  ];
  // One audit per system — mixing systems in one audit is rejected.
  const air = m.auditNetwork([segs[0]], { t1: 1.0 }, "src", { method: "friction", targetFrictionPaM: 0.8 });
  const row = air.rows[0];
  assert(row.size.rule.includes("friction method"), "rule names the friction method");
  const ductPd = require(path.join(tmpOut, "modules/mep/pressure.js")).ductPressureDrop;
  const seg = ductPd({ length: 1, flow: row.flowM3s, width: row.size.thickness, height: row.size.height });
  assert(seg.frictionRate <= 0.8 + 1e-6, `friction rate ${seg.frictionRate} <= 0.8`);

  const water = m.auditNetwork([segs[1]], { t2: 5 }, "src", { method: "friction", targetFrictionPaM: 150 });
  const wrow = water.rows[0];
  assert(wrow.size.rule.includes("friction method"), "water friction rule");
  const pipePd = require(path.join(tmpOut, "modules/mep/pressure.js")).pipePressureDrop;
  const wseg = pipePd({ length: 1, flow: wrow.flowM3s, diameter: wrow.size.thickness });
  assert(wseg.frictionRate <= 150 + 1e-6, `pipe rate ${wseg.frictionRate} <= 150`);
});

t("resizeUndersized: false keeps the existing (overspeeding) size", () => {
  const segs = [{ id: "a", from: "src", to: "t1", lengthM: 10, system: "supply-air", width: 0.1, height: 0.1 }];
  const r = m.auditNetwork(segs, { t1: 0.5 }, "src", { resizeUndersized: false });
  const row = r.rows[0];
  assert(!row.resized, "kept the model size");
  assert(row.warnings.some((w) => w.includes("exceeds")), "velocity warning surfaced");
});

// ── 4. Topology guards ──────────────────────────────────────────────────────
t("cycle detection blocks flow accumulation across the loop", () => {
  const segs = [
    { id: "x1", from: "src", to: "j", lengthM: 5, system: "supply-air", width: 0.5, height: 0.3 },
    { id: "x2", from: "j", to: "t1", lengthM: 5, system: "supply-air", width: 0.3, height: 0.2 },
    { id: "x3", from: "j", to: "src", lengthM: 5, system: "supply-air", width: 0.3, height: 0.2 },
  ];
  const r = m.auditNetwork(segs, { t1: 0.5 }, "src");
  assert(r.diagnostics.some((d) => d.includes("Cycle")), `cycle diagnostic expected: ${r.diagnostics.join("; ")}`);
});

t("unreachable segments and demand-less terminals are diagnosed", () => {
  const segs = [
    { id: "ok", from: "src", to: "t1", lengthM: 5, system: "supply-air", width: 0.5, height: 0.3 },
    { id: "orphan", from: "mystery", to: "t9", lengthM: 5, system: "supply-air", width: 0.5, height: 0.3 },
  ];
  const r = m.auditNetwork(segs, { t1: 0.5 }, "src");
  assert(r.diagnostics.some((d) => d.includes("orphan") && d.includes("not reachable")), "orphan diagnosed");
  assert(r.diagnostics.some((d) => d.includes("t9") && d.includes("no demand")), "demand-less terminal diagnosed");
  assert(r.rows.length === 1, "only the reachable segment audited");
});

t("mixed systems in one audit are rejected; bad terminals rejected", () => {
  let threw = 0;
  try {
    m.auditNetwork([
      { id: "a", from: "s", to: "t", lengthM: 1, system: "supply-air", width: 0.5, height: 0.3 },
      { id: "b", from: "s", to: "t2", lengthM: 1, system: "chilled-water", diameter: 0.05 },
    ], { t: 1 }, "s");
  } catch { threw++; }
  try {
    m.auditNetwork([
      { id: "a", from: "s", to: "t", lengthM: 1, system: "supply-air", width: 0.5, height: 0.3 },
    ], { t: -1 }, "s");
  } catch { threw++; }
  try { m.auditNetwork([], {}, "s"); } catch { threw++; }
  assert(threw === 3, `expected 3 throws, got ${threw}`);
});

t("ifcEntityForSystem maps duct/pipe systems", () => {
  assert(m.ifcEntityForSystem("supply-air") === "IfcDuctSegment", "duct entity");
  assert(m.ifcEntityForSystem("chilled-water") === "IfcPipeSegment", "pipe entity");
});

console.log(`\nmep-network: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
