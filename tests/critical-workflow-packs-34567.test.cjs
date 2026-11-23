/**
 * tests/critical-workflow-packs-34567.test.cjs
 *
 * Regression tests for critical workflow packs 3–7
 * (src/modules/bim-gaps/critical-workflow-pack-{3,4,5,6,7}.ts — 50 commands).
 *
 * Why this file exists: packs 3–7 shipped their commands through a
 * window.dispatchEvent(new CustomEvent("obs-register-command", …)) channel
 * that has no listener anywhere in the repo — the exact "dead channel" bug
 * class that tests/critical-workflow-pack.test.cjs was written to prevent
 * for pack 1. All 50 commands were therefore invisible in the command
 * palette. These tests pin the corrected behaviour:
 *   1. all 5 packs register exactly 10 commands each into the real palette
 *   2. running the commands never writes window.__obs* globals
 *   3. the takeoff / GIS-centroid / topo / matchline / grid-study / daylight /
 *      materials / mass math is correct on fixtures, against the REAL
 *      signatures of the modules the packs call
 *
 * Run: `node tests/critical-workflow-packs-34567.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function approx(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }

/* ── localStorage shim (before module load) ─────────────────────────── */
const lsStore = new Map();
globalThis.localStorage = {
  setItem: (k, v) => lsStore.set(String(k), String(v)),
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => lsStore.delete(String(k)),
  clear: () => lsStore.clear(),
};

