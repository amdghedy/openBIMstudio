/*
 * multi-move Copy regression test (AutoCAD parity A2).
 *
 * The options-bar Copy button starts multi-move in copy mode, but the
 * copyMode branch in multi-move.ts was an empty stub: the commit fell
 * through to translateSelected(), so Copy MOVED the original instead of
 * copying it — a data-loss bug that reported success.
 *
 * Strategy (same as escape-all.test.cjs): esbuild-transform the real
 * multi-move.ts to CJS and instantiate it with a require shim. THREE and
 * the authoring primitives are stubbed, but the authoring stubs keep the
 * REAL semantics (translateSelected moves in place; duplicateSelected
 * clones with the offset applied), so the test proves the wiring decision
 * inside multi-move, not the stubs: without the fix, copy mode moves the
 * originals and creates nothing; with the fix, the originals stay put and
 * copies land at the target.
 *
 * Screen -> world map in the Raycaster stub is linear: client (400,300)
 * on an 800x600 canvas is world (0,0,0); each +100px in x is +2.5 world
 * units in x. Tests assert on the resulting deltas, not on pixels.
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

/* ---- THREE stubs: only the surface multi-move.ts touches ---- */
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new Vector3(this.x, this.y, this.z); }
}
class Vector2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  set(x, y) { this.x = x; this.y = y; return this; }
  clone() { return new Vector2(this.x, this.y); }
}
class Box3 {
  constructor() {
    this.min = new Vector3(Infinity, Infinity, Infinity);
    this.max = new Vector3(-Infinity, -Infinity, -Infinity);
  }
  isEmpty() { return this.max.x < this.min.x; }
  setFromObject(obj) {
    const b = obj.__bounds;
    this.min.set(b.min[0], b.min[1], b.min[2]);
    this.max.set(b.max[0], b.max[1], b.max[2]);
    return this;
  }
  union(box) {
    this.min.set(Math.min(this.min.x, box.min.x), Math.min(this.min.y, box.min.y), Math.min(this.min.z, box.min.z));
    this.max.set(Math.max(this.max.x, box.max.x), Math.max(this.max.y, box.max.y), Math.max(this.max.z, box.max.z));
    return this;
  }
  getCenter(t) { return t.set((this.min.x + this.max.x) / 2, (this.min.y + this.max.y) / 2, (this.min.z + this.max.z) / 2); }
  getSize(t) { return t.set(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); }
  clone() { const b = new Box3(); b.min = this.min.clone(); b.max = this.max.clone(); return b; }
}
class Box3Helper {
  constructor(box) { this.box = box; this.material = {}; this.position = new Vector3(); this.renderOrder = 0; }
}
class Line {
  constructor(geometry, material) { this.geometry = geometry; this.material = material; this.position = new Vector3(); this.renderOrder = 0; }
  computeLineDistances() {}
}
class BufferGeometry {
  constructor() { this.attributes = { position: { setXYZ() {}, needsUpdate: false } }; }
  setFromPoints() { return this; }
  dispose() {}
}
class LineDashedMaterial { constructor(o = {}) { Object.assign(this, o); } dispose() {} }
class LineBasicMaterial { constructor(o = {}) { Object.assign(this, o); } dispose() {} }
class Plane { constructor() {} }
class Raycaster {
  setFromCamera(ndc) { this._ndc = ndc; }
  get ray() {
    const ndc = this._ndc;
    return {
      intersectPlane(_plane, target) {
        target.set(ndc.x * 10, 0, -ndc.y * 10);
        return target;
      },
    };
  }
}
const threeStub = {
  Vector2, Vector3, Box3, Box3Helper, Line, BufferGeometry,
  LineDashedMaterial, LineBasicMaterial, Plane, Raycaster,
};

