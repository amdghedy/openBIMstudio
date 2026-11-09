/**
 * tests/mep-distribution.test.cjs
 *
 * Unit tests for the electrical distribution cascade and the wire-sized
 * panel schedule (src/modules/mep/distribution.ts). Expected currents and
 * drops verified by hand against the IEC tables in electrical-calc.ts.
 *
 * Run: `node tests/mep-distribution.test.cjs`
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
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-distribution-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/mep/distribution.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const m = require(path.join(tmpOut, "modules/mep/distribution.js"));

// ── Fixtures ────────────────────────────────────────────────────────────────
const panel = (id, name, voltageV, phase, busRatingA, circuits) => ({
  id, name, voltageV, phase, busRatingA, circuitSpaces: 12, circuits,
});
const c1 = { id: "c1", panelId: "P1", circuitNumber: 1, loadIds: ["ld1"], breakerRatingA: 63, poles: 1, voltageV: 230, phase: 1 };
const c2 = { id: "c2", panelId: "P2", circuitNumber: 1, loadIds: ["ld2"], breakerRatingA: 32, poles: 1, voltageV: 230, phase: 1 };
const P1 = panel("P1", "Apartment board 1", 230, 1, 100, [c1]);
const P2 = panel("P2", "Apartment board 2", 230, 1, 63, [c2]);
const RP = panel("RP", "Riser root", 230, 1, 250, []);
const LOADS = [
  { id: "ld1", name: "Flat 1 feed", apparentPowerVA: 12000, voltageV: 230, phase: 1, poles: 1 },
  { id: "ld2", name: "Flat 2 feed", apparentPowerVA: 5000, voltageV: 230, phase: 1, poles: 1 },
];

// ── 1. Enhanced panel schedule ──────────────────────────────────────────────
t("enhanced schedule auto-selects conductors and flags voltage drop", () => {
  const sp = panel("SP", "Small board", 230, 1, 63, [
    { id: "sc1", panelId: "SP", circuitNumber: 1, loadIds: ["s1"], breakerRatingA: 16, poles: 1, voltageV: 230, phase: 1 },
    { id: "sc2", panelId: "SP", circuitNumber: 3, loadIds: ["s2"], breakerRatingA: 16, poles: 1, voltageV: 230, phase: 1 },
  ]);
  const loads = [
    { id: "s1", name: "Socket ring", apparentPowerVA: 3000, voltageV: 230, phase: 1, poles: 1 },
    { id: "s2", name: "Lighting", apparentPowerVA: 2000, voltageV: 230, phase: 1, poles: 1, demandFactor: 0.5 },
  ];
  const r = m.enhancePanelSchedule(sp, loads, [{ circuitId: "sc1", routeLengthM: 100 }]);
  const row1 = r.rows.find((x) => x.circuitId === "sc1");
  const row2 = r.rows.find((x) => x.circuitId === "sc2");
  near(row1.designCurrentA, 3000 / 230, 1e-6); // 13.04 A
  near(row1.recommendedConductorMm2, 1.5, 1e-9); // 17.5 A ref ampacity
  near(row2.recommendedConductorMm2, 1.5, 1e-9);
  assert(row1.voltageDropPercent !== null, "route length enables the drop check");
  // 2·0.1 km·14.478 Ω/km·13.04 A = 37.8 V → 16.4 %
  assert(row1.voltageDropPercent > 3, `drop ${row1.voltageDropPercent} must breach 3 %`);
  assert(row1.wireFindings.some((w) => w.includes("Voltage drop")), "drop finding present");
  assert(row2.voltageDropPercent === null, "no length → no drop value");
  assert(r.wireIssueCount === 1, `one row carries findings, got ${r.wireIssueCount}`);
  assert(r.wireInfoAccepted === 1, "wire info accepted count");
});

t("enhanced schedule: unknown override size is flagged, known override wins", () => {
  const sp = panel("SP", "Small board", 230, 1, 63, [
    { id: "sc1", panelId: "SP", circuitNumber: 1, loadIds: ["s1"], breakerRatingA: 16, poles: 1, voltageV: 230, phase: 1 },
  ]);
  const loads = [{ id: "s1", name: "Socket", apparentPowerVA: 3000, voltageV: 230, phase: 1, poles: 1 }];
  const bad = m.enhancePanelSchedule(sp, loads, [{ circuitId: "sc1", conductorMm2Override: 999 }]);
  assert(bad.rows[0].recommendedConductorMm2 === 999, "override kept");
  assert(bad.rows[0].recommendedConductorAmpacityA === null, "unknown size has no ampacity");
  assert(bad.rows[0].wireFindings.some((w) => w.includes("not in the reference ampacity table")), "finding raised");
  const good = m.enhancePanelSchedule(sp, loads, [{ circuitId: "sc1", conductorMm2Override: 2.5 }]);
  near(good.rows[0].recommendedConductorAmpacityA, 24, 1e-9);
  assert(good.rows[0].wireFindings.length === 0, "2.5 mm² (24 A) covers a 16 A breaker");
});

// ── 2. Distribution cascade ─────────────────────────────────────────────────
t("rolls demand up the tree with depths and leaves", () => {
  const links = [
    { downstreamPanelId: "P1", upstreamPanelId: "RP", feedBreakerA: 63 },
    { downstreamPanelId: "P2", upstreamPanelId: "RP", feedBreakerA: 63 },
  ];
  const s = m.buildDistributionSummary([RP, P1, P2], LOADS, links);
  const byId = new Map(s.rollups.map((r) => [r.panelId, r]));
  near(byId.get("P1").ownDemandVA, 12000, 1e-6);
  near(byId.get("P1").totalDemandVA, 12000, 1e-6);
  near(byId.get("RP").ownDemandVA, 0, 1e-6);
  near(byId.get("RP").downstreamDemandVA, 17000, 1e-6);
  near(byId.get("RP").totalDemandVA, 17000, 1e-6);
  near(byId.get("RP").totalDemandCurrentA, 17000 / 230, 1e-6);
  near(byId.get("RP").depth, 0, 1e-9);
  near(byId.get("P1").depth, 1, 1e-9);
  assert(s.leafPanelIds.includes("P1") && s.leafPanelIds.includes("P2"), "children are leaves");
  assert(s.treeOk, "radial tree ok");
  assert(!s.diagnostics.some((d) => d.severity === "error"), `no errors expected: ${s.diagnostics.map((d) => d.code).join(",")}`);
});

t("demand diversity applies per link", () => {
  const links = [
    { downstreamPanelId: "P1", upstreamPanelId: "RP", feedBreakerA: 63, downstreamDemandFactor: 0.8 },
    { downstreamPanelId: "P2", upstreamPanelId: "RP", feedBreakerA: 63 },
  ];
  const s = m.buildDistributionSummary([RP, P1, P2], LOADS, links);
  near(s.rollups.find((r) => r.panelId === "RP").downstreamDemandVA, 0.8 * 12000 + 5000, 1e-6);
});

t("underrated feeder breaker and voltage mismatch are diagnosed", () => {
  const root400 = panel("HV", "Main switchboard", 400, 3, 400, []);
  const links = [
    { downstreamPanelId: "P1", upstreamPanelId: "HV", feedBreakerA: 10 },
  ];
  const s = m.buildDistributionSummary([root400, P1], LOADS, links);
  assert(s.diagnostics.some((d) => d.code === "FEED_BREAKER_UNDERRATED" && d.panelId === "P1"), "52.2 A through a 10 A feeder");
  assert(s.diagnostics.some((d) => d.code === "FEED_VOLTAGE_MISMATCH" && d.panelId === "P1"), "400 V → 230 V needs a transformer");
});

t("feeder voltage drop advisory at long, thin feeders", () => {
  const links = [
    { downstreamPanelId: "P1", upstreamPanelId: "RP", feedBreakerA: 63, cableLengthM: 60, cableMm2: 16 },
  ];
  const s = m.buildDistributionSummary([RP, P1], LOADS, links);
  const drop = s.diagnostics.find((d) => d.code === "FEED_VOLTAGE_DROP");
  assert(drop, "drop advisory expected (~3.2 % over 60 m of 16 mm² at 52.2 A)");
  assert(drop.severity === "warning", "advisory severity");
});

t("cycles, self links, multiple parents and ghosts are all caught", () => {
  const A = panel("A", "A", 230, 1, 100, []);
  const B = panel("B", "B", 230, 1, 100, []);
  const cycle = m.buildDistributionSummary([A, B], [], [
    { downstreamPanelId: "A", upstreamPanelId: "B" },
    { downstreamPanelId: "B", upstreamPanelId: "A" },
  ]);
  assert(cycle.diagnostics.some((d) => d.code === "LINK_CYCLE"), "cycle detected");
  assert(!cycle.treeOk, "tree not ok across a cycle");

  const self = m.buildDistributionSummary([A], [], [{ downstreamPanelId: "A", upstreamPanelId: "A" }]);
  assert(self.diagnostics.some((d) => d.code === "LINK_SELF"), "self link rejected");

  const RP2 = panel("RP2", "Second root", 230, 1, 100, []);
  const multi = m.buildDistributionSummary([RP, RP2, P1], LOADS, [
    { downstreamPanelId: "P1", upstreamPanelId: "RP" },
    { downstreamPanelId: "P1", upstreamPanelId: "RP2" },
  ]);
  assert(multi.diagnostics.some((d) => d.code === "LINK_MULTIPLE_PARENTS"), "two parents rejected");

  const ghost = m.buildDistributionSummary([RP, P1], LOADS, [
    { downstreamPanelId: "P1", upstreamPanelId: "GHOST" },
  ]);
  assert(ghost.diagnostics.some((d) => d.code === "LINK_UPSTREAM_UNKNOWN"), "ghost upstream caught");

  const orphan = m.buildDistributionSummary([RP, P1], LOADS, [
    { downstreamPanelId: "NOPE", upstreamPanelId: "RP" },
  ]);
  assert(orphan.diagnostics.some((d) => d.code === "LINK_DOWNSTREAM_UNKNOWN"), "ghost downstream caught");
});

console.log(`\nmep-distribution: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
