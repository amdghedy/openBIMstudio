/* Stored connector semantics for plain MEP runs (stored-connectors.ts +
 * system-tree.ts with stored connections + model-lifecycle.ts).
 *
 * Proves: run ports are derived from geometry (bidirectional); coincident
 * ports are adopted into stored port-to-port edges; a run end on another
 * run's body gets NO edge and is reported unadopted (and is NOT connected
 * in the tree); stored edges survive a JSON save/reload round-trip through
 * the lifecycle snapshot (the exact shape projects.ts persists as
 * mepLifecycle); a named system keeps its identity across a model edit;
 * a mixed-system cluster is an error through the stored-edge path; and
 * legacy callers without a connection list keep pure-geometry behaviour.
 *
 * Run: `node tests/mep-stored-connectors.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "msc-"));
execSync(
  `npx tsc src/modules/mep/stored-connectors.ts src/modules/mep/system-tree.ts src/modules/mep/model-lifecycle.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const sc = require(find(out, "stored-connectors.js"));
const st = require(find(out, "system-tree.js"));
const { MepModelLifecycle } = require(find(out, "model-lifecycle.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const run = (id, type, s, e, extra = {}) => ({ id, type, params: { start: s, end: e, elevation: 3, height: 0.3, thickness: 0.3, ...extra } });
const fit = (id, pt, kind, aIn, aOut, extra = {}) => ({ id, type: "fitting", params: { point: pt, elevation: 3, height: 0.3, thickness: 0.3, fittingKind: kind, angleIn: aIn, angleOut: aOut, parentType: "duct", bendRadius: 0.45, ...extra } });

/** All derived run ports for a set of elements, keyed by element id. */
function deriveAll(elements) {
  const out = [];
  for (const e of elements) {
    const ports = sc.deriveRunConnectors(e);
    if (ports) out.push(...ports);
  }
  return out;
}

// ── deriveRunConnectors ──────────────────────────────────────────────────

t("duct run derives two bidirectional rectangular ports at its ends", () => {
  const ports = sc.deriveRunConnectors(run("A", "duct", [0, 0], [5, 0], { width: 0.4, height: 0.3 }));
  assert.strictEqual(ports.length, 2);
  assert.deepStrictEqual(ports.map((p) => p.def.name), ["start", "end"]);
  assert.strictEqual(ports[0].def.domain, "duct");
  assert.strictEqual(ports[0].def.shape, "rectangular");
  assert.deepStrictEqual(ports[0].def.size, [0.4, 0.3]);
  assert.deepStrictEqual(ports[0].worldOrigin, [0, 3, 0]);
  assert.deepStrictEqual(ports[1].worldOrigin, [5, 3, 0]);
  // Bidirectional: draw order is not flow direction.
  assert.strictEqual(ports[0].def.flowDirection, "inout");
  assert.strictEqual(ports[1].def.flowDirection, "inout");
  // Directions point out of the run at each end.
  assert.ok(ports[0].worldDirection[0] < 0 && ports[1].worldDirection[0] > 0);
});

t("pipe run derives round ports sized from thickness; classification override is honoured", () => {
  const el = run("P", "pipe", [0, 0], [5, 0], { thickness: 0.05 });
  el.properties = { systemClassification: "chilled-water" };
  const ports = sc.deriveRunConnectors(el);
  assert.strictEqual(ports[0].def.domain, "pipe");
  assert.strictEqual(ports[0].def.shape, "round");
  assert.strictEqual(ports[0].def.size, 0.05);
  assert.strictEqual(ports[0].def.systemClassification, "chilled-water");
});

t("deriveRunConnectors returns null for fittings, degenerate and missing geometry", () => {
  assert.strictEqual(sc.deriveRunConnectors(fit("E", [5, 0], "elbow", 0, Math.PI / 2)), null);
  assert.strictEqual(sc.deriveRunConnectors(run("Z", "duct", [1, 1], [1, 1])), null);
  const missing = run("M", "duct", [0, 0], [5, 0]);
  delete missing.params.end;
  assert.strictEqual(sc.deriveRunConnectors(missing), null);
});

// ── Adoption ─────────────────────────────────────────────────────────────

t("two ducts joined end-to-end adopt one stored edge (end to start)", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const { quads, unadopted } = sc.adoptStoredConnections([A, B], []);
  assert.strictEqual(unadopted.length, 0);
  assert.strictEqual(quads.length, 1);
  assert.deepStrictEqual(quads[0], {
    sourceElementId: "A", sourceConnector: "end",
    targetElementId: "B", targetConnector: "start",
  });
});

t("two runs joined start-to-start are adoptable (draw order is not flow)", () => {
  const A = run("A", "duct", [5, 0], [0, 0]); // drawn right-to-left
  const B = run("B", "duct", [5, 0], [10, 0]);
  const { quads, unadopted } = sc.adoptStoredConnections([A, B], []);
  assert.strictEqual(unadopted.length, 0);
  assert.strictEqual(quads.length, 1);
  assert.strictEqual(quads[0].sourceConnector, "start");
  assert.strictEqual(quads[0].targetConnector, "start");
});

