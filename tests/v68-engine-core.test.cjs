/**
 * tests/v68-engine-core.test.cjs
 *
 * Unit tests for the MASTER PROMPT authoring core (v0.68):
 *   - Module 1.1–1.3  dependency graph + incremental evaluation + cycles
 *   - Module 1.6/2.3  parameter engine (EffectiveValue, formulas, units)
 *   - Module 2.1–2.2  object hierarchy + identity
 *   - Module 1.4      constraint solver additions (tangent, concentric)
 *
 * Values are verified against closed forms (spec §4.4: no vague checks).
 *
 * Run: `node tests/v68-engine-core.test.cjs`
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
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-9) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
}
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile the module slice ────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v68-core-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/dependency-graph/index.ts src/modules/parameter-engine/index.ts" +
  " src/modules/object-hierarchy/index.ts src/modules/constraints/solver.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const dg = require(path.join(tmpOut, "modules/dependency-graph/index.js"));
const pe = require(path.join(tmpOut, "modules/parameter-engine/index.js"));
const oh = require(path.join(tmpOut, "modules/object-hierarchy/index.js"));
const solver = require(path.join(tmpOut, "modules/constraints/solver.js"));

// ═══ MODULE 1.1–1.3: dependency graph ═══════════════════════════════════

t("graph: AddNode/RemoveNode guards", () => {
  const g = new dg.DependencyGraph();
  g.addNode("a", "parameter");
  throws(() => g.addNode("a", "parameter"), "already exists");
  assert(g.removeNode("a") === true);
  assert(g.removeNode("a") === false);
  throws(() => g.getDependencies("missing"), "unknown node");
});

t("graph: dependencies/dependents/affected subgraph", () => {
  const g = new dg.DependencyGraph();
  g.addNode("p1", "parameter");
  g.addNode("p2", "parameter");
  g.addNode("f1", "formula", {
    evaluator: (inputs) => {
      const a = inputs.get("p1");
      const b = inputs.get("p2");
      const s = (a.number ?? 0) + (b.number ?? 0);
      return { value: s, number: s };
    },
  });
  g.addNode("geo1", "geometry");
  g.addNode("qty1", "quantity");
  g.addDependency("p1", "f1", "formula-dependency");
  g.addDependency("p2", "f1", "formula-dependency");
  g.addDependency("f1", "geo1", "geometry-dependency");
  g.addDependency("geo1", "qty1", "quantity");
  assert(JSON.stringify(g.getDependencies("f1").sort()) === JSON.stringify(["p1", "p2"]));
  assert(JSON.stringify(g.getDependents("f1")) === JSON.stringify(["geo1"]));
  const affected = g.buildAffectedSubgraph(["p1"]).sort();
  assert(affected.includes("f1") && affected.includes("geo1") && affected.includes("qty1") && !affected.includes("p2"));
  // Incremental evaluation: set p1, everything downstream recomputes once.
  g.setNodeValue("p1", { value: 2, number: 2 });
  g.setNodeValue("p2", { value: 3, number: 3 });
  throws(() => g.addNode("f1", "formula"), "already exists"); // id collision guarded
  g.removeNode("geo1");
  g.addNode("geo1", "geometry", { evaluator: (inputs) => ({ value: (inputs.get("f1").number ?? 0) * 2 }) });
  g.addDependency("f1", "geo1", "geometry-dependency");
  const report = g.recompute();
  assert(report.evaluated.includes("f1") && report.evaluated.includes("geo1"));
  assert(g.evaluateNode("geo1").value === 10);
  // Change one input: f1 and geo1 recompute, p2 does not.
  const beforeP2 = g.getState("p2").evalCount;
  g.setNodeValue("p1", { value: 5, number: 5 });
  const r2 = g.recompute();
  assert(r2.evaluated.includes("f1") && r2.evaluated.includes("geo1") && !r2.evaluated.includes("p2"));
  assert(g.getState("p2").evalCount === beforeP2);
  assert(g.evaluateNode("geo1").value === 16);
});

t("graph: batch coalescing (spec 1.2)", () => {
  const g = new dg.DependencyGraph();
  g.addNode("p", "parameter");
  g.addNode("geo", "geometry", { evaluator: (inputs) => ({ value: (inputs.get("p").number ?? 0) + 1 }) });
  g.addDependency("p", "geo", "geometry-dependency");
  g.recompute();
  const before = g.getState("geo").evalCount;
  g.beginBatch();
  g.setNodeValue("p", { value: 10, number: 10 });
  g.invalidate("geo");
  g.invalidate("geo"); // duplicate invalidations coalesce
  g.endBatch();
  assert(g.getState("geo").evalCount === before + 1, "geo must recompute exactly once per batch");
});

t("graph: prohibited formula cycle rejected at AddDependency", () => {
  const g = new dg.DependencyGraph();
  g.addNode("a", "formula");
  g.addNode("b", "formula");
  g.addDependency("a", "b", "formula-dependency"); // b depends on a
  throws(() => g.addDependency("b", "a", "formula-dependency"), "prohibited formula cycle");
});

t("graph: Tarjan SCC classification (spec 1.3)", () => {
  const g = new dg.DependencyGraph();
  // Formula cycle (forced): a -> b -> c -> a
  for (const id of ["a", "b", "c"]) g.addNode(id, "formula");
  g.addDependency("a", "b", "formula-dependency", true);
  g.addDependency("b", "c", "formula-dependency", true);
  g.addDependency("c", "a", "formula-dependency", true);
  // Legitimate simultaneous system: two constraint nodes mutually related
  g.addNode("k1", "constraint");
  g.addNode("k2", "constraint");
  g.addDependency("k1", "k2", "constraint", true);
  g.addDependency("k2", "k1", "constraint", true);
  const v = g.validateAcyclicDependencies();
  assert(!v.ok, "formula cycle must make validation fail");
  const reports = g.detectCycles();
  assert(reports.length === 2);
  const classes = reports.map((r) => r.classification).sort();
  assert(classes[0] === "circular-formula" && classes[1] === "simultaneous-constraint-system");
});

t("graph: topological sort + failure recovery (last-good value)", () => {
  const g = new dg.DependencyGraph();
  g.addNode("p", "parameter");
  g.addNode("geo", "geometry", {
    evaluator: (inputs) => {
      const v = inputs.get("p").number ?? 0;
      if (v < 0) throw new Error("negative length not allowed");
      return { value: v * 2, number: v * 2 };
    },
  });
  g.addDependency("p", "geo", "geometry-dependency");
  g.setNodeValue("p", { value: 4, number: 4 });
  g.recompute();
  assert(g.evaluateNode("geo").value === 8);
  const order = g.topologicalSort();
  assert(order.indexOf("p") < order.indexOf("geo"));
  // Now break it: last-good value must survive (spec 1.2 failure recovery).
  g.setNodeValue("p", { value: -1, number: -1 });
  const r = g.recompute();
  assert(r.failed.length === 1 && r.failed[0].id === "geo");
  assert(g.evaluateNode("geo").value === 8, "last-good value preserved");
  assert(g.getState("geo").lastError === "negative length not allowed");
  // Recovery: valid value again.
  g.setNodeValue("p", { value: 7, number: 7 });
  g.recompute();
  assert(g.evaluateNode("geo").value === 14);
});

t("graph: cooperative cancellation", () => {
  const g = new dg.DependencyGraph();
  g.addNode("p1", "parameter"); g.addNode("p2", "parameter");
  g.setNodeValue("p1", { value: 1, number: 1 });
  g.setNodeValue("p2", { value: 2, number: 2 });
  g.addNode("g1", "geometry", { evaluator: (i) => ({ value: i.get("p1").number }) });
  g.addNode("g2", "geometry", { evaluator: (i) => ({ value: i.get("p2").number }) });
  g.addDependency("p1", "g1", "geometry-dependency");
  g.addDependency("p2", "g2", "geometry-dependency");
  g.cancel();
  const r = g.recompute();
  assert(r.cancelled === true && r.evaluated.length === 0);
});

// ═══ MODULE 1.6 / 2.3: parameter engine ═════════════════════════════════

t("units: exact conversions (m/mm/ft/deg)", () => {
  near(pe.convertUnits(1500, "mm", "m"), 1.5, 1e-12);
  near(pe.convertUnits(1, "m", "ft"), 1 / 0.3048, 1e-12);
  near(pe.convertUnits(180, "deg", "rad"), Math.PI, 1e-12);
  throws(() => pe.convertUnits(1, "m", "deg"), "incompatible units");
});

t("EffectiveValue precedence: instance-override > type > default (spec 2.3)", () => {
  const eng = new pe.ParameterEngine();
  eng.registerDefinition({ id: "wall.height", name: "Height", symbol: "height", dataType: "length", scope: "instance", origin: "builtin", unit: "m", defaultValue: 3.0 });
  eng.putType({ id: "t1", familyId: "f", values: { "wall.height": 2.7 } });
  eng.putElement({ id: "e1", typeId: "t1", instanceValues: {} });
  eng.putElement({ id: "e2", typeId: "t1", instanceValues: { "wall.height": 3.2 } });
  const r1 = eng.effectiveValue("e1", "wall.height");
  assert(r1.value === 2.7 && r1.source === "type");
  const r2 = eng.effectiveValue("e2", "wall.height");
  assert(r2.value === 3.2 && r2.source === "instance-override");
  eng.putElement({ id: "e3", typeId: "", instanceValues: {} });
  const r3 = eng.effectiveValue("e3", "wall.height");
  assert(r3.value === 3.0 && r3.source === "default");
});

t("formula parameters evaluate and become read-only (spec 1.6)", () => {
  const eng = new pe.ParameterEngine();
  eng.registerDefinition({ id: "w", name: "Width", symbol: "width", dataType: "length", scope: "instance", origin: "builtin", unit: "m" });
  eng.registerDefinition({ id: "h", name: "Height", symbol: "height", dataType: "length", scope: "instance", origin: "builtin", unit: "m" });
  eng.registerDefinition({ id: "area", name: "Area", symbol: "area", dataType: "area", scope: "instance", origin: "builtin", formula: "width * height", unit: "m2" });
  eng.putElement({ id: "e1", typeId: "", instanceValues: { w: 4, h: 2.5 } });
  const r = eng.effectiveValue("e1", "area");
  assert(r.source === "formula" && Math.abs(r.value - 10) < 1e-12, `area=${r.value}`);
  assert(eng.isEditable("area") === false, "formula parameters are read-only");
  const p = eng.setInstanceValue("e1", "area", 42);
  assert(p && p.code === "read-only");
});

t("setTypeValue updates instances without overriding instance values (spec 2.3)", () => {
  const eng = new pe.ParameterEngine();
  eng.registerDefinition({ id: "thk", name: "Thickness", symbol: "thk", dataType: "length", scope: "type", origin: "family", unit: "m" });
  eng.putType({ id: "t1", familyId: "f", values: {} });
  eng.putElement({ id: "a", typeId: "t1", instanceValues: {} });
  eng.putElement({ id: "b", typeId: "t1", instanceValues: { thk: 0.9 } });
  const p = eng.setTypeValue("t1", "thk", 0.2);
  assert(p === null);
  assert(eng.effectiveValue("a", "thk").value === 0.2, "non-overridden instance follows the type");
  assert(eng.effectiveValue("b", "thk").value === 0.9, "explicit override preserved");
  assert(eng.effectiveValue("a", "thk").source === "type");
  assert(eng.effectiveValue("b", "thk").source === "instance-override");
});

t("circular reference detection across formulas (spec 1.6)", () => {
  const eng = new pe.ParameterEngine();
  eng.registerDefinition({ id: "a", name: "A", symbol: "a", dataType: "number", scope: "instance", origin: "global", formula: "b + 1" });
  eng.registerDefinition({ id: "b", name: "B", symbol: "b", dataType: "number", scope: "instance", origin: "global", formula: "a + 1" });
  const problems = eng.detectCircularReferences();
  assert(problems.length >= 1 && problems[0].code === "circular-reference");
});

t("parseParameterValue: unit-aware input + range validation", () => {
  const def = { id: "x", name: "X", symbol: "x", dataType: "length", scope: "instance", origin: "project", unit: "m", min: 0, max: 10 };
  const r1 = pe.parseParameterValue(def, "1500 mm");
  assert(r1.value !== null && Math.abs(r1.value - 1.5) < 1e-12);
  const r2 = pe.parseParameterValue(def, "not-a-number");
  assert(r2.problem && r2.problem.code === "type-mismatch");
  const r3 = pe.parseParameterValue(def, "42");
  assert(r3.problem && r3.problem.code === "out-of-range");
});

// ═══ MODULE 2.1–2.2: object hierarchy ═══════════════════════════════════

t("registry: hierarchy coherence enforced", () => {
  const reg = new oh.BimRegistry();
  reg.addCategory({ id: "walls", name: "Walls", kind: "architecture" });
  reg.addFamily({ id: "basic-wall", name: "Basic Wall", categoryId: "walls", placementMode: "level-based", referencePlaneNames: ["Core Centerline"], nestedFamilyIds: [], connectorDefs: [] });
  reg.addType({ id: "w200", familyId: "basic-wall", name: "200mm", values: { width: 0.2 } });
  const el = reg.createElement({ name: "Wall 1", categoryId: "walls", familyId: "basic-wall", typeId: "w200" });
  assert(reg.getElement(el.id) !== null);
  throws(() => reg.createElement({ name: "X", categoryId: "walls", familyId: "basic-wall", typeId: "nope" }), "not a type of family");
  throws(() => reg.addType({ id: "x", familyId: "ghost", name: "X", values: {} }), "unknown family");
});

t("identity: unique ids, never reused, lookup by uniqueId (spec 2.2)", () => {
  const reg = new oh.BimRegistry();
  reg.addCategory({ id: "c", name: "C", kind: "other" });
  reg.addFamily({ id: "f", name: "F", categoryId: "c", placementMode: "free", referencePlaneNames: [], nestedFamilyIds: [], connectorDefs: [] });
  reg.addType({ id: "t", familyId: "f", name: "T", values: {} });
  const e1 = reg.createElement({ name: "1", categoryId: "c", familyId: "f", typeId: "t" });
  const e2 = reg.createElement({ name: "2", categoryId: "c", familyId: "f", typeId: "t" });
  assert(e1.id !== e2.id && e1.uniqueId !== e2.uniqueId);
  assert(reg.identity.findByUniqueId(e1.uniqueId) === e1.id);
  reg.deleteElement(e1.id);
  const e3 = reg.createElement({ name: "3", categoryId: "c", familyId: "f", typeId: "t" });
  assert(e3.id !== e1.id, "deleted ids are never reused");
  assert(reg.identity.findByUniqueId(e1.uniqueId) === null, "uniqueId forgotten on delete");
});

t("duplication: fresh ids, host remap, no external ids (spec 2C.8)", () => {
  const reg = new oh.BimRegistry();
  reg.addCategory({ id: "c", name: "C", kind: "other" });
  reg.addFamily({ id: "f", name: "F", categoryId: "c", placementMode: "free", referencePlaneNames: [], nestedFamilyIds: [], connectorDefs: [] });
  reg.addType({ id: "t", familyId: "f", name: "T", values: {} });
  const host = reg.createElement({ name: "H", categoryId: "c", familyId: "f", typeId: "t", externalIds: { "ifc-guid": "ABC" } });
  const child = reg.createElement({ name: "D", categoryId: "c", familyId: "f", typeId: "t", hostId: host.id, instanceValues: { sill: 1.1 } });
  const plan = reg.duplicate([host.id, child.id]);
  const newHost = plan.newElements.find((e) => e.name === "H");
  const newChild = plan.newElements.find((e) => e.name === "D");
  assert(newHost.id !== host.id && newHost.uniqueId !== host.uniqueId);
  assert(Object.keys(newHost.externalIds).length === 0, "external ids not copied");
  assert(newChild.hostId === newHost.id, "host remapped to the copied host");
  assert(newChild.instanceValues.sill === 1.1, "instance values cloned");
});

t("changeType: same-family validation (spec 2.11)", () => {
  const reg = new oh.BimRegistry();
  reg.addCategory({ id: "c", name: "C", kind: "other" });
  reg.addFamily({ id: "f1", name: "F1", categoryId: "c", placementMode: "free", referencePlaneNames: [], nestedFamilyIds: [], connectorDefs: [] });
  reg.addFamily({ id: "f2", name: "F2", categoryId: "c", placementMode: "free", referencePlaneNames: [], nestedFamilyIds: [], connectorDefs: [] });
  reg.addType({ id: "t1", familyId: "f1", name: "T1", values: {} });
  reg.addType({ id: "t2", familyId: "f2", name: "T2", values: {} });
  const el = reg.createElement({ name: "E", categoryId: "c", familyId: "f1", typeId: "t1" });
  throws(() => reg.changeType(el.id, "t2"), "belongs to family");
  reg.changeType(el.id, "t1");
});

// ═══ MODULE 1.4: solver additions ═══════════════════════════════════════

t("solver: tangent (fixed radius) converges to the exact tangent line", () => {
  const pts = [
    { x: -3, y: 2 }, { x: 3, y: 2 },   // line to become tangent to unit circle
    { x: 0, y: 0, fixed: true },        // circle centre
  ];
  const cons = [{ kind: "tangent", pts: [0, 1, 2], value: 1 }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status=${r.status} maxR=${r.maxResidual}`);
  // Distance from centre to the solved line must be 1.
  const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
  const dist = Math.abs(dx * (pts[2].y - pts[0].y) - dy * (pts[2].x - pts[0].x)) / Math.hypot(dx, dy);
  near(dist, 1, 1e-5);
});

t("solver: tangent (point-defined radius) exact", () => {
  // Circle centre (0,0) fixed; radius point (0,1) fixed → radius 1.
  const pts = [
    { x: -2, y: 3 }, { x: 2, y: 3 },
    { x: 0, y: 0, fixed: true }, { x: 0, y: 1, fixed: true },
  ];
  const cons = [{ kind: "tangent", pts: [0, 1, 2, 3] }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status=${r.status}`);
  const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
  const dist = Math.abs(dx * (pts[2].y - pts[0].y) - dy * (pts[2].x - pts[0].x)) / Math.hypot(dx, dy);
  near(dist, 1, 1e-5);
});

t("solver: concentric forces centre coincidence (2 equations)", () => {
  assert(solver.equationsFor({ kind: "concentric", pts: [0, 1] }) === 2);
  const pts = [{ x: 4, y: 7 }, { x: 1, y: 1, fixed: true }];
  const cons = [{ kind: "concentric", pts: [0, 1] }];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged");
  near(pts[0].x, 1, 1e-6);
  near(pts[0].y, 1, 1e-6);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
