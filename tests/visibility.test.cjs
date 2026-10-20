const assert = require("assert");
const dir = process.env.OUT_DIR || "";            // .../modules/bim-gaps
const root = dir + "/../..";                       // compiled src root
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }

/* ---- browser-ish globals ---- */
const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } };
global.window = { dispatchEvent() {}, addEventListener() {}, setTimeout, clearTimeout, prompt: () => null };
global.document = {};
const tick = () => new Promise((r) => setTimeout(r, 5));

const { ctx } = require(root + "/core/context.js");
const { visibilityFilter } = require(root + "/modules/visibility/visibility-filter.js");
const { designOptionsStore } = require(root + "/modules/design-options/design-options.js");
const vb = require(dir + "/visibility-bridge.js");

/* ---- fake authored scene ---- */
const mesh = (id) => ({ isMesh: true, userData: { elementId: id }, visible: true, material: { opacity: 1, transparent: false, userData: {} } });
const group = { children: [], add(...o) { this.children.push(...o); return this; }, traverse(fn) { this.children.forEach(fn); } };
let elements = [
  { id: "w1", type: "wall", params: {} }, { id: "w2", type: "wall", params: {} }, { id: "s1", type: "slab", params: {} },
];
elements.forEach((e) => group.children.push(mesh(e.id)));
let selected = [];
let authoringListener = null;
ctx.features = {
  authoring: {
    getAuthoredGroup: () => group, getElements: () => elements, getSelectedIds: () => selected,
    getElementById: (id) => elements.find((e) => e.id === id), onAuthoringChange: (cb) => { authoringListener = cb; return () => {}; },
  },
  selection: { snapshot: () => ({ modelA: new Set([5, 6]) }) },
};
/* ---- fake Fragments + Hider ---- */
const calls = [];
ctx.hider = {
  async set(v, map) { calls.push(["set", v, map ? JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(map).map(([k, s]) => [k, [...s]])))) : null]); },
  async isolate(map) { calls.push(["isolate", Object.fromEntries(Object.entries(map).map(([k, s]) => [k, [...s]]))]); },
};
ctx.fragments = {
  core: { update() { calls.push(["update"]); } },
  list: new Map([["modelA", { async getItemsOfCategories(pats) { calls.push(["cats", pats.map(String)]); return { IFCWALL: [10, 11], IFCWALLSTANDARDCASE: [12] }; } }]]),
};
const vis = () => Object.fromEntries(group.children.map((m) => [m.userData.elementId, m.visible]));

