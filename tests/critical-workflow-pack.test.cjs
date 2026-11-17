/**
 * tests/critical-workflow-pack.test.cjs
 *
 * Regression tests for the 10-command critical workflow pack
 * (src/modules/bim-gaps/critical-workflow-pack.ts).
 *
 * Why this file exists: the pack originally published its results on window
 * globals and registered its commands through channels that had no backing
 * (a legacy window registry method that does not exist, and a CustomEvent
 * nobody listens to) — so the 10 commands never appeared in the palette and
 * the ui-honesty global ratchet broke. These tests pin the corrected
 * behaviour:
 *   1. all 10 commands are registered into the real command palette
 *   2. results live in module-local state surfaced via
 *      ctx.features.workflowPack getters, never on window
 *   3. the schedule/takeoff/tagging math is correct on fixtures
 *
 * Run: `node tests/critical-workflow-pack.test.cjs`
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

/* ── localStorage shim (before module load) ─────────────────────────── */
const lsStore = new Map();
globalThis.localStorage = {
  setItem: (k, v) => lsStore.set(String(k), String(v)),
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => lsStore.delete(String(k)),
  clear: () => lsStore.clear(),
};

/* ── Compile the single module to CommonJS ──────────────────────────── */
const repoRoot = path.resolve(__dirname, "..");
const entry = path.join(repoRoot, "src/modules/bim-gaps/critical-workflow-pack.ts");
const tmpOut = path.join(os.tmpdir(), "obs-cwp-test-" + Date.now());
fs.mkdirSync(tmpOut, { recursive: true });
// --noResolve: compile only this file (its transitive graph pulls in DOM/pwa
// code that cannot load under CommonJS). Every local import is stubbed via the
// Module._load hook below, mirroring tests/ai-presets.test.cjs.
execSync(
  `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(tmpOut)} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const compiled = path.join(tmpOut, "critical-workflow-pack.js");
const output = fs.readFileSync(compiled, "utf8");

/* ── Stubs for the module's local imports ───────────────────────────── */
const notices = [];
const registered = [];
const createdSheets = [];
const createdViews = [];
const existingSheets = [];
const existingViews = [];

// Authoring fixture store (shared by all commands).
const authored = [
  { id: "d1", type: "door", params: { width: 0.9, height: 2.1 }, properties: {} },
  { id: "d2", type: "door", params: { width: 0.9, height: 2.1 }, properties: { Mark: "D07" } },
  { id: "d3", type: "door", params: { width: 1.0, height: 2.1 }, properties: {} },
  { id: "w1", type: "window", params: { width: 1.2, height: 1.4 }, properties: {} },
  { id: "c1", type: "column", params: { point: [0, 0], height: 3 }, properties: {} },
  { id: "c2", type: "column", params: { point: [4, 0], height: 3.5 }, properties: {} },
  { id: "c3", type: "column", params: { point: [8, 0], height: 4 }, properties: {} },
  { id: "wa1", type: "wall", params: { start: [0, 0], end: [10, 0], thickness: 0.2, height: 3 }, properties: { wallTypeId: "W-200" } },
  { id: "wa2", type: "wall", params: { start: [0, 4], end: [0, 9], thickness: 0.2, height: 3 }, properties: { wallTypeId: "W-200" } },
  { id: "wa3", type: "wall", params: { start: [2, 2], end: [8, 2], thickness: 0.3, height: 3 }, properties: { wallTypeId: "W-300" } },
  { id: "s1", type: "slab", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] }, properties: {} },
  { id: "r1", type: "room", params: {}, properties: {} },
];
let columnCreateCalls = [];

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
        getSelectedIds: () => ["wa1", "wa2", "wa3"],
        createElementByType: async (kind, opts) => {
          columnCreateCalls.push({ kind, opts });
          return "col-" + columnCreateCalls.length;
        },
        rebuildAuthored: () => {},
      },
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../core/context") return ctxMock;
  if (request === "../../core/notify") {
    return { notify: (kind, msg) => notices.push({ kind, msg }) };
  }
  if (request === "../views/plan-tags") {
    return {
      buildTagAll: (targets) =>
        targets.map((e) => ({ id: e.id, type: e.type, mark: e.properties?.Mark ?? e.properties?.mark ?? "" })),
    };
  }
  if (request === "../sheets/sheets") {
    return {
      createSheet: (spec) => { createdSheets.push(spec); return { ...spec }; },
      listSheets: () => existingSheets,
    };
  }
  if (request === "../views/store") {
    return {
      createView: (kind, name) => { createdViews.push({ kind, name }); return { kind, name, plan: {}, elevation: {} }; },
      listViews: () => [...existingViews, ...createdViews],
    };
  }
  if (request === "../../features/command-palette") {
    return { registerCommand: (cmd) => registered.push(cmd), unregisterCommand: () => {}, listCommands: () => registered };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const mod = new Module(compiled, module);
mod.filename = compiled;
mod.paths = Module._nodeModulePaths(path.dirname(compiled));
mod._compile(output, compiled);
const pack = mod.exports;

/* ── 1. Registration into the real command palette ──────────────────── */
t("setup registers exactly 10 commands into the palette registry", () => {
  assert(typeof pack.setupCriticalWorkflowPack === "function", "setup export missing");
  pack.setupCriticalWorkflowPack();
  assert(registered.length === 10, `expected 10 commands, got ${registered.length}`);
  const ids = registered.map((c) => c.id);
  for (const want of ["rg-autotag", "rg-door-sch", "rg-win-sch", "rg-wall-sch", "rg-sheet-pack",
    "rg-views-pack", "rg-takeoff", "rg-cols-grid", "rg-matchprop", "rg-space"]) {
    assert(ids.includes(want), `missing command ${want}`);
  }
});

t("every registered command has label, category and a runnable function", () => {
  for (const c of registered) {
    assert(typeof c.label === "string" && c.label.length > 3, `${c.id}: bad label`);
    assert(typeof c.category === "string" && c.category.length > 2, `${c.id}: bad category`);
    assert(typeof c.run === "function", `${c.id}: run not a function`);
  }
});

t("service API published on ctx.features.workflowPack with result getters", () => {
  const svc = ctxMock.ctx.features.workflowPack;
  assert(!!svc, "workflowPack service key missing");
  for (const fn of ["autoTagAll", "buildDoorSchedule", "materialTakeoff", "getAutoTags", "getLastSchedule", "getLastTakeoff"]) {
    assert(typeof svc[fn] === "function", `service missing ${fn}`);
  }
});

/* ── 2. No window globals (module-local state instead) ──────────────── */
t("running the pack never writes window globals", () => {
  pack.buildDoorSchedule();
  pack.materialTakeoff();
  pack.autoTagAll();
  assert(globalThis.__obsAutoTags === undefined, "leaked auto-tags global");
  assert(globalThis.__obsLastSchedule === undefined, "leaked schedule global");
  assert(globalThis.__obsTakeoff === undefined, "leaked takeoff global");
  assert(globalThis.__obsWorkflowPack === undefined, "leaked api global");
});

/* ── 3. Auto-tag behaviour ──────────────────────────────────────────── */
t("autoTagAll assigns marks only to unmarked elements and returns tag count", () => {
  // Reset marks from any earlier run.
  for (const e of authored) { delete e.properties.Mark; }
  authored[1].properties.Mark = "D07";
  const n = pack.autoTagAll();
  assert(n === authored.filter((e) => ["door", "window", "column", "room", "equipment", "stairs"].includes(e.type)).length,
    `tag count ${n}`);
  assert(authored[0].properties.Mark === "D01", `door mark = ${authored[0].properties.Mark}`);
  assert(authored[1].properties.Mark === "D07", "existing mark overwritten");
  assert(authored[3].properties.Mark === "W01", `window mark = ${authored[3].properties.Mark}`);
  assert(authored[4].properties.Mark === "C01", `column mark = ${authored[4].properties.Mark}`);
  const svc = ctxMock.ctx.features.workflowPack;
  assert(Array.isArray(svc.getAutoTags()) && svc.getAutoTags().length === n, "getAutoTags state mismatch");
});

/* ── 4. Schedules ───────────────────────────────────────────────────── */
t("door schedule groups by mark+size and counts instances", () => {
  const rows = pack.buildDoorSchedule();
  assert(rows.length === 3, `expected 3 door rows, got ${rows.length}`);
  const d01 = rows.find((r) => r.mark === "D01");
  assert(d01 && d01.count === 1 && d01.size === "900×2100", "D01 row wrong");
  const d07 = rows.find((r) => r.mark === "D07");
  assert(d07 && d07.count === 1, "D07 row wrong");
  const last = ctxMock.ctx.features.workflowPack.getLastSchedule();
  assert(last && last.title === "Door Schedule" && last.rows.length === 3 && typeof last.at === "number",
    "getLastSchedule state wrong");
  assert(lsStore.has("obs.schedule.Door_Schedule"), "schedule not persisted to localStorage");
});

t("wall schedule accumulates length per type+thickness", () => {
  const rows = pack.buildWallSchedule();
  const w200 = rows.find((r) => r.mark === "W-200");
  assert(w200, "W-200 row missing");
  assert(w200.count === 2, `W-200 count ${w200.count}`);
  assert(Math.abs(w200.length - 15) < 0.01, `W-200 length ${w200.length}`); // 10 + 5
  const w300 = rows.find((r) => r.mark === "W-300");
  assert(w300 && w300.count === 1 && Math.abs(w300.length - 6) < 0.01, "W-300 row wrong");
});

/* ── 5. Material takeoff ────────────────────────────────────────────── */
t("material takeoff computes wall length/area, slab area and counts", () => {
  const out = pack.materialTakeoff();
  const wallLen = out.find((r) => r.category === "Walls length");
  assert(Math.abs(wallLen.qty - 21) < 0.01, `wall length ${wallLen.qty}`); // 10+5+6
  const wallArea = out.find((r) => r.category === "Walls area (gross)");
  assert(Math.abs(wallArea.qty - 63) < 0.01, `wall area ${wallArea.qty}`); // 21×3
  const slab = out.find((r) => r.category === "Floor/roof area");
  assert(Math.abs(slab.qty - 80) < 0.01, `slab area ${slab.qty}`); // 10×8 shoelace
  assert(out.find((r) => r.category === "Doors").qty === 3, "door count");
  assert(out.find((r) => r.category === "Windows").qty === 1, "window count");
  assert(out.find((r) => r.category === "Columns").qty === 3, "column count");
  const svc = ctxMock.ctx.features.workflowPack;
  assert(svc.getLastTakeoff().length === out.length, "getLastTakeoff state mismatch");
});

/* ── 6. Match properties ────────────────────────────────────────────── */
t("matchProperties copies type props between same-type elements only", () => {
  const n = pack.matchProperties("wa1", ["wa2", "wa3", "c1"]);
  assert(n === 2, `expected 2 walls matched, got ${n}`); // wa2+wa3 same type, c1 skipped
  assert(authored[8].properties.wallTypeId === "W-200", "wa3 wallTypeId not copied");
  assert(authored[8].params.thickness === 0.2, "wa3 thickness not copied");
});

t("matchPropertiesFromSelection uses authoring selection (source = first)", () => {
  for (const e of authored.filter((x) => x.type === "wall")) e.properties.wallTypeId = "W-X";
  authored[7].properties.wallTypeId = "W-200";
  authored[7].params.thickness = 0.25;
  const n = pack.matchPropertiesFromSelection(); // selection = [wa1, wa2, wa3]
  assert(n === 2, `expected 2 matched from selection, got ${n}`);
  assert(authored[8].properties.wallTypeId === "W-200", "selection match failed on wa2");
});

/* ── 7. Space evenly ────────────────────────────────────────────────── */
t("spaceElementsEvenly anchors first/last and interpolates the middle", () => {
  const n = pack.spaceElementsEvenly(["c1", "c2", "c3"]);
  assert(n === 3, `expected 3, got ${n}`);
  const pts = [authored[4], authored[5], authored[6]].map((e) => e.params.point);
  assert(pts[0][0] === 0 && pts[2][0] === 8, "endpoints must stay anchored");
  assert(Math.abs(pts[1][0] - 4) < 0.001, `middle x = ${pts[1][0]}`);
});

/* ── 8. Columns on grid ─────────────────────────────────────────────── */
t("columnsOnGrid places columns at unique grid intersections", async () => {
  columnCreateCalls = [];
  const n = await pack.columnsOnGrid();
  assert(n === 4, `expected 4 intersections, got ${n}`); // A×1, A×2, B×1, B×2
  assert(columnCreateCalls.length === 4 && columnCreateCalls[0].kind === "column", "createElement not called for columns");
});

/* ── 9. Sheet + view packs ──────────────────────────────────────────── */
t("sheet pack creates missing standard sheets and skips existing", () => {
  createdSheets.length = 0;
  existingSheets.length = 0;
  existingSheets.push({ number: "A-101" }, { number: "A-401" });
  const n = pack.createSheetPack();
  assert(n === 4, `expected 4 new sheets, got ${n}`);
  const nums = createdSheets.map((s) => s.number).sort();
  assert(JSON.stringify(nums) === JSON.stringify(["A-001", "A-201", "A-301", "A-501"]), `created ${nums}`);
});

t("views pack creates plan per level + 4 elevations + section, skips existing", () => {
  createdViews.length = 0;
  existingViews.length = 0;
  const n = pack.createStandardViews();
  assert(n === 7, `expected 7 views, got ${n}`); // 2 plans + 4 elevations + 1 section
  const kinds = createdViews.map((v) => v.kind);
  assert(kinds.filter((k) => k === "plan").length === 2, "plan per level");
  assert(kinds.filter((k) => k === "elevation").length === 4, "4 elevations");
  assert(kinds.includes("section"), "section");
  // Second run: nothing new.
  const n2 = pack.createStandardViews();
  assert(n2 === 0, `second run should create 0, got ${n2}`);
});

/* ── 10. Honest toasts ──────────────────────────────────────────────── */
t("success toasts never point users at the console or window globals", () => {
  for (const n of notices) {
    if (n.kind !== "success") continue;
    assert(!/console/i.test(n.msg), `toast points at console: "${n.msg}"`);
    assert(!/__obs/i.test(n.msg), `toast points at a global: "${n.msg}"`);
  }
});

Module._load = originalLoad;
if (fail) process.exit(1);
console.log(`=== critical-workflow-pack tests complete: ${pass} passed, ${fail} failed ===`);
