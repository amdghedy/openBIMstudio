/**
 * tests/undo-transaction-architecture.test.cjs
 *
 * Undo/redo & command-transaction architecture — regression tests against
 * the REAL production implementations (features/history.ts, the canonical
 * TransactionService facade, modules/modify Group-1 tools, modules/cad
 * CadEngine, core/undo-stack.ts EntityUndoStack).
 *
 * Coverage mandated by the consolidation brief:
 *   1. multi-step editing            5. compound commands (transactions)
 *   2. undo-all / redo-all           6. failed operations + rollback
 *   3. deterministic before/after    7. save/reopen (document transition,
 *   4. redo invalidation                persistence-safe restoration)
 *   8. geometry + metadata + relationship synchronization (hosted followers)
 *   9. single canonical stack (Group-1 commits visible to Ctrl+Z)
 *  10. source-level wiring pins (keyboard single-owner, dirty-on-undo,
 *      no duplicated history systems, no untracked auto-mutations)
 *
 * Run: `node tests/undo-transaction-architecture.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
// ALL tests (sync and async) run strictly sequentially: they share the
// canonical history singleton, so concurrent async tests would race.
const testQueue = [];
function t(name, fn) { testQueue.push({ name, fn: async () => fn() }); }
function ta(name, fn) { testQueue.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-6) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol}), diff ${Math.abs(a - b)}`); }
function throws(fn, substr) {
  try { fn(); } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected throw containing '${substr}'`);
}
/** Async variant: awaits a promise expected to reject with `substr`. */
async function throwsA(p, substr) {
  try { await p; } catch (e) {
    if (!substr || String(e.message).includes(substr)) return;
    throw new Error(`threw wrong error: ${e.message}`);
  }
  throw new Error(`expected rejection containing '${substr}'`);
}

// ── Minimal browser shims (history.ts dispatches DOM events on undo/redo) ─
const historyEvents = [];
if (typeof globalThis.CustomEvent === "undefined") {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
  };
}
if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    setTimeout: (fn, _ms) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (type, fn) => { (historyEvents.listeners[type] ??= []).push(fn); },
    removeEventListener: (type, fn) => {
      const arr = historyEvents.listeners[type];
      if (arr) historyEvents.listeners[type] = arr.filter((f) => f !== fn);
    },
    dispatchEvent: (ev) => {
      historyEvents.push(ev);
      for (const fn of historyEvents.listeners[ev.type] ?? []) fn(ev);
      return true;
    },
  };
  historyEvents.listeners = {};
}

// ── Compile the real production modules ─────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-undo-txn-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/features/history.ts src/modules/modify/index.ts src/modules/selection/index.ts" +
  " src/modules/references/index.ts src/modules/transaction/index.ts src/modules/relationships/index.ts" +
  " src/modules/cad/cad-engine.ts src/core/undo-stack.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const { history } = require(path.join(tmpOut, "features/history.js"));
const txnMod = require(path.join(tmpOut, "modules/transaction/index.js"));
const mod = require(path.join(tmpOut, "modules/modify/index.js"));
const { RelationshipRegistry } = require(path.join(tmpOut, "modules/relationships/index.js"));
const { CadEngine } = require(path.join(tmpOut, "modules/cad/cad-engine.js"));
const { EntityUndoStack } = require(path.join(tmpOut, "core/undo-stack.js"));

// ── Store harness (identical shape to the production RemovableElementStore) ─
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

function lineEl(id, x0, y0, x1, y1) {
  return { id, kind: "line", a: { x: x0, y: y0 }, b: { x: x1, y: y1 }, color: "#fff", strokeWidth: 1, layer: "0" };
}

function makeMove(store, ids, dx, dy, txn, relationships) {
  const tool = new mod.MoveTool(relationships ? { store, relationships } : { store }, txn);
  tool.BeginMove(ids);
  tool.SetNumericTranslation([dx, dy]);
  tool.GenerateMovePreview();
  return tool;
}

function resetHistory() { history.clear(); }

console.log("== tests/undo-transaction-architecture.test.cjs");
// ═══ 1. Canonical history: deterministic commands ═══════════════════════

console.log("── history.ts core ──");

