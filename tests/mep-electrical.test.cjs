const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-electrical-"));
try {
  execSync(`npx tsc "${path.join(root, "src/modules/mep/electrical.ts")}" --outDir "${out}" --module commonjs --target es2020 --strict --skipLibCheck`, { cwd: root, stdio: "pipe" });
  const m = require(path.join(out, "electrical.js"));
  let pass = 0, fail = 0;
  const test = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); } };
  const loads = [
    { id: "L1", name: "Lighting", apparentPowerVA: 1200, voltageV: 230, phase: 1, poles: 1, demandFactor: 0.8, panelId: "P1" },
    { id: "L2", name: "Socket", apparentPowerVA: 1800, voltageV: 230, phase: 1, poles: 1, panelId: "P1" },
  ];
  const panel = { id: "P1", name: "LP-1", voltageV: 230, phase: 1, busRatingA: 100, mainBreakerRatingA: 80, circuitSpaces: 12, circuits: [
    { id: "C1", panelId: "P1", circuitNumber: 1, loadIds: ["L1"], breakerRatingA: 10, poles: 1, voltageV: 230, phase: 1, conductorAmpacityA: 15 },
    { id: "C2", panelId: "P1", circuitNumber: 2, loadIds: ["L2"], breakerRatingA: 16, poles: 1, voltageV: 230, phase: 1, conductorAmpacityA: 20 },
  ]};
  test("single-phase current uses VA / V", () => assert.equal(m.currentFromVA(2300, 230, 1), 10));
  test("three-phase current uses sqrt(3) x line voltage", () => assert.ok(Math.abs(m.currentFromVA(17320.508, 400, 3) - 25) < 0.001));
  test("panel schedule totals connected and demand loads", () => {
    const s = m.buildPanelSchedule(panel, loads);
    assert.equal(s.totalConnectedVA, 3000);
    assert.equal(s.totalDemandVA, 2760);
    assert.equal(s.rows.length, 2);
    assert.equal(s.availableSpaces, 10);
    assert.deepEqual(s.rows.map(x => x.circuitNumber), [1, 2]);
  });
  test("rejects duplicate circuit numbers and incompatible poles", () => {
    const p = { ...panel, circuits: [panel.circuits[0], { ...panel.circuits[1], circuitNumber: 1, poles: 2 }] };
    const codes = m.validateElectricalDistribution([p], loads).map(x => x.code);
    assert.ok(codes.includes("CIRCUIT_NUMBER_DUPLICATE"));
    assert.ok(codes.includes("LOAD_CIRCUIT_POLE_MISMATCH"));
  });
  test("detects undersized breaker and conductor", () => {
    const p = { ...panel, circuits: [{ ...panel.circuits[1], breakerRatingA: 5, conductorAmpacityA: 4 }] };
    const codes = m.validateElectricalDistribution([p], loads).map(x => x.code);
    assert.ok(codes.includes("BREAKER_UNDERRATED"));
    assert.ok(codes.includes("CONDUCTOR_AMPACITY_INSUFFICIENT"));
  });
  test("detects panel bus overload and excess main breaker", () => {
    const p = { ...panel, busRatingA: 8, mainBreakerRatingA: 20 };
    const codes = m.validateElectricalDistribution([p], loads).map(x => x.code);
    assert.ok(codes.includes("PANEL_BUS_OVERLOAD"));
    assert.ok(codes.includes("MAIN_BREAKER_EXCEEDS_BUS"));
  });
  test("flags missing loads and missing assigned panels", () => {
    const p = { ...panel, circuits: [{ ...panel.circuits[0], loadIds: ["MISSING"] }] };
    const extra = [...loads, { id: "L3", name: "Bad assigned load", apparentPowerVA: 50, voltageV: 230, phase: 1, poles: 1, panelId: "NO_PANEL" }];
    const codes = m.validateElectricalDistribution([p], extra).map(x => x.code);
    assert.ok(codes.includes("CIRCUIT_LOAD_MISSING"));
    assert.ok(codes.includes("ASSIGNED_PANEL_MISSING"));
  });
  test("rejects invalid demand factor", () => assert.throws(() => m.effectiveDemandVA({ id: "X", name: "x", apparentPowerVA: 100, voltageV: 230, phase: 1, poles: 1, demandFactor: 1.2 })));
  console.log(`=== Electrical tests: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
} finally { fs.rmSync(out, { recursive: true, force: true }); }