(async () => {
  await t("setup installs getSelectedIds on the selection manager (it did not exist)", async () => {
    assert.strictEqual(ctx.features.selection.getSelectedIds, undefined);
    assert.ok(vb.setupVisibilityBridge().ok);
    selected = ["w1"];
    assert.deepStrictEqual(ctx.features.selection.getSelectedIds(), ["w1", "frag:modelA::5", "frag:modelA::6"]);
    assert.deepStrictEqual(vb.parseFragKey("frag:modelA::5"), { modelId: "modelA", localId: 5 });
    selected = [];
  });
  await t("hideElements now hides the authored mesh (before: nothing listened)", async () => {
    visibilityFilter.hideElements(["w1"]); await tick();
    assert.deepStrictEqual(vis(), { w1: false, w2: true, s1: true });
    visibilityFilter.resetTemporary(); await tick();
    assert.deepStrictEqual(vis(), { w1: true, w2: true, s1: true });
  });
  await t("isolate: only the isolated authored element stays; linked models are hidden", async () => {
    calls.length = 0;
    visibilityFilter.isolateElements(["w2"]); await tick();
    assert.deepStrictEqual(vis(), { w1: false, w2: true, s1: false });
    assert.deepStrictEqual(calls.find((c) => c[0] === "set"), ["set", false, null]);
    visibilityFilter.resetTemporary(); await tick();
    assert.deepStrictEqual(vis(), { w1: true, w2: true, s1: true });
    assert.deepStrictEqual(calls.filter((c) => c[0] === "set").pop(), ["set", true, null]);
  });
  await t("isolate with a fragment item uses Hider.isolate with a model-id map", async () => {
    calls.length = 0;
    visibilityFilter.isolateElements(["frag:modelA::5", "frag:modelA::6"]); await tick();
    assert.deepStrictEqual(calls.find((c) => c[0] === "isolate"), ["isolate", { modelA: [5, 6] }]);
    assert.deepStrictEqual(vis(), { w1: false, w2: false, s1: false });
    visibilityFilter.resetTemporary(); await tick();
  });
  await t("hide a fragment item: reset then hide exactly that item", async () => {
    calls.length = 0;
    visibilityFilter.hideElements(["frag:modelA::7"]); await tick();
    const sets = calls.filter((c) => c[0] === "set");
    assert.deepStrictEqual(sets, [["set", true, null], ["set", false, { modelA: [7] }]]);
    visibilityFilter.resetTemporary(); await tick();
  });
  await t("nothing active -> the bridge does not touch the Hider (leaves the context menu's own hide alone)", async () => {
    calls.length = 0;
    visibilityFilter.hideElements(["w1"]); await tick();
    // authored-only hide still resets fragments only if we had touched them: after the previous reset we hadn't
    assert.ok(!calls.some((c) => c[0] === "set"), JSON.stringify(calls));
    visibilityFilter.resetTemporary(); await tick();
  });
  await t("category override hides authored walls and the matching IFC categories of linked models", async () => {
    calls.length = 0;
    visibilityFilter.setCategoryOverride("wall", { visible: false }); await tick();
    assert.deepStrictEqual(vis(), { w1: false, w2: false, s1: true });
    assert.ok(calls.some((c) => c[0] === "cats"));
    const hide = calls.filter((c) => c[0] === "set" && c[1] === false).pop();
    assert.deepStrictEqual(hide[2], { modelA: [10, 11, 12] });
    visibilityFilter.clearCategoryOverrides(); await tick();
    assert.deepStrictEqual(vis(), { w1: true, w2: true, s1: true });
  });
  await t("halftone category override lowers opacity and restores it", async () => {
    visibilityFilter.setCategoryOverride("slab", { halftone: true }); await tick();
    const m = group.children.find((x) => x.userData.elementId === "s1").material;
    assert.ok(m.transparent && m.opacity <= 0.4, `opacity ${m.opacity}`);
    visibilityFilter.clearCategoryOverrides(); await tick();
    assert.ok(!m.transparent && m.opacity === 1);
  });
  await t("design options: element tagged with an inactive option is hidden, active option shows it", async () => {
    designOptionsStore.boot();
    const set = designOptionsStore.createSet("Entrance");
    const a = designOptionsStore.addOption(set.id, "A"); const b = designOptionsStore.addOption(set.id, "B");
    designOptionsStore.setActive(set.id, a.id);
    elements[2].properties = { designOptionId: b.id };
    vb.applyAuthored(true); await tick();
    assert.strictEqual(vis().s1, false); assert.strictEqual(vis().w1, true);
    designOptionsStore.setActive(set.id, b.id); await tick();
    assert.strictEqual(vis().s1, true);
  });
  await t("tagSelection writes phase / option tags on the selected element", async () => {
    selected = ["w1"];
    // projects module is not loaded in this harness; tagSelection must still tag and re-apply
    const n = await vb.tagSelection({ phaseCreated: "ph-1", designOptionId: null });
    assert.strictEqual(n, 1);
    assert.strictEqual(elements[0].properties.phaseCreated, "ph-1");
    selected = [];
  });
  await t("meshes added by a rebuild are styled after the microtask (group.add hook)", async () => {
    visibilityFilter.hideElements(["w2"]); await tick();
    group.children.length = 0;                       // rebuild: drop everything...
    elements.forEach((e) => group.add(mesh(e.id))); // ...and re-add fresh (visible) meshes
    await tick();
    assert.strictEqual(vis().w2, false); assert.strictEqual(vis().s1, true);
    visibilityFilter.resetTemporary(); await tick();
  });
  console.log(`${passed} passed`);
})();