ta("multi-step editing: N commands undo step-by-step to original, redo step-by-step to final", async () => {
  resetHistory();
  const state = { v: 0 };
  const mk = (label, delta) => ({
    label,
    apply: () => { state.v += delta; },
    revert: () => { state.v -= delta; },
  });
  await history.exec(mk("add 10", 10));
  await history.exec(mk("add 3", 3));
  await history.exec(mk("add 32", 32));
  assert(state.v === 45, `state after 3 execs: ${state.v}`);
  assert(history.depth().undo === 3 && history.depth().redo === 0, "depth after execs");
  await history.undo(); assert(state.v === 13, `undo 1: ${state.v}`);
  await history.undo(); assert(state.v === 10, `undo 2: ${state.v}`);
  await history.undo(); assert(state.v === 0, "undo 3: back to original");
  assert(history.canUndo() === false, "undo-all exhausted");
  await history.redo(); assert(state.v === 10, "redo 1");
  await history.redo(); assert(state.v === 13, "redo 2");
  await history.redo(); assert(state.v === 45, "redo 3: back to final");
  assert(history.canRedo() === false, "redo-all exhausted");
});

ta("exec: failed apply auto-reverts — no partial state, command not recorded", async () => {
  resetHistory();
  const state = { done: false };
  await throwsA(history.exec({
    label: "exploding",
    apply: () => { state.done = true; throw new Error("boom"); },
    revert: () => { state.done = false; },
  }), "boom");
  assert(state.done === false, "revert must restore pre-apply state");
  assert(history.canUndo() === false, "failed command must not land on the stack");
});

ta("exec: failed apply with failing revert surfaces AggregateError, stack stays clean", async () => {
  resetHistory();
  let err = null;
  try {
    await history.exec({
      label: "double-failure",
      apply: () => { throw new Error("apply-fail"); },
      revert: () => { throw new Error("revert-fail"); },
    });
  } catch (e) { err = e; }
  assert(err instanceof AggregateError, `expected AggregateError, got ${err}`);
  assert(err.errors.length === 2, "both errors reported");
  assert(history.canUndo() === false, "stack clean after double failure");
});

ta("doUndo: failed revert pushes the command back so the user can retry", async () => {
  resetHistory();
  let attempts = 0;
  history.push({
    label: "retry-me",
    apply: () => {},
    revert: () => { attempts++; if (attempts < 2) throw new Error("not yet"); },
  });
  await throwsA(history.undo(), "not yet"); // revert attempt 1 fails
  assert(history.canUndo(), "command back on the stack after failed undo");
  await history.undo(); // revert attempt 2 succeeds
  assert(attempts === 2, `revert attempts: ${attempts}`);
  assert(history.canRedo(), "undone command is redoable");
});

// ═══ 2. Compound commands / transactions ════════════════════════════════

console.log("── transactions (compound + rollback) ──");

ta("transaction: nested pushes fold into ONE undoable compound command", async () => {
  resetHistory();
  const log = [];
  await history.transaction("Delete 3 elements", async () => {
    for (let i = 0; i < 3; i++) {
      history.push({ label: `remove ${i}`, apply: () => log.push(`+${i}`), revert: () => log.push(`-${i}`) });
    }
  });
  assert(history.depth().undo === 1, `compound folds into one entry, got ${history.depth().undo}`);
  assert(history.undoLabel() === "Delete 3 elements", `label: ${history.undoLabel()}`);
  assert(log.length === 0, "push records without applying — no forward log at record time");
  await history.undo();
  // reverse-order rollback is the compound contract
  assert(log.join(",") === "-2,-1,-0", `undo log: ${log.join(",")}`);
  await history.redo();
  assert(log.join(",") === "-2,-1,-0,+0,+1,+2", `redo log: ${log.join(",")}`);
});

ta("transaction: nested inner transaction folds into the outer compound", async () => {
  resetHistory();
  const log = [];
  await history.transaction("outer", async () => {
    history.push({ label: "a", apply: () => log.push("a"), revert: () => log.push("A") });
    await history.transaction("inner", async () => {
      history.push({ label: "b", apply: () => log.push("b"), revert: () => log.push("B") });
    });
    history.push({ label: "c", apply: () => log.push("c"), revert: () => log.push("C") });
  });
  assert(history.depth().undo === 1, "nested folds into the outermost entry");
  await history.undo();
  assert(log.join(",") === "C,B,A", `reverse-order rollback: ${log.join(",")}`);
  await history.redo();
  assert(log.join(",") === "C,B,A,a,b,c", `forward-order redo: ${log.join(",")}`);
});

