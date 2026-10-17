const assert = require("assert");
const path = require("path");
const dir = process.env.OUT_DIR || "";
const root = path.join(dir, "..", "..");
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

/* ---- browser-ish globals + minimal three.js ---- */
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
const toasts = [];
global.window = { dispatchEvent(e) { if (e.detail && e.detail.message) toasts.push(e.detail); }, addEventListener() {} };
global.document = {};
const Module = require("module");
const origLoad = Module._load;
class Obj { constructor() { this.children = []; this.userData = {}; } add(...o) { this.children.push(...o); return this; } }
const fakeThree = {
  Group: class extends Obj {}, Mesh: class extends Obj { constructor(g, m) { super(); this.geometry = g; this.material = m; } },
  BufferGeometry: class { setAttribute(n, a) { this[n] = a; } computeVertexNormals() {} dispose() {} },
  Float32BufferAttribute: class { constructor(a, s) { this.array = a; this.itemSize = s; } },
  MeshLambertMaterial: class { constructor(o) { Object.assign(this, o); } dispose() {} }, Color: class { constructor(c) { this.c = c; } },
  DoubleSide: 2,
};
Module._load = function (request, ...rest) { return request === "three" ? fakeThree : origLoad.call(this, request, ...rest); };

/* ---- fake history (runs apply immediately, keeps an undo stack) ---- */
const undo = [];
require.cache[require.resolve(path.join(root, "features/history.js"))] = { id: "h", filename: "h", loaded: true, exports: { history: { async exec(cmd) { await cmd.apply(); undo.push(cmd); } } } };

const { ctx } = require(path.join(root, "core/context.js"));
const { roomsStore } = require(path.join(root, "modules/rooms/rooms.js"));
const geo = require(path.join(dir, "m2-geometry.js"));
const tools = require(path.join(dir, "m2-tools.js"));
const reg = require(path.join(dir, "m2-register.js"));
const { SCHEMAS } = require(path.join(root, "features/property-schema.js"));

/* ---- fake authoring ---- */
const elements = []; let rebuilds = 0; let selected = []; const toolCalls = [];
const api = {
  getElements: () => elements, rebuildAuthored: () => { rebuilds++; }, setSelectedAuthored: (ids) => { selected = ids; },
  getLevels: () => [{ id: "L0", name: "Ground", elevation: 0 }, { id: "L1", name: "First", elevation: 3.4 }],
  getActiveLevelId: () => "L0", setAuthoringTool: (tool) => { toolCalls.push(tool); }, onAuthoringChange: () => () => {}, getActiveTool: () => "select",
};
ctx.features = { authoring: api };

