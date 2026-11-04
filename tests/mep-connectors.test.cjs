const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-connectors-"));
try {
  execSync(`npx tsc "${path.join(root, "src/modules/mep/connectors.ts")}" --outDir "${out}" --module commonjs --target es2020 --strict --skipLibCheck`, { cwd: root, stdio: "pipe" });
  const findCompiled = (dir, file) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findCompiled(full, file); if (found) return found; }
      else if (entry.isFile() && entry.name === file) return full;
    }
    return null;
  };
  const compiled = findCompiled(out, "connectors.js");
  assert.ok(compiled, "TypeScript compiler output not found");
  const m = require(compiled);
  const connector = (owner, origin, direction, size = 0.1, extra = {}) => ({
    ownerElementId: owner,
    def: { name: "port", origin: [0, 0, 0], direction, domain: "pipe", shape: "round", size, flowDirection: extra.flowDirection ?? "out", systemClassification: "chilled-water" },
    worldOrigin: origin, worldDirection: direction, engaged: false, connectedTo: null,
  });
  let pass = 0, fail = 0;
  const test = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); } };
  test("route starts by following source connector direction", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0]);
    const b = connector("B", [4, 3, 2], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const route = m.findMepConnectionPath(a, b);
    assert.deepEqual(route[0], a.worldOrigin);
    const first = route[1].map((v, i) => v - route[0][i]);
    assert.ok(first[0] > 0 && Math.abs(first[1]) < 1e-8 && Math.abs(first[2]) < 1e-8);
  });
  test("route reaches target against target connector direction", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0]);
    const b = connector("B", [4, 3, 2], [0, -1, 0], 0.1, { flowDirection: "in" });
    const route = m.findMepConnectionPath(a, b);
    const n = route.length;
    assert.deepEqual(route[n - 1], b.worldOrigin);
    const intoTarget = route[n - 1].map((v, i) => v - route[n - 2][i]);
    const dot = intoTarget.reduce((s, v, i) => s + v * b.worldDirection[i], 0);
    assert.ok(dot < 0, "route should enter opposite to the target's outward direction");
  });
  test("orthogonal core avoids diagonal coordinate jumps", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0]);
    const b = connector("B", [4, 3, 2], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const route = m.findMepConnectionPath(a, b);
    for (let i = 2; i < route.length - 2; i++) {
      const delta = route[i].map((v, j) => Math.abs(v - route[i - 1][j])).filter(v => v > 1e-8);
      assert.ok(delta.length <= 1, "core segment must change at most one axis");
    }
  });
  test("preview rejects incompatible flow directions and reports no fittings", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [1, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "out" });
    const preview = m.previewMepConnection(a, b);
    assert.equal(preview.valid, false);
    assert.ok(preview.reasons.some(x => /both connectors are outlets/.test(x)));
    assert.equal(preview.fittings.length, 0);
  });
  test("preview identifies a reducer for different round sizes", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.15, { flowDirection: "in" });
    const preview = m.previewMepConnection(a, b);
    assert.ok(preview.valid);
    assert.ok(preview.fittings.some(x => x.kind === "reducer"));
  });
  test("relationship creation is atomic when connectors are incompatible", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "out" });
    assert.throws(() => m.createConnectorRelationship(a, b, [a.worldOrigin, b.worldOrigin], []), /incompatible connectors/);
    assert.equal(a.engaged, false);
    assert.equal(b.engaged, false);
  });
  test("relationship creation rejects route endpoints that do not match ports", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    assert.throws(() => m.createConnectorRelationship(a, b, [[0.5, 0, 0], b.worldOrigin], []), /route endpoints/);
    assert.equal(a.engaged, false);
    assert.equal(b.engaged, false);
  });

  const edge = (id, a, b, route = [a.worldOrigin, b.worldOrigin], fittings = []) => ({
    id, sourceElementId: a.ownerElementId, sourceConnector: a.def.name,
    targetElementId: b.ownerElementId, targetConnector: b.def.name,
    fittings, route, createdAt: 1,
  });
  test("topology validator accepts one compatible, correctly engaged edge", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const conn = m.createConnectorRelationship(a, b, [a.worldOrigin, b.worldOrigin], []);
    const issues = m.validateMepNetworkTopology([a, b], [conn]);
    assert.equal(issues.some(x => ["dangling-connection", "connector-multiple-connections", "connector-compatibility", "invalid-connection-route", "connector-engagement-mismatch"].includes(x.code)), false);
  });
  test("topology validator reports a dangling edge endpoint", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const missing = connector("B-missing", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const issues = m.validateMepNetworkTopology([a], [edge("dangling", a, missing)]);
    assert.ok(issues.some(x => x.code === "dangling-connection"));
  });
  test("topology validator rejects two edges occupying the same connector", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const c = connector("C", [3, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    a.engaged = true; a.connectedTo = "C";
    b.engaged = true; b.connectedTo = "A";
    c.engaged = true; c.connectedTo = "A";
    const issues = m.validateMepNetworkTopology([a, b, c], [edge("ab", a, b), edge("ac", a, c)]);
    assert.ok(issues.some(x => x.code === "connector-multiple-connections" && x.elementIds.includes("A")));
  });
  test("topology validator reports duplicate connector definitions and connection IDs", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "in" });
    const duplicate = { ...a, worldOrigin: [...a.worldOrigin] };
    a.engaged = true; a.connectedTo = "B"; b.engaged = true; b.connectedTo = "A";
    const issues = m.validateMepNetworkTopology([a, duplicate, b], [edge("same", a, b), edge("same", a, b)]);
    assert.ok(issues.some(x => x.code === "duplicate-connector-definition"));
    assert.ok(issues.some(x => x.code === "duplicate-connection-id"));
    assert.ok(issues.some(x => x.code === "connector-multiple-connections"));
  });
  test("topology validator reports incompatible endpoints and malformed route geometry", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0], 0.1, { flowDirection: "out" });
    const b = connector("B", [2, 0, 0], [-1, 0, 0], 0.1, { flowDirection: "out" });
    a.engaged = true; a.connectedTo = "B"; b.engaged = true; b.connectedTo = "A";
    const issues = m.validateMepNetworkTopology([a, b], [edge("bad", a, b, [[0, 0, 0], [Number.NaN, 0, 0]])]);
    assert.ok(issues.some(x => x.code === "connector-compatibility"));
    assert.ok(issues.some(x => x.code === "invalid-connection-route"));
  });
  test("topology validator detects stale engagement not backed by an edge", () => {
    const a = connector("A", [0, 0, 0], [1, 0, 0]);
    a.engaged = true; a.connectedTo = "B";
    const issues = m.validateMepNetworkTopology([a], []);
    assert.ok(issues.some(x => x.code === "connector-engagement-mismatch"));
  });

  console.log(`=== MEP connector tests: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
} finally { fs.rmSync(out, { recursive: true, force: true }); }