ta("transaction: failing inner scope rolls back to its savepoint; outer rethrows", async () => {
  resetHistory();
  const log = [];
  await throwsA(history.transaction("outer", async () => {
    history.push({ label: "a", apply: () => log.push("a"), revert: () => log.push("A") });
    await history.transaction("doomed", async () => {
      history.push({ label: "b", apply: () => log.push("b"), revert: () => log.push("B") });
      throw new Error("inner-fail");
    });
  }), "inner-fail");
  // savepoint rollback undid ONLY the doomed scope's work, in reverse; the
  // outer scope then unwinds its own buffered work (its savepoint too).
  assert(log.join(",") === "B,A", `log: ${log.join(",")}`);
  assert(history.canUndo() === false, "nothing recorded from a failed outer transaction");
});

ta("transaction: rollback that itself fails raises AggregateError (never silent)", async () => {
  resetHistory();
  let err = null;
  try {
    await history.transaction("bad-rollback", async () => {
      history.push({
        label: "stuck",
        apply: () => {},
        revert: () => { throw new Error("revert-broken"); },
      });
      throw new Error("trigger");
    });
  } catch (e) { err = e; }
  assert(err instanceof AggregateError, `AggregateError expected, got ${err}`);
  assert(String(err.message).includes("bad-rollback"), "error names the transaction");
});

ta("cancellation path: pending work can be rolled back without polluting history", () => {
  // TransactionService.cancel/rollback reverse-apply pending changes and
  // record nothing — the compound never reaches the undo stack.
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = new txnMod.TransactionService(); // private mode: synchronous
  txn.setApplyHandler(mod.makeStoreApplyHandler(store)); // raw replay: record applies forward live
  txn.start({ name: "Move (cancelled)" });
  txn.recordChange({ elementId: "w", propertyPath: "transform", oldValue: { position: [2, 0] }, newValue: { position: [9, 9] }, source: "user" });
  near(store.get("w").position[0], 9, 1e-12, "pending changes are live during the transaction");
  assert(txn.cancel() === true, "cancel applies the inverse");
  near(store.get("w").position[0], 2, 1e-12);
  assert(txn.canUndo() === false, "cancelled compound is not undoable");
  assert(history.canUndo() === false, "private-mode instance must not touch the shared stack");
});

// ═══ 3. Redo invalidation ═══════════════════════════════════════════════

console.log("── redo invalidation ──");

ta("new edit after undo clears the redo stack (no divergent redo branches)", async () => {
  resetHistory();
  await history.exec({ label: "a", apply: () => {}, revert: () => {} });
  await history.undo();
  assert(history.canRedo(), "undo opens a redo branch");
  await history.exec({ label: "b", apply: () => {}, revert: () => {} });
  assert(history.canRedo() === false, "push invalidates redo");
  await history.undo();
  // the pre-undo branch ("a") is gone forever — single linear history
  assert(history.canUndo() === false && history.undoLabel() === null, "old branch discarded, not divergent");
  assert(history.redoLabel() === "b", "the undone edit is redoable");
});

ta("depth bound: oldest entries drop beyond maxDepth (100)", () => {
  resetHistory();
  for (let i = 0; i < 105; i++) {
    history.push({ label: `c${i}`, apply: () => {}, revert: () => {} });
  }
  assert(history.depth().undo === 100, `bounded depth, got ${history.depth().undo}`);
  assert(history.undoLabel() === "c104", "newest intact");
});

ta("coalescing: same-key rapid edits merge into one undo step", async () => {
  resetHistory();
  history.push({ label: "drag", apply: () => {}, revert: () => {} }, "slider-1");
  history.push({ label: "drag", apply: () => {}, revert: () => {} }, "slider-1");
  assert(history.depth().undo === 1, `coalesced depth, got ${history.depth().undo}`);
  history.push({ label: "other", apply: () => {}, revert: () => {} });
  assert(history.depth().undo === 2, "different key does not merge");
});

