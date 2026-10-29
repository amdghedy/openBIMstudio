const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-connectors-"));
try {
  execSync(`npx tsc "${path.join(root, "src/modules/mep/connectors.ts")}" --outDir "${out}" --module commonjs --target es2020 --strict --skipLibCheck`, { cwd: root, stdio: "pipe" });
  const m = require(path.join(out, "connectors.js"));
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
  console.log(`=== MEP connector tests: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
} finally { fs.rmSync(out, { recursive: true, force: true }); }
