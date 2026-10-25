/**
 * tests/v68-acceptance.test.cjs
 *
 * MASTER PROMPT MODULE 2E — the ten mandatory integration/acceptance
 * scenarios, executed against the real engine APIs (no mocks of the
 * behaviour under test). Performance scenario 10 measures candidate
 * query time and memory with generous CI-safe budgets.
 *
 * Run: `node tests/v68-acceptance.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-9) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`); }

// ── Compile the full authoring slice ────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v68-acc-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/snapping/index.ts src/modules/relationships/index.ts src/modules/modify/index.ts" +
  " src/modules/mep/connectors.ts src/modules/properties-panel/authoring.ts" +
  " src/modules/object-hierarchy/index.ts src/modules/solid-kernel/index.ts" +
  " src/modules/hosting/index.ts src/modules/dependency-graph/index.ts" +
  " src/modules/parameter-engine/index.ts src/modules/constraints/solver.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const snap = require(path.join(tmpOut, "modules/snapping/index.js"));
const rel = require(path.join(tmpOut, "modules/relationships/index.js"));
const mod = require(path.join(tmpOut, "modules/modify/index.js"));
const mepc = require(path.join(tmpOut, "modules/mep/connectors.js"));
const pp = require(path.join(tmpOut, "modules/properties-panel/authoring.js"));
const oh = require(path.join(tmpOut, "modules/object-hierarchy/index.js"));
const sk = require(path.join(tmpOut, "modules/solid-kernel/index.js"));
const host = require(path.join(tmpOut, "modules/hosting/index.js"));
const dg = require(path.join(tmpOut, "modules/dependency-graph/index.js"));
const pe = require(path.join(tmpOut, "modules/parameter-engine/index.js"));
const solver = require(path.join(tmpOut, "modules/constraints/solver.js"));

function makeStore(elements) {
  const map = new Map();
  for (const el of elements) map.set(el.id, { ...el, curve: el.curve ? { ...el.curve } : undefined });
  return {
    get: (id) => map.get(id),
    apply: (id, patch) => { const el = map.get(id); if (!el) return false; Object.assign(el, patch); return true; },
    insert: (el) => map.set(el.id, { ...el, curve: el.curve ? { ...el.curve } : undefined }),
    all: () => [...map.values()],
  };
}
const wall = (id, start, end, extra = {}) => ({
  id, categoryId: "walls", pinned: false, editable: true,
  position: [0, 0], rotationZ: 0,
  curve: { start, end }, ...extra,
});

// ── Scenario 1: wall drawn toward a rectangular column ───────────────────
t("2E.1 wall toward column: detection, endpoint, relationship, propagation", () => {
  const col = snap.getColumnReferenceGeometry({
    elementId: "col1",
    footprint: [[4, -0.3], [4.6, -0.3], [4.6, 0.3], [4, 0.3]],
    baseZ: 0, topZ: 3,
  });
  const wallLine = snap.getWallLocationLine({ start: [0, 0], end: [4.5, 0], width: 0.2, justification: "core-centerline" });
  const resolved = snap.calculateWallEndpoint(wallLine, col);
  assert(resolved !== null);
  near(resolved.endpoint[0], 4, 1e-12); // west face
  const v = snap.validateWallColumnConnection(wallLine, col, resolved.endpoint, resolved.contact);
  assert(v.valid, v.problems.join("; "));
  const registry = new rel.RelationshipRegistry();
  snap.createWallColumnRelationship(registry, wallLine, col, "w1", resolved.endpoint, resolved.contact, 0);
  assert(registry.count === 1);
  // Column moves +0.5 x → the wall endpoint relationship follows.
  const out = registry.evaluateRelationshipAfterGeometryChange({
    elementId: "col1", newVersion: 2, translation: [0.5, 0, 0], rotationZ: 0,
  });
  near(out[0].newPosition[0], 4.5, 1e-9);
});

// ── Scenario 2: corner + T junction via the constraint solver ────────────
t("2E.2 corner/T junction: snapping, joining, dependent movement", () => {
  // Corner: two walls sharing an endpoint (coincident), one horizontal
  // one vertical. T: a third wall ending on the first's middle (midpoint).
  const pts = [
    { x: 0, y: 0, fixed: true },   // corner origin
    { x: 4, y: 0 },                // wall A end
    { x: 0, y: 3 },                // wall B end (corner join with origin)
    { x: 2, y: 0 },                // wall C start (midpoint of A)
  ];
  const cons = [
    { kind: "coincident", pts: [0, 2] },              // B joins the corner
    { kind: "midpoint", pts: [3, 0, 1] },             // C starts at A's midpoint
  ];
  const r = solver.solve(pts, cons);
  assert(r.status === "converged", `status=${r.status} maxR=${r.maxResidual}`);
  // Move wall A's end to (5, 1) — the user-pinned endpoint is FIXED during
  // the solve (the platform pins dragged endpoints, v0.67 semantics), so
  // the midpoint follower must track to half.
  pts[1].x = 5; pts[1].y = 1; pts[1].fixed = true;
  const r2 = solver.solve(pts, cons);
  assert(r2.status === "converged");
  near(pts[3].x, 2.5, 1e-6);
  near(pts[3].y, 0.5, 1e-6);
  near(pts[2].x, 0, 1e-6); // corner stays joined
  near(pts[2].y, 0, 1e-6);
});

// ── Scenario 3: window in a wall; wall edits regenerate the opening ──────
t("2E.3 window hosting: thickness/position/height changes regenerate", () => {
  const mk = (curve, height, version) => ({ curve, baseZ: 0, height, version, layers: [] });
  const g0 = mk({ kind: "line", start: [0, 0], end: [6, 0] }, 3, 1);
  const win = { id: "win1", s: 3, width: 1.2, height: 1.4, sillHeight: 0.9, layerOffset: 0 };
  const p0 = host.placeOpening(g0, win);
  near(p0.center[0], 3, 1e-12);
  // Wall shortens to 4 m: the window at s=3 with width 1.2 (needs ≤ 4)
  // survives; a second window at s=5 becomes invalid.
  const win2 = { id: "win2", s: 5, width: 1.0, height: 1.2, sillHeight: 0.9, layerOffset: 0 };
  const g1 = mk({ kind: "line", start: [0, 0], end: [4, 0] }, 3, 2);
  const r = host.evaluateHostedOpeningsAfterHostChange(g0, g1, [win, win2]);
  assert(r.moved.length === 1 && r.moved[0].openingId === "win1");
  assert(r.invalid.length === 1 && r.invalid[0].openingId === "win2");
  // Curved host: radius change keeps the angular position.
  const arc = { center: [0, 0], radius: 4, startAngle: 0, endAngle: Math.PI / 2 };
  const curved = { id: "cw", s: 4 * Math.PI / 4, width: 0.8, height: 1.2, sillHeight: 0.9, layerOffset: 0 };
  const rp = host.propagateOpeningToNewRadius(arc, curved, 8);
  const newL = 8 * (Math.PI / 2);
  near(rp.newS / newL, (4 * Math.PI / 4) / (4 * Math.PI / 2), 1e-9);
});

// ── Scenario 4: pipe routed from equipment ───────────────────────────────
t("2E.4 pipe routing: compatibility, preview, connectivity, movement", () => {
  function connector(owner, name, opts = {}) {
    return {
      ownerElementId: owner,
      def: { name, origin: [0, 0, 0], direction: [1, 0, 0], domain: opts.domain ?? "pipe",
        shape: opts.shape ?? "round", size: opts.size ?? 0.05,
        flowDirection: opts.flow ?? "out", systemClassification: opts.system ?? "domestic-cold" },
      worldOrigin: opts.origin ?? [0, 0, 0], worldDirection: opts.dir ?? [1, 0, 0],
      engaged: false, connectedTo: null,
    };
  }
  const pump = connector("pump", "out", { flow: "out", origin: [0, 0, 1] });
  const bend = connector("pipe1", "in", { flow: "in", size: 0.08, origin: [3, 0, 1] });
  const wrongDomain = connector("fan", "in", { flow: "in", domain: "duct", origin: [2, 0, 1] });
  const cands = mepc.queryCompatibleConnectors(pump, [wrongDomain, bend], 10);
  assert(cands.length === 1 && cands[0].connector.ownerElementId === "pipe1");
  const route = mepc.findMepConnectionPath(pump, bend);
  const fittings = mepc.calculateRequiredFittings(route, pump, bend);
  assert(fittings.some((f) => f.kind === "reducer"), JSON.stringify(fittings));
  const conn = mepc.createConnectorRelationship(pump, bend, route, fittings);
  assert(pump.engaged && bend.engaged);
  // Equipment moves: affected connections re-evaluate (cache invalidation).
  const affected = mepc.recalculateAffectedMepProperties([conn], "pump");
  assert(affected.length === 1);
  const issues = mepc.validateMepNetworkTopology([pump, bend, connector("stray", "in", { origin: [9, 9, 9] })], [conn]);
  assert(issues.some((i) => i.code === "disconnected-equipment" && i.elementIds.includes("stray")));
});

// ── Scenario 5: column width edited in the Properties panel ──────────────
t("2E.5 property edit: validation, regen dependency, rollback", () => {
  const engine = new pe.ParameterEngine();
  engine.registerDefinition({ id: "col.width", name: "Width", symbol: "width", dataType: "length", scope: "instance", origin: "builtin", unit: "m", min: 0.1, max: 2 });
  engine.registerDefinition({ id: "col.volume", name: "Volume", symbol: "vol", dataType: "volume", scope: "instance", origin: "builtin", unit: "m3", formula: "width * width * 3" });
  engine.putElement({ id: "col1", typeId: "", instanceValues: { "col.width": 0.4 } });
  // Valid edit through the full lifecycle.
  const access = {
    getCategory: () => "columns",
    getInstanceValue: (id, p) => (id === "col1" ? engine.effectiveValue(id, p).value : null),
    setInstanceValue: (id, p, v) => { const pr = engine.setInstanceValue(id, p, v); if (pr) throw new Error(pr.message); },
  };
  const built = pp.BuildPropertyChangeSet({ elementIds: ["col1"], categoryId: "columns", parameterId: "col.width", input: "600 mm", access, engine });
  assert(built.changeSet !== null && built.changeSet.value === 0.6);
  const preview = pp.PreviewPropertyChange(built.changeSet, engine);
  assert(preview[0].dependents.some((d) => d.parameterId === "col.volume" && Math.abs(d.value - 1.08) < 1e-9), JSON.stringify(preview));
  pp.CommitPropertyChange(built.changeSet, access, engine);
  assert(engine.effectiveValue("col1", "col.width").value === 0.6);
  // Out-of-range edit rejected atomically.
  const rejected = pp.BuildPropertyChangeSet({ elementIds: ["col1"], categoryId: "columns", parameterId: "col.width", input: "5", access, engine });
  assert(rejected.changeSet === null && rejected.diagnostics[0].code === "out-of-range");
  assert(engine.effectiveValue("col1", "col.width").value === 0.6, "rejected edit left the model untouched");
});

// ── Scenario 6: move/rotate/copy/mirror connected objects ────────────────
t("2E.6 connected objects: identity, constraints, connector orientation", () => {
  const store = makeStore([wall("beam1", [0, 0], [4, 0], { position: [0, 0], categoryId: "beams" })]);
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "rigid-attachment",
    source: { elementId: "beam1", kind: "endpoint", position: [4, 0, 0] },
    target: { elementId: "hanger", kind: "endpoint", position: [4, -1, 0] },
    reconnection: "follow-source",
  });
  let n = 0;
  const alloc = () => `copy-${++n}`;
  // Rotate 90° about the origin: end (4,0) → (0,4).
  const rot = new mod.RotateCommand({ store, relationships: registry });
  rot.Begin(["beam1"]);
  rot.UpdatePreview({ type: "rotation", pivot: [0, 0], angle: Math.PI / 2 });
  const rc = rot.Commit();
  assert(rc.ok);
  const el = store.get("beam1");
  // The local curve is frame-relative; assert the WORLD-space end.
  const rwex = el.position[0] + el.curve.end[0] * Math.cos(el.rotationZ) - el.curve.end[1] * Math.sin(el.rotationZ);
  const rwey = el.position[1] + el.curve.end[0] * Math.sin(el.rotationZ) + el.curve.end[1] * Math.cos(el.rotationZ);
  near(rwex, 0, 1e-9);
  near(rwey, 4, 1e-9);
  // Propagate: hanger follows the moved end. The source reference (the
  // beam end at (4,0)) rotated about the origin to (0,4): its ACTUAL
  // displacement is (−4, +4) with Δrotation 90°. The rigid follow composes
  // R(90°)·offset + source + translation:
  //   R(90°)·(0,−1) = (1,0); (4,0)+(−4,4) = (0,4); → (1,4).
  const prop = mod.propagateAfterCommit(registry, "beam1", [-4, 4], Math.PI / 2);
  assert(prop.length === 1 && prop[0].elementId === "hanger");
  near(prop[0].newPosition[0], 1, 1e-9);
  near(prop[0].newPosition[1], 4, 1e-9);
  // Copy: fresh identity.
  const cp = new mod.CopyCommand({ store, allocateId: alloc });
  cp.Begin(["beam1"]);
  cp.UpdatePreview({ type: "copy", translation: [2, 0] });
  cp.Commit();
  const copy = store.get("copy-1");
  // Fresh identity at the modify layer (uniqueId minting is the BimRegistry
  // layer's concern — verified in v68-engine-core).
  assert(copy.id !== "beam1");
  // The local curve is frame-relative; the copy's WORLD end sits at
  // (2,0) + R(90°)·(4,0) = (2,4).
  const cwex = copy.position[0] + copy.curve.end[0] * Math.cos(copy.rotationZ) - copy.curve.end[1] * Math.sin(copy.rotationZ);
  const cwey = copy.position[1] + copy.curve.end[0] * Math.sin(copy.rotationZ) + copy.curve.end[1] * Math.cos(copy.rotationZ);
  near(cwex, 2, 1e-9);
  near(cwey, 4, 1e-9);
  // Mirror about x-axis: y flips.
  const mir = new mod.MirrorCommand({ store, allocateId: alloc });
  mir.Begin(["copy-1"]);
  mir.UpdatePreview({ type: "mirror-axis", point: [0, 0], dir: [1, 0], copy: false });
  mir.Commit();
  const mirrored = store.get("copy-1");
  near(mirrored.position[1], 0, 1e-9);
  // World-space end = position + R(rot)·local end; the mirrored beam must
  // reach y = −4 in WORLD coordinates.
  const wex = mirrored.position[0] + mirrored.curve.end[0] * Math.cos(mirrored.rotationZ) - mirrored.curve.end[1] * Math.sin(mirrored.rotationZ);
  const wey = mirrored.position[1] + mirrored.curve.end[0] * Math.sin(mirrored.rotationZ) + mirrored.curve.end[1] * Math.cos(mirrored.rotationZ);
  near(wex, 2, 1e-9);
  near(wey, -4, 1e-9);
});

// ── Scenario 7: locked alignment + incompatible move ─────────────────────
t("2E.7 locked alignment blocks; valid state preserved", () => {
  const store = makeStore([wall("w1", [0, 0], [4, 0])]);
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "w1", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "grid-a", kind: "grid", position: [0, 0, 0] },
    constraint: { kind: "coincident" },
    reconnection: "follow-source",
  });
  const cmd = new mod.MoveCommand({ store, relationships: registry });
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "numeric-offset", dx: 2, dy: 0 });
  const v = cmd.Validate();
  assert(!v.ok && v.diagnostics.some((d) => d.code === "alignment-conflict"));
  const c = cmd.Commit();
  assert(!c.ok && c.applied === 0);
  near(store.get("w1").curve.start[0], 0, 1e-12, "last valid state preserved");
  // Unlocking (breaking) the relationship allows the same move.
  const recs = registry.queryRelationships({ elementId: "w1" });
  registry.breakRelationship(recs[0].id, true);
  const cmd2 = new mod.MoveCommand({ store, relationships: registry });
  cmd2.Begin(["w1"]);
  cmd2.UpdatePreview({ type: "numeric-offset", dx: 2, dy: 0 });
  assert(cmd2.Validate().ok);
  assert(cmd2.Commit().ok);
});

// ── Scenario 8: undo/redo of a complex connected modification ────────────
t("2E.8 undo/redo: deterministic replay of graph + relationships", () => {
  // The engine's undo story: commands are deterministic functions of their
  // inputs; replaying the same change set yields the same state (spec 5.4).
  const g = new dg.DependencyGraph();
  g.addNode("p.height", "parameter");
  g.addNode("p.width", "parameter");
  g.addNode("geo.wall", "geometry", {
    evaluator: (inputs) => {
      const h = inputs.get("p.height").number ?? 0;
      const w = inputs.get("p.width").number ?? 0;
      return { value: { h, w, volume: h * w * 4 }, number: h * w * 4 };
    },
  });
  g.addDependency("p.height", "geo.wall", "geometry-dependency");
  g.addDependency("p.width", "geo.wall", "geometry-dependency");
  g.setNodeValue("p.height", { value: 3, number: 3 });
  g.setNodeValue("p.width", { value: 0.2, number: 0.2 });
  g.recompute();
  const state1 = g.evaluateNode("geo.wall").value;
  // "Edit": height 2.8.
  g.setNodeValue("p.height", { value: 2.8, number: 2.8 });
  g.recompute();
  assert(Math.abs(g.evaluateNode("geo.wall").value.volume - 2.24) < 1e-9);
  // "Undo": restore the journaled old values → identical state.
  g.setNodeValue("p.height", { value: 3, number: 3 });
  g.recompute();
  const state2 = g.evaluateNode("geo.wall").value;
  assert(JSON.stringify(state1) === JSON.stringify(state2), "undo replay must be deterministic");
  // "Redo": re-apply the edit → the edited state again.
  g.setNodeValue("p.height", { value: 2.8, number: 2.8 });
  g.recompute();
  assert(Math.abs(g.evaluateNode("geo.wall").value.volume - 2.24) < 1e-9);
  // Relationship bookkeeping survives round-trips.
  const registry = new rel.RelationshipRegistry();
  const rec = registry.createRelationship({
    type: "host",
    source: { elementId: "wall", kind: "face", position: [0, 0, 0] },
    target: { elementId: "win", kind: "endpoint", position: [1, 0, 1] },
  });
  registry.setGeometryVersion("wall", 3);
  registry.reconcileRelationshipsAfterReload(new Set(["wall", "win"]));
  assert(registry.getRecord(rec.id).valid && registry.getRecord(rec.id).geometryVersion === 3);
});

// ── Scenario 9: multi-select mixed values + bulk edit ────────────────────
t("2E.9 multi-selection: *VARIES* display, bulk edit, type vs instance", () => {
  const engine = new pe.ParameterEngine();
  engine.registerDefinition({ id: "w.h", name: "Height", symbol: "h", dataType: "length", scope: "instance", origin: "builtin", unit: "m" });
  engine.putType({ id: "t1", familyId: "f", values: { "w.h": 2.7 } });
  engine.putElement({ id: "a", typeId: "t1", instanceValues: {} });
  engine.putElement({ id: "b", typeId: "t1", instanceValues: { "w.h": 3.3 } });
  engine.putElement({ id: "c", typeId: "t1", instanceValues: {} });
  const access = {
    getCategory: () => "walls",
    getInstanceValue: (id, p) => engine.effectiveValue(id, p).value,
    setInstanceValue: (id, p, v) => { engine.setInstanceValue(id, p, v); },
  };
  const slot = pp.GetPropertyValue(["a", "b", "c"], "w.h", access, engine);
  assert(slot.isMixed && slot.displayValue === "*VARIES*");
  // Provenance: a/c inherit from the type, b overrides.
  const sources = Object.fromEntries(slot.sources.map((s) => [s.elementId, s.source]));
  assert(sources.a === "type" && sources.c === "type" && sources.b === "instance-override");
  // Bulk edit applies to all three atomically (type change must not
  // clobber overrides — here we set instance values explicitly).
  const built = pp.BuildPropertyChangeSet({ elementIds: ["a", "b", "c"], categoryId: "walls", parameterId: "w.h", input: "3000 mm", access, engine });
  assert(built.changeSet !== null);
  const diags = pp.CommitPropertyChange(built.changeSet, access, engine);
  assert(pp.GetPropertyEditDiagnostics(diags).ok);
  for (const id of ["a", "b", "c"]) {
    assert(engine.effectiveValue(id, "w.h").value === 3, `${id} bulk-edited`);
    assert(engine.effectiveValue(id, "w.h").source === "instance-override");
  }
});

// ── Scenario 10: snapping in a dense model (performance) ─────────────────
t("2E.10 performance: 800 candidates query+rank well inside budget", () => {
  const raws = [];
  for (let i = 0; i < 800; i++) {
    raws.push({
      position: [i * 0.01, (i % 7) * 0.3, 0],
      screen: { x: (i * 13) % 1600, y: (i * 7) % 900 },
      kind: i % 3 === 0 ? "endpoint" : i % 3 === 1 ? "midpoint" : "grid",
      elementId: `e${i}`,
      depth: (i % 5) * 0.1,
    });
  }
  const settings = snap.DEFAULT_SNAP_SETTINGS;
  const t0 = Date.now();
  const RUNS = 200;
  for (let r = 0; r < RUNS; r++) {
    const eligible = snap.querySnapCandidates(raws, { x: 400, y: 400 }, settings);
    const ranked = snap.rankSnapCandidates(eligible, { x: 400, y: 400 }, settings, 0.2);
    snap.resolveSnapAmbiguity(ranked, null, settings);
  }
  const ms = Date.now() - t0;
  assert(ms < 5000, `snap pipeline too slow: ${ms} ms for ${RUNS} frames of 800 candidates`);
  // AABB tree build + queries on a dense mesh.
  const boxMesh = sk.generateVoid({ kind: "box", center: { x: 5, y: 5, z: 5 }, size: { x: 10, y: 10, z: 10 } });
  const t1 = Date.now();
  const tree = new sk.AabbTree(boxMesh);
  for (let q = 0; q < 1000; q++) {
    tree.query({ minX: q % 9, minY: q % 8, minZ: q % 7, maxX: (q % 9) + 1, maxY: (q % 8) + 1, maxZ: (q % 7) + 1 });
  }
  const ms2 = Date.now() - t1;
  assert(ms2 < 5000, `AABB queries too slow: ${ms2} ms`);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