// ═══ 4. Single canonical stack (Group-1 ⇄ Ctrl+Z) ═══════════════════════

console.log("── TransactionService facade (canonical mode) ──");

ta("Group-1 Move commit lands on the canonical history stack — visible to Ctrl+Z", async () => {
  resetHistory();
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = txnMod.getTransactionService();
  assert(txn.isCanonical, "singleton must be canonical");
  const tool = makeMove(store, ["w"], 10, 0, txn);
  tool.CommitMove();
  near(store.get("w").position[0], 12, 1e-12);
  assert(history.canUndo(), "commit must be undoable on the SHARED stack");
  assert(history.undoLabel() === "Move", `label: ${history.undoLabel()}`);
  await history.undo();
  near(store.get("w").position[0], 2, 1e-12);
  assert(txn.canRedo(), "facade canRedo mirrors history");
  await history.redo();
  near(store.get("w").position[0], 12, 1e-12);
});

ta("REGRESSION: first redo of an OLDER transaction applies (persistent seen-registry)", async () => {
  resetHistory();
  const store = makeStore([wallEl("w1", 0, 0, 4, 0), wallEl("w2", 10, 0, 14, 0)]);
  const txn = txnMod.getTransactionService();
  // Two sequential tool commits re-wire the apply handler twice; the seen
  // registry must persist, or the first redo of the older commit silently
  // no-ops (the historical bug).
  const t1 = makeMove(store, ["w1"], 10, 0, txn); t1.CommitMove();
  const t2 = makeMove(store, ["w2"], 5, 0, txn); t2.CommitMove();
  assert(history.depth().undo === 2, `both commits on one stack: ${history.depth().undo}`);
  await history.undo(); await history.undo();
  near(store.get("w1").position[0], 2, 1e-12);
  near(store.get("w2").position[0], 12, 1e-12);
  await history.redo();
  near(store.get("w1").position[0], 12, 1e-12, "older transaction redo MUST apply");
  await history.redo();
  near(store.get("w2").position[0], 17, 1e-12, "newer transaction redo applies");
});

ta("undo-all/redo-all across mixed Group-1 commits keeps geometry + params in sync", async () => {
  resetHistory();
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = txnMod.getTransactionService();
  const moves = [[1, 0], [0, 2], [3, -1]];
  for (const [dx, dy] of moves) { const tool = makeMove(store, ["w"], dx, dy, txn); tool.CommitMove(); }
  near(store.get("w").position[0], 6, 1e-12);
  near(store.get("w").position[1], 1, 1e-12);
  assert(history.depth().undo === 3, "three deterministic steps");
  let guard = 0;
  while (history.canUndo() && guard++ < 10) await history.undo();
  near(store.get("w").position[0], 2, 1e-12, "undo-all restores original geometry");
  near(store.get("w").position[1], 0, 1e-12);
  near(store.get("w").curve.start[0], 0, 1e-12, "curve endpoints untouched by round-trip");
  near(store.get("w").params.width, 0.2, 1e-12, "metadata (params) untouched");
  guard = 0;
  while (history.canRedo() && guard++ < 10) await history.redo();
  near(store.get("w").position[0], 6, 1e-12, "redo-all restores final geometry");
  near(store.get("w").position[1], 1, 1e-12, "redo-all restores final elevation");
});

ta("geometry + metadata + relationships stay synchronized through undo (hosted follower)", async () => {
  resetHistory();
  const store = makeStore([wallEl("host", 0, 0, 4, 0), wallEl("door", 1, 0, 1.2, 0)]);
  const reg = new RelationshipRegistry();
  reg.createRelationship({
    type: "host",
    source: { elementId: "host", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "door", kind: "endpoint", position: [1, 0, 0] },
  });
  const txn = txnMod.getTransactionService();
  const tool = makeMove(store, ["host"], 0, 1, txn, reg);
  const deps = tool.EvaluateMoveDependencies();
  assert(deps.hosted.includes("door"), "door must rigidly follow");
  tool.CommitMove();
  near(store.get("host").position[1], 1, 1e-12);
  near(store.get("door").position[1], 1, 1e-12);
  await history.undo();
  near(store.get("host").position[1], 0, 1e-12, "host geometry restored");
  near(store.get("door").position[1], 0, 1e-12, "dependent geometry restored in the SAME step");
  await history.redo();
  near(store.get("door").position[1], 1, 1e-12, "dependent follows on redo");
});