t("a run end on another run's body adopts nothing and is reported no-port-pair", () => {
  const A = run("A", "duct", [0, 0], [10, 0]);
  const C = run("C", "duct", [5, 0], [5, 5]); // C's start lands mid-body on A
  const { quads, unadopted } = sc.adoptStoredConnections([A, C], []);
  assert.strictEqual(quads.length, 0);
  assert.strictEqual(unadopted.length, 1);
  assert.strictEqual(unadopted[0].reason, "no-port-pair");
  assert.ok(unadopted[0].detail.includes("junction fitting"));
});

t("a duct touching a pipe end-to-end is incompatible (domain), not adopted", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const P = run("P", "pipe", [5, 0], [10, 0]);
  const { quads, unadopted } = sc.adoptStoredConnections([A, P], []);
  assert.strictEqual(quads.length, 0);
  assert.strictEqual(unadopted.length, 1);
  assert.strictEqual(unadopted[0].reason, "incompatible-ports");
  assert.ok(unadopted[0].detail.includes("domain mismatch"));
});

t("adoption is idempotent: already-edged pairs adopt nothing new", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const first = sc.adoptStoredConnections([A, B], []);
  assert.strictEqual(first.quads.length, 1);
  const edge = {
    id: "conn-1", sourceElementId: "A", sourceConnector: "end",
    targetElementId: "B", targetConnector: "start", fittings: [],
    route: [[5, 3, 0], [5, 3, 0]], createdAt: 1,
  };
  const second = sc.adoptStoredConnections([A, B], [edge]);
  assert.strictEqual(second.quads.length, 0);
  assert.strictEqual(second.unadopted.length, 0);
});

t("fitting-joined runs are not adoption candidates (junctions stay positional)", () => {
  const A = run("A", "duct", [0, 0], [4.55, 0]);
  const E = fit("E", [5, 0], "elbow", 0, Math.PI / 2);
  const B = run("B", "duct", [5, 0.45], [5, 8]);
  const { quads, unadopted } = sc.adoptStoredConnections([A, E, B], []);
  assert.strictEqual(quads.length, 0);
  assert.strictEqual(unadopted.length, 0);
});

// ── Lifecycle round-trip (the real persistence boundary) ────────────────

t("a stored connector edge survives a save/reload round-trip through the lifecycle snapshot", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B]) });
  const sync = sc.syncStoredConnections([A, B], lifecycle);
  assert.strictEqual(sync.adopted.length, 1);
  assert.strictEqual(sync.failed.length, 0);
  assert.strictEqual(lifecycle.listConnections().length, 1);
  // This JSON round-trip is exactly what the project save/load does with
  // `mepLifecycle` (projects.ts: snapshot on save, hydrate on load).
  const saved = JSON.parse(JSON.stringify(lifecycle.snapshot()));
  const reloaded = new MepModelLifecycle();
  reloaded.hydrate(saved);
  const edges = reloaded.listConnections();
  assert.strictEqual(edges.length, 1);
  assert.strictEqual(edges[0].sourceElementId, "A");
  assert.strictEqual(edges[0].sourceConnector, "end");
  assert.strictEqual(edges[0].targetElementId, "B");
  assert.strictEqual(edges[0].targetConnector, "start");
  const snap = reloaded.snapshot();
  assert.strictEqual(snap.connectors.find((c) => c.ownerElementId === "A" && c.def.name === "end").engaged, true);
  assert.strictEqual(snap.connectors.find((c) => c.ownerElementId === "B" && c.def.name === "start").connectedTo, "A");
  assert.strictEqual(snap.connectors.find((c) => c.ownerElementId === "A" && c.def.name === "start").engaged, false);
});

t("sync reports a rejected edge instead of throwing when a port is already engaged", () => {
  // Three runs meet at one point (5,0) with no tee: only one edge can
  // exist, because a port is a single connection. The other two quads
  // are reported as failures and the stored edge is left untouched.
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const C = run("C", "duct", [5, 0], [5, 5]);
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B, C]) });
  const sync = sc.syncStoredConnections([A, B, C], lifecycle);
  assert.strictEqual(sync.adopted.length, 1);
  assert.strictEqual(sync.failed.length, 2);
  assert.strictEqual(lifecycle.listConnections().length, 1);
});

// ── System tree over stored edges ────────────────────────────────────────

function storedTree(elements, connections) {
  const registry = new st.MepSystemRegistry();
  const tree = st.computeMepSystemTree(elements, { registry, connections });
  return { registry, tree };
}

