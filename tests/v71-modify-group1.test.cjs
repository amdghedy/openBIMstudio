/**
 * tests/v71-modify-group1.test.cjs
 *
 * Group 1 Modify acceptance tests (MODIFY GROUP 1 spec §8,
 * docs/MODIFY_GROUP1_SPEC_V71.md) — Selection (§2), References (§3),
 * Move (§4), Rotate (§5), Mirror (§6).
 *
 * All transforms are verified against closed forms:
 *   Move   P' = P + Δ ; axis-constrained Δ' = (Δ·â)â
 *   Rotate p' = Q + R(θ)(p − Q) ; θ' = θ_element + θ
 *   Mirror X' = Q + (2ddᵀ − I)(X − Q) ; θ' = 2φ − θ
 * plus transaction-guaranteed undo/redo restore and preview-no-mutation.
 *
 * Run: `node tests/v71-modify-group1.test.cjs`
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
function near(a, b, tol = 1e-6) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v71-group1-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/modify/index.ts src/modules/selection/index.ts" +
  " src/modules/references/index.ts src/modules/transaction/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const mod = require(path.join(tmpOut, "modules/modify/index.js"));
const sel = require(path.join(tmpOut, "modules/selection/index.js"));
const ref = require(path.join(tmpOut, "modules/references/index.js"));
const { TransactionService } = require(path.join(tmpOut, "modules/transaction/index.js"));
const { RelationshipRegistry } = require(path.join(tmpOut, "modules/relationships/index.js"));

// ── Helpers ─────────────────────────────────────────────────────────────

function makeStore(elems = []) {
  const map = new Map(elems.map((e) => [e.id, { ...e }]));
  return {
    get: (id) => map.get(id),
    apply: (id, patch) => {
      const el = map.get(id);
      if (!el) return false;
      if (patch.position) el.position = [...patch.position];
      if (patch.rotationZ !== undefined) el.rotationZ = patch.rotationZ;
      if (patch.curve !== undefined && patch.curve) el.curve = { start: [...patch.curve.start], end: [...patch.curve.end] };
      if (patch.params) el.params = { ...el.params, ...patch.params };
      return true;
    },
    insert: (el) => { map.set(el.id, JSON.parse(JSON.stringify(el))); },
    all: () => [...map.values()],
    remove: (id) => map.delete(id),
    map,
  };
}

function wallEl(id, x0, y0, x1, y1, extra = {}) {
  return {
    id, categoryId: "walls", pinned: false, editable: true,
    position: [(x0 + x1) / 2, (y0 + y1) / 2], rotationZ: 0,
    curve: { start: [x0, y0], end: [x1, y1] },
    params: { width: 0.2 },
    aabb: { min: [Math.min(x0, x1), Math.min(y0, y1)], max: [Math.max(x0, x1), Math.max(y0, y1)] },
    ...extra,
  };
}

console.log("== tests/v71-modify-group1.test.cjs");

// ═══ 1. Selection engine (spec §2) ══════════════════════════════════════

console.log("── Selection ──");

t("selection: vertex beats edge beats body at the same pick point (priority, E-M1-01)", () => {
  const store = makeStore([{
    ...wallEl("w1", 0, 0, 4, 0),
    // real body thickness so aabb containment is meaningful
    aabb: { min: [0, -0.1], max: [4, 0.1] },
  }]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  // pick exactly on the start endpoint: vertex (100) must outrank edge (90) and body (40)
  const hit = engine.HitTest([0, 0]);
  assert(hit && hit.subKind === "vertex", `expected vertex hit, got ${hit && hit.subKind}`);
  // mid-span pick: edge outranks body
  const hit2 = engine.HitTest([2, 0]);
  assert(hit2 && hit2.subKind === "edge", `expected edge hit, got ${hit2 && hit2.subKind}`);
  // inside the body but OUTSIDE the edge pick radius: body
  const hit3 = engine.HitTest([2, 0.04], 0.01);
  assert(hit3 && hit3.subKind === "body", `expected body hit, got ${hit3 && hit3.subKind}`);
});

t("selection: nearest edge wins when two elements share the pick point", () => {
  const store = makeStore([wallEl("near", 0, 0, 4, 0), wallEl("far", 0, 0.03, 4, 0.03)]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const hit = engine.HitTest([2, 0.01]);
  assert(hit && hit.elementId === "near", `expected 'near', got ${hit && hit.elementId}`);
});

t("selection: hidden elements are invisible by default; force-select warns MOD-SEL-005", () => {
  const store = makeStore([wallEl("h1", 0, 0, 4, 0, { hidden: true }), wallEl("v1", 0, 1, 4, 1)]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const hit = engine.HitTest([2, 0]);
  assert(!hit, "hidden element must not be hit");
  engine.SetFilter({ includeHidden: true });
  const hit2 = engine.SelectSingle([2, 0]);
  assert(hit2 && hit2.elementId === "h1", "force hit failed");
  const codes = engine.GetDiagnostics().map((d) => d.code);
  assert(codes.includes("MOD-SEL-005"), `expected MOD-SEL-005, got ${codes.join(",")}`);
});

t("selection: window inside vs crossing semantics (spec §2.3)", () => {
  const store = makeStore([
    wallEl("inside", 1, 1, 2, 1),
    wallEl("crossing", 2.5, 1, 4, 1),
    wallEl("outside", 6, 6, 7, 6),
  ]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const win = engine.SelectWindow([0, 0], [3, 2], "inside");
  assert(win.length === 1 && win[0] === "inside", `inside-window: ${win}`);
  const cross = engine.SelectWindow([0, 0], [3, 2], "crossing");
  assert(cross.length === 2 && cross.includes("crossing") && cross.includes("inside"), `crossing-window: ${cross}`);
});

t("selection: category filter, parameter predicate, by-id with unknown ids (MOD-SEL-004)", () => {
  const store = makeStore([
    wallEl("w1", 0, 0, 1, 0),
    { ...wallEl("c1", 0, 1, 1, 1), categoryId: "columns", params: { height: 3 } },
    { ...wallEl("c2", 0, 2, 1, 2), categoryId: "columns", params: { height: 5 } },
  ]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const byCat = engine.SelectByCategory(["columns"]);
  assert(byCat.length === 2, `category: ${byCat}`);
  const byParam = engine.SelectByParameter((p) => p.height === 5);
  assert(byParam.length === 1 && byParam[0] === "c2", `param: ${byParam}`);
  const byIds = engine.SelectByIds(["w1", "ghost"]);
  assert(byIds.length === 1 && byIds[0] === "w1", `ids: ${byIds}`);
  assert(engine.GetDiagnostics().some((d) => d.code === "MOD-SEL-004"), "expected MOD-SEL-004");
});

t("selection: invert respects visibility filter", () => {
  const store = makeStore([wallEl("a", 0, 0, 1, 0), wallEl("b", 0, 1, 1, 1), wallEl("h", 0, 2, 1, 2, { hidden: true })]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  engine.SelectByIds(["a"]);
  const inv = engine.Invert();
  assert(inv.length === 1 && inv[0] === "b", `invert: ${inv}`);
});

t("selection: group expansion selects the whole group (spec §2.4)", () => {
  const store = makeStore([
    wallEl("g1a", 0, 0, 1, 0, { groupId: "G" }),
    wallEl("g1b", 0, 1, 1, 1, { groupId: "G" }),
    wallEl("solo", 0, 2, 1, 2),
  ]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const picked = engine.SelectByIds(["g1a"]);
  assert(picked.length === 2 && picked.includes("g1b"), `group: ${picked}`);
  engine.SetFilter({ selectWholeGroups: false });
  const picked2 = engine.SelectByIds(["g1a"]);
  assert(picked2.length === 1, `no-group: ${picked2}`);
});

t("selection: ExpandHosted finds hostedOnId links and registry host records", () => {
  const store = makeStore([
    wallEl("host", 0, 0, 4, 0),
    { ...wallEl("door", 1, 0, 1.2, 0), categoryId: "doors", hostedOnId: "host" },
  ]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "host",
    source: { elementId: "host", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "win", kind: "endpoint", position: [3, 0, 0] },
  });
  store.insert({ ...wallEl("win", 3, 0, 3.2, 0), categoryId: "windows" });
  const engine = new sel.SelectionEngine({ elements: () => store.all(), relationships: reg });
  engine.SelectByIds(["host"]);
  const expanded = engine.ExpandHosted("host");
  assert(expanded.includes("door") && expanded.includes("win"), `expand: ${expanded}`);
  assert(engine.GetSelection().includes("door") && engine.GetSelection().includes("win"), "expansion must extend the selection");
});

t("selection: pinned and linked-model elements selectable with warnings; edits stay blocked upstream", () => {
  const store = makeStore([
    wallEl("p1", 0, 0, 1, 0, { pinned: true }),
    { ...wallEl("lm", 0, 1, 1, 1), linkedModel: true, editable: false },
  ]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  engine.SelectByIds(["p1"]);
  assert(engine.GetDiagnostics().some((d) => d.code === "MOD-SEL-002"), "expected pinned warning");
  // linked models are excluded by default...
  engine.SelectByIds(["lm"]);
  assert(engine.GetSelection().length === 0, "linked model must not be selectable by default");
  // ...and selectable with a read-only warning when the filter allows them
  engine.SetFilter({ includeLinkedModels: true });
  engine.SelectByIds(["lm"]);
  assert(engine.GetSelection().includes("lm"), "filter override must allow selection");
  assert(engine.GetDiagnostics().some((d) => d.code === "MOD-SEL-003"), "expected read-only warning");
});

t("selection: degenerate pick radius raises MOD-SEL-006 and returns null", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const hit = engine.HitTest([0.5, 0], 0);
  assert(hit === null, "degenerate radius must yield null");
  assert(engine.GetDiagnostics().some((d) => d.code === "MOD-SEL-006"), "expected MOD-SEL-006");
});

// ═══ 2. Reference acquisition (spec §3) ═════════════════════════════════

console.log("── References ──");

function orthonormality(fr) {
  const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  for (const axis of [fr.xAxis, fr.yAxis, fr.zAxis]) near(len(axis), 1, 1e-12);
  near(d(fr.xAxis, fr.yAxis), 0, 1e-12);
  near(d(fr.xAxis, fr.zAxis), 0, 1e-12);
  near(d(fr.yAxis, fr.zAxis), 0, 1e-12);
}

t("references: level frame sits at elevation with world axes; grid frame x along direction", () => {
  const svc = new ref.ReferenceService();
  const lvl = svc.Acquire({ kind: "level", elevation: 3.5, name: "L2" });
  near(lvl.frame.origin[2], 3.5, 1e-12);
  orthonormality(lvl.frame);
  const grid = svc.Acquire({ kind: "grid", position: [2, 1, 0], direction: [0, 1, 0], name: "A" });
  near(grid.frame.xAxis[1], 1, 1e-12);
  near(grid.frame.origin[0], 2, 1e-12);
  orthonormality(grid.frame);
  assert(lvl.persistent === false && grid.persistent === false, "acquired references are non-persistent (spec §3.2)");
});

t("references: face frame z = normal, origin at pick point; edge frame x = tangent", () => {
  const svc = new ref.ReferenceService();
  const face = svc.Acquire({ kind: "face", ownerElementId: "w1", position: [1, 0, 2], normal: [0, 1, 0] });
  near(face.frame.zAxis[1], 1, 1e-12);
  near(face.frame.origin[0], 1, 1e-12);
  orthonormality(face.frame);
  const edge = svc.Acquire({ kind: "edge", ownerElementId: "w1", position: [2, 0, 0], direction: [3, 0, 0] });
  near(edge.frame.xAxis[0], 1, 1e-12);
  orthonormality(edge.frame);
});

t("references: zero-length direction rejected (MOD-REF-002); unknown kind rejected (MOD-REF-003)", () => {
  const svc = new ref.ReferenceService();
  throws(() => svc.Acquire({ kind: "edge", position: [0, 0, 0], direction: [0, 0, 0] }), "MOD-REF-002");
  throws(() => svc.Acquire({ kind: "wormhole", position: [0, 0, 0] }), "unknown reference kind");
  assert(svc.GetDiagnostics().some((d) => d.code === "MOD-REF-002"), "expected MOD-REF-002");
});

t("references: owner geometry change makes refs stale; deletion makes them broken; validation refuses both", () => {
  const svc = new ref.ReferenceService();
  const face = svc.Acquire({ kind: "face", ownerElementId: "w1", position: [1, 0, 2], normal: [0, 1, 0], geometryVersion: 3 });
  assert(svc.ValidateForCommand(face, "move").ok, "fresh ref must validate");
  const n = svc.MarkGeometryChanged("w1", 4);
  assert(n === 1, `expected 1 stale ref, got ${n}`);
  assert(svc.Status(face.id) === "stale", "expected stale");
  assert(!svc.ValidateForCommand(face.id, "move").ok, "stale ref must be refused");
  assert(svc.GetDiagnostics().some((d) => d.code === "MOD-REF-004"), "expected MOD-REF-004");
  svc.MarkOwnerDeleted("w1");
  assert(svc.Status(face.id) === "broken", "expected broken");
  assert(!svc.ValidateForCommand(face.id, "move").ok, "broken ref must be refused");
  assert(svc.GetDiagnostics().some((d) => d.code === "MOD-REF-005"), "expected MOD-REF-005");
});

t("references: command eligibility — mirror refuses vertex/level refs (MOD-REF-006)", () => {
  const svc = new ref.ReferenceService();
  const v = svc.Acquire({ kind: "vertex", position: [0, 0, 0] });
  const lvl = svc.Acquire({ kind: "level", elevation: 0 });
  const edge = svc.Acquire({ kind: "edge", position: [0, 0, 0], direction: [1, 0, 0] });
  assert(!svc.ValidateForCommand(v, "mirror").ok, "vertex must be ineligible for mirror");
  assert(!svc.ValidateForCommand(lvl, "mirror").ok, "level must be ineligible for mirror");
  assert(svc.ValidateForCommand(edge, "mirror").ok, "edge must be eligible for mirror");
  assert(svc.GetDiagnostics().some((d) => d.code === "MOD-REF-006"), "expected MOD-REF-006");
});

// ═══ 3. Move (spec §4) ══════════════════════════════════════════════════

console.log("── Move ──");

t("move: exact translation P'=P+Δ, world curve shifts by Δ (E-M1-05)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const tool = new mod.MoveTool({ store });
  tool.BeginMove(["w"]);
  tool.AcquireMoveBasePoint([1, 1]);
  tool.ResolveMoveTarget([2.5, 4]);
  const v = tool.CalculateMoveVector();
  near(v[0], 1.5, 1e-12); near(v[1], 3, 1e-12);
  tool.GenerateMovePreview();
  assert(store.get("w").position[0] === 2, "preview must NOT mutate the store");
  const r = tool.CommitMove();
  assert(r.ok && r.applied === 1, `commit failed: ${JSON.stringify(r.diagnostics)}`);
  // position moves BY Δ (spec P' = P + Δ): (2,0) + (1.5,3) = (3.5,3)
  near(store.get("w").position[0], 3.5, 1e-12);
  near(store.get("w").position[1], 3, 1e-12);
  near(store.get("w").curve.start[0], 1.5, 1e-12);
  near(store.get("w").curve.end[1], 3, 1e-12);
});

t("move: axis-constrained target projects Δ (Δ=[3,1], axis x → [3,0])", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.MoveTool({ store });
  tool.BeginMove(["w"]);
  tool.AcquireMoveBasePoint([0, 0]);
  const resolved = tool.ResolveMoveTarget([3, 1], { axis: "x" });
  near(resolved[0], 3, 1e-12); near(resolved[1], 0, 1e-12);
  tool.GenerateMovePreview();
  tool.CommitMove();
  near(store.get("w").position[0], 3.5, 1e-12);
  near(store.get("w").position[1], 0, 1e-12);
});

t("move: numeric displacement input bypasses base/target acquisition", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.MoveTool({ store });
  tool.BeginMove(["w"]);
  tool.SetNumericTranslation([-2, 0.5]);
  tool.GenerateMovePreview();
  tool.CommitMove();
  near(store.get("w").position[0], -1.5, 1e-12);
  near(store.get("w").position[1], 0.5, 1e-12);
});

t("move: hosted dependent rigidly follows with the same Δ (MOD-MOV-011, D-16)", () => {
  const store = makeStore([wallEl("host", 0, 0, 4, 0), wallEl("door", 1, 0, 1.2, 0)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "host",
    source: { elementId: "host", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "door", kind: "endpoint", position: [1, 0, 0] },
  });
  const tool = new mod.MoveTool({ store, relationships: reg });
  tool.BeginMove(["host"]);
  const deps = tool.EvaluateMoveDependencies();
  assert(deps.hosted.includes("door"), `hosted deps: ${JSON.stringify(deps)}`);
  tool.AcquireMoveBasePoint([0, 0]);
  tool.ResolveMoveTarget([0, 1]); // Δ = (0,1)
  const preview = tool.GenerateMovePreview();
  assert(preview.some((p) => p.elementId === "door"), "preview must include the follower");
  const r = tool.CommitMove();
  assert(r.ok, "commit failed");
  near(store.get("host").position[1], 1, 1e-12);
  near(store.get("door").position[1], 1, 1e-12);
  assert(r.diagnostics.some((d) => d.code === "MOD-MOV-011"), "expected MOD-MOV-011 info");
  // registry coherence after refresh: a second move re-evaluates cleanly
  const tool2 = new mod.MoveTool({ store, relationships: reg });
  tool2.BeginMove(["host"]);
  tool2.SetNumericTranslation([0, 1]);
  tool2.GenerateMovePreview();
  tool2.CommitMove();
  near(store.get("door").position[1], 2, 1e-12);
});

t("move: locked coincident alignment BLOCKS the move with MOD-MOV-010; model unchanged", () => {
  const store = makeStore([wallEl("a", 0, 0, 1, 0), wallEl("b", 1, 0, 2, 0)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "a", kind: "endpoint", position: [1, 0, 0] },
    target: { elementId: "b", kind: "endpoint", position: [1, 0, 0] },
    constraint: { kind: "coincident" },
  });
  const tool = new mod.MoveTool({ store, relationships: reg });
  tool.BeginMove(["a"]);
  tool.SetNumericTranslation([0, 5]);
  tool.GenerateMovePreview();
  const v = tool.ValidateMove();
  assert(!v.ok, "locked alignment must block");
  assert(v.diagnostics.some((d) => d.code === "MOD-MOV-010"), "expected MOD-MOV-010");
  const r = tool.CommitMove();
  assert(!r.ok && r.applied === 0, "blocked move must not apply");
  near(store.get("a").position[0], 0.5, 1e-12);
  near(store.get("a").position[1], 0, 1e-12);
});

t("move: pinned element rejected at BeginMove (MOD-MOV-002)", () => {
  const store = makeStore([wallEl("p", 0, 0, 1, 0, { pinned: true })]);
  const tool = new mod.MoveTool({ store });
  throws(() => tool.BeginMove(["p"]), "pinned");
});

t("move: transaction-guaranteed undo restores exact state; redo re-applies (§8 classes 10-11)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = new TransactionService();
  const tool = new mod.MoveTool({ store }, txn);
  tool.BeginMove(["w"]);
  tool.SetNumericTranslation([10, 0]);
  tool.GenerateMovePreview();
  tool.CommitMove();
  near(store.get("w").position[0], 12, 1e-12);
  assert(tool.UndoMove(), "undo failed");
  near(store.get("w").position[0], 2, 1e-12);
  near(store.get("w").curve.start[0], 0, 1e-12);
  assert(tool.RedoMove(), "redo failed");
  near(store.get("w").position[0], 12, 1e-12);
  // undo without a wired transaction is reported, not crashed
  const tool2 = new mod.MoveTool({ store });
  tool2.BeginMove(["w"]);
  tool2.SetNumericTranslation([1, 0]);
  tool2.GenerateMovePreview();
  tool2.CommitMove();
  assert(!tool2.UndoMove(), "undo without txn must return false");
  assert(tool2.GetDiagnostics().some((d) => d.code === "MOD-MOV-020"), "expected MOD-MOV-020");
});

// ═══ 4. Rotate (spec §5) ════════════════════════════════════════════════

console.log("── Rotate ──");

t("rotate: 90° about pivot — closed form p' = Q + R(θ)(p−Q), orientation accumulates (E-M1-06)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]); // position (2,0)
  const tool = new mod.RotateTool({ store });
  tool.BeginRotate(["w"]);
  tool.AcquireRotationAxis();
  tool.AcquireRotationPivot([0, 0]);
  const theta = tool.ResolveRotationAngle({ angle: Math.PI / 2 });
  near(theta, Math.PI / 2, 1e-12);
  tool.GenerateRotationPreview();
  tool.CommitRotation();
  near(store.get("w").position[0], 0, 1e-9);
  near(store.get("w").position[1], 2, 1e-9);
  near(store.get("w").rotationZ, Math.PI / 2, 1e-12);
  // world curve endpoints: (0,0)->(0,0), (4,0)->(0,4)
  near(store.get("w").curve.end[0], 0, 1e-9);
  near(store.get("w").curve.end[1], 4, 1e-9);
});

t("rotate: two-point angle resolution (start ray → end ray = +90°)", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.RotateTool({ store });
  tool.BeginRotate(["w"]);
  tool.AcquireRotationPivot([0, 0]);
  const theta = tool.ResolveRotationAngle({ start: [1, 0], end: [0, 1] });
  near(theta, Math.PI / 2, 1e-12);
});

t("rotate: angular snap θ' = round(θ/s)·s with s = π/12 (spec §5.2, D-15)", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.RotateTool({ store });
  tool.BeginRotate(["w"]);
  tool.AcquireRotationPivot([0, 0]);
  const theta = tool.ResolveRotationAngle({ angle: 0.26 }, { snapStep: Math.PI / 12 });
  near(theta, Math.PI / 12, 1e-12);
  assert(tool.GetDiagnostics().some((d) => d.code === "MOD-ROT-023"), "expected snap info");
});

t("rotate: hosted follower rotates about the SAME pivot (spec §5.3)", () => {
  const store = makeStore([wallEl("col", 2, 0, 2, 0.2), wallEl("beam", 2.1, 0.1, 4, 0.1)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "rigid-attachment",
    source: { elementId: "col", kind: "endpoint", position: [2, 0, 0] },
    target: { elementId: "beam", kind: "endpoint", position: [2.1, 0.1, 0] },
  });
  const tool = new mod.RotateTool({ store, relationships: reg });
  tool.BeginRotate(["col"]);
  tool.AcquireRotationPivot([0, 0]);
  tool.ResolveRotationAngle({ angle: Math.PI / 2 });
  tool.GenerateRotationPreview();
  const r = tool.CommitRotation();
  assert(r.ok, `commit failed: ${JSON.stringify(r.diagnostics)}`);
  // column center (2,0.1) rotated 90° about origin → (−0.1, 2)
  near(store.get("col").position[0], -0.1, 1e-9);
  near(store.get("col").position[1], 2, 1e-9);
  // beam center (3.05, 0.1) → (−0.1, 3.05)
  near(store.get("beam").position[0], -0.1, 1e-9);
  near(store.get("beam").position[1], 3.05, 1e-9);
  assert(r.diagnostics.some((d) => d.code === "MOD-ROT-024"), "expected MOD-ROT-024 info");
});

t("rotate: zero-angle commit rejected as no-op (MOD-ROT-021); out-of-plane axis rejected (MOD-ROT-022)", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.RotateTool({ store });
  tool.BeginRotate(["w"]);
  tool.AcquireRotationPivot([0, 0]);
  tool.ResolveRotationAngle({ angle: 0 });
  tool.GenerateRotationPreview();
  const r = tool.CommitRotation();
  assert(!r.ok && r.applied === 0, "zero-angle must be rejected");
  assert(r.diagnostics.some((d) => d.code === "MOD-ROT-021"), "expected MOD-ROT-021");
  const tool2 = new mod.RotateTool({ store });
  tool2.BeginRotate(["w"]);
  throws(() => tool2.AcquireRotationAxis([1, 0, 0]), "MOD-ROT-022");
});

// ═══ 5. Mirror (spec §6) ════════════════════════════════════════════════

console.log("── Mirror ──");

t("mirror: reflection across y=x — point (4,0)→(0,4), θ'=2φ−θ (E-M1-07 closed form)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]); // θ=0, pos (2,0)
  const tool = new mod.MirrorTool({ store });
  tool.BeginMirror(["w"], false);
  tool.AcquireMirrorPlane([0, 0], [1, 1]);
  const tr = tool.CalculateMirrorTransform();
  const rp = tr.reflectPoint([4, 0]);
  near(rp[0], 0, 1e-12); near(rp[1], 4, 1e-12);
  // y≠0 input catches any matrix-component error: (1,2) across y=x → (2,1)
  const rp2 = tr.reflectPoint([1, 2]);
  near(rp2[0], 2, 1e-12); near(rp2[1], 1, 1e-12);
  near(tr.reflectAngle(0), Math.PI / 2, 1e-12);
  tool.GenerateMirrorPreview();
  const r = tool.CommitMirror();
  assert(r.ok && r.createdIds.length === 0, "move mode must not create");
  near(store.get("w").position[0], 0, 1e-9);
  near(store.get("w").position[1], 2, 1e-9);
  near(store.get("w").rotationZ, Math.PI / 2, 1e-12);
  // world endpoints: (0,0)→(0,0), (4,0)→(0,4)
  near(store.get("w").curve.end[0], 0, 1e-9);
  near(store.get("w").curve.end[1], 4, 1e-9);
});

t("mirror: copy mode — original preserved, new unpinned copy with new id (spec §6.3)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0), wallEl("p", 0, 5, 4, 5, { pinned: true })]);
  const tool = new mod.MirrorTool({ store, allocateId: (() => { let i = 0; return () => `mir_${++i}`; })() });
  // pinned elements reject mirror at activation (editability gate)
  throws(() => tool.BeginMirror(["p"], true), "pinned");
  tool.BeginMirror(["w"], true);
  tool.AcquireMirrorPlane([0, 0], [1, 1]);
  tool.GenerateMirrorPreview();
  const r = tool.CommitMirror();
  assert(r.ok && r.createdIds.length === 1 && r.createdIds[0] === "mir_1", `created: ${r.createdIds}`);
  // original untouched
  near(store.get("w").position[0], 2, 1e-12);
  near(store.get("w").rotationZ, 0, 1e-12);
  // copy mirrored
  const copy = store.get("mir_1");
  near(copy.position[0], 0, 1e-9);
  near(copy.position[1], 2, 1e-9);
  near(copy.rotationZ, Math.PI / 2, 1e-12);
  near(copy.curve.end[0], 0, 1e-9);
  near(copy.curve.end[1], 4, 1e-9);
  assert(copy.pinned === false, "copies always start unpinned (E-M1-09)");
});

t("mirror: hand and facing parameters flip; world curve reflection exact (spec §6.2)", () => {
  const store = makeStore([wallEl("d", 0, 0, 1, 0, { params: { hand: 0, facing: 1, width: 0.1 } })]);
  const tool = new mod.MirrorTool({ store });
  tool.BeginMirror(["d"], false);
  tool.AcquireMirrorPlane([0, 0], [0, 1]); // mirror across the Y-AXIS line: (x,y) → (−x,y)
  tool.GenerateMirrorPreview();
  tool.CommitMirror();
  const el = store.get("d");
  assert(el.params.hand === 1 && el.params.facing === 0, `hand/facing: ${JSON.stringify(el.params)}`);
  near(el.params.width, 0.1, 1e-12);
  near(el.position[0], -0.5, 1e-12);
  near(el.position[1], 0, 1e-12);
  near(el.curve.start[0], 0, 1e-12);
  near(el.curve.end[0], -1, 1e-12);
  near(el.curve.start[1], 0, 1e-12);
  near(el.curve.end[1], 0, 1e-12);
});

t("mirror: zero-length direction rejected (MOD-MIR-002)", () => {
  const store = makeStore([wallEl("w", 0, 0, 1, 0)]);
  const tool = new mod.MirrorTool({ store });
  tool.BeginMirror(["w"], true);
  throws(() => tool.AcquireMirrorPlane([0, 0], [0, 0]), "MOD-MIR-002");
});

t("mirror: relationship cloning — host record cloned between mirrored copies, once (spec §6.3)", () => {
  const store = makeStore([wallEl("host", 0, 0, 4, 0), wallEl("other", 0, 5, 4, 5)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "host",
    source: { elementId: "host", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "other", kind: "endpoint", position: [0, 5, 0] },
  });
  const tool = new mod.MirrorTool({ store, relationships: reg, allocateId: (() => { let i = 0; return () => `m_${++i}`; })() });
  tool.BeginMirror(["host", "other"], true);
  tool.AcquireMirrorPlane([0, 0], [1, 0]); // mirror across the X-AXIS line: (x,y) → (x,−y)
  tool.GenerateMirrorPreview();
  const r = tool.CommitMirror();
  assert(r.ok, "commit failed");
  assert(r.clonedRelationships === 1, `expected 1 cloned record, got ${r.clonedRelationships}`);
  // the clone connects m_1 (copy of host) to m_2 (copy of other), mirrored geometry
  const clone = reg.queryRelationships({}).find((x) => x.source.elementId === "m_1");
  assert(clone && clone.target.elementId === "m_2", "clone must connect the two copies");
  near(clone.target.position[1], -5, 1e-9);
});

t("mirror: hosted copy detaches with MOD-MIR-010 when its host is not mirrored (D-13)", () => {
  const store = makeStore([wallEl("host", 0, 0, 4, 0), wallEl("door", 1, 0, 1.2, 0)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "host",
    source: { elementId: "host", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "door", kind: "endpoint", position: [1, 0, 0] },
  });
  const tool = new mod.MirrorTool({ store, relationships: reg, allocateId: (() => { let i = 0; return () => `m_${++i}`; })() });
  tool.BeginMirror(["door"], true); // host NOT mirrored
  tool.AcquireMirrorPlane([0, 0], [1, 0]);
  tool.GenerateMirrorPreview();
  const r = tool.CommitMirror();
  assert(r.ok, "commit must succeed");
  assert(r.diagnostics.some((d) => d.code === "MOD-MIR-010"), "expected MOD-MIR-010 detach warning");
});

t("mirror: undo of copy mode removes created copies (transaction + store.remove)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = new TransactionService();
  const tool = new mod.MirrorTool({ store }, txn);
  tool.BeginMirror(["w"], true);
  tool.AcquireMirrorPlane([0, 0], [1, 1]);
  tool.GenerateMirrorPreview();
  const r = tool.CommitMirror();
  assert(r.ok && store.all().length === 2, "copy must exist");
  assert(tool.txn, "txn wired");
  assert(txn.canUndo(), "undo stack must hold the mirror");
  // undo via the tool's transaction
  assert(txn.undo(), "undo failed");
  assert(store.all().length === 1 && !store.get("mir_1"), "copy must be removed by undo");
  assert(store.get("w"), "original must survive");
  assert(txn.redo(), "redo failed");
  assert(store.all().length === 2, "redo must re-create the copy");
});

// ═══ 6. Performance at scale (spec §13.25, budget A7) ═══════════════════

console.log("── Performance ──");

t("performance: hit-test over 10k elements ≤ 50ms; preview over 1k selected ≤ 100ms", () => {
  const elems = [];
  for (let i = 0; i < 10000; i++) {
    const x = (i % 100) * 1.5;
    const y = Math.floor(i / 100) * 1.5;
    elems.push(wallEl(`w${i}`, x, y, x + 1, y));
  }
  const store = makeStore(elems);
  const engine = new sel.SelectionEngine({ elements: () => store.all() });
  const t0 = process.hrtime.bigint();
  engine.HitTest([75, 75]);
  const t1 = process.hrtime.bigint();
  const hitMs = Number(t1 - t0) / 1e6;
  assert(hitMs <= 50, `hit-test ${hitMs.toFixed(1)}ms > 50ms budget`);
  const many = elems.slice(0, 1000).map((e) => e.id);
  const tool = new mod.MoveTool({ store });
  tool.BeginMove(many);
  tool.SetNumericTranslation([1, 1]);
  const t2 = process.hrtime.bigint();
  tool.GenerateMovePreview();
  const t3 = process.hrtime.bigint();
  const prevMs = Number(t3 - t2) / 1e6;
  assert(prevMs <= 100, `preview ${prevMs.toFixed(1)}ms > 100ms budget`);
});

// ── Report ──────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
