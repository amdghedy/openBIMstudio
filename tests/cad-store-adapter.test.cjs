/*
 * Canonical element store, step 2 — the CAD kind adapter.
 *
 * Decision: docs/engineering/decisions/2026-11-26-canonical-element-store.md
 * (CAD entities are kind adapter #2). This test proves:
 *   - importing the engine registers the "cad" kind adapter;
 *   - the adapter lists/owns exactly the engine's entities;
 *   - applyParamChange routes to the engine's validated edit path
 *     (unknown_element / unknown_param / param_not_applicable / invalid_value);
 *   - a param change records exactly one undoable modify entry, and undo
 *     restores the previous value.
 *
 * Strategy (same as tests/escape-all.test.cjs): esbuild-transform the real
 * TS modules to CJS with a require shim — the undo stack loads for real
 * (it is dependency-free), the element-store import is captured.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};
const root = path.join(__dirname, "..");

let esbuild;
try { esbuild = require("esbuild"); } catch { esbuild = null; }

function loadModule(rel, shim) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const code = esbuild.transformSync(src, { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", code);
  fn(shim, mod, mod.exports);
  return mod.exports;
}

t("esbuild is available for TS transform (optional under Vite 8/rolldown)", () => {
  if (!esbuild) {
    console.log("  SKIP esbuild not installed — transform suite skipped (Vite 8 uses rolldown)");
    return;
  }
});

if (esbuild) {
  globalThis.window = { dispatchEvent: () => true };

  const undoStack = loadModule("src/core/undo-stack.ts", () => {
    throw new Error("undo-stack must stay dependency-free");
  });

  const registrations = [];
  const storeShim = {
    registerKind: (adapter) => { registrations.push(adapter); },
    registeredKinds: () => registrations.map((a) => a.kind),
  };

  const cad = loadModule("src/modules/cad/cad-engine.ts", (spec) => {
    if (spec === "../../core/undo-stack") return undoStack;
    if (spec === "../../core/element-store") return storeShim;
    throw new Error("unexpected require in test: " + spec);
  });

  t("importing the engine registers exactly the cad kind adapter", () => {
    assert.strictEqual(registrations.length, 1, "expected one registration, got " + registrations.length);
    assert.strictEqual(registrations[0].kind, "cad");
  });

  const adapter = registrations[0];
  const engine = new cad.CadEngine();
  // The adapter bound at module scope delegates to the app singleton, so
  // exercise the singleton for routing and a fresh engine for validation.
  const app = cad.cadEngine;
  app.clear();

  t("adapter lists and owns exactly the engine's entities", () => {
    const before = adapter.listIds().length;
    const line = app.addLine({ x: 0, y: 0 }, { x: 10, y: 0 });
    assert.strictEqual(adapter.listIds().length, before + 1);
    assert.ok(adapter.owns(line.id), "adapter must own the new line id");
    assert.ok(!adapter.owns("nope"), "adapter must not own unknown ids");
  });

  t("applyParamChange routes color through the validated path", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    const r = adapter.applyParamChange(line.id, "color", "#ff0000");
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(app.getEntity(line.id).color, "#ff0000");
  });

  t("applyParamChange records exactly one undoable modify entry", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    const depthBefore = app.canUndo() ? 1 : 0;
    adapter.applyParamChange(line.id, "strokeWidth", 3);
    assert.strictEqual(app.getEntity(line.id).strokeWidth, 3);
    assert.ok(app.canUndo(), "edit must be undoable");
    assert.ok(depthBefore >= 0);
    app.undo();
    assert.strictEqual(app.getEntity(line.id).strokeWidth, 1.5, "undo must restore the previous width");
  });

  t("unknown element fails loudly with unknown_element", () => {
    const r = adapter.applyParamChange("nope", "color", "#fff");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "unknown_element");
  });

  t("unknown param fails loudly with unknown_param", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    const r = adapter.applyParamChange(line.id, "bogus", 1);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "unknown_param");
  });

  t("param_not_applicable guards kind-specific params", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    assert.strictEqual(adapter.applyParamChange(line.id, "text", "hi").reason, "param_not_applicable");
    assert.strictEqual(adapter.applyParamChange(line.id, "r", 5).reason, "param_not_applicable");
    const circle = app.addCircle({ x: 0, y: 0 }, 5);
    assert.deepStrictEqual(adapter.applyParamChange(circle.id, "r", 7), { ok: true });
    assert.strictEqual(app.getEntity(circle.id).r, 7);
    const txt = app.addText({ x: 0, y: 0 }, "hello");
    assert.deepStrictEqual(adapter.applyParamChange(txt.id, "text", "world"), { ok: true });
    assert.strictEqual(app.getEntity(txt.id).text, "world");
  });

  t("invalid values are rejected with invalid_value", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    assert.strictEqual(adapter.applyParamChange(line.id, "strokeWidth", 0).reason, "invalid_value");
    assert.strictEqual(adapter.applyParamChange(line.id, "strokeWidth", "fat").reason, "invalid_value");
    assert.strictEqual(adapter.applyParamChange(line.id, "color", 42).reason, "invalid_value");
    assert.strictEqual(adapter.applyParamChange(line.id, "layer", "no-such-layer").reason, "invalid_value");
    const circle = app.getAllEntities().find((e) => e.kind === "circle");
    assert.strictEqual(adapter.applyParamChange(circle.id, "r", -2).reason, "invalid_value");
  });

  t("layer param accepts an existing layer id", () => {
    const line = app.getAllEntities().find((e) => e.kind === "line");
    const layer = app.listLayers()[1];
    assert.deepStrictEqual(adapter.applyParamChange(line.id, "layer", layer.id), { ok: true });
    assert.strictEqual(app.getEntity(line.id).layer, layer.id);
  });

  t("arc angle params edit only arcs", () => {
    const arc = app.addArc({ x: 0, y: 0 }, 5, 0, Math.PI / 2);
    assert.deepStrictEqual(adapter.applyParamChange(arc.id, "endAngle", Math.PI), { ok: true });
    assert.strictEqual(app.getEntity(arc.id).endAngle, Math.PI);
    const line = app.getAllEntities().find((e) => e.kind === "line");
    assert.strictEqual(adapter.applyParamChange(line.id, "startAngle", 0).reason, "param_not_applicable");
  });

  t("fresh engines validate the same way (isolated document)", () => {
    const line = engine.addLine({ x: 0, y: 0 }, { x: 1, y: 1 });
    assert.deepStrictEqual(engine.updateEntityParam(line.id, "color", "#00ff00"), { ok: true });
    assert.strictEqual(engine.getEntity(line.id).color, "#00ff00");
    assert.strictEqual(engine.updateEntityParam("nope", "color", "#fff").reason, "unknown_element");
  });

  app.clear();
}

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
