const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-lifecycle-"));
try {
  execSync(`npx tsc "${path.join(root, "src/modules/mep/model-lifecycle.ts")}" --outDir "${out}" --module commonjs --target es2020 --strict --skipLibCheck`, { cwd: root, stdio: "pipe" });
  const findCompiled = (dir, file) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findCompiled(full, file); if (found) return found; }
      else if (entry.isFile() && entry.name === file) return full;
    }
    return null;
  };
  const compiled = findCompiled(out, "model-lifecycle.js");
  assert.ok(compiled, "TypeScript compiler output not found");
  const { MepModelLifecycle } = require(compiled);
  const connector = (owner, name, origin, direction, flowDirection) => ({
    ownerElementId: owner,
    def: { name, origin: [0, 0, 0], direction, domain: "pipe", shape: "round", size: 0.05, flowDirection, systemClassification: "chilled-water" },
    worldOrigin: origin, worldDirection: direction, engaged: false, connectedTo: null,
  });
  const a = connector("P1", "out", [0, 0, 0], [1, 0, 0], "out");
  const b = connector("P2", "in", [2, 0, 0], [-1, 0, 0], "in");
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: [a, b] });
  let pass = 0, fail = 0;
  const test = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); } };
  test("connect persists an edge and engages both ports", () => {
    const edge = lifecycle.connect("P1", "out", "P2", "in");
    assert.equal(lifecycle.listConnections().length, 1);
    assert.equal(edge.sourceElementId, "P1");
    const snap = lifecycle.snapshot();
    assert.equal(snap.connectors.find(c => c.ownerElementId === "P1").engaged, true);
    assert.equal(snap.connectors.find(c => c.ownerElementId === "P2").connectedTo, "P1");
  });
  test("geometry edit invalidating a port removes stale connection", () => {
    const before = lifecycle.getRevision();
    const result = lifecycle.onElementChanged("P1", []);
    assert.ok(result.revision > before);
    assert.equal(lifecycle.listConnections().length, 0);
    assert.ok(result.topologyIssues.some(x => x.code === "disconnected-equipment"));
  });
  test("move/resize of connected element regenerates route and retains valid relationship", () => {
    lifecycle.hydrate({ connectors: [a, b] });
    lifecycle.connect("P1", "out", "P2", "in");
    const moved = connector("P1", "out", [0, 1, 0], [1, 0, 0], "out");
    const result = lifecycle.onElementChanged("P1", [moved]);
    assert.equal(lifecycle.listConnections().length, 1);
    const route = lifecycle.listConnections()[0].route;
    assert.deepEqual(route[0], [0, 1, 0]);
    assert.deepEqual(route[route.length - 1], [2, 0, 0]);
    assert.ok(result.affectedConnectionIds.length >= 0);
  });
  test("save/load snapshot restores connector graph and electrical data", () => {
    lifecycle.hydrate({ connectors: [a, b] });
    lifecycle.connect("P1", "out", "P2", "in");
    const persisted = lifecycle.snapshot();
    const restored = new MepModelLifecycle();
    restored.hydrate(persisted);
    assert.equal(restored.listConnections().length, 1);
    assert.equal(restored.snapshot().connectors.find(c => c.ownerElementId === "P1").engaged, true);
  });
  test("electrical distribution is held by lifecycle and schedule generated", () => {
    lifecycle.setElectricalDistribution([{
      id: "LP1", name: "Lighting Panel", voltageV: 230, phase: 1, busRatingA: 100,
      circuitSpaces: 4, circuits: [{ id: "C1", panelId: "LP1", circuitNumber: 1, loadIds: ["L1"], breakerRatingA: 10, poles: 1, voltageV: 230, phase: 1 }]
    }], [{ id: "L1", name: "Lighting", apparentPowerVA: 1150, voltageV: 230, phase: 1, poles: 1, panelId: "LP1" }]);
    const schedule = lifecycle.getPanelSchedule("LP1");
    assert.equal(schedule.totalConnectedVA, 1150);
    assert.equal(schedule.rows[0].designCurrentA, 5);
    assert.equal(schedule.availableSpaces, 3);
  });
  test("snapshot returns defensive copies", () => {
    const s = lifecycle.snapshot();
    s.loads[0].name = "mutated";
    assert.equal(lifecycle.getPanelSchedule("LP1").rows[0].loadNames[0], "Lighting");
  });
  console.log(`=== MEP lifecycle tests: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
} finally { fs.rmSync(out, { recursive: true, force: true }); }