ta("transient transactions mutate without history coverage (preview-class edits)", () => {
  resetHistory();
  const txn = txnMod.getTransactionService();
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  txn.setApplyHandler(mod.makeStoreApplyHandler(store));
  txn.start({ name: "preview", transient: true });
  txn.recordChange({ elementId: "w", propertyPath: "transform", oldValue: null, newValue: { position: [7, 7] }, source: "system" });
  txn.commit();
  assert(history.canUndo() === false, "transient commits must not pollute the undo stack");
});

ta("private-mode instances keep isolated synchronous stacks (tool/test back-compat)", () => {
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = new txnMod.TransactionService();
  txn.setApplyHandler(mod.makeStoreApplyHandler(store));
  txn.start({ name: "Move (private)" });
  // before/after patches exactly as group1.recordTxn records them (the
  // tool applies the after-patch itself; the wrapper skips that first
  // forward replay and the inverse patch drives undo).
  txn.recordChange({ elementId: "w", propertyPath: "transform", oldValue: { reason: "edit-undo", position: [2, 0] }, newValue: { reason: "edit", position: [5, 0] }, source: "user" });
  assert(txn.commit() === true, "commit ok");
  assert(txn.canUndo(), "private stack holds the entry");
  assert(history.canUndo() === false, "private instance must NOT write the shared stack");
  assert(txn.undo() === true, "synchronous undo");
  near(store.get("w").position[0], 2, 1e-12);
  assert(txn.redo() === true, "synchronous redo");
  near(store.get("w").position[0], 5, 1e-12);
});

// ═══ 5. Document boundaries (save / reopen) ═════════════════════════════

console.log("── document transition (save/reopen safety) ──");

ta("reopen path: beginDocumentTransition clears both stacks; history cannot cross documents", async () => {
  resetHistory();
  const store = makeStore([wallEl("w", 0, 0, 4, 0)]);
  const txn = txnMod.getTransactionService();
  const tool = makeMove(store, ["w"], 2, 0, txn); tool.CommitMove();
  assert(history.canUndo(), "pre-condition");
  // projects.ts openProject/createProject do exactly this
  const release = await history.beginDocumentTransition();
  assert(history.canUndo() === false && history.canRedo() === false, "stacks cleared at the boundary");
  await history.undo(); // must be a silent no-op, not a stale revert
  near(store.get("w").position[0], 4, 1e-12, "no stale revert across documents");
  history.push({ label: "ghost", apply: () => {}, revert: () => {} });
  assert(history.canUndo() === false, "pushes are refused while suspended");
  release();
  history.push({ label: "fresh doc edit", apply: () => {}, revert: () => {} });
  assert(history.canUndo(), "editing resumes after the release");
});

ta("exec/transaction throw during a transition (no half-applied cross-document work)", async () => {
  resetHistory();
  const release = await history.beginDocumentTransition();
  try {
    await throwsA(history.exec({ label: "x", apply: () => {}, revert: () => {} }), "transition");
    await throwsA(history.transaction("y", async () => {}), "transition");
  } finally {
    release(); // never leave the engine suspended, even on failure
  }
});

ta("undo/redo dispatch obs-history so persistence can mark the document dirty", async () => {
  resetHistory();
  historyEvents.length = 0;
  history.push({ label: "dirty-me", apply: () => {}, revert: () => {} });
  await history.undo();
  await history.redo();
  const evts = historyEvents.filter((e) => e.type === "obs-history");
  assert(evts.length === 2, `obs-history dispatched per undo/redo: ${evts.length}`);
  assert(evts[0].detail.action === "undo" && evts[1].detail.action === "redo", "actions reported");
});

// ═══ 6. CAD quick-sketch engine (real CadEngine) ════════════════════════

console.log("── cad-engine deterministic commands ──");

