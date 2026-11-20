/* Electrical protection coordination — selectivity + breaking capacity.
 *
 * Screening checks only (see modules/mep/protection-coordination.ts):
 * the 1.6x ratio is a same-family thermal-magnetic MCCB rule of thumb,
 * and selectivity is proven only by manufacturer time-current curves.
 * Fault currents are caller-supplied inputs, never computed here.
 *
 * Run: `node tests/mep-protection-coordination.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mpc-"));
execSync(`npx tsc src/modules/mep/protection-coordination.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "protection-coordination.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const dev = (label, ratingA, extra = {}) => ({ label, ratingA, ...extra });

t("selectivity: 100 A upstream vs 50 A downstream is likely (2x)", () => {
  const r = m.checkBreakerSelectivity(dev("main", 100), dev("branch", 50));
  assert.strictEqual(r.status, "likely");
  assert.strictEqual(r.ratio, 2);
  assert.deepStrictEqual(r.findings, []);
  assert.ok(r.basis.includes("manufacturer"));
});

t("selectivity: 63 A vs 50 A (1.26x) is not demonstrated", () => {
  const r = m.checkBreakerSelectivity(dev("main", 63), dev("branch", 50));
  assert.strictEqual(r.status, "not-demonstrated");
  assert.ok(Math.abs(r.ratio - 1.26) < 1e-9);
  assert.ok(r.findings[0].includes("not demonstrated"));
  assert.ok(r.findings[0].includes("manufacturer"));
});

t("selectivity: upstream <= downstream is invalid", () => {
  const r = m.checkBreakerSelectivity(dev("main", 32), dev("branch", 32));
  assert.strictEqual(r.status, "invalid");
  assert.ok(r.findings[0].includes("does not exceed"));
  const r2 = m.checkBreakerSelectivity(dev("main", 20), dev("branch", 32));
  assert.strictEqual(r2.status, "invalid");
});

t("selectivity: non-positive ratings are invalid, not a pass", () => {
  const r = m.checkBreakerSelectivity(dev("main", 0), dev("branch", 16));
  assert.strictEqual(r.status, "invalid");
  assert.ok(r.findings.length > 0);
});

t("breaking capacity: Icu below the fault current is an error", () => {
  const r = m.checkBreakingCapacity(dev("main", 100, { breakingCapacityKA: 6, faultCurrentKA: 10 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.findings[0].includes("below the 10 kA"));
});

t("breaking capacity: Icu covers Ik but Ics does not — warning, not silent", () => {
  const r = m.checkBreakingCapacity(dev("main", 100, { breakingCapacityKA: 25, serviceBreakingCapacityKA: 6, faultCurrentKA: 10 }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.findings[0].includes("may not remain serviceable"));
});

t("breaking capacity: Icu and Ics both cover Ik — ok", () => {
  const r = m.checkBreakingCapacity(dev("main", 100, { breakingCapacityKA: 25, serviceBreakingCapacityKA: 12, faultCurrentKA: 10 }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.findings, []);
});

t("breaking capacity: missing fault current or Icu never silently passes", () => {
  const noIk = m.checkBreakingCapacity(dev("main", 100, { breakingCapacityKA: 25 }));
  assert.strictEqual(noIk.ok, false);
  assert.ok(noIk.findings[0].includes("No prospective fault current"));
  const noIcu = m.checkBreakingCapacity(dev("main", 100, { faultCurrentKA: 10 }));
  assert.strictEqual(noIcu.ok, false);
  assert.ok(noIcu.findings[0].includes("No breaking capacity"));
});

t("chain audit: clean three-device chain passes end to end", () => {
  const r = m.auditProtectionChain([
    dev("MDB main", 250, { breakingCapacityKA: 36, faultCurrentKA: 20 }),
    dev("DB main", 125, { breakingCapacityKA: 25, faultCurrentKA: 12 }),
    dev("final circuit", 32, { breakingCapacityKA: 10, faultCurrentKA: 6 }),
  ], 28);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.selectivity.map((s) => s.status), ["likely", "likely"]);
});

t("chain audit: one weak pair + one underrated breaker both surface", () => {
  const r = m.auditProtectionChain([
    dev("MDB main", 250, { breakingCapacityKA: 36, faultCurrentKA: 20 }),
    dev("DB main", 200, { breakingCapacityKA: 25, faultCurrentKA: 12 }), // 1.25x — not demonstrated
    dev("final circuit", 32, { breakingCapacityKA: 6, faultCurrentKA: 10 }), // Icu exceeded
  ], 40); // design current exceeds the 32 A final breaker
  assert.strictEqual(r.ok, false);
  assert.ok(r.findings.some((f) => f.includes("not demonstrated")));
  assert.ok(r.findings.some((f) => f.includes("breaking capacity exceeded")));
  assert.ok(r.findings.some((f) => f.includes("Ib ≤ In violated")));
});

t("chain audit: empty chain and negative design current throw", () => {
  assert.throws(() => m.auditProtectionChain([], 10), /at least one/);
  assert.throws(() => m.auditProtectionChain([dev("x", 32)], -1), /designCurrentA/);
});

t("panel coordination: feeder vs downstream main at 2x passes", () => {
  const panels = [
    { id: "MDB", name: "MDB", voltageV: 400, phase: 3, busRatingA: 250, circuitSpaces: 6, mainBreakerRatingA: 250, circuits: [] },
    { id: "DB1", name: "DB1", voltageV: 400, phase: 3, busRatingA: 125, circuitSpaces: 6, mainBreakerRatingA: 100, circuits: [] },
  ];
  const r = m.auditPanelBreakerCoordination(panels, [{ downstreamPanelId: "DB1", upstreamPanelId: "MDB", feedBreakerA: 200 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.selectivity[0].status, "likely");
});

t("panel coordination: feeder vs largest branch when the panel has no main", () => {
  const panels = [
    { id: "MDB", name: "MDB", voltageV: 400, phase: 3, busRatingA: 250, circuitSpaces: 6, mainBreakerRatingA: 250, circuits: [] },
    { id: "DB1", name: "DB1", voltageV: 400, phase: 3, busRatingA: 125, circuitSpaces: 6, circuits: [
      { id: "c1", panelId: "DB1", circuitNumber: 1, voltageV: 400, phase: 3, breakerRatingA: 80, loadIds: [] },
      { id: "c2", panelId: "DB1", circuitNumber: 2, voltageV: 400, phase: 3, breakerRatingA: 63, loadIds: [] },
    ] },
  ];
  const r = m.auditPanelBreakerCoordination(panels, [{ downstreamPanelId: "DB1", upstreamPanelId: "MDB", feedBreakerA: 100 }]);
  assert.strictEqual(r.ok, false); // 100/80 = 1.25x — not demonstrated
  assert.ok(r.selectivity[0].downstreamLabel.includes("largest branch"));
});

t("panel coordination: missing feed breaker and breaker-less panel never silently pass", () => {
  const panels = [
    { id: "MDB", name: "MDB", voltageV: 400, phase: 3, busRatingA: 250, circuitSpaces: 6, mainBreakerRatingA: 250, circuits: [] },
    { id: "DB1", name: "DB1", voltageV: 400, phase: 3, busRatingA: 125, circuitSpaces: 6, circuits: [] },
  ];
  const noFeed = m.auditPanelBreakerCoordination(panels, [{ downstreamPanelId: "DB1", upstreamPanelId: "MDB" }]);
  assert.strictEqual(noFeed.ok, false);
  assert.ok(noFeed.findings[0].includes("no usable feed breaker"));
  const noDown = m.auditPanelBreakerCoordination(panels, [{ downstreamPanelId: "DB1", upstreamPanelId: "MDB", feedBreakerA: 100 }]);
  assert.strictEqual(noDown.ok, false);
  assert.ok(noDown.findings[0].includes("no main breaker and no branch breakers"));
});

console.log(`\nmep-protection-coordination: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
