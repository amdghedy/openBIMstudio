/*
 * escape-all regression test (one ESC press cancels ALL active orders).
 *
 * Strategy: esbuild-transform the two real core modules (escape-all.ts,
 * input-router.ts) to CJS and instantiate them with a require shim that
 * stubs their imports (context / camera-gate / feature modules), then drive
 * the real window-capture keydown handler with fake events. Source-contract
 * assertions guard the wiring that plain JS cannot execute (main.ts step
 * order, feature exports the adapters rely on).
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

/* ---- tiny window/keyboard harness ---- */
function makeWindow() {
  const listeners = {};
  const dispatched = [];
  return {
    listeners, dispatched,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type] || []; const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    dispatchEvent(ev) { dispatched.push(ev); return true; },
    keydown(fn) { (listeners.keydown || []).forEach((h) => h(fn)); },
  };
}
function escEvent(over) {
  return Object.assign({
    key: "Escape", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    target: { tagName: "BODY" },
    defaultPrevented: false, propagStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagStopped = true; },
    stopPropagation() { this.propagStopped = true; },
  }, over || {});
}

/* ---- module loader: TS -> CJS via esbuild, imports via shim ---- */
let esbuild;
try { esbuild = require("esbuild"); } catch { esbuild = null; }

function loadModule(rel, shim) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const code = esbuild.transformSync(src, { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", "globalThis_ref", code);
  fn(shim, mod, mod.exports, globalThis);
  return mod.exports;
}

function coreShim(windowStub, over) {
  const map = Object.assign({
    "./input-router": { inputRouter: { cancelAll: () => 0, releaseGesture() {} } },
    "./camera-gate": { forceResumeCameraControls() {} },
    "./context": { ctx: { features: {}, lengthMeasurer: { enabled: false } } },
    "../features/modify-live": { isModifyLiveActive: () => false, modifyLiveEscape: () => false },
    "../features/rotate-tool": { isRotateActive: () => false, cancelRotate: () => false },
    "../features/array-tool": { isArrayActive: () => false, cancelArray: () => false },
    "../features/multi-move": { isMultiMoveActive: () => false, cancelMultiMove: () => false },
    "../features/section-cut-interaction": { cancelSectionCutDrag: () => false },
    "../modules/cad/cad-engine": { cadEngine: { getPolyPoints: () => [], cancelPoly() {} } },
  }, over || {});
  return (spec) => {
    if (map[spec]) return map[spec];
    throw new Error("unexpected require in test: " + spec);
  };
}

/* ---- tests ---- */
t("esbuild is available for TS transform", () => {
  assert.ok(esbuild, "esbuild not found in node_modules");
});

if (esbuild) {
  t("ESC cancels ALL active scopes, not just the first (the headline fix)", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    const calls = [];
    ea.registerEscapeScope({ id: "a", priority: 800, cancel: () => { calls.push("a"); return true; } });
    ea.registerEscapeScope({ id: "b", priority: 600, cancel: () => { calls.push("b"); return true; } });
    const ev = escEvent();
    win.keydown(ev);
    assert.deepStrictEqual(calls.sort(), ["a", "b"], "both scopes must cancel");
    assert.ok(ev.defaultPrevented, "key consumed when something canceled");
    assert.ok(ev.propagStopped, "legacy listeners must not double-handle");
    assert.strictEqual(win.dispatched.length, 1, "obs:operation-cancelled fired once");
  });

  t("higher priority scope cancels first", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    const order = [];
    ea.registerEscapeScope({ id: "low", priority: 100, cancel: () => { order.push("low"); return true; } });
    ea.registerEscapeScope({ id: "high", priority: 900, cancel: () => { order.push("high"); return true; } });
    win.keydown(escEvent());
    assert.deepStrictEqual(order, ["high", "low"]);
  });

  t("ESC with nothing active falls through unconsumed (modals keep working)", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    ea.registerEscapeScope({ id: "idle", cancel: () => false });
    const ev = escEvent();
    win.keydown(ev);
    assert.ok(!ev.defaultPrevented && !ev.propagStopped, "idle ESC must not be consumed");
  });

  t("editable target is skipped (field keeps its own ESC)", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    let called = 0;
    ea.registerEscapeScope({ id: "x", cancel: () => { called++; return true; } });
    win.keydown(escEvent({ target: { tagName: "INPUT" } }));
    win.keydown(escEvent({ target: { tagName: "TEXTAREA" } }));
    win.keydown(escEvent({ target: { isContentEditable: true } }));
    assert.strictEqual(called, 0, "no cancel sweep for editable targets");
  });

  t("modified ESC (ctrl/shift/alt/meta) is skipped", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    let called = 0;
    ea.registerEscapeScope({ id: "x", cancel: () => { called++; return true; } });
    win.keydown(escEvent({ ctrlKey: true }));
    win.keydown(escEvent({ shiftKey: true }));
    win.keydown(escEvent({ metaKey: true }));
    win.keydown(escEvent({ altKey: true }));
    assert.strictEqual(called, 0);
  });

  t("a throwing scope never blocks the others", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    let ok = 0;
    ea.registerEscapeScope({ id: "boom", priority: 900, cancel: () => { throw new Error("boom"); } });
    ea.registerEscapeScope({ id: "fine", priority: 100, cancel: () => { ok++; return true; } });
    win.keydown(escEvent());
    assert.strictEqual(ok, 1, "sweep must continue past the throwing scope");
  });

  t("scopes can unregister; built-in adapter uses window.__obsModifyLive.escape", () => {
    const win = makeWindow();
    globalThis.window = win;
    const ea = loadModule("src/core/escape-all.ts", coreShim(win));
    ea.installEscapeAll();
    let calls = 0;
    const off = ea.registerEscapeScope({ id: "tmp", cancel: () => { calls++; return true; } });
    off();
    win.keydown(escEvent());
    assert.strictEqual(calls, 0);
    // built-in modify-orders adapter via global
    let escaped = 0;
    win.__obsModifyLive = { isActive: () => true, escape: () => { escaped++; return true; } };
    const ev = escEvent();
    win.keydown(ev);
    assert.strictEqual(escaped, 1, "__obsModifyLive.escape must run on ESC");
    assert.ok(ev.defaultPrevented);
  });

  t("input-router.cancelAll runs EVERY handler (unlike first-true Escape path)", () => {
    const win = makeWindow();
    globalThis.window = win;
    const gateCalls = [];
    const shim = coreShim(win, {
      "./camera-gate": { forceResumeCameraControls: () => gateCalls.push("resume") },
    });
    const ir = loadModule("src/core/input-router.ts", shim);
    let a = 0, b = 0;
    ir.inputRouter.registerCancel(() => { a++; return true; });
    ir.inputRouter.registerCancel(() => { b++; return true; });
    const n = ir.inputRouter.cancelAll();
    assert.strictEqual(n, 2, "cancelAll must not stop at the first true");
    assert.strictEqual(a, 1); assert.strictEqual(b, 1);
    assert.strictEqual(typeof ir.inputRouter.releaseGesture, "function");
  });

  t("escape-all sweep releases camera gate + router gesture after canceling", () => {
    const win = makeWindow();
    globalThis.window = win;
    const gateCalls = [];
    const shim = coreShim(win, {
      "./camera-gate": { forceResumeCameraControls: () => gateCalls.push("x") },
    });
    const ea = loadModule("src/core/escape-all.ts", shim);
    ea.installEscapeAll();
    ea.registerEscapeScope({ id: "active", cancel: () => true });
    win.keydown(escEvent());
    assert.deepStrictEqual(gateCalls, ["x"], "camera gate must be released after a sweep");
  });

  t("main.ts installs escape-all BEFORE the input-router step", () => {
    const src = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
    const iEsc = src.indexOf('step("escape-all"');
    const iRouter = src.indexOf('step("input-router"');
    assert.ok(iEsc >= 0, "escape-all step missing in main.ts");
    assert.ok(iRouter > iEsc, "escape-all must be registered before input-router (FIFO capture order)");
  });

  t("feature adapters: the exports escape-all relies on exist", () => {
    const must = [
      ["src/features/rotate-tool.ts", /export function (isRotateActive|cancelRotate)\(/],
      ["src/features/array-tool.ts", /export function (isArrayActive|cancelArray)\(/],
      ["src/features/multi-move.ts", /export function (isMultiMoveActive|cancelMultiMove)\(/],
      ["src/features/section-cut-interaction.ts", /export function cancelSectionCutDrag\(/],
      ["src/features/modify-live.ts", /escape:\s*modifyLiveEscape/],
    ];
    for (const [f, re] of must) {
      const s = fs.readFileSync(path.join(root, f), "utf8");
      assert.ok(re.test(s), f + " is missing export " + re);
    }
  });

  t("built-in scope ids and priorities are present in escape-all.ts", () => {
    const s = fs.readFileSync(path.join(root, "src/core/escape-all.ts"), "utf8");
    for (const id of ["viewport-router", "modify-orders", "rotate-preview", "array-preview",
      "multi-move-preview", "section-cut-drag", "measure-creation", "cad-poly",
      "bim-policy-modes", "ui-transients"]) {
      assert.ok(s.includes('id: "' + id + '"'), "missing scope: " + id);
    }
    assert.ok(/priority:\s*900/.test(s) && /priority:\s*100/.test(s), "priority bands missing");
  });
}

console.log("\n" + (fail ? "FAILED" : "ALL OK") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