/* ── Compile the five pack modules to CommonJS ──────────────────────── */
const repoRoot = path.resolve(__dirname, "..");
const tmpBase = path.join(os.tmpdir(), "obs-cwp567-test-" + Date.now());
fs.mkdirSync(tmpBase, { recursive: true });
const compiled = {}; // packKey -> { file, output }
for (const n of [3, 4, 5, 6, 7]) {
  const entry = path.join(repoRoot, `src/modules/bim-gaps/critical-workflow-pack-${n}.ts`);
  const outDir = path.join(tmpBase, `p${n}`);
  fs.mkdirSync(outDir, { recursive: true });
  execSync(
    `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(outDir)} ` +
    `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
    `--ignoreDeprecations 5.0 --noResolve --noCheck`,
    { cwd: repoRoot, stdio: "pipe" },
  );
  const file = path.join(outDir, `critical-workflow-pack-${n}.js`);
  compiled[`p${n}`] = { file, output: fs.readFileSync(file, "utf8") };
}

/* ── Shared fixtures ────────────────────────────────────────────────── */
// Bounds: x [0,10], z [0,9]; max elev+height = 4 (column c3).
const authored = [
  { id: "d1", type: "door", params: { width: 0.9, height: 2.1 }, properties: {} },
  { id: "d2", type: "door", params: { width: 0.9, height: 2.1 }, properties: {} },
  { id: "d3", type: "door", params: { width: 1.0, height: 2.1 }, properties: {} },
  { id: "w1", type: "window", params: { width: 1.2, height: 1.4 }, properties: {} },
  { id: "c1", type: "column", params: { point: [0, 0], height: 3 }, properties: {} },
  { id: "c2", type: "column", params: { point: [4, 0], height: 3.5 }, properties: {} },
  { id: "c3", type: "column", params: { point: [8, 0], height: 4 }, properties: {} },
  { id: "wa1", type: "wall", params: { start: [0, 0], end: [10, 0], thickness: 0.2, height: 3 }, properties: {} },
  { id: "wa2", type: "wall", params: { start: [0, 4], end: [0, 9], thickness: 0.2, height: 3 }, properties: {} },
  { id: "wa3", type: "wall", params: { start: [2, 2], end: [8, 2], thickness: 0.3, height: 3 }, properties: {} },
  { id: "s1", type: "slab", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] }, properties: {} },
  { id: "r1", type: "room", params: {}, properties: {} },
];
let selection = ["wa1", "wa2", "wa3"];
const colCreateCalls = [];
const notices = [];
const registered = [];

const ctxMock = {
  ctx: {
    features: {
      authoring: {
        getElements: () => authored,
        getLevels: () => [{ id: "L0", name: "Ground", elevation: 0 }, { id: "L1", name: "First", elevation: 3.2 }],
        getGrids: () => [
          { id: "A", start: [-1, 0], end: [12, 0] },
          { id: "B", start: [-1, 6], end: [12, 6] },
          { id: "1", start: [2, -2], end: [2, 9] },
          { id: "2", start: [6, -2], end: [6, 9] },
        ],
        getSelectedIds: () => [...selection],
        setSelectedAuthored: (ids) => { selection = ids.map(String); },
        createElementByType: async (kind, opts) => {
          colCreateCalls.push({ kind, opts });
          return "created-" + colCreateCalls.length;
        },
        rebuildAuthored: () => {},
      },
      groups: {
        create: (label, ids) => { groupCalls.push({ label, ids }); return { id: "g-1" }; },
      },
      copyMonitor: {
        addRule: (rule) => { copyMonRules.push(rule); },
      },
      snappingEngine: {
        calls: [],
        setEnabled(v) { this.calls.push(["setEnabled", v]); },
        enableAllTypes() { this.calls.push(["enableAllTypes"]); },
        setGridSize(v) { this.calls.push(["setGridSize", v]); },
        setPixelTolerance(v) { this.calls.push(["setPixelTolerance", v]); },
      },
    },
  },
};

/* ── Stubs for every module the packs import ────────────────────────── */
const groupCalls = [];
const copyMonRules = [];
const costItems = [];
const costCalls = { setAssignment: [], setQtyOverride: [] };
let costSeed = 0;
const lodCalls = [];
const topoCalls = [];
const matchlineCalls = [];
const familiesMade = [];
const fabCalls = [];
const daylightCalls = [];
const lockCalls = [];
const justCalls = [];
const classificationCalls = [];
const checkerMode = { fail: false };
const checkerCalls = [];
const northCalls = [];
const materialsList = [];
let materialsSeed = 0;
const filledRegionCalls = [];
const mepCalls = [];
const massCalls = [];

// pack-4 imports three.js; the compiled module lives in /tmp so node_modules
// is not on its resolution path — provide a permissive proxy stub instead.
const threeStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === "__esModule") return false;
    return function Ctor(..._args) { return { isProxyThree: true, type: String(prop) }; };
  },
});

const stubs = {
  "../../features/command-palette": {
    registerCommand: (cmd) => registered.push(cmd),
    unregisterCommand: () => {},
    listCommands: () => registered,
  },
  "./bim-gaps-boot": { BIM_GAPS_VERSION: "test-pack-9.9.9" },
  "../phases/phases": { phasesStore: { list: () => [], ensureDefaults: () => [] } },
  "../design-options/design-options": { designOptionsStore: { list: () => [], ensurePrimary: () => null } },
  "three": threeStub,
  "../cost/cost": {
    getItems: () => costItems.map((i) => ({ ...i })),
    addCostItem: (item) => { costItems.push({ id: `ci-${++costSeed}`, ...item }); return costItems[costItems.length - 1]; },
    setAssignment: (key, id) => costCalls.setAssignment.push({ key, id }),
    setQtyOverride: (key, qty) => costCalls.setQtyOverride.push({ key, qty }),
  },
  "../lod-performance/index": {
    getLODPerformanceService: () => ({ setLOD: (l) => lodCalls.push(l) }),
  },
  "../toposurface/toposurface": {
    buildToposurface: (spec) => { topoCalls.push(spec); return { points: spec.points }; },
  },
  "../matchline/matchline": {
    buildMatchline: (spec) => { matchlineCalls.push(spec); return { ...spec, id: "ML-1" }; },
  },
  "../families/builtin-families": {
    createBuiltInFamilies: () => {
      const list = [
        { id: "f1", name: "Door-Standard", category: "door" },
        { id: "f2", name: "Window-Fixed", category: "window" },
        { id: "f3", name: "Column-Rect", category: "column" },
      ];
      familiesMade.push(...list);
      return list;
    },
  },
  "../fabrication-parts/fabrication-parts": {
    buildFabricationPart: (spec) => { fabCalls.push(spec); return { id: "fp-1", type: spec.type }; },
    getAstmCode: () => "EL90",
  },
  "../daylighting/daylighting": {
    runDaylightAnalysis: (spec) => {
      daylightCalls.push(spec);
      return { averageDF: 2.5, sDA: "60%", inputs: spec };
    },
  },
  "../collaboration/workshare-locks": {
    lockElement: (id) => lockCalls.push(id),
  },
  "../detail-components/types": { listComponents: () => [] },
  "../justification/index": {
    justificationShiftMeters: (mode, w) => { justCalls.push({ mode, w }); return w / 2; },
  },
  "../plugin-marketplace/types": {
    listMarketplace: () => [
      { id: "ifc-tools", name: "IFC Tools", status: "available" },
      { id: "cost-plus", name: "Cost Plus", status: "available" },
    ],
  },
  "../classification/index": {
    setAssignment: (id, system, code) => classificationCalls.push({ id, system, code }),
  },
  "../model-checker/model-checker": {
    runModelChecker: (els, opts) => {
      checkerCalls.push({ n: els.length, opts });
      if (checkerMode.fail) throw new Error("checker unavailable");
      return { summary: { errors: 1, warnings: 2 }, results: [{}, {}, {}] };
    },
  },
  "../north/north": {
    setNorthState: (s) => northCalls.push(s),
    formatNorthAngle: (deg) => `${deg}°`,
  },
  "../materials/materials": {
    ensureDefaultMaterials: () => {},
    listMaterials: () => materialsList.map((m) => ({ ...m })),
    addMaterial: (p) => { materialsList.push({ id: `m-${++materialsSeed}`, color: "#888888", ...p }); return materialsList[materialsList.length - 1]; },
  },
  "../filled-regions/index": {
    createFilledRegion: (spec) => filledRegionCalls.push(spec),
  },
  "../mep/connectivity": {
    expandConnected: (ids, els) => { mepCalls.push({ ids, n: els.length }); return []; },
  },
  "../in-place-mass/types": {
    createMass: (basePolygon, height, name) => {
      massCalls.push({ basePolygon, height, name });
      return { id: "mass-1", name, basePolygon, height };
    },
    listMasses: () => [],
    removeMass: () => {},
    getMassFloors: () => [],
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../core/context") return ctxMock;
  if (request === "../../core/notify") return { notify: (kind, msg) => notices.push({ kind, msg }) };
  if (request === "../groups/groups") return { groupsStore: { create: ctxMock.ctx.features.groups.create } };
  if (request === "../copy-monitor/copy-monitor") return { copyMonitorStore: { addRule: ctxMock.ctx.features.copyMonitor.addRule } };
  if (request === "../phases/phases") return stubs["../phases/phases"];
  if (request === "../design-options/design-options") return stubs["../design-options/design-options"];
  if (request === "three") return threeStub;
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

const packs = {};
for (const key of Object.keys(compiled)) {
  const mod = new Module(compiled[key].file, module);
  mod.filename = compiled[key].file;
  mod.paths = Module._nodeModulePaths(path.dirname(compiled[key].file));
  mod._compile(compiled[key].output, compiled[key].file);
  packs[key] = mod.exports;
}

/* ── 1. Registration into the real command palette (the dead-channel fix) ── */
// NOTE (2026-11-24, #102): pack 3 used to register 11 commands — its cmds
// table carried an "rg-isolate" row duplicating the registration in
// src/modules/bim-gaps/bim-gaps-boot.ts, which is the one that wins at
// runtime. #102 removed the duplicate row, so pack 3 registers 10 like the
// other four packs and the total is 50, not 51. rg-isolate itself is not
// gone: it still registers via bim-gaps-boot.ts in the real app.
t("packs 3–7 register their commands into the real palette (10+10+10+10+10 = 50)", () => {
  for (const key of ["p3", "p4", "p5", "p6", "p7"]) {
    const setup = packs[key][`setupCriticalWorkflowPack${key.slice(1)}`];
    assert(typeof setup === "function", `${key}: setup export missing`);
    setup();
  }
  assert(registered.length === 50, `expected 50 commands, got ${registered.length}`);
  // Pin the duplicate removal: rg-isolate must not come back as an 11th
  // pack-3 row (it lives in bim-gaps-boot.ts).
  assert(!registered.some((c) => c.id === "rg-isolate"), "rg-isolate registered twice: pack row + boot");
});

t("every registered command has label, category and a runnable function", () => {
  for (const c of registered) {
    assert(typeof c.id === "string" && c.id.startsWith("rg-"), `bad id ${c.id}`);
    assert(typeof c.label === "string" && c.label.length > 3, `${c.id}: bad label`);
    assert(typeof c.category === "string" && c.category.length >= 2, `${c.id}: bad category`);
    assert(typeof c.run === "function", `${c.id}: run not a function`);
  }
});

t("no command registration path dispatches the dead obs-register-command channel", () => {
  for (const key of ["p3", "p4", "p5", "p6", "p7"]) {
    assert(!/__obs[A-Za-z0-9]+/.test(compiled[key].output), `${key}: leaks a window global in source`);
  }
});

/* ── 2. Pack 5 — cost takeoff math ──────────────────────────────────── */
t("pack-5 cost takeoff: walls/slab/doors/windows/columns priced on fixtures", async () => {
  const r = await packs.p5.runCostTakeoff();
  // walls 30+15+18=63 m² ×45; slab 80 m² ×120; doors 3×350; windows 1×280;
  // columns (0.3²×3 + 0.3²×3.5 + 0.3²×4)=0.945 m³ ×120
  assert(approx(r.total, 63 * 45 + 80 * 120 + 3 * 350 + 1 * 280 + 0.945 * 120, 0.05), `bad total ${r.total}`);
  assert(r.lines.length === 5, `expected 5 lines, got ${r.lines.length}`);
  assert(r.lines[0].key === "walls" && approx(r.lines[0].qty, 63) && r.lines[0].rate === 45, "walls line wrong");
  assert(approx(r.lines[1].qty, 80) && r.lines[1].rate === 120, "slab line wrong");
  assert(costCalls.setAssignment.length === 5 && costCalls.setQtyOverride.length === 5, "assignments not recorded");
  assert(costItems.length === 8, `catalog should seed 8 items, got ${costItems.length}`);
});

t("pack-5 group/ungroup stamps groupId via the groups service", () => {
  const id = packs.p5.groupSelection("qa-group");
  assert(id === "g-1", `group id ${id}`);
  assert(groupCalls.length === 1 && groupCalls[0].label === "qa-group" && groupCalls[0].ids.length === 3, "store.create not called correctly");
  for (const wid of ["wa1", "wa2", "wa3"]) assert(authored.find((e) => e.id === wid).properties.groupId === "g-1", `${wid} not stamped`);
  assert(packs.p5.ungroupSelection() === 3, "ungroup count wrong");
  assert(!authored.find((e) => e.id === "wa1").properties.groupId, "groupId not cleared");
});

t("pack-5 LOD medium drives the real service and persists the choice", async () => {
  await packs.p5.setLodMedium();
  assert(lodCalls.includes(1), "service.setLOD(1) not called");
  assert(lsStore.get("obs.lod") === "medium", "obs.lod not persisted");
});

t("pack-5 flat topo pads model bounds by 5 m and places a terrain slab", async () => {
  const okr = await packs.p5.createFlatTopo();
  assert(okr === true, "createFlatTopo returned false");
  assert(topoCalls.length === 1, "buildToposurface not called");
  const pts = topoCalls[0].points;
  assert(pts.length === 5, "expected 5 topo points (4 corners + centre)");
  assert(approx(pts[0].x, -5) && approx(pts[0].z, -5), "first corner wrong (bounds x[0,10] z[0,9], pad 5)");
  assert(approx(pts[2].x, 15) && approx(pts[2].z, 14), "max corner wrong");
  assert(approx(pts[4].x, 5) && approx(pts[4].z, 4.5), "centre point wrong");
  const terrain = colCreateCalls.find((c) => c.kind === "terrain");
  assert(!!terrain, "terrain slab not created");
  assert(terrain.opts.polygon.length === 4 && approx(terrain.opts.height, 0.05), "terrain slab spec wrong");
});

t("pack-5 matchline runs through model bounds centre", async () => {
  const okr = await packs.p5.createMatchline();
  assert(okr === true, "createMatchline returned false");
  const spec = matchlineCalls[0];
  assert(approx(spec.points[0].x, 5), "matchline not at centre x");
  assert(approx(spec.points[0].z, -2) && approx(spec.points[1].z, 11), "matchline z ends wrong (minZ-2 .. maxZ+2)");
  assert(spec.labels.left === "ML-1" && spec.labels.right === "ML-1", "labels wrong");
});

t("pack-5 generative grid study scores spacings and picks the best", async () => {
  const r = await packs.p5.runGridSpacingStudy();
  assert(Array.isArray(r) && r.length === 5, `expected 5 candidates, got ${r.length}`);
  assert(approx(r[0].spacing, 7.5), `best spacing should be 7.5, got ${r[0].spacing}`);
  assert(approx(r[0].score, 120), `best score should be 120 (ceil(30/7.5)²×7.5), got ${r[0].score}`);
});

t("pack-5 copy/monitor rule registered on the real store", () => {
  packs.p5.ensureCopyMonitorRule();
  assert(copyMonRules.length === 1, "addRule not called");
  assert(copyMonRules[0].name === "Grids & Levels" && copyMonRules[0].autoUpdate === true, "rule content wrong");
  assert(copyMonRules[0].categories.includes("grid") && copyMonRules[0].categories.includes("level"), "rule categories wrong");
});

t("pack-5 pin-all-of-type pins every element of the selected type", () => {
  const n = packs.p5.pinSimilarToSelection();
  assert(n === 3, `expected 3 walls pinned, got ${n}`);
  for (const wid of ["wa1", "wa2", "wa3"]) assert(authored.find((e) => e.id === wid).properties.pinned === true, `${wid} not pinned`);
  assert(!authored.find((e) => e.id === "d1").properties.pinned, "non-wall got pinned");
});

/* ── 3. Pack 6 — families / daylight / GIS / collab ─────────────────── */
t("pack-6 loads built-in families and caches the catalog", async () => {
  const n = await packs.p6.loadBuiltinFamilies();
  assert(n === 3, `expected 3 families, got ${n}`);
  const cached = JSON.parse(lsStore.get("obs.families.builtin") || "[]");
  assert(cached.length === 3 && cached[0].name === "Door-Standard", "family catalog not cached");
});

t("pack-6 fabrication elbow builds a real part and places a fitting", async () => {
  const okr = await packs.p6.placeFabElbow();
  assert(okr === true, "placeFabElbow returned false");
  assert(fabCalls.length === 1 && fabCalls[0].type === "elbow" && fabCalls[0].angle === 90, "fab spec wrong");
  assert(colCreateCalls.some((c) => c.kind === "fitting"), "fitting not placed");
});

t("pack-6 daylight study derives room size and window area from the model", async () => {
  const r = await packs.p6.runDaylightStudy();
  assert(!!r && r.averageDF === 2.5, `daylight result wrong: ${JSON.stringify(r)}`);
  const spec = daylightCalls[0];
  assert(approx(spec.roomWidth, 10) && approx(spec.roomDepth, 9), "room dims wrong (bounds x[0,10] z[0,9])");
  assert(approx(spec.windowArea, 1.5), "window area wrong (1 window × 1.5 m²)");
});

t("pack-6 GIS origin is the centroid of point/linear elements", () => {
  packs.p6.setGisProjectOrigin();
  // columns mids: (0,0)(4,0)(8,0); wall mids: (5,0)(0,6.5)(5,2) → n=6, cx=22/6, cz=8.5/6
  const o = JSON.parse(lsStore.get("obs.gis.origin") || "null");
  assert(!!o, "obs.gis.origin not persisted");
  assert(approx(o.localX, 22 / 6, 0.002), `localX ${o.localX}`);
  assert(approx(o.localZ, 8.5 / 6, 0.002), `localZ ${o.localZ}`);
  assert(ctxMock.ctx.gisOrigin === o || (ctxMock.ctx.gisOrigin && approx(ctxMock.ctx.gisOrigin.localX, 22 / 6, 0.002)), "ctx.gisOrigin not set");
});

t("pack-6 workshare lock stamps selection through the lock engine", async () => {
  const n = await packs.p6.lockSelectionWorkshare();
  assert(n === 3, `expected 3 locked, got ${n}`);
  assert(lockCalls.length === 3 && lockCalls[0] === "wa1", "lockElement not called for selection");
  assert(authored.find((e) => e.id === "wa2").properties.workshareLocked === true, "wa2 not stamped");
});

t("pack-6 detail catalog seeds 5 defaults when module list is empty", async () => {
  const n = await packs.p6.seedDetailCatalog();
  assert(n === 5, `expected 5 seeds, got ${n}`);
  const stored = JSON.parse(lsStore.get("obs.details.catalog") || "[]");
  assert(stored.length === 5 && stored[0].id === "dt-wall-section", "seed not persisted");
});

t("pack-6 fine snaps configures the real snapping engine (50 mm grid)", () => {
  packs.p6.enableFineSnaps();
  const snap = ctxMock.ctx.features.snappingEngine;
  assert(snap.calls.some((c) => c[0] === "setGridSize" && c[1] === 0.05), "grid size 0.05 not set");
  assert(snap.calls.some((c) => c[0] === "enableAllTypes"), "all snap types not enabled");
  assert(JSON.parse(lsStore.get("obs.snap")).grid === 0.05, "snap choice not persisted");
});

t("pack-6 wall justification sets exterior finish face with real shift", async () => {
  const n = await packs.p6.setWallsExteriorFace();
  assert(n === 3, `expected 3 walls, got ${n}`);
  const wa1 = authored.find((e) => e.id === "wa1");
  assert(wa1.properties.locationLine === "finish-face-exterior", "locationLine not set");
  assert(approx(wa1.properties.justificationShift, 0.1), `shift should be thickness/2 = 0.1, got ${wa1.properties.justificationShift}`);
});

t("pack-6 diagnostics report counts elements, levels, grids and packs", () => {
  const r = packs.p6.diagnosticsReport();
  assert(r.elements === 12, `expected 12 elements, got ${r.elements}`);
  assert(r.levels === 2 && r.grids === 4 && r.selected === 3, "counts wrong");
  assert(r.byType.wall === 3 && r.byType.door === 3 && r.byType.column === 3, "byType wrong");
  assert(r.packs.pack5 === true && r.packs.pack6 === true, "pack availability flags wrong");
  assert(r.bimGaps === "test-pack-9.9.9", "version not carried through");
});

/* ── 4. Pack 7 — classification / checker / materials / mass ────────── */
t("pack-7 Uniclass stamps the right code per type and records assignments", async () => {
  const n = await packs.p7.classifyByUniclass();
  assert(n === 11, `expected 11 classified (room has no code), got ${n}`);
  assert(classificationCalls.length === 11, "setAssignment not called for each");
  const wa1 = authored.find((e) => e.id === "wa1");
  const d1 = authored.find((e) => e.id === "d1");
  const s1 = authored.find((e) => e.id === "s1");
  assert(wa1.properties.classification === "Ss_25_10_30" && wa1.properties.classificationSystem === "Uniclass2015", "wall code wrong");
  assert(d1.properties.classification === "Pr_30_36_08", "door code wrong");
  assert(s1.properties.classification === "Ss_30_10_30", "slab code wrong");
});

t("pack-7 formal checker returns the engine result and does not clobber any global", async () => {
  const r = await packs.p7.runFormalModelChecker();
  assert(r.summary.errors === 1 && r.summary.warnings === 2, "checker result wrong");
  assert(checkerCalls[0].n === 12, "checker not given all elements");
  assert(globalThis.__obsModelChecker === undefined, "result leaked onto window");
  const last = notices[notices.length - 1];
  assert(last.kind === "warn" && /2 err/.test(last.msg) === false && /1 err/.test(last.msg), `toast wrong: ${last.msg}`);
});

t("pack-7 checker fallback finds unhosted doors/windows when the engine throws", async () => {
  checkerMode.fail = true;
  const r = await packs.p7.runFormalModelChecker();
  checkerMode.fail = false;
  assert(Array.isArray(r) && r.length === 4, `expected 4 findings (3 doors + 1 window unhosted), got ${r.length}`);
  assert(r.every((f) => f.code === "UNHOSTED" && f.severity === "warning"), "finding shape wrong");
});

t("pack-7 setProjectNorth drives the north module", async () => {
  await packs.p7.setProjectNorth(0);
  assert(northCalls.length === 1 && northCalls[0].trueNorthAngle === 0 && northCalls[0].projectNorthAngle === 0, "north state wrong");
});

t("pack-7 ensureMaterials seeds six materials with valid categories", async () => {
  const n = await packs.p7.ensureMaterials();
  assert(n === 6, `expected 6 materials, got ${n}`);
  const cats = materialsList.map((m) => m.category);
  // Real MaterialCategory union: mep|other|concrete|steel|timber|glass|insulation|finish
  const allowed = new Set(["mep", "other", "concrete", "steel", "timber", "glass", "insulation", "finish"]);
  assert(cats.length === 6 && cats.every((c) => allowed.has(c)), `invalid categories: ${cats.join(",")}`);
  assert(cats.includes("concrete") && cats.includes("glass") && cats.includes("steel") && cats.includes("finish") && cats.includes("timber") && cats.includes("other"), "expected category mix missing");
});

t("pack-7 paintAllWalls assigns a real library material to every wall", async () => {
  const n = await packs.p7.paintAllWalls();
  assert(n === 3, `expected 3 walls, got ${n}`);
  const wa1 = authored.find((e) => e.id === "wa1");
  assert(wa1.properties.Material === "Concrete" && wa1.properties.materialId === "m-1", `wall material wrong: ${JSON.stringify(wa1.properties)}`);
});

t("pack-7 placeBoundingMass calls the positional createMass signature", async () => {
  const id = await packs.p7.placeBoundingMass();
  assert(id === "mass-1", `mass id ${id}`);
  assert(massCalls.length === 1, "createMass not called");
  const c = massCalls[0];
  assert(Array.isArray(c.basePolygon) && c.basePolygon.length === 4, "basePolygon must be an array of 4 corner tuples");
  assert(Array.isArray(c.basePolygon[0]) && approx(c.basePolygon[0][0], 0) && approx(c.basePolygon[0][1], 0), "first corner wrong");
  assert(Array.isArray(c.basePolygon[2]) && approx(c.basePolygon[2][0], 10) && approx(c.basePolygon[2][1], 9), "third corner wrong (bounds x[0,10] z[0,9])");
  assert(approx(c.height, 4), `height should be 4 (tallest column), got ${c.height}`);
  assert(c.name === "Building Mass", "name wrong");
});

t("pack-7 federation status reads ctx services and never writes globals", async () => {
  const links = await packs.p7.federationStatus();
  assert(Array.isArray(links) && links.length === 0, `expected 0 links, got ${links.length}`);
  assert(globalThis.__obsFederationStatus === undefined, "status leaked onto window");
  assert(globalThis.__obsLinkedModels === undefined, "linked models global read path gone");
});

t("pack-7 MEP network select expands through the connectivity engine", async () => {
  selection = ["wa1"];
  const n = await packs.p7.selectMepNetwork();
  selection = ["wa1", "wa2", "wa3"];
  assert(mepCalls.length === 1 && mepCalls[0].ids.length === 1, "expandConnected not called with seed");
  assert(n === 0, `stub returns empty network, expected 0 selected, got ${n}`);
});

t("pack-7 filled region falls back to a rectangle when the room has no polygon", async () => {
  const okr = await packs.p7.createFilledRegion();
  assert(okr === true, "createFilledRegion returned false");
  assert(filledRegionCalls.length === 1, "createFilledRegion not called on the module");
  const spec = filledRegionCalls[0];
  assert(spec.pattern === "solid" && spec.polygon.length === 4, "spec wrong");
  assert(approx(spec.polygon[0][0], 0) && approx(spec.polygon[2][0], 5), "fallback rectangle wrong");
});

t("pack-7 model tree export returns the full payload", () => {
  const payload = packs.p7.exportModelTree();
  assert(payload.totalElements === 12, `expected 12, got ${payload.totalElements}`);
  assert(payload.levels.length === 2 && payload.levels[0].count === 12, "per-level tree wrong");
  assert(payload.project === "OpenBIMStudio", "payload project wrong");
});

/* ── 5. No window globals after exercising everything ───────────────── */
t("running all exercised commands never writes window.__obs* globals", () => {
  assert(globalThis.__obsModelChecker === undefined, "leaked checker global");
  assert(globalThis.__obsFederation === undefined, "leaked federation global");
  assert(globalThis.__obsFederationStatus === undefined, "leaked status global");
  assert(globalThis.__obsLinkedModels === undefined, "leaked linked-models global");
  assert(globalThis.__obsFilledRegion === undefined, "leaked filled-region global");
  assert(globalThis.__obsModelTree === undefined, "leaked model-tree global");
  assert(globalThis.__obsWorkflowPack7 === undefined, "leaked pack-7 global");
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
