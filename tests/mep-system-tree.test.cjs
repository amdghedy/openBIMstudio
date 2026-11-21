/* MEP System Browser tree — real named systems from connectivity (system-tree.ts). */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mst-"));
execSync(`npx tsc src/modules/mep/system-tree.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "system-tree.js"));

let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };

const run = (id, type, s, e, extra = {}) => ({ id, type, params: { start: s, end: e, elevation: 3, height: 0.3, thickness: 0.3, ...extra } });
const fit = (id, pt, kind, aIn, aOut, extra = {}) => ({ id, type: "fitting", params: { point: pt, elevation: 3, height: 0.3, thickness: 0.3, fittingKind: kind, angleIn: aIn, angleOut: aOut, parentType: "duct", bendRadius: 0.45, ...extra } });
const eq = (id, pt, extra = {}) => ({ id, type: "equipment", params: { point: pt, elevation: 2.8, height: 0.6, thickness: 0.6, depth: 0.6, ...extra } });
const wall = { id: "w1", type: "wall", params: { start: [0, 0], end: [3, 0], elevation: 0, height: 3, thickness: 0.2 } };
const door = { id: "d1", type: "door", params: { point: [1, 0], elevation: 0, height: 2.1, thickness: 0.06 } };

// A (0,0)->(4.55,0), elbow at (5,0) turning north, B (5,0.45)->(5,8) — the
// connectivity suite's canonical joined run.
const A = run("A", "duct", [0, 0], [4.55, 0]);
const E = fit("E", [5, 0], "elbow", 0, Math.PI / 2);
const B = run("B", "duct", [5, 0.45], [5, 8]);
const far = run("far", "duct", [20, 20], [25, 20]);

t("two ducts joined through an elbow form ONE named system", () => {
  const tree = m.computeMepSystemTree([A, E, B]);
  assert.strictEqual(tree.clusters.length, 1);
  const c = tree.clusters[0];
  assert.strictEqual(c.system, "supply-air");
  assert.strictEqual(c.label, "Supply Air 1");
  assert.strictEqual(c.id, "supply-air-1");
  assert.deepStrictEqual(c.memberIds, ["A", "B", "E"]); // linear before fitting
  assert.strictEqual(c.unconnected, false);
  assert.strictEqual(tree.totalMep, 3);
  assert.strictEqual(tree.unconnectedCount, 0);
});
t("equipment heads the member list and follows its duct", () => {
  const Q = eq("Q", [-0.3, 0]);
  const ed = run("ed", "duct", [-0.3, 0.2], [-0.3, -6]);
  const tree = m.computeMepSystemTree([ed, Q, far]);
  assert.strictEqual(tree.clusters.length, 2);
  const sys = tree.clusters.find((c) => c.memberIds.includes("Q"));
  assert.strictEqual(sys.memberIds[0], "Q"); // equipment first
  assert.strictEqual(sys.unconnected, false);
  assert.strictEqual(tree.unconnectedCount, 1); // `far` alone
});
t("declared properties.system wins over the type default", () => {
  const p1 = run("p1", "pipe", [0, 0], [2, 0], { });
  const p2 = run("p2", "pipe", [2, 0], [4, 0], { });
  p1.properties = { system: "hot-water" }; p2.properties = { system: "hot-water" };
  const d = run("d", "duct", [4, 0], [6, 0]);
  const tree = m.computeMepSystemTree([p1, p2, d]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].system, "hot-water");
  assert.strictEqual(tree.clusters[0].label, "Hot Water 1");
});
t("two declared systems in one cluster are REJECTED as a conflict, not majority-voted", () => {
  const p1 = run("p1", "pipe", [0, 0], [1, 0]); p1.properties = { system: "domestic-cold" };
  const p2 = run("p2", "pipe", [1, 0], [2, 0]); p2.properties = { system: "domestic-hot" };
  const tree = m.computeMepSystemTree([p1, p2]);
  assert.strictEqual(tree.clusters.length, 1);
  const c = tree.clusters[0];
  assert.strictEqual(c.system, null); // rejected, not resolved
  assert.strictEqual(c.label, "System Conflict 1");
  assert.strictEqual(c.id, "system-conflict-1");
  assert.deepStrictEqual([...c.conflicts].sort(), ["domestic-cold", "domestic-hot"]);
  assert.strictEqual(c.diagnostics.length, 1);
  assert.ok(c.diagnostics[0].includes("domestic-cold") || c.diagnostics[0].includes("Domestic Cold Water"));
  assert.ok(c.diagnostics[0].includes("p1") && c.diagnostics[0].includes("p2"));
  assert.strictEqual(tree.conflictCount, 1);
});
t("a 3-to-1 declared majority still conflicts — no majority vote", () => {
  const mk = (id, x0, sys) => { const r = run(id, "pipe", [x0, 0], [x0 + 1, 0]); r.properties = { system: sys }; return r; };
  const tree = m.computeMepSystemTree([mk("a", 0, "domestic-cold"), mk("b", 1, "domestic-cold"), mk("c", 2, "domestic-cold"), mk("d", 3, "domestic-hot")]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].system, null);
  assert.strictEqual(tree.conflictCount, 1);
});
t("a conflict cluster does not poison a separate clean cluster", () => {
  const p1 = run("p1", "pipe", [0, 0], [1, 0]); p1.properties = { system: "domestic-cold" };
  const p2 = run("p2", "pipe", [1, 0], [2, 0]); p2.properties = { system: "domestic-hot" };
  const q1 = run("q1", "duct", [20, 20], [25, 20]);
  const tree = m.computeMepSystemTree([p1, p2, q1]);
  assert.strictEqual(tree.clusters.length, 2);
  assert.strictEqual(tree.conflictCount, 1);
  const clean = tree.clusters.find((c) => c.memberIds.includes("q1"));
  assert.strictEqual(clean.system, "supply-air");
  assert.strictEqual(clean.label, "Supply Air 1");
  assert.deepStrictEqual(clean.conflicts, []);
});
t("one declared system plus undeclared members is not a conflict", () => {
  const p1 = run("p1", "pipe", [0, 0], [1, 0]); p1.properties = { system: "hot-water" };
  const p2 = run("p2", "pipe", [1, 0], [2, 0]); // undeclared
  const tree = m.computeMepSystemTree([p1, p2]);
  assert.strictEqual(tree.clusters[0].system, "hot-water");
  assert.strictEqual(tree.conflictCount, 0);
});
t("invalid properties.system values are ignored (fall to type default)", () => {
  const p = run("p", "pipe", [0, 0], [1, 0]); p.properties = { system: "steam" };
  const tree = m.computeMepSystemTree([p]);
  assert.strictEqual(tree.clusters[0].system, "domestic-cold");
});
t("isolated element is an unconnected singleton", () => {
  const tree = m.computeMepSystemTree([far]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].unconnected, true);
  assert.strictEqual(tree.unconnectedCount, 1);
  assert.ok(/^Supply Air \d+$/.test(tree.clusters[0].label));
});
t("non-MEP elements are excluded everywhere", () => {
  const tree = m.computeMepSystemTree([wall, door, A, E, B]);
  assert.strictEqual(tree.totalMep, 3);
  for (const c of tree.clusters) {
    assert.ok(!c.memberIds.includes("w1"));
    assert.ok(!c.memberIds.includes("d1"));
  }
});
t("separate clusters of one system number by first appearance", () => {
  const q1 = run("q1", "pipe", [0, 0], [1, 0]);
  const q2 = run("q2", "pipe", [10, 0], [11, 0]);
  const q3 = run("q3", "pipe", [11, 0], [12, 0]);
  const tree = m.computeMepSystemTree([q1, q2, q3]);
  assert.strictEqual(tree.clusters.length, 2);
  const labels = tree.clusters.map((c) => c.label).sort();
  assert.deepStrictEqual(labels, ["Domestic Cold Water 1", "Domestic Cold Water 2"]);
  const first = tree.clusters.find((c) => c.memberIds.includes("q1"));
  assert.strictEqual(first.label, "Domestic Cold Water 1");
});
t("fitting-only cluster classifies through parentType", () => {
  const f1 = fit("f1", [0, 0], "union", 0, Math.PI / 2, { parentType: "pipe" });
  const f2 = fit("f2", [0.4, 0], "union", 0, Math.PI / 2, { parentType: "pipe" });
  const tree = m.computeMepSystemTree([f1, f2]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].system, "domestic-cold");
  assert.strictEqual(tree.clusters[0].memberIds.length, 2);
});
t("tee-joined network stays ONE system with all members", () => {
  const main1 = run("m1", "duct", [0, 0], [3.8, 0]);
  const main2 = run("m2", "duct", [6.2, 0], [10, 0]);
  const tee = fit("T", [5, 0], "tee", 0, Math.PI / 2);
  const br = run("br", "duct", [5, 0.9], [5, 6]);
  const tree = m.computeMepSystemTree([main1, main2, tee, br]);
  assert.strictEqual(tree.clusters.length, 1);
  assert.strictEqual(tree.clusters[0].system, "supply-air");
  assert.strictEqual(tree.clusters[0].memberIds.length, 4);
  assert.strictEqual(tree.clusters[0].memberIds[3], "T"); // fitting last
});
t("cable-tray and conduit map to their own systems", () => {
  const t1 = run("t1", "cable-tray", [0, 0], [1, 0]);
  const t2 = run("t2", "cable-tray", [1, 0], [2, 0]);
  const tree = m.computeMepSystemTree([t1, t2]);
  assert.strictEqual(tree.clusters[0].system, "cable-tray");
  assert.strictEqual(tree.clusters[0].label, "Cable Tray 1");
  const c1 = run("c1", "conduit", [0, 0], [1, 0]);
  const c2 = run("c2", "conduit", [1, 0], [2, 0]);
  const tree2 = m.computeMepSystemTree([c1, c2]);
  assert.strictEqual(tree2.clusters[0].system, "conduit");
  assert.strictEqual(tree2.clusters[0].label, "Conduit 1");
});
t("equipment-only inputs are unclassified unconnected singletons", () => {
  const Q1 = eq("Q1", [0, 0]);
  const Q2 = eq("Q2", [10, 10]);
  const tree = m.computeMepSystemTree([Q1, Q2]);
  assert.strictEqual(tree.clusters.length, 2); // equipment never connects to equipment
  for (const c of tree.clusters) {
    assert.strictEqual(c.system, null);
    assert.strictEqual(c.unconnected, true);
    assert.strictEqual(c.id.startsWith("unclassified-"), true);
  }
  assert.deepStrictEqual(tree.clusters.map((c) => c.label), ["Unclassified 1", "Unclassified 2"]);
});
t("tree is deterministic across runs", () => {
  const input = [A, E, B, far, wall, eq("Q", [-0.3, 0])];
  const t1 = m.computeMepSystemTree(input);
  const t2 = m.computeMepSystemTree(input);
  assert.deepStrictEqual(t1, t2);
});
t("cluster ids are unique across a mixed tree", () => {
  const q1 = run("q1", "pipe", [0, 0], [1, 0]);
  const q2 = run("q2", "pipe", [10, 0], [11, 0]);
  const tree = m.computeMepSystemTree([A, E, B, q1, q2, far]);
  const ids = tree.clusters.map((c) => c.id);
  assert.deepStrictEqual(ids, [...new Set(ids)]);
});
t("empty and non-MEP inputs yield an empty tree", () => {
  assert.deepStrictEqual(m.computeMepSystemTree([]), { clusters: [], unconnectedCount: 0, conflictCount: 0, totalMep: 0, unadoptedContacts: [] });
  const tree = m.computeMepSystemTree([wall, door]);
  assert.strictEqual(tree.totalMep, 0);
  assert.strictEqual(tree.clusters.length, 0);
});
t("labels cover every typed system (no missing key)", () => {
  const systems = ["supply-air", "return-air", "exhaust-air", "outside-air", "chilled-water", "hot-water",
    "domestic-cold", "domestic-hot", "sanitary", "condensate", "gas", "medical-vacuum", "medical-oxygen",
    "sprinkler", "cable-tray", "conduit"];
  for (const s of systems) assert.ok(typeof m.MEP_SYSTEM_LABELS[s] === "string" && m.MEP_SYSTEM_LABELS[s].length > 0, s);
});

// ── Persisted named systems (MepSystemRegistry + stampSystemNames) ───────

t("registry: names survive recompute after stamping (no renumbering)", () => {
  const reg = new m.MepSystemRegistry();
  const tree1 = m.computeMepSystemTree([A, E, B], { registry: reg });
  assert.strictEqual(tree1.clusters[0].label, "Supply Air 1");
  assert.ok(tree1.clusters[0].persistentId);
  assert.strictEqual(m.stampSystemNames([A, E, B], tree1), 3);
  const tree2 = m.computeMepSystemTree([A, E, B], { registry: reg });
  assert.strictEqual(tree2.clusters[0].label, "Supply Air 1");
  assert.strictEqual(tree2.clusters[0].persistentId, tree1.clusters[0].persistentId);
  assert.strictEqual(tree2.clusters[0].id, tree1.clusters[0].id);
});
t("registry: adding an unrelated system does not renumber the first", () => {
  const reg = new m.MepSystemRegistry();
  const a1 = run("a1", "duct", [0, 0], [4, 0]);
  const b1 = run("b1", "duct", [20, 20], [24, 20]);
  const t1 = m.computeMepSystemTree([a1], { registry: reg });
  m.stampSystemNames([a1], t1);
  const t2 = m.computeMepSystemTree([a1, b1], { registry: reg });
  m.stampSystemNames([a1, b1], t2);
  const first = t2.clusters.find((c) => c.memberIds.includes("a1"));
  const second = t2.clusters.find((c) => c.memberIds.includes("b1"));
  assert.strictEqual(first.label, "Supply Air 1");
  assert.strictEqual(second.label, "Supply Air 2");
  // And a third refresh still keeps both names.
  const t3 = m.computeMepSystemTree([a1, b1], { registry: reg });
  assert.deepStrictEqual(t3.clusters.map((c) => c.label).sort(), ["Supply Air 1", "Supply Air 2"]);
});
t("registry: removing a member keeps the system name", () => {
  const reg = new m.MepSystemRegistry();
  const a1 = run("a1", "duct", [0, 0], [4, 0]);
  const a2 = run("a2", "duct", [4, 0], [8, 0]);
  const t1 = m.computeMepSystemTree([a1, a2], { registry: reg });
  m.stampSystemNames([a1, a2], t1);
  const t2 = m.computeMepSystemTree([a1], { registry: reg });
  assert.strictEqual(t2.clusters[0].label, "Supply Air 1");
  assert.strictEqual(t2.clusters[0].persistentId, t1.clusters[0].persistentId);
});
t("registry: joining two named systems keeps the earliest name and reports the merge", () => {
  const reg = new m.MepSystemRegistry();
  const a1 = run("a1", "duct", [0, 0], [4, 0]);
  const b1 = run("b1", "duct", [20, 20], [24, 20]);
  const t1 = m.computeMepSystemTree([a1, b1], { registry: reg });
  m.stampSystemNames([a1, b1], t1);
  assert.deepStrictEqual(t1.clusters.map((c) => c.label).sort(), ["Supply Air 1", "Supply Air 2"]);
  // Move b1 to touch a1, joining the two systems.
  b1.params.start = [4, 0]; b1.params.end = [8, 0];
  const t2 = m.computeMepSystemTree([a1, b1], { registry: reg });
  assert.strictEqual(t2.clusters.length, 1);
  assert.strictEqual(t2.clusters[0].label, "Supply Air 1");
  assert.ok(t2.clusters[0].diagnostics.some((d) => d.includes("Supply Air 2") && d.includes("Merged")));
  // Stamping overwrites the retired name on b1.
  m.stampSystemNames([a1, b1], t2);
  assert.strictEqual(b1.properties.mepSystemName, "Supply Air 1");
});
t("registry: re-classifying a system invalidates its old stamp", () => {
  const reg = new m.MepSystemRegistry();
  const a1 = run("a1", "duct", [0, 0], [4, 0]);
  const t1 = m.computeMepSystemTree([a1], { registry: reg });
  m.stampSystemNames([a1], t1);
  assert.strictEqual(t1.clusters[0].label, "Supply Air 1");
  a1.properties = { ...(a1.properties ?? {}), system: "return-air" };
  const t2 = m.computeMepSystemTree([a1], { registry: reg });
  assert.strictEqual(t2.clusters[0].label, "Return Air 1");
  assert.notStrictEqual(t2.clusters[0].persistentId, t1.clusters[0].persistentId);
});
t("registry: conflict clusters get no persistent identity and stamp nothing", () => {
  const reg = new m.MepSystemRegistry();
  const p1 = run("p1", "pipe", [0, 0], [1, 0]); p1.properties = { system: "domestic-cold" };
  const p2 = run("p2", "pipe", [1, 0], [2, 0]); p2.properties = { system: "domestic-hot" };
  const tree = m.computeMepSystemTree([p1, p2], { registry: reg });
  assert.strictEqual(tree.clusters[0].persistentId, null);
  assert.strictEqual(m.stampSystemNames([p1, p2], tree), 0);
  assert.strictEqual(p1.properties.mepSystemId, undefined);
});
t("registry: a fresh registry rehydrates names from stamps alone", () => {
  const reg1 = new m.MepSystemRegistry();
  const a1 = run("a1", "duct", [0, 0], [4, 0]);
  const a2 = run("a2", "duct", [20, 20], [24, 20]);
  const t1 = m.computeMepSystemTree([a1, a2], { registry: reg1 });
  m.stampSystemNames([a1, a2], t1);
  // Simulate a reload: brand-new registry, same stamped elements.
  const reg2 = new m.MepSystemRegistry();
  const t2 = m.computeMepSystemTree([a1, a2], { registry: reg2 });
  assert.deepStrictEqual(t2.clusters.map((c) => c.label).sort(), ["Supply Air 1", "Supply Air 2"]);
  // A new third system mints past the stamped maximum, never colliding.
  const a3 = run("a3", "duct", [40, 40], [44, 40]);
  const t3 = m.computeMepSystemTree([a1, a2, a3], { registry: reg2 });
  assert.strictEqual(t3.clusters.find((c) => c.memberIds.includes("a3")).label, "Supply Air 3");
});
t("without a registry the tree is unchanged (derived ids, no stamps)", () => {
  const x1 = run("x1", "duct", [0, 0], [4, 0]);
  const tree = m.computeMepSystemTree([x1]);
  assert.strictEqual(tree.clusters[0].id, "supply-air-1");
  assert.strictEqual(tree.clusters[0].persistentId, null);
  assert.strictEqual(x1.properties, undefined);
});

console.log(`\nmep-system-tree: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