t("add/undo/redo: exact entity restored in order", () => {
  const cad = new CadEngine();
  const l1 = cad.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const c1 = cad.addCircle({ x: 5, y: 5 }, 8);
  const l2 = cad.addLine({ x: 0, y: 3 }, { x: 7, y: 3 });
  assert(cad.getCount() === 3, "pre-condition");
  assert(cad.undo() === true, "undo");
  assert(cad.getCount() === 2 && !cad.getAllEntities().some((e) => e.id === l2.id), "last add removed");
  assert(cad.redo() === true, "redo");
  assert(cad.getCount() === 3 && cad.getAllEntities()[2].id === l2.id, "exact entity + order restored");
});

t("REGRESSION: undo after deleteById restores the DELETED entity, not the last one", () => {
  const cad = new CadEngine();
  const a = cad.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const b = cad.addLine({ x: 0, y: 5 }, { x: 10, y: 5 });
  const c = cad.addCircle({ x: 2, y: 2 }, 4);
  assert(cad.deleteById(b.id) === true, "delete middle entity");
  assert(cad.getCount() === 2, "deleted");
  assert(cad.undo() === true, "undo the delete");
  let ents = cad.getAllEntities();
  assert(ents.length === 3, "count restored");
  assert(ents.some((e) => e.id === b.id), "the deleted entity is back (historical bug removed an unrelated entity)");
  assert(cad.redo() === true && !cad.getAllEntities().some((e) => e.id === b.id), "redo deletes it again");
  assert(cad.undo() === true, "undo again");
  ents = cad.getAllEntities();
  assert(ents.some((e) => e.id === a.id), "earlier entities untouched by the cycle");
});

t("trim is undoable: exact before endpoints restored, redo re-trims", () => {
  const cad = new CadEngine();
  const cutter = cad.addLine({ x: -5, y: 5 }, { x: 15, y: 5 }); // horizontal at y=5
  const target = cad.addLine({ x: 0, y: 0 }, { x: 0, y: 10 }); // vertical at x=0
  assert(cad.trimAt({ x: 6, y: 5 }, { x: 0, y: 8 }) === true, "trim upper half");
  const afterTrim = cad.getAllEntities().find((e) => e.id === target.id);
  assert(afterTrim.b.y === 5, `trimmed to intersection: ${afterTrim.b.y}`);
  assert(cad.undo() === true, "trim undo");
  const restored = cad.getAllEntities().find((e) => e.id === target.id);
  assert(restored.a.y === 0 && restored.b.y === 10, "exact before-state endpoints");
  assert(cad.redo() === true, "trim redo");
  const again = cad.getAllEntities().find((e) => e.id === target.id);
  assert(again.b.y === 5, "re-trimmed");
});

t("extend is undoable: exact endpoints restored", () => {
  const cad = new CadEngine();
  cad.addLine({ x: 0, y: 10 }, { x: 10, y: 10 }); // boundary
  const target = cad.addLine({ x: 2, y: 0 }, { x: 2, y: 4 });
  // click near the END of the target: the end is the side that extends
  assert(cad.extendTo({ x: 5, y: 10 }, { x: 2, y: 3 }) === true, "extend end upward to boundary");
  const extended = cad.getAllEntities().find((e) => e.id === target.id);
  assert(Math.abs(extended.b.y - 10) < 1e-9, `extended to y=10: ${extended.b.y}`);
  assert(cad.undo() === true, "extend undo");
  const restored = cad.getAllEntities().find((e) => e.id === target.id);
  assert(restored.a.x === 2 && restored.a.y === 0 && restored.b.y === 4, "exact before endpoints");
});

t("FILLET is ONE compound command: single undo removes arc AND restores both endpoints", () => {
  const cad = new CadEngine();
  const l1 = cad.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const l2 = cad.addLine({ x: 0, y: 0 }, { x: 0, y: 10 });
  const before = cad.getCount();
  assert(cad.filletAt({ x: 2, y: 0 }, { x: 0, y: 2 }, 3) === true, "fillet applied");
  const after = cad.getAllEntities();
  assert(after.length === before + 1, "tangent arc inserted");
  assert(after.some((e) => e.kind === "arc"), "arc exists");
  assert(cad.undo() === true, "ONE undo for the whole fillet");
  const reverted = cad.getAllEntities();
  assert(reverted.length === before, "arc removed by the same single undo");
  const r1 = reverted.find((e) => e.id === l1.id);
  const r2 = reverted.find((e) => e.id === l2.id);
  assert(r1.a.x === 0 && r1.b.x === 10 && r1.a.y === 0, "line 1 endpoints exact");
  assert(r2.a.y === 0 && r2.b.y === 10 && r2.a.x === 0, "line 2 endpoints exact");
  assert(cad.redo() === true, "fillet redo");
  assert(cad.getAllEntities().length === before + 1, "arc back");
});

