const assert = require("assert");
const path = require("path");
const dir = process.env.OUT_DIR || "";
const root = path.join(dir, "..", "..");
let passed = 0;
async function t(name, fn) { try { await fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + (e.stack || e.message).split("\n").slice(0, 3).join("\n       ")); process.exitCode = 1; } }
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

const store = new Map();
global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
global.CustomEvent = class { constructor(tp, o) { this.type = tp; this.detail = o && o.detail; } };
const toasts = []; global.window = { dispatchEvent(e) { if (e.detail && e.detail.message) toasts.push(e.detail.message); } }; global.document = {};
/* fake pdf-lib operator API */
const Module = require("module"); const origLoad = Module._load;
let pdfApi = { pushGraphicsState: () => ["q"], popGraphicsState: () => ["Q"], setFillingRgbColor: (r, g, b) => ["rg", r, g, b], moveTo: (x, y) => ["m", x, y], lineTo: (x, y) => ["l", x, y], closePath: () => ["h"], fill: () => ["f"] };
Module._load = function (request, ...rest) { return request === "pdf-lib" ? pdfApi : origLoad.call(this, request, ...rest); };

const { ctx } = require(path.join(root, "core/context.js"));
const { roomsStore } = require(path.join(root, "modules/rooms/rooms.js"));
const reg = require(path.join(dir, "m3-register.js"));
const fill = require(path.join(dir, "m3-pdf-fill.js"));

const wall = (id, s, e, o = {}) => ({ id, type: "wall", params: { start: s, end: e, height: 3, thickness: 0.2, elevation: 0, ...o } });
const elements = [wall("w1", [0, 0], [8, 0]), wall("w2", [8, 0], [8, 6]), wall("w3", [8, 6], [0, 6]), wall("w4", [0, 6], [0, 0]),
  { id: "d1", type: "door", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 3, sillHeight: 0 } },
  { id: "st", type: "stairs", params: { height: 3, thickness: 0.15, elevation: 0, start: [1, 1], end: [5, 1], width: 1.2 } }];
ctx.features = { authoring: { getElements: () => elements, getLevels: () => [{ id: "L0", name: "Ground", elevation: 0 }, { id: "L1", name: "First", elevation: 3.4 }] } };

const planDef = (elev = 0) => ({ id: "p", kind: "plan", name: "Plan", scale: 100, plan: { levelId: "x", levelElevation: elev, cutHeight: 1.2, topHeight: 2.4, bottomDepth: 1.2, viewDepth: 4 } });
const emptyScene = () => ({ bounds: { minX: 0, minZ: 0, maxX: 8, maxZ: 6 }, layers: { cut: [{ kind: "line", x1: 0, z1: 0, x2: 1, z2: 0 }], project: [], overhead: [], below: [], grid: [], annotation: [], symbols: [] }, generatedAt: 0 });