(async () => {
  await t("snapPoint: snaps to existing end points, else the 5 cm grid, Shift = orthogonal", () => {
    const anchors = [[10, 10], [3, 0]];
    assert.deepStrictEqual(tools.snapPoint([10.12, 9.9], anchors, null, false), [10, 10]);
    const g = tools.snapPoint([1.234, 2.678], anchors, null, false); near(g[0], 1.25); near(g[1], 2.7);
    assert.deepStrictEqual(tools.snapPoint([5.02, 1.4], [], [0, 0], true).map((v) => Math.round(v * 100) / 100), [5, 0]);
    assert.deepStrictEqual(tools.snapPoint([0.4, 5.0], [], [0, 0], true).map((v) => Math.round(v * 100) / 100), [0, 5]);
  });
  await t("defaults: stairs rise = next level - active level; every default element yields valid geometry", () => {
    const lv = { id: "L0", elevation: 0, above: 3.4 };
    const cases = [
      ["stairs", [[0, 0], [5, 0]]], ["ramp", [[0, 0], [6, 0]]], ["curtain-wall", [[0, 0], [6, 0]]],
      ["railing", [[0, 0], [4, 0], [4, 3]]], ["roof", [[0, 0], [10, 0], [10, 6], [0, 6]]], ["ceiling", [[0, 0], [4, 0], [4, 3], [0, 3]]],
    ];
    for (const [kind, pts] of cases) {
      const d = tools.defaultsFor(kind, pts, lv, "straight");
      const g = geo.buildElementGeo({ type: kind, params: d.params, properties: d.properties });
      assert.ok(g && g.parts.length && g.parts[0].positions.length > 9, kind + " produced no geometry");
    }
    near(tools.defaultsFor("stairs", [[0, 0], [5, 0]], lv, "L").params.height, 3.4);
    assert.strictEqual(tools.defaultsFor("stairs", [[0, 0], [5, 0]], lv, "U").properties.stairShape, "U");
    near(tools.defaultsFor("roof", [[0, 0], [10, 0], [10, 6], [0, 6]], lv, "straight").params.elevation, 3.4);
    assert.strictEqual(tools.defaultsFor("roof", [[0, 0], [10, 0], [10, 6], [0, 6]], lv, "straight").properties.slopeDirection, 90); // ridge along the long side
    assert.strictEqual(tools.defaultsFor("roof", [[0, 0], [4, 0], [4, 9], [0, 9]], lv, "straight").properties.slopeDirection, 0);
    near(tools.defaultsFor("stairs", [[0, 0], [5, 0]], { id: null, elevation: 0, above: null }, "straight").params.height, 3);
  });
  await t("createM2Element: adds an authored element on the active level, selects it, one undo step reverts it", async () => {
    const before = rebuilds;
    const el = tools.createM2Element("stairs", [[0, 0], [5, 0]], { shape: "L" });
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(el && elements.includes(el)); assert.strictEqual(el.levelId, "L0"); assert.strictEqual(el.type, "stairs");
    assert.strictEqual(el.name, "Stair 1"); assert.deepStrictEqual(selected, [el.id]); assert.ok(rebuilds > before);
    near(el.params.height, 3.4); assert.strictEqual(el.properties.stairShape, "L");
    assert.strictEqual(undo.length, 1); undo[0].revert();
    assert.ok(!elements.includes(el));
    undo[0].apply(); assert.ok(elements.includes(el));
    assert.strictEqual(tools.createM2Element("stairs", [[0, 0], [5, 0]]).name, "Stair 2");
  });
  await t("ceilings from rooms: one per room at level + room height, none for rooms that already have one", async () => {
    roomsStore.boot();
    const r1 = roomsStore.createRoom({ boundary: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], levelId: "L0" });
    const r2 = roomsStore.createRoom({ boundary: [{ x: 6, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 3 }, { x: 6, z: 3 }], levelId: "L0" });
    roomsStore.createRoom({ boundary: [{ x: 0, z: 10 }, { x: 4, z: 10 }, { x: 4, z: 13 }, { x: 0, z: 13 }], levelId: "L1" }); // other level
    assert.strictEqual(tools.ceilingsFromRooms(), 2);
    await new Promise((r) => setTimeout(r, 5));
    const cs = elements.filter((e) => e.type === "ceiling");
    assert.strictEqual(cs.length, 2);
    for (const c of cs) { near(c.params.elevation, r1.height || 2.7); assert.strictEqual(c.levelId, "L0"); assert.ok(geo.buildElementGeo(c).parts[0].positions.length > 9); }
    assert.strictEqual(tools.ceilingsFromRooms(), 0);
    assert.ok(r2.id !== r1.id);
  });
  await t("register: palette schemas for the six types, mesh builders and the quantity provider", () => {
    const out = reg.setupM2Register();
    assert.ok(out.ok);
    for (const k of ["stairs", "railing", "ramp", "curtain-wall", "roof", "ceiling"]) {
      assert.ok(SCHEMAS[k] && SCHEMAS[k].fields.length >= 5, k + " schema");
      assert.ok(typeof window.__obsMeshBuilders[k] === "function", k + " builder");
      const keys = SCHEMAS[k].fields.map((f) => f.target + ":" + f.key);
      assert.ok(new Set(keys).size === keys.length, "duplicate field keys in " + k);
    }
    assert.ok(SCHEMAS.stairs.fields.some((f) => f.key === "stairShape" && f.options.length === 3));
    const q = window.__obsM2Quantities({ type: "curtain-wall", params: { height: 3.6, thickness: 0.1, elevation: 0, start: [0, 0], end: [6, 0] } });
    near(q.area, 21.6);
    assert.strictEqual(window.__obsM2Quantities({ type: "wall", params: {} }), null);
  });
  await t("mesh builder: one mesh per part (frame + glazing), tagged with the element id, glass transparent; bad params give null instead of throwing", () => {
    const g = reg.buildM2Mesh({ id: "c1", type: "curtain-wall", params: { height: 3.6, thickness: 0.1, elevation: 0, start: [0, 0], end: [6, 0] } });
    assert.strictEqual(g.children.length, 2);
    assert.ok(g.children.every((m) => m.userData.elementId === "c1" && typeof m.userData.baseColor === "string"));
    assert.strictEqual(g.children[1].material.transparent, true); assert.strictEqual(g.children[0].material.transparent, false);
    assert.strictEqual(reg.buildM2Mesh({ id: "bad", type: "stairs", params: { height: 3, thickness: 0.1, elevation: 0, start: [0, 0], end: [0.05, 0] } }), null);
    assert.strictEqual(reg.buildM2Mesh({ id: "x", type: "stairs", params: { height: 3, thickness: 0.1, elevation: 0 } }), null);
    assert.strictEqual(reg.buildM2Mesh({ id: "r", type: "roof", params: { height: 0.2, thickness: 0.2, elevation: 3, polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] } }).children[0].material.side, 2);
  });
  await t("redirects: ST/RA/CW/RF/CL tool names start the M2 tools, every other tool passes through untouched", () => {
    tools.installM2Redirects();
    toolCalls.length = 0;
    toasts.length = 0;
    api.setAuthoringTool("wall"); api.setAuthoringTool("select");
    assert.deepStrictEqual(toolCalls, ["wall", "select"]);
    toolCalls.length = 0;
    api.setAuthoringTool("stairs");                       // no 3D view in this harness -> warns, but must NOT reach the legacy "equipment" alias
    assert.ok(!toolCalls.includes("stairs"));
    assert.ok(toasts.some((x) => /3D view not ready/.test(x.message)));
    assert.strictEqual(typeof window.__obsM2.start, "function");
  });
  console.log(`${passed} passed`);
})();