/* ---- fake DOM: canvas + window ---- */
function makeCanvas() {
  const listeners = {};
  return {
    listeners,
    style: {},
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type] || []; const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    pointerdown(ev) { (listeners.pointerdown || []).forEach((h) => h(ev)); },
    pointermove(ev) { (listeners.pointermove || []).forEach((h) => h(ev)); },
  };
}
function makeWindow() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type] || []; const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    },
    keydown(ev) { (listeners.keydown || []).forEach((h) => h(ev)); },
    keyup(ev) { (listeners.keyup || []).forEach((h) => h(ev)); },
  };
}
function pointerEvent(x, y) {
  return { button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {} };
}
function keyEvent(key) {
  return { key, preventDefault() {} };
}

/* ---- fake authoring store, with the REAL primitive semantics ---- */
function makeAuthoring(selected = ["w1"]) {
  const elements = [{ id: "w1", params: { start: [-4, 0], end: [4, 0] } }];
  let selectedIds = [...selected];
  const calls = { translate: [], duplicate: [] };
  return {
    elements, calls,
    getElements() { return elements; },
    getSelectedIds() { return [...selectedIds]; },
    setSelectedIds(ids) { selectedIds = [...ids]; },
    rebuild() {},
    translateSelected(dx, dz) {
      calls.translate.push([dx, dz]);
      let n = 0;
      for (const id of selectedIds) {
        const el = elements.find((e) => String(e.id) === id);
        if (!el) continue;
        const p = el.params;
        if (p.start) p.start = [p.start[0] + dx, p.start[1] + dz];
        if (p.end) p.end = [p.end[0] + dx, p.end[1] + dz];
        if (p.point) p.point = [p.point[0] + dx, p.point[1] + dz];
        if (p.polygon) p.polygon = p.polygon.map(([x, z]) => [x + dx, z + dz]);
        n++;
      }
      return n;
    },
    duplicateSelected(dx, dz) {
      calls.duplicate.push([dx, dz]);
      const newIds = [];
      for (const id of selectedIds) {
        const el = elements.find((e) => String(e.id) === id);
        if (!el) continue;
        const p = { ...el.params };
        if (p.start) p.start = [p.start[0] + dx, p.start[1] + dz];
        if (p.end) p.end = [p.end[0] + dx, p.end[1] + dz];
        if (p.point) p.point = [p.point[0] + dx, p.point[1] + dz];
        if (p.polygon) p.polygon = p.polygon.map(([x, z]) => [x + dx, z + dz]);
        const nid = `copy-${newIds.length + 1}`;
        elements.push({ ...el, id: nid, params: p });
        newIds.push(nid);
      }
      return newIds;
    },
    getActiveTool() { return null; },
    onAuthoringChange() {},
  };
}

/* ---- module loader: TS -> CJS via esbuild, imports via shim ---- */
let esbuild;
try { esbuild = require("esbuild"); } catch { esbuild = null; }

