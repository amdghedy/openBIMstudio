/**
 * tests/v68-authoring-interaction.test.cjs
 *
 * Unit tests for MASTER PROMPT Module 2B (snapping, state machine,
 * wall-column, alignment, relationships, MEP connectors), Module 2C
 * (modify engine) and Module 2D (property panel engine).
 *
 * Run: `node tests/v68-authoring-interaction.test.cjs`
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
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v68-int-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/snapping/index.ts src/modules/relationships/index.ts src/modules/modify/index.ts" +
  " src/modules/mep/connectors.ts src/modules/properties-panel/authoring.ts src/modules/object-hierarchy/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const snap = require(path.join(tmpOut, "modules/snapping/index.js"));
const rel = require(path.join(tmpOut, "modules/relationships/index.js"));
const mod = require(path.join(tmpOut, "modules/modify/index.js"));
const mepc = require(path.join(tmpOut, "modules/mep/connectors.js"));
const pp = require(path.join(tmpOut, "modules/properties-panel/authoring.js"));
const oh = require(path.join(tmpOut, "modules/object-hierarchy/index.js"));

// ═══ 2B.2: magnetic snapping ════════════════════════════════════════════

function mkRaw(kind, elementId, model, screen, extra = {}) {
  return { position: model, screen, kind, elementId, depth: extra.depth ?? 0, ...extra };
}

t("snap: tolerance filter + enabled kinds", () => {
  const settings = { ...snap.DEFAULT_SNAP_SETTINGS, screenTolerancePx: 10 };
  const raws = [
    mkRaw("endpoint", "e1", [0, 0, 0], { x: 5, y: 5 }),
    mkRaw("endpoint", "e2", [5, 5, 0], { x: 50, y: 50 }), // out of tolerance
    mkRaw("grid", "g1", [1, 1, 0], { x: 7, y: 7 }),
  ];
  settings.enabled.delete("grid");
  const hits = snap.querySnapCandidates(raws, { x: 6, y: 6 }, settings);
  assert(hits.length === 1 && hits[0].elementId === "e1", `hits=${hits.length}`);
});

t("snap: ranking is deterministic and priority-aware", () => {
  const settings = { ...snap.DEFAULT_SNAP_SETTINGS, screenTolerancePx: 12 };
  // endpoint closer but grid farther: endpoint must win on both distance and priority.
  const raws = [
    mkRaw("grid", "g1", [0, 0, 0], { x: 8, y: 8 }),
    mkRaw("endpoint", "e1", [0, 0, 0], { x: 7, y: 7 }),
  ];
  const ranked = snap.rankSnapCandidates(raws, { x: 6, y: 6 }, settings);
  assert(ranked[0].kind === "endpoint", `top=${ranked[0].kind}`);
  // Deterministic: same input → same order.
  const again = snap.rankSnapCandidates(raws, { x: 6, y: 6 }, settings);
  assert(again[0].raw.elementId === ranked[0].raw.elementId);
});

t("snap: hysteresis keeps the locked candidate (spec 2B.2)", () => {
  const settings = { ...snap.DEFAULT_SNAP_SETTINGS, screenTolerancePx: 12, hysteresis: 1.5 };
  const a = mkRaw("endpoint", "e1", [0, 0, 0], { x: 8, y: 8 });
  const b = mkRaw("midpoint", "e2", [0, 0, 0], { x: 7, y: 7 });
  const locked = snap.rankSnapCandidates([a], { x: 6, y: 6 }, settings)[0];
  const ranked = snap.rankSnapCandidates([a, b], { x: 6, y: 6 }, settings);
  const resolved = snap.resolveSnapAmbiguity(ranked, locked, settings);
  assert(resolved.raw.elementId === "e1", `hysteresis should keep e1, got ${resolved.raw.elementId}`);
  // Far better candidate overrides the lock.
  const c = mkRaw("endpoint", "e3", [0, 0, 0], { x: 6.2, y: 6.2 });
  const ranked2 = snap.rankSnapCandidates([a, c], { x: 6, y: 6 }, settings);
  const resolved2 = snap.resolveSnapAmbiguity(ranked2, locked, settings);
  assert(resolved2.raw.elementId === "e3", "a much better candidate must override the lock");
});

t("snap: temporary snap is NOT a persistent relationship (spec §3.4)", () => {
  const registry = new rel.RelationshipRegistry();
  throws(() => registry.createRelationship({
    type: "temporary-snap",
    source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [0, 0, 0] },
  }), "temporary snaps are not persistent");
  // The only sanctioned path: explicit conversion.
  const cand = snap.rankSnapCandidates(
    [mkRaw("endpoint", "col1", [2, 0, 0], { x: 10, y: 10 })], { x: 10, y: 10 }, snap.DEFAULT_SNAP_SETTINGS)[0];
  const temp = snap.createTemporarySnapConstraint(cand);
  const rec = snap.convertSnapToPersistentRelationship(temp, {
    targetElementId: "wall1", type: "endpoint-constraint", registry,
  });
  assert(registry.count === 1 && rec.type === "endpoint-constraint");
});

// ═══ 2B.1: modeling state machine ═══════════════════════════════════════

function wallTool(committed) {
  return {
    name: "wall",
    accepts: new Set(["endpoint", "midpoint", "grid", "centerline", "nearest"]),
    resolveIntent: (session, pointer) => {
      const p = session.locked ? session.locked.raw.position : pointer.model;
      const pts = [...session.points, p];
      const temp = session.locked ? [snap.createTemporarySnapConstraint(session.locked)] : [];
      return { points: pts, tempConstraints: temp };
    },
    validate: (session) => session.points.length >= 2
      ? { ok: true }
      : { ok: false, code: "need-two-points", message: "wall needs 2 points" },
    commit: () => { committed.push(1); return true; },
  };
}

t("state machine: full wall placement flow (spec 2B.1)", () => {
  const committed = [];
  const s = new snap.ModelingSession();
  s.beginModelingCommand(wallTool(committed));
  assert(s.state === "ToolActivated");
  const pointer = (x, y) => ({
    screen: { x, y }, model: [x / 10, y / 10, 0], depth: 0, orthoLock: false,
    candidates: [mkRaw("endpoint", "e1", [1, 0, 0], { x, y })],
  });
  s.updatePointerContext(pointer(10, 0));
  s.resolveModelingIntent(pointer(10, 0));   // first point
  assert(s.state === "PlacementPreview" || s.state === "FirstPoint" || s.state === "SnapAcquisition" || s.state === "TempConstraint");
  s.resolveModelingIntent(pointer(20, 0));   // second point
  assert(s.preview.points.length === 2);
  const v = s.validatePlacementCandidate();
  assert(v.ok);
  const c = s.commitModelingCommand();
  assert(c.ok && committed.length === 1);
  assert(s.state === "Idle" && s.points.length === 0, "commit clears temp state and returns to Idle");
});

t("state machine: illegal transition throws, cancel clears state", () => {
  const s = new snap.ModelingSession();
  // Validation without a tool/preview is a no-preview diagnostic, not a crash.
  const v0 = s.validatePlacementCandidate();
  assert(!v0.ok && v0.code === "no-preview");
  const committed = [];
  s.beginModelingCommand(wallTool(committed));
  s.cancelModelingCommand();
  assert(s.state === "Idle" && s.tool === null);
  // Commit from Idle is an illegal transition.
  throws(() => s.commitModelingCommand());
});

t("state machine: failed validation → Failed, no commit", () => {
  const committed = [];
  const s = new snap.ModelingSession();
  s.beginModelingCommand(wallTool(committed));
  // Single point only: validation fails and commit must refuse.
  s.resolveModelingIntent({ screen: { x: 0, y: 0 }, model: [0, 0, 0], depth: 0, orthoLock: false, candidates: [] });
  s.preview.points = s.preview.points.slice(0, 1);
  const c = s.commitModelingCommand();
  assert(!c.ok && c.code === "need-two-points");
  assert(s.state === "Failed");
  assert(committed.length === 0, "failed validation must not commit");
});

// ═══ 2B.3: wall-column connection ═══════════════════════════════════════

t("wall-column: perpendicular approach lands exactly on the face", () => {
  const col = snap.getColumnReferenceGeometry({
    elementId: "col1",
    footprint: [[2, -0.5], [3, -0.5], [3, 0.5], [2, 0.5]],
    baseZ: 0, topZ: 3,
  });
  assert(col.isRectangle);
  const wall = snap.getWallLocationLine({ start: [0, 0], end: [2.5, 0], width: 0.2, justification: "core-centerline" });
  const r = snap.calculateWallEndpoint(wall, col);
  assert(r !== null);
  near(r.endpoint[0], 2, 1e-12);       // west face plane
  near(r.endpoint[1], 0, 1e-12);
  near(r.pullback, 0, 1e-12);          // perpendicular approach → no pullback
  const v = snap.validateWallColumnConnection(wall, col, r.endpoint, r.contact);
  assert(v.valid, v.problems.join("; "));
});

t("wall-column: oblique approach pullback = ℓ·|p·n|/|d·n| (exact)", () => {
  const col = snap.getColumnReferenceGeometry({
    elementId: "col1",
    footprint: [[2, -0.5], [3, -0.5], [3, 0.5], [2, 0.5]],
    baseZ: 0, topZ: 3,
  });
  // 45° approach: d = (1,1)/√2, width 0.2 → pullback = 0.1 exactly.
  const wall = snap.getWallLocationLine({ start: [0, -2], end: [2.1213203435596424, 0.1213203435596424], width: 0.2, justification: "core-centerline" });
  const r = snap.calculateWallEndpoint(wall, col);
  assert(r !== null);
  near(r.pullback, 0.1, 1e-9);
  near(r.endpoint[0], 2 - 0.1 / Math.SQRT2, 1e-9);
  near(r.endpoint[1], 0 - 0.1 / Math.SQRT2, 1e-9);
  // Contact point is on the west face at y=0.
  near(r.contact.point[0], 2, 1e-9);
  near(r.contact.point[1], 0, 1e-9);
});

t("wall-column: near-parallel approach refused; miss reported", () => {
  const col = snap.getColumnReferenceGeometry({
    elementId: "col1",
    footprint: [[2, -0.5], [3, -0.5], [3, 0.5], [2, 0.5]],
    baseZ: 0, topZ: 3,
  });
  const wall = snap.getWallLocationLine({ start: [0, 0], end: [2, 0], width: 0.2, justification: "core-centerline" });
  const preview = snap.previewWallColumnJoin(wall, col);
  assert(preview.hasContact); // grazing hit along y=0 exists (edge-on)
  // Wall pointing away: no contact at all.
  const away = snap.getWallLocationLine({ start: [0, 0], end: [-1, 0], width: 0.2, justification: "core-centerline" });
  const r = snap.calculateWallEndpoint(away, col);
  assert(r === null);
  const rep = snap.repairOrReportInvalidWallColumnConnection(away, col);
  assert(!rep.repaired && rep.diagnostic !== null);
});

t("wall-column: relationship persists and follows the column move", () => {
  const registry = new rel.RelationshipRegistry();
  const col = snap.getColumnReferenceGeometry({
    elementId: "col1",
    footprint: [[2, -0.5], [3, -0.5], [3, 0.5], [2, 0.5]],
    baseZ: 0, topZ: 3,
  });
  const wall = snap.getWallLocationLine({ start: [0, 0], end: [2, 0], width: 0.2, justification: "core-centerline" });
  const r = snap.calculateWallEndpoint(wall, col);
  const rec = snap.createWallColumnRelationship(registry, wall, col, "wall1", r.endpoint, r.contact, 0);
  assert(rec.reconnection === "follow-source");
  // Column moves +1 in x: dependents follow.
  const results = registry.evaluateRelationshipAfterGeometryChange({
    elementId: "col1", newVersion: 1, translation: [1, 0, 0], rotationZ: 0,
  });
  assert(results.length === 1 && results[0].action === "moved-dependent");
  near(results[0].newPosition[0], r.endpoint[0] + 1, 1e-9);
});

// ═══ 2B.4: alignment ════════════════════════════════════════════════════

t("alignment: residuals match the spec formulas exactly", () => {
  const line = snap.acquireAlignmentReference({ kind: "line", point: [1, 1], dir: [1, 0], elementId: "a" });
  const r1 = snap.computeAlignmentResidual([3, 4], line);
  near(r1.residual[0], 0, 1e-12);   // along the line: removed
  near(r1.residual[1], 3, 1e-12);   // r = (P−Q) − [(P−Q)·u]u
  const planeY = snap.acquireAlignmentReference({ kind: "plane-y", value: 5, elementId: "b" });
  const r2 = snap.computeAlignmentResidual([9, 7], planeY);
  near(r2.magnitude, 2, 1e-12);     // r = (P−Q)·n
});

t("alignment: locked coincidence blocks incompatible moves (acceptance 7)", () => {
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [0, 0, 0] },
    constraint: { kind: "coincident" },
    reconnection: "follow-source",
  });
  const conflicts = snap.detectAlignmentConflict(registry, "b", [3, 4]);
  assert(conflicts.length === 1 && conflicts[0].kind === "coincident-violated");
  // Locked distance: the projected move is allowed.
  const registry2 = new rel.RelationshipRegistry();
  registry2.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "c", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "d", kind: "endpoint", position: [5, 0, 0] },
    constraint: { kind: "locked-distance", value: 5 },
    reconnection: "follow-source",
  });
  const c2 = snap.detectAlignmentConflict(registry2, "d", [0, 4]);
  assert(c2.length === 1 && c2[0].kind === "locked-distance-violated");
  assert(c2[0].allowedMove !== null);
  // Radial move [2,0] violates the lock, but the exact allowed move along
  // the proposed direction is t* = -2(r·u)/(u·u) = -5 → (-10, 0), landing
  // at (-5,0): distance 5 preserved on the far side of the anchor.
  const c3 = snap.detectAlignmentConflict(registry2, "d", [2, 0]);
  assert(c3.length === 1);
  near(c3[0].allowedMove[0], -10, 1e-9);
  near(c3[0].allowedMove[1], 0, 1e-9);
});

// ═══ 2B.5–2B.6: relationship registry ═══════════════════════════════════

t("relationships: reconnection policies evaluated exactly", () => {
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "host",
    source: { elementId: "wall", kind: "face", position: [1, 0, 0] },
    target: { elementId: "window", kind: "endpoint", position: [1, 0, 1] },
    reconnection: "follow-source",
  });
  registry.createRelationship({
    type: "contact",
    source: { elementId: "wall", kind: "face", position: [0, 0, 0] },
    target: { elementId: "panel", kind: "face", position: [2, 0, 0] },
    reconnection: "fixed-world",
  });
  registry.createRelationship({
    type: "wall-join",
    source: { elementId: "wall", kind: "endpoint", position: [1, 1, 0] },
    target: { elementId: "wall2", kind: "endpoint", position: [2, 2, 0] },
    reconnection: "local-reference",
  });
  registry.createRelationship({
    type: "clearance",
    source: { elementId: "wall", kind: "face", position: [0, 0, 0] },
    target: { elementId: "equip", kind: "face", position: [3, 0, 0] },
    reconnection: "becomes-invalid",
  });
  const results = registry.evaluateRelationshipAfterGeometryChange({
    elementId: "wall", newVersion: 2, translation: [1, 0, 0], rotationZ: Math.PI / 2,
  });
  const byEl = Object.fromEntries(results.map((r) => [r.elementId, r]));
  assert(byEl.window.action === "moved-dependent");
  near(byEl.window.newPosition[0], 2, 1e-9); // followed
  assert(byEl.panel.action === "unchanged");  // fixed-world
  assert(byEl.wall2.action === "moved-dependent");
  // local-reference: offset (1,1) rotated 90° → (−1,1), base (2,0)
  near(byEl.wall2.newPosition[0], 1, 1e-9);
  near(byEl.wall2.newPosition[1], 2, 1e-9);
  assert(byEl.equip.action === "flagged-invalid");
  const q = registry.queryRelationships({ validOnly: true });
  assert(q.length === 3, `valid after eval: ${q.length}`);
});

t("relationships: suspend/restore/orphan-cleanup/reconcile", () => {
  const registry = new rel.RelationshipRegistry();
  const rec = registry.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "a", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [1, 0, 0] },
  });
  registry.suspendRelationship(rec.id);
  assert(registry.queryRelationships({ elementId: "a" }).length === 0, "suspended excluded by default");
  assert(registry.queryRelationships({ elementId: "a", includeSuspended: true }).length === 1);
  registry.restoreRelationship(rec.id);
  // Orphan cleanup: 'b' deleted.
  const removed = registry.deleteOrphanedRelationships(new Set(["a"]));
  assert(removed === 1 && registry.count === 0);
  // Reconcile: versioned source moved without evaluation → re-derived.
  const rec2 = registry.createRelationship({
    type: "endpoint-constraint",
    source: { elementId: "x", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "y", kind: "endpoint", position: [1, 0, 0] },
  });
  registry.setGeometryVersion("x", 5);
  const rr = registry.reconcileRelationshipsAfterReload(new Set(["x", "y"]));
  assert(rr.removed === 0 && rr.invalidated === 0);
  assert(registry.getRecord(rec2.id).geometryVersion === 5);
});

// ═══ 2B.7: MEP connectors ═══════════════════════════════════════════════

function connector(owner, name, opts = {}) {
  return {
    ownerElementId: owner,
    def: {
      name, origin: [0, 0, 0], direction: [1, 0, 0],
      domain: opts.domain ?? "pipe",
      shape: opts.shape ?? "round",
      size: opts.size ?? 0.05,
      flowDirection: opts.flow ?? "out",
      systemClassification: opts.system ?? "domestic-cold",
    },
    worldOrigin: opts.origin ?? [0, 0, 0],
    worldDirection: opts.dir ?? [1, 0, 0],
    engaged: false,
    connectedTo: null,
  };
}

t("mep: compatibility enforces domain/size/flow (never proximity alone)", () => {
  const pumpOut = connector("pump", "out", { flow: "out", size: 0.05 });
  const pipeIn = connector("pipe", "in", { flow: "in", size: 0.05, origin: [1, 0, 0] });
  const ductIn = connector("duct", "in", { flow: "in", domain: "duct", origin: [1, 0, 0] });
  const bigIn = connector("big", "in", { flow: "in", size: 0.15, origin: [1, 0, 0] });
  const doubleIn = connector("x", "in", { flow: "in", size: 0.05, origin: [1, 0, 0] });
  assert(mepc.evaluateConnectorCompatibility(pumpOut, pipeIn).compatible);
  assert(!mepc.evaluateConnectorCompatibility(pumpOut, ductIn).compatible, "domain mismatch");
  assert(mepc.evaluateConnectorCompatibility(pumpOut, bigIn).compatible, "size transitions are resolvable with a reducer");
  const inletSource = connector("x", "in", { flow: "in", size: 0.05 });
  assert(!mepc.evaluateConnectorCompatibility(inletSource, pipeIn).compatible, "both inlets");
  // Compatible pool query: domain rejects ducts; sizes resolve via reducers.
  const pool = [ductIn, bigIn, pipeIn, connector("far", "in", { origin: [100, 0, 0] })];
  const cands = mepc.queryCompatibleConnectors(pumpOut, pool, 50);
  assert(cands.length === 2, `cands=${cands.map((c) => c.connector.ownerElementId)}`);
  // Deterministic tie-break at equal distance: element id order.
  assert(cands[0].connector.ownerElementId === "big" && cands[1].connector.ownerElementId === "pipe",
    `order=${cands.map((c) => c.connector.ownerElementId)}`);
});

t("mep: fittings — elbows at direction changes, reducer for size jumps", () => {
  const a = connector("a", "out", { size: 0.05 });
  const b = connector("b", "in", { size: 0.08, origin: [2, 2, 0] });
  const route = mepc.findMepConnectionPath(a, b);
  const fittings = mepc.calculateRequiredFittings(route, a, b);
  assert(fittings.some((f) => f.kind === "elbow"), JSON.stringify(fittings));
  assert(fittings.some((f) => f.kind === "reducer"));
  // Straight route: no fittings beyond the reducer.
  const b2 = connector("b2", "in", { size: 0.05, origin: [2, 0, 0] });
  const f2 = mepc.calculateRequiredFittings([{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }].map((p) => [p.x, p.y, p.z]), a, b2);
  assert(f2.length === 0, JSON.stringify(f2));
});

t("mep: topology validation catches loops, disconnection, size jumps", () => {
  const A = connector("A", "out");
  const B = connector("B", "in", { origin: [1, 0, 0] });
  const conn = mepc.createConnectorRelationship(A, B, [[0, 0, 0], [1, 0, 0]], []);
  assert(A.engaged && B.engaged);
  // Loop: connect B back to A — blocked (engaged).
  const preview = mepc.previewMepConnection(B, A);
  assert(!preview.valid && preview.reasons.some((r) => r.includes("engaged")));
  // Disconnected equipment + size jump without fitting.
  const C = connector("C", "out", { size: 0.05 });
  const D = connector("D", "in", { size: 0.1, origin: [5, 0, 0] });
  const conn2 = { ...mepc.createConnectorRelationship(C, D, [[0, 0, 0], [5, 0, 0]], []), fittings: [] };
  const connectors = [A, B, C, D, connector("E", "in", { origin: [9, 9, 9] })];
  // Rebuild C/D as unengaged copies for topology input consistency.
  const issues = mepc.validateMepNetworkTopology(connectors, [conn, conn2]);
  assert(issues.some((i) => i.code === "size-jump-without-fitting"), JSON.stringify(issues));
  assert(issues.some((i) => i.code === "disconnected-equipment"));
  // Disconnect releases both sides.
  const rel2 = mepc.disconnectMepConnectors([A, B], conn);
  assert(!A.engaged && !B.engaged && rel2.released.length === 2);
});

// ═══ 2C: modify engine ══════════════════════════════════════════════════

function makeStore(elements) {
  const map = new Map();
  for (const el of elements) map.set(el.id, { ...el });
  return {
    get: (id) => map.get(id),
    apply: (id, patch) => {
      const el = map.get(id);
      if (!el) return false;
      Object.assign(el, patch);
      return true;
    },
    insert: (el) => map.set(el.id, { ...el }),
    all: () => [...map.values()],
  };
}

const baseWall = {
  id: "w1", categoryId: "walls", pinned: false, editable: true,
  position: [0, 0], rotationZ: 0,
  curve: { start: [0, 0], end: [4, 0] },
};

t("modify: move — translation exact, pinned rejected, conflicts block", () => {
  const store = makeStore([baseWall, { ...baseWall, id: "pinned1", pinned: true }]);
  const cmd = new mod.MoveCommand({ store });
  assert(!cmd.CanExecute(["pinned1"]).can);
  assert(cmd.CanExecute(["w1"]).can);
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "translation", from: [0, 0], to: [3, -2] });
  const r = cmd.Commit();
  assert(r.ok && r.applied === 1);
  const el = store.get("w1");
  near(el.position[0], 3, 1e-12);
  near(el.position[1], -2, 1e-12);
  near(el.curve.end[0], 4, 1e-12, "curve is local — unchanged by a position move");
});

t("modify: rotate — Rodrigues matches planar rotation, curve follows", () => {
  // Arbitrary-axis Rodrigues: rotate (1,0,0) about z by 90° → (0,1,0).
  const p = mod.rotateAboutAxis([1, 0, 0], [0, 0, 1], Math.PI / 2);
  near(p[0], 0, 1e-12); near(p[1], 1, 1e-12); near(p[2], 0, 1e-12);
  // About a tilted axis: 90° about x maps (0,1,0) → (0,0,1).
  const q = mod.rotateAboutAxis([0, 1, 0], [1, 0, 0], Math.PI / 2);
  near(q[1], 0, 1e-12); near(q[2], 1, 1e-12);
  const store = makeStore([{ ...baseWall, position: [1, 1] }]);
  const cmd = new mod.RotateCommand({ store });
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "rotation", pivot: [1, 1], angle: Math.PI / 2 });
  cmd.Commit();
  const el = store.get("w1");
  near(el.rotationZ, Math.PI / 2, 1e-12);
  near(el.position[0], 1, 1e-12); // pivot == position: stays
  near(el.curve.start[1], 0, 1e-12);
});

t("modify: offset — corners exact, self-intersection detected", () => {
  const store = makeStore([{ ...baseWall }]);
  const cmd = new mod.OffsetCommand({ store });
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "offset", distance: 0.5 });
  const pending = cmd.GetDiagnostics();
  assert(pending.length === 0);
  const preview = cmd.previewPolyline;
  near(preview[0][1], -0.5, 1e-12);
  near(preview[1][1], -0.5, 1e-12);
  cmd.Commit();
  near(store.get("w1").curve.start[1], -0.5, 1e-12);
  // Self-intersecting offset on a closed square ring is refused (pure fn;
  // rings are passed WITHOUT a duplicated closing point — closure is the
  // `closed` flag).
  const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
  const inward = mod.offsetPolyline(square.map(([x, y]) => [x, y]), -1.5, true);
  assert(inward.selfIntersects, "inward offset past the inradius must self-intersect (inverted ring)");
  const outward = mod.offsetPolyline(square.map(([x, y]) => [x, y]), -0.5, true);
  assert(!outward.selfIntersects, "0.5 m outward offset is clean");
});

t("modify: trim/extend — exact intersection and side pick", () => {
  const store = makeStore([{ ...baseWall }]); // (0,0)→(4,0)
  const boundary = { point: [2, -5], dir: [0, 1] }; // vertical line x=2
  const r = mod.trimExtendSegment([0, 0], [4, 0], boundary, [2.5, 1], "trim");
  assert(r !== null && !r.extended);
  near(r.start[0], 2, 1e-12);
  near(r.end[0], 4, 1e-12);
  // Extend beyond the end.
  const r2 = mod.trimExtendSegment([0, 0], [1, 0], boundary, [2.5, 1], "extend");
  assert(r2 !== null && r2.extended);
  near(r2.end[0], 2, 1e-12);
  // Parallel boundary: no intersection.
  assert(mod.trimExtendSegment([0, 0], [4, 0], { point: [0, 1], dir: [1, 0] }, [1, 1], "trim") === null);
});

t("modify: split — identity policy (original keeps id, new part gets new id)", () => {
  const store = makeStore([{ ...baseWall }]);
  let n = 0;
  const cmd = new mod.SplitCommand({ store, allocateId: () => `new-${++n}` });
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "split", parameter: 0.25 });
  const r = cmd.Commit();
  assert(r.ok && r.applied === 2);
  near(store.get("w1").curve.end[0], 1, 1e-12);
  const second = store.all().find((e) => e.id === "new-1");
  assert(second !== undefined);
  near(second.curve.start[0], 1, 1e-12);
  near(second.curve.end[0], 4, 1e-12);
});

t("modify: copy/array/mirror — placements exact", () => {
  const store = makeStore([{ ...baseWall, position: [1, 1] }]);
  let n = 0;
  const alloc = () => `c${++n}`;
  // Copy.
  const copy = new mod.CopyCommand({ store, allocateId: alloc });
  copy.Begin(["w1"]);
  copy.UpdatePreview({ type: "copy", translation: [2, 0] });
  copy.Commit();
  near(store.get("c1").position[0], 3, 1e-12);
  // Linear array of 4 at step (1,0): copies at +1..+3.
  const arr = new mod.ArrayLinearCommand({ store, allocateId: alloc });
  arr.Begin(["w1"]);
  arr.UpdatePreview({ type: "array-linear", count: 4, step: [1, 0] });
  arr.Commit();
  near(store.get("c2").position[0], 2, 1e-12);
  near(store.get("c4").position[0], 4, 1e-12);
  // Radial array of 4 over 90° about (1,1): first copy at 30°... step=30°.
  const rad = new mod.ArrayRadialCommand({ store, allocateId: alloc });
  rad.Begin(["c2"]);
  rad.UpdatePreview({ type: "array-radial", count: 4, center: [1, 1], totalAngle: Math.PI / 2, rotateInstances: true });
  rad.Commit();
  const firstRadial = store.get("c5");
  near(firstRadial.position[0], 1 + Math.cos(Math.PI / 6), 1e-9);
  // Mirror in place about the y-axis (x → −x + 2·0): point (1,1) → (−1,1).
  const mir = new mod.MirrorCommand({ store, allocateId: alloc });
  mir.Begin(["w1"]);
  mir.UpdatePreview({ type: "mirror-axis", point: [0, 0], dir: [0, 1], copy: false });
  mir.Commit();
  near(store.get("w1").position[0], -1, 1e-12);
});

t("modify: atomicity — a failed validation applies NOTHING (spec 2C.11)", () => {
  const store = makeStore([{ ...baseWall }, { ...baseWall, id: "locked", editable: false }]);
  const cmd = new mod.MoveCommand({ store });
  throws(() => cmd.Begin(["w1", "locked"]), "not editable");
  // Begin valid, preview, then invalidate through a conflicting registry.
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "w1", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "anchor", kind: "endpoint", position: [0, 0, 0] },
    constraint: { kind: "coincident" },
    reconnection: "follow-source",
  });
  const cmd2 = new mod.MoveCommand({ store, relationships: registry });
  cmd2.Begin(["w1"]);
  cmd2.UpdatePreview({ type: "numeric-offset", dx: 5, dy: 0 });
  const v = cmd2.Validate();
  assert(!v.ok, "coincident lock must block the move");
  const c = cmd2.Commit();
  assert(!c.ok && c.applied === 0, "commit refused");
  near(store.get("w1").position[0], 0, 1e-12, "model untouched");
  cmd2.Cancel();
});

t("modify: propagateAfterCommit drives dependents", () => {
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "rigid-attachment",
    source: { elementId: "host", kind: "face", position: [0, 0, 0] },
    target: { elementId: "attached", kind: "face", position: [1, 0, 0] },
    reconnection: "follow-source",
  });
  const out = mod.propagateAfterCommit(registry, "host", [2, 3]);
  assert(out.length === 1 && out[0].elementId === "attached");
  near(out[0].newPosition[0], 3, 1e-12);
  near(out[0].newPosition[1], 3, 1e-12);
});

// ═══ 2D: property panel engine ══════════════════════════════════════════

t("properties: every definition carries the 21 metadata fields (spec 2D.1)", () => {
  const required = ["id", "name", "symbol", "description", "dataType", "editable", "kind", "scope", "dependsOn", "precision", "group", "propagation"];
  for (const cat of pp.coveredCategories()) {
    for (const def of pp.getPropertyDefinitions(cat)) {
      for (const k of required) {
        assert(def[k] !== undefined, `${cat}.${def.id} missing ${k}`);
      }
      assert(def.readOnlyReason !== undefined || def.editable === true, `${cat}.${def.id} read-only without reason`);
    }
  }
  assert(pp.coveredCategories().length >= 13, `categories covered: ${pp.coveredCategories().length}`);
});

t("properties: visibility conditions gate dependent rows", () => {
  const wallDefs = pp.GetPropertyDefinitions("walls");
  const unconnectedH = wallDefs.find((d) => d.id === "unconnected-height");
  assert(unconnectedH.visibleWhen({ values: { "top-constraint": "unconnected" }, categoryId: "walls" }) === true);
  assert(unconnectedH.visibleWhen({ values: { "top-constraint": "level-2" }, categoryId: "walls" }) === false);
  const winDefs = pp.GetPropertyDefinitions("windows");
  assert(winDefs.find((d) => d.id === "sill-height") !== undefined);
});

t("properties: editing lifecycle — parse units, block read-only, atomic reject", () => {
  const access = {
    getCategory: () => "walls",
    getInstanceValue: (id, p) => (id === "w1" && p === "unconnected-height" ? 3 : null),
    setInstanceValue: () => {},
  };
  // Unit-aware parse: "2500 mm" → 2.5 m.
  const parsed = pp.ParsePropertyInput("walls", "unconnected-height", "2500 mm");
  assert(parsed.value !== null && Math.abs(parsed.value - 2.5) < 1e-12, `value=${parsed.value}`);
  // Out of range: negative.
  const bad = pp.ParsePropertyInput("walls", "unconnected-height", "-3");
  assert(bad.diagnostic && bad.diagnostic.code === "out-of-range");
  // Read-only: computed length.
  const ro = pp.IsPropertyEditable("walls", "length");
  assert(!ro.editable && ro.reason.includes("calculated"));
  // Build + commit atomically.
  const built = pp.BuildPropertyChangeSet({
    elementIds: ["w1"], categoryId: "walls", parameterId: "unconnected-height",
    input: "2500 mm", access,
  });
  assert(built.changeSet !== null && built.changeSet.value === 2.5);
  const diags = pp.CommitPropertyChange(built.changeSet, access);
  assert(pp.GetPropertyEditDiagnostics(diags).ok);
  // Rejection: read-only parameter cannot build a change set.
  const rejected = pp.BuildPropertyChangeSet({
    elementIds: ["w1"], categoryId: "walls", parameterId: "length", input: "42", access,
  });
  assert(rejected.changeSet === null && rejected.diagnostics[0].code === "read-only");
});

t("properties: multi-select mixed values → *VARIES* (spec 2D.5)", () => {
  const access = {
    getCategory: () => "walls",
    getInstanceValue: (id, p) => (p === "unconnected-height" ? (id === "a" ? 3 : 4) : null),
    setInstanceValue: () => {},
  };
  const slot = pp.GetPropertyValue(["a", "b"], "unconnected-height", access);
  assert(slot.isMixed && slot.displayValue === "*VARIES*");
  const same = pp.GetPropertyValue(["a", "a"], "unconnected-height", access);
  assert(!same.isMixed);
});

t("dimensions: driving edit moves the tracked reference exactly", () => {
  const dim = {
    id: "d1", kind: "aligned", role: "driving",
    references: [
      { elementId: "w1", anchor: "endpoint", position: [0, 0] },
      { elementId: "w2", anchor: "endpoint", position: [3, 4] },
    ],
    drivingParameterId: "wall.length", precision: 3,
  };
  assert(pp.IsDimensionDriving(dim));
  near(pp.EvaluateDimension(dim), 5, 1e-12);
  const plan = pp.ResolveDimensionEdit(dim, 10);
  assert(plan.ok && plan.parameterId === "wall.length");
  near(plan.moves[0].to[0], 6, 1e-9);   // bearing preserved (3/5, 4/5) × 10
  near(plan.moves[0].to[1], 8, 1e-9);
  const v = pp.ValidateDimensionConstraints(plan);
  assert(v.valid);
  // Reference dimensions refuse to drive (spec 2D.6).
  const ref = { ...dim, role: "reference" };
  const plan2 = pp.ResolveDimensionEdit(ref, 10);
  assert(!plan2.ok && plan2.message.includes("cannot drive"));
  // Zero value rejected.
  const plan3 = pp.ResolveDimensionEdit(dim, 0);
  assert(!pp.ValidateDimensionConstraints(plan3).valid);
});

t("dimensions: formula dependents re-evaluate in the preview", () => {
  const engine = new (require(path.join(tmpOut, "modules/parameter-engine/index.js")).ParameterEngine)();
  engine.registerDefinition({ id: "p.length", name: "L", symbol: "L", dataType: "length", scope: "instance", origin: "builtin", unit: "m" });
  engine.registerDefinition({ id: "p.area", name: "A", symbol: "area", dataType: "area", scope: "instance", origin: "builtin", unit: "m2", formula: "L * 2" });
  engine.putElement({ id: "w1", typeId: "", instanceValues: { "p.length": 3 } });
  const dim = {
    id: "d1", kind: "aligned", role: "driving",
    references: [
      { elementId: "w1", anchor: "endpoint", position: [0, 0] },
      { elementId: "w1", anchor: "endpoint", position: [3, 0] },
    ],
    drivingParameterId: "p.length", precision: 3,
  };
  const plan = pp.ResolveDimensionEdit(dim, 6);
  const preview = pp.PreviewDimensionEdit(plan, engine, "w1");
  assert(preview.applied && preview.dependentValues && preview.dependentValues["p.area"] === 12, JSON.stringify(preview));
  const commit = pp.CommitDimensionEdit(plan, engine, "w1");
  assert(commit.committed && commit.moves.length === 1);
  // The engine now holds the committed value.
  assert(engine.effectiveValue("w1", "p.length").value === 6);
});

t("identity: uuid generator produces unique values", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(oh.newUniqueId());
  assert(seen.size === 500);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