(async () => {
  await t("setup installs the generator hooks, PDF fill hook and options API", () => {
    assert.ok(reg.setupM3().ok);
    for (const k of ["planFilter", "plan", "section", "elevation"]) assert.strictEqual(typeof window.__obsViewExt[k], "function");
    assert.strictEqual(window.__obsM3FillPolygon, fill.fillPolygonPdf);
  });
  await t("plan: stairs lose their base-generator geometry, poche goes under the outlines, tags and symbols are added", () => {
    roomsStore.boot();
    roomsStore.createRoom({ boundary: [{ x: 0.1, z: 0.1 }, { x: 7.9, z: 0.1 }, { x: 7.9, z: 5.9 }, { x: 0.1, z: 5.9 }], levelId: "L0" });
    roomsStore.createRoom({ boundary: [{ x: 0.1, z: 0.1 }, { x: 7.9, z: 0.1 }, { x: 7.9, z: 5.9 }, { x: 0.1, z: 5.9 }], levelId: "L1" });
    const def = planDef(0);
    const pv = { segments: [{ x1: 0, z1: 0, x2: 1, z2: 0, kind: "cut", source: "w1" }, { x1: 1, z1: 1, x2: 5, z2: 1, kind: "cut", source: "st" }, { x1: 0, z1: 0, x2: 0, z2: 1, kind: "grid" }], arcs: [] };
    window.__obsViewExt.planFilter(pv, def);
    assert.deepStrictEqual(pv.segments.map((s) => s.source), ["w1", undefined]);
    const scene = emptyScene();
    window.__obsViewExt.plan(def, scene);
    assert.ok(scene.layers.cut[0].fill, "poche polygons first");
    assert.ok(scene.layers.cut.some((e) => e.kind === "line" && e.x1 === 0 && e.z2 === 0 && !e.fill), "base outline kept");
    assert.ok(scene.layers.symbols.some((e) => e.kind === "text" && e.text === "UP"));
    const txt = scene.layers.symbols.filter((e) => e.kind === "text").map((e) => e.text);
    assert.ok(txt.includes("D1")); assert.strictEqual(txt.filter((x) => /m\u00B2/.test(x)).length, 1, "only the room of this level is tagged");
    assert.strictEqual(def.__m3, undefined);
  });
  await t("plan at the next level tags that level's rooms (matched by elevation, not by id)", () => {
    const def = planDef(3.4); const pv = { segments: [], arcs: [] };
    window.__obsViewExt.planFilter(pv, def); const scene = emptyScene(); window.__obsViewExt.plan(def, scene);
    assert.strictEqual(scene.layers.symbols.filter((e) => e.kind === "text" && /m\u00B2/.test(e.text)).length, 1);
    assert.ok(!scene.layers.cut.some((e) => e.fill), "walls end at 3.0 m, so nothing is cut at 3.4 + 1.2");
  });
  await t("plan options persist and switch content off", () => {
    reg.setPlanOption("roomTags", false); reg.setPlanOption("poche", false);
    assert.strictEqual(reg.getPlanOptions().roomTags, false);
    const def = planDef(0); window.__obsViewExt.planFilter({ segments: [], arcs: [] }, def); const sc = emptyScene(); window.__obsViewExt.plan(def, sc);
    assert.ok(!sc.layers.cut.some((e) => e.fill)); assert.ok(!sc.layers.symbols.some((e) => e.kind === "text" && /m\u00B2/.test(e.text)));
    reg.setPlanOption("roomTags", true); reg.setPlanOption("poche", true);
    reg.togglePlanOption("doorTags", "Door tags"); assert.strictEqual(reg.getPlanOptions().doorTags, false); assert.ok(toasts.some((m) => /Door tags: off/.test(m)));
    reg.togglePlanOption("doorTags", "Door tags");
  });
  await t("section: real cut with poche, door opening shows as a gap, datums added; no solids -> null (old generator takes over)", async () => {
    const def = { kind: "section", section: { cutLine: { x1: 3, z1: -2, x2: 3, z2: 8 }, lookDir: "right", top: 6, bottom: -1, farClip: 30 } };
    const sc = await window.__obsViewExt.section(def);
    const caps = sc.layers.cut.filter((e) => e.fill && e.fill.color !== "#ffffff");
    assert.ok(caps.length >= 2, "cap loops: " + caps.length);   // lintel above the door in w1 + the far wall w3 at z=6
    const areas = caps.map((e) => { let s = 0; for (let i = 0; i < e.points.length; i++) { const a = e.points[i], b = e.points[(i + 1) % e.points.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); });
    assert.ok(areas.some((a) => Math.abs(a - 0.2 * 0.9) < 1e-9), "lintel above the door: " + areas.join(","));  // 0.9 m opening x 0.2 m wall, from 2.1 to 3.0 m
    assert.ok(areas.some((a) => Math.abs(a - 0.2 * 3) < 1e-9), "full-height far wall");
    assert.ok(sc.layers.annotation.some((e) => e.kind === "text" && /Ground/.test(e.text)));
    assert.ok(sc.bounds.maxX > sc.bounds.minX && sc.bounds.maxZ > sc.bounds.minZ);
    const left = await window.__obsViewExt.section({ ...def, section: { ...def.section, lookDir: "left" } });
    assert.ok(left.layers.cut.length >= 1);
    const keep = elements.splice(0, elements.length);
    assert.strictEqual(await window.__obsViewExt.section(def), null);
    elements.push(...keep);
    assert.strictEqual(await window.__obsViewExt.section({ kind: "section" }), null);
  });
  await t("elevation: true silhouette with openings, extents match the building, datums added", async () => {
    const sc = await window.__obsViewExt.elevation({ kind: "elevation", elevation: { direction: "south", origin: [0, 3, 15], farClip: 60 } });
    assert.ok(sc.layers.project.length > 6);
    near(sc.bounds.maxZ - sc.bounds.minZ, 3 + 0, 0.6);   // 0..3 m building, the datum label sits slightly above the line
    near(sc.bounds.maxX - sc.bounds.minX, 8, 1.2);
    assert.ok(sc.layers.annotation.length >= 2);
  });
  await t("refreshViews bumps every saved view so sheets regenerate", async () => {
    const vs = require(path.join(root, "modules/views/store.js")); vs.bootViewsStore();
    const before = vs.listViews().map((v) => v.updatedAt); await new Promise((r) => setTimeout(r, 5));
    await reg.refreshViews();
    assert.ok(vs.listViews().every((v, i) => v.updatedAt > before[i]));
  });
  await t("PDF fill: raw path operators in page coordinates, translucent fills blended with white, safe fallbacks", () => {
    const pushed = []; const page = { pushOperators: (...o) => pushed.push(...o) };
    assert.strictEqual(fill.fillPolygonPdf(page, [[10, 20], [30, 20], [30, 40]], { r: 0, g: 0.5, b: 1 }, 1), true);
    assert.deepStrictEqual(pushed, [["q"], ["rg", 0, 0.5, 1], ["m", 10, 20], ["l", 30, 20], ["l", 30, 40], ["h"], ["f"], ["Q"]]);
    pushed.length = 0;
    fill.fillPolygonPdf(page, [[0, 0], [1, 0], [1, 1]], { r: 0, g: 0, b: 0 }, 0.35);
    near(pushed[1][1], 0.65, 1e-12);
    assert.strictEqual(fill.fillPolygonPdf(page, [[0, 0], [1, 1]], { r: 0, g: 0, b: 0 }, 1), false);
    assert.strictEqual(fill.fillPolygonPdf({}, [[0, 0], [1, 0], [1, 1]], { r: 0, g: 0, b: 0 }, 1), false);
    const keep = pdfApi.fill; delete pdfApi.fill;
    assert.strictEqual(fill.fillPolygonPdf(page, [[0, 0], [1, 0], [1, 1]], { r: 0, g: 0, b: 0 }, 1), false);
    pdfApi.fill = keep;
  });
  console.log(`${passed} passed`);
})();