t("cad-engine undo-all/redo-all across mixed add/delete/modify ops", () => {
  const cad = new CadEngine();
  cad.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
  const b = cad.addLine({ x: 0, y: 5 }, { x: 10, y: 5 });
  cad.deleteById(b.id);
  cad.addCircle({ x: 3, y: 3 }, 6);
  cad.trimAt({ x: 15, y: 0 }, { x: 9, y: 0 }); // trim first line's right side? click beyond hit → removes end side
  let guard = 0;
  while (cad.canUndo() && guard++ < 10) cad.undo();
  assert(cad.getCount() === 0, `undo-all empties the drawing (count ${cad.getCount()})`);
  guard = 0;
  while (cad.canRedo() && guard++ < 10) cad.redo();
  assert(cad.getCount() === 2, `redo-all restores every step (count ${cad.getCount()})`);
  assert(cad.getAllEntities().some((e) => e.kind === "circle"), "adds replayed");
});

t("cad-engine depth bound + clear() wipes history", () => {
  const cad = new CadEngine();
  for (let i = 0; i < 105; i++) cad.addLine({ x: i, y: 0 }, { x: i + 1, y: 0 });
  let guard = 0;
  while (cad.canUndo() && guard++ < 200) cad.undo();
  assert(guard === 100, `bounded to 100 entries (undone ${guard})`);
  cad.addLine({ x: 0, y: 1 }, { x: 1, y: 1 });
  cad.clear();
  assert(cad.getCount() === 0 && !cad.canUndo() && !cad.canRedo(), "clear wipes entities + both stacks");
});

// ═══ 7. Shared EntityUndoStack (core) ═══════════════════════════════════

console.log("── core/undo-stack shared algorithm ──");

t("EntityUndoStack: delete-undo preserves index; compound units are atomic", () => {
  const list = [lineEl("a", 0, 0, 1, 1), lineEl("b", 2, 0, 3, 1), lineEl("c", 4, 0, 5, 1)];
  const h = new EntityUndoStack(list, { maxDepth: 10 });
  list.splice(1, 1);
  h.record("Erase b", { kind: "delete", entity: lineEl("b", 2, 0, 3, 1), index: 1 });
  h.record("Move c", { kind: "modify", id: "c", before: lineEl("c", 4, 0, 5, 1), after: lineEl("c", 40, 0, 50, 1) });
  list[1] = lineEl("c", 40, 0, 50, 1); // apply the after-state like a real tool
  const d = lineEl("d", 9, 9, 9.5, 9.5);
  list.push(d);
  h.record("Add d", { kind: "add", entity: d });
  assert(h.undoLabel() === "Add d", "labels tracked");
  assert(h.undo() === true, "undo add");
  assert(list.length === 2 && list[1].id === "c", "add inverse removes");
  assert(h.undo() === true, "undo modify");
  assert(list[1].a.x === 4, "modify inverse restores before payload");
  assert(h.undo() === true, "undo delete");
  assert(list.map((e) => e.id).join(",") === "a,b,c", `delete inverse re-inserts at index: ${list.map((e) => e.id).join(",")}`);
  assert(h.redoLabel() === "Erase b", "redo label tracks");
  assert(h.redo() === true && list.map((e) => e.id).join(",") === "a,c", "delete redo removes again");
  h.clear();
  assert(!h.canUndo() && !h.canRedo(), "clear wipes both directions");
});

t("EntityUndoStack: snapshots are isolated — later mutation of live entities cannot corrupt history", () => {
  const list = [lineEl("a", 0, 0, 1, 1)];
  const h = new EntityUndoStack(list);
  const ent = lineEl("a", 0, 0, 1, 1);
  list[0] = ent;
  h.record("modify", { kind: "modify", id: "a", before: lineEl("a", 0, 0, 1, 1), after: ent });
  ent.a = { x: 999, y: 999 }; // mutate the live object after recording
  assert(h.undo() === true, "undo");
  assert(list[0].a.x === 0, "history snapshot was isolated from the live mutation");
});