function loadMultiMove(opts = {}) {
  const canvas = makeCanvas();
  const win = makeWindow();
  globalThis.window = win;
  const authoring = makeAuthoring(opts.selected);
  const routerSubs = [];
  const inputRouterStub = {
    subscribe(fn, priority) {
      const sub = { fn, priority, unsubscribed: false };
      routerSubs.push(sub);
      return () => { sub.unsubscribed = true; };
    },
  };
  const sceneObjects = [
    { userData: { elementId: "w1" }, __bounds: { min: [-4, 0, 0], max: [4, 0, 0] } },
  ];
  const scene = {
    traverse(cb) { sceneObjects.forEach(cb); },
    add() {}, remove() {},
  };
  const ctx = {
    world: { renderer: { domElement: canvas }, scene, camera: {} },
    features: { authoring },
  };
  const shim = (spec) => {
    if (spec === "three") return threeStub;
    if (spec === "../core/context") return { ctx };
    if (spec === "./authoring") return authoring;
    if (spec === "../core/input-router") return { inputRouter: inputRouterStub };
    throw new Error("unexpected require in test: " + spec);
  };
  const src = fs.readFileSync(path.join(root, "src/features/multi-move.ts"), "utf8");
  const code = esbuild.transformSync(src, { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", "globalThis_ref", code);
  fn(shim, mod, mod.exports, globalThis);
  return { mm: mod.exports, canvas, win, authoring, routerSubs };
}

/* ---- tests ---- */
t("esbuild is available for TS transform", () => {
  assert.ok(esbuild, "esbuild is required to transform multi-move.ts");
});

if (esbuild) {
  t("copy mode leaves the original in place and drops a copy at the target (A2)", () => {
    const { mm, canvas, authoring } = loadMultiMove();
    mm.startMultiMove(true);
    canvas.pointerdown(pointerEvent(400, 300)); // base: world (0, 0)
    canvas.pointerdown(pointerEvent(500, 300)); // target: world (2.5, 0)
    assert.deepStrictEqual(authoring.calls.duplicate, [[2.5, 0]], "duplicateSelected must run once with the displacement");
    assert.deepStrictEqual(authoring.calls.translate, [], "translateSelected must NOT run in copy mode");
    assert.strictEqual(authoring.elements.length, 2, "one copy must exist next to the original");
    assert.deepStrictEqual(authoring.elements[0].params, { start: [-4, 0], end: [4, 0] }, "original must not move");
    assert.deepStrictEqual(authoring.elements[1].params, { start: [-1.5, 0], end: [6.5, 0] }, "copy must land at the target");
    assert.deepStrictEqual(authoring.getSelectedIds(), ["w1"], "originals stay selected for repeated placement");
    mm.cancel();
  });

  t("copy mode places a second copy of the originals, not a copy of the copy", () => {
    const { mm, canvas, authoring } = loadMultiMove();
    mm.startMultiMove(true);
    canvas.pointerdown(pointerEvent(400, 300));
    canvas.pointerdown(pointerEvent(500, 300)); // copy 1 at +2.5
    canvas.pointerdown(pointerEvent(400, 300));
    canvas.pointerdown(pointerEvent(600, 300)); // copy 2 at +5
    assert.strictEqual(authoring.elements.length, 3, "two copies plus the original");
    assert.deepStrictEqual(authoring.elements[0].params, { start: [-4, 0], end: [4, 0] }, "original still unmoved");
    assert.deepStrictEqual(authoring.elements[1].params, { start: [-1.5, 0], end: [6.5, 0] });
    assert.deepStrictEqual(authoring.elements[2].params, { start: [1, 0], end: [9, 0] });
    assert.strictEqual(authoring.calls.translate.length, 0, "no move ever happens in copy mode");
    mm.cancel();
  });

  t("move mode still moves the original and creates nothing", () => {
    const { mm, canvas, authoring } = loadMultiMove();
    mm.startMultiMove(false);
    canvas.pointerdown(pointerEvent(400, 300));
    canvas.pointerdown(pointerEvent(500, 300));
    assert.deepStrictEqual(authoring.calls.translate, [[2.5, 0]], "translateSelected must run once in move mode");
    assert.deepStrictEqual(authoring.calls.duplicate, [], "duplicateSelected must NOT run in move mode");
    assert.strictEqual(authoring.elements.length, 1, "move creates no copy");
    assert.deepStrictEqual(authoring.elements[0].params, { start: [-1.5, 0], end: [6.5, 0] }, "original moves to the target");
    mm.cancel();
  });

  t("Escape during a copy preview cancels cleanly without touching the original", () => {
    const { mm, canvas, win, authoring } = loadMultiMove();
    mm.startMultiMove(true);
    canvas.pointerdown(pointerEvent(400, 300)); // base picked, previewing
    assert.strictEqual(mm.isMultiMoveActive(), true, "preview must be active");
    win.keydown(keyEvent("Escape"));
    assert.strictEqual(mm.isMultiMoveActive(), true, "Escape returns to awaiting-base, tool stays active");
    win.keydown(keyEvent("Escape"));
    assert.strictEqual(mm.isMultiMoveActive(), false, "second Escape cancels the tool");
    assert.strictEqual(authoring.elements.length, 1, "no copy was committed");
    assert.deepStrictEqual(authoring.elements[0].params, { start: [-4, 0], end: [4, 0] }, "original untouched");
  });

  t("multi-move claims plain clicks while active so the authoring handler cannot deselect (A2)", () => {
    const { mm, routerSubs } = loadMultiMove();
    mm.startMultiMove(true);
    assert.strictEqual(routerSubs.length, 1, "start must subscribe one router claim");
    assert.strictEqual(routerSubs[0].priority, 50, "claim sits below drag/gizmo handlers, above authoring (10)");
    const claim = routerSubs[0].fn;
    assert.strictEqual(claim({ kind: "click" }), true, "plain clicks belong to multi-move while active");
    assert.strictEqual(claim({ kind: "dblclick" }), true, "double-clicks belong to multi-move while active");
    assert.strictEqual(claim({ kind: "rmb-click" }), false, "right-clicks are not claimed (context menu still works)");
    assert.strictEqual(claim({ kind: "drag-start" }), false, "drags are not claimed (orbit/nav still works)");
    mm.cancel();
    assert.strictEqual(routerSubs[0].unsubscribed, true, "cancel must release the router claim");
    assert.strictEqual(claim({ kind: "click" }), false, "idle multi-move claims nothing");
  });

  t("startMultiMove with nothing selected does not subscribe or activate", () => {
    const { mm, routerSubs } = loadMultiMove({ selected: [] });
    mm.startMultiMove(true);
    assert.strictEqual(mm.isMultiMoveActive(), false, "no selection means no tool");
    assert.strictEqual(routerSubs.length, 0, "no subscription without a live tool");
    mm.cancel();
  });

  t("Escape during a move preview restores the session-start positions (2D-35)", () => {
    const { mm, canvas, win, authoring } = loadMultiMove();
    // The real authoring service has no `elements` property — only
    // getElements(). Drop the stub's property so the test reads the
    // live list the way the app does; on the unfixed tree
    // savePositions reads undefined and restores nothing.
    delete authoring.elements;
    const live = () => authoring.getElements()[0].params;
    mm.startMultiMove(false);
    canvas.pointerdown(pointerEvent(400, 300)); // base: world (0, 0)
    canvas.pointerdown(pointerEvent(500, 300)); // commit move +2.5
    assert.deepStrictEqual(live(), { start: [-1.5, 0], end: [6.5, 0] }, "committed move must land first");
    canvas.pointerdown(pointerEvent(400, 300)); // next base pick, previewing
    win.keydown(keyEvent("Escape")); // revert the session to its start
    assert.strictEqual(mm.isMultiMoveActive(), true, "Escape returns to awaiting-base, tool stays active");
    assert.deepStrictEqual(live(), { start: [-4, 0], end: [4, 0] }, "Escape must restore the saved positions");
    assert.strictEqual(authoring.calls.translate.length, 1, "restore must not re-run translateSelected");
    mm.cancel();
  });

  t("source contract: save/restore read the live list via getElements(), not the .elements property", () => {
    const s = fs.readFileSync(path.join(root, "src/features/multi-move.ts"), "utf8");
    assert.ok(/function getLiveElements\(\)/.test(s), "getLiveElements helper missing");
    assert.ok(/a\?\.getElements/.test(s), "live list must come from authoring.getElements()");
    assert.ok(!/authoring\?\.elements/.test(s), "save/restore must not read the .elements property");
    assert.ok(/savePositions\(\)[\s\S]*getLiveElements\(\)/.test(s), "savePositions must use the live list");
    assert.ok(/restorePositions\(\)[\s\S]*getLiveElements\(\)/.test(s), "restorePositions must use the live list");
  });

  t("source contract: multi-move imports duplicateSelected and calls it in the copyMode branch", () => {
    const s = fs.readFileSync(path.join(root, "src/features/multi-move.ts"), "utf8");
    assert.ok(/import \{[^}]*duplicateSelected[^}]*\} from "\.\/authoring"/.test(s),
      "multi-move.ts must import duplicateSelected from ./authoring");
    assert.ok(/if \(copyMode\) \{[^}]*duplicateSelected\(dx, dz\);/.test(s),
      "copyMode branch must call duplicateSelected(dx, dz)");
    assert.ok(/inputRouter\.subscribe\(claimClicks, 50\)/.test(s),
      "multi-move must claim router clicks at priority 50 while active");
  });
}

console.log("\n" + (fail ? "FAILED" : "ALL OK") + " — " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