t("tree over stored edges: end-to-end runs are one system, the body-touch run is not connected", () => {
  const A = run("A", "duct", [0, 0], [10, 0]);
  const B = run("B", "duct", [10, 0], [15, 0]); // end-to-end with A
  const C = run("C", "duct", [5, 0], [5, 5]); // start lands mid-body on A
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B, C]) });
  const sync = sc.syncStoredConnections([A, B, C], lifecycle);
  assert.strictEqual(sync.adopted.length, 1);
  assert.strictEqual(sync.unadopted.length, 1);
  const { tree } = storedTree([A, B, C], lifecycle.listConnections());
  assert.strictEqual(tree.clusters.length, 2);
  const ab = tree.clusters.find((c) => c.memberIds.includes("A"));
  assert.deepStrictEqual([...ab.memberIds].sort(), ["A", "B"]);
  assert.strictEqual(ab.system, "supply-air");
  assert.strictEqual(ab.label, "Supply Air 1");
  const cOnly = tree.clusters.find((c) => c.memberIds.includes("C"));
  assert.deepStrictEqual(cOnly.memberIds, ["C"]);
  assert.strictEqual(cOnly.unconnected, true);
  assert.strictEqual(tree.unadoptedContacts.length, 1);
  assert.strictEqual(tree.unadoptedContacts[0].reason, "no-port-pair");
  assert.strictEqual(tree.unadoptedContacts[0].elementAId, "A");
  assert.strictEqual(tree.unadoptedContacts[0].elementBId, "C");
});

t("tree without a connection list keeps pure-geometry behaviour (legacy fallback)", () => {
  const A = run("A", "duct", [0, 0], [10, 0]);
  const B = run("B", "duct", [10, 0], [15, 0]);
  const C = run("C", "duct", [5, 0], [5, 5]); // start lands mid-body on A
  const tree = st.computeMepSystemTree([A, B, C]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.deepStrictEqual([...tree.clusters[0].memberIds].sort(), ["A", "B", "C"]);
  assert.deepStrictEqual(tree.unadoptedContacts, []);
});

t("tree with an EMPTY connection list still joins fitting-mediated runs geometrically", () => {
  const A = run("A", "duct", [0, 0], [4.55, 0]);
  const E = fit("E", [5, 0], "elbow", 0, Math.PI / 2);
  const B = run("B", "duct", [5, 0.45], [5, 8]);
  const tree = st.computeMepSystemTree([A, E, B], { connections: [] });
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].system, "supply-air");
  assert.deepStrictEqual(tree.unadoptedContacts, []);
});

t("a named system keeps its identity across a model edit (stored-edge path)", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B]) });
  sc.syncStoredConnections([A, B], lifecycle);
  const connections = lifecycle.listConnections();
  const registry = new st.MepSystemRegistry();
  const tree1 = st.computeMepSystemTree([A, B], { registry, connections });
  assert.strictEqual(tree1.clusters[0].persistentId, "mep-sys-1");
  assert.strictEqual(tree1.clusters[0].label, "Supply Air 1");
  st.stampSystemNames([A, B], tree1);
  // Edit: add an unrelated run far away. The system must NOT renumber.
  const D = run("D", "duct", [20, 20], [25, 20]);
  const tree2 = st.computeMepSystemTree([A, B, D], { registry, connections });
  const ab = tree2.clusters.find((c) => c.memberIds.includes("A"));
  assert.strictEqual(ab.persistentId, "mep-sys-1");
  assert.strictEqual(ab.label, "Supply Air 1");
});

t("a mixed-system cluster is an error through the stored-edge path", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  A.properties = { system: "supply-air" };
  const B = run("B", "duct", [5, 0], [10, 0]);
  B.properties = { system: "return-air" };
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B]) });
  sc.syncStoredConnections([A, B], lifecycle);
  const tree = st.computeMepSystemTree([A, B], { connections: lifecycle.listConnections() });
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.conflictCount, 1);
  const c = tree.clusters[0];
  assert.strictEqual(c.system, null);
  assert.strictEqual(c.label, "System Conflict 1");
  assert.deepStrictEqual([...c.conflicts].sort(), ["return-air", "supply-air"]);
  assert.strictEqual(c.persistentId, null);
});

t("stored edges naming deleted elements are ignored, not fatal", () => {
  const A = run("A", "duct", [0, 0], [5, 0]);
  const B = run("B", "duct", [5, 0], [10, 0]);
  const C = run("C", "duct", [10, 0], [15, 0]);
  const lifecycle = new MepModelLifecycle();
  lifecycle.hydrate({ connectors: deriveAll([A, B, C]) });
  sc.syncStoredConnections([A, B, C], lifecycle);
  assert.strictEqual(lifecycle.listConnections().length, 2);
  // C is deleted from the model afterwards; its edges dangle.
  const tree = st.computeMepSystemTree([A, B], { connections: lifecycle.listConnections() });
  assert.strictEqual(tree.clusters.length, 1);
  assert.deepStrictEqual([...tree.clusters[0].memberIds].sort(), ["A", "B"]);
});

console.log(`\nmep-stored-connectors: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