// ═══ 8. Source-level wiring pins (single owner / dirty / no duplicates) ══

console.log("── source wiring pins ──");

const readSrc = (...p) => fs.readFileSync(path.join(root, ...p), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

t("global-undo stands down while the CAD drawing editor owns the keyboard", () => {
  const g = stripComments(readSrc("src", "features", "global-undo.ts"));
  assert(g.includes("isCadHotkeyOwnerActive()"), "ownership guard required");
  assert(g.includes("addEventListener(\"keydown\", onKeyDown, true)"), "capture-phase owner pinned by boot test");
  assert(g.indexOf("isCadHotkeyOwnerActive()") < g.indexOf("key === \"z\""), "guard must run before any key handling");
});

t("undo/redo marks the project dirty so post-undo state is persisted (persistence-safe)", () => {
  const p = stripComments(readSrc("src", "modules", "projects", "persistence.ts"));
  assert(p.includes("\"obs-history\""), "persistence listens for undo/redo completion");
  assert(p.includes("markDirty()"), "and marks the document dirty");
});

t("no duplicated history systems: production has exactly one TransactionService surface", () => {
  const engineUi = stripComments(readSrc("src", "features", "engine-ui.ts"));
  assert(engineUi.includes("getTransactionService()"), "engine-ui uses the canonical singleton");
  assert(!engineUi.includes("new TransactionService()"), "no second production instance over the model");
  const srcDir = path.join(root, "src");
  const txnDir = path.join(root, "src", "modules", "transaction");
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) { if (full !== txnDir) walk(full); continue; }
      if (!f.name.endsWith(".ts")) continue;
      const s = stripComments(fs.readFileSync(full, "utf8"));
      if (s.includes("new TransactionService(")) offenders.push(path.relative(root, full));
    }
  };
  walk(srcDir);
  assert(offenders.length === 0, `no direct construction outside modules/transaction: ${offenders.join(", ")}`);
});

t("auto-repairs are never untracked: mep-joint-healer records every change it makes", () => {
  const h = stripComments(readSrc("src", "features", "mep-joint-healer.ts"));
  assert(!h.includes("history.depth().undo > 0"), "conditional push gate removed");
  assert(h.includes("isTransitioning()"), "transition guard present (never mutate during swap)");
  assert(h.includes("history.push({"), "healer records its deterministic command");
});

t("make-native-twin offers real redo (no no-op apply)", () => {
  const r = stripComments(readSrc("src", "features", "rvt-view.ts"));
  assert(!r.includes("redo is not offered"), "no-op redo removed");
  assert(r.includes("addNativeGeometryElement(twinInput)"), "redo re-runs the deterministic creation");
});

t("property palette edits are deterministic commands (family type + family params)", () => {
  const p = stripComments(readSrc("src", "features", "property-palette.ts"));
  assert(p.includes("import { history } from \"./history\""), "single history import path");
  assert(p.includes("Family type ·"), "type swap is a recorded command");
  assert(p.includes("Family param "), "family parameter edit is a recorded command");
});

t("entity surfaces share one undo algorithm (no per-module clones)", () => {
  assert(fs.existsSync(path.join(root, "src", "core", "undo-stack.ts")), "shared core exists");
  const cad = stripComments(readSrc("src", "modules", "cad", "cad-engine.ts"));
  const d2d = stripComments(readSrc("src", "features", "drafting-2d.ts"));
  assert(cad.includes("EntityUndoStack"), "cad-engine uses the shared stack");
  assert(d2d.includes("EntityUndoStack"), "drafting-2d uses the shared stack");
  assert(!cad.includes("redoStack"), "cad-engine has no private stack clone left");
  assert(!d2d.includes("redoStack"), "drafting-2d has no private stack clone left");
});

// ── Sequential runner (shared history singleton — no concurrency) ───────
(async () => {
  for (const { name, fn } of testQueue) {
    try { await fn(); console.log(`  PASS ${name}`); pass++; }
    catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
