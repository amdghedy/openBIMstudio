/**
 * tests/critical-workflow-pack-8.test.cjs
 *
 * Regression tests for critical workflow pack 8
 * (src/modules/bim-gaps/critical-workflow-pack-8.ts — 11 commands).
 *
 * Why this file exists: pack 8 shipped (a) with 5 window.__obs* globals —
 * the honesty ratchet forbids new ones, (b) registering its 11 commands
 * through the window CustomEvent "obs-register-command" channel that has no
 * listener anywhere in the repo — the exact dead-channel bug class packs 1–7
 * were repaired from, (c) calling APIs that do not exist (nl-query executor
 * given a parsed object instead of the raw string, addModelCurve with an
 * options bag instead of (hostId, faceIndex, points…), ../shared-params/index
 * and ../parameter-engine/engine module paths that are not in the repo, and
 * a parameter-engine evaluate() that has no such export), and (d) with 8
 * compile errors that turned the whole CI + production build red. These
 * tests pin the repaired behaviour against the REAL signatures of the
 * modules the pack calls.
 *
 * Run: `node tests/critical-workflow-pack-8.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert");

let pass = 0;
let fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      pending.push(
        r.then(
          () => { console.log(`  PASS ${name}`); pass++; },
          (e) => { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; },
        ),
      );
      return;
    }
    console.log(`  PASS ${name}`); pass++;
  } catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}

/* ── localStorage shim (before module load) ─────────────────────────── */
const lsStore = new Map();
globalThis.localStorage = {
  setItem: (k, v) => lsStore.set(String(k), String(v)),
  getItem: (k) => (lsStore.has(String(k)) ? lsStore.get(String(k)) : null),
  removeItem: (k) => lsStore.delete(String(k)),
  clear: () => lsStore.clear(),
};

/* ── Compile pack 8 to CommonJS ─────────────────────────────────────── */
const repoRoot = path.resolve(__dirname, "..");
const tmp = path.join(os.tmpdir(), "obs-cwp8-test-" + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const entry = path.join(repoRoot, "src/modules/bim-gaps/critical-workflow-pack-8.ts");
execSync(
  `npx tsc ${JSON.stringify(entry)} --outDir ${JSON.stringify(tmp)} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const compiledFile = path.join(tmp, "critical-workflow-pack-8.js");
const compiledSrc = fs.readFileSync(compiledFile, "utf8");

/* ── Compile the REAL nl-model (parser/planner/executor) too ──────────
   runNlModel is tested against the real words-to-room code, not a stub
   of it — only the authoring engine behind it is faked (see ctxMock). */
const nlModelDir = path.join(repoRoot, "src/modules/nl-model");
execSync(
  `npx tsc ${JSON.stringify(path.join(nlModelDir, "index.ts"))} ` +
  `${JSON.stringify(path.join(nlModelDir, "parse.ts"))} ` +
  `${JSON.stringify(path.join(nlModelDir, "plan.ts"))} ` +
  `${JSON.stringify(path.join(nlModelDir, "execute.ts"))} ` +
  `--outDir ${JSON.stringify(path.join(tmp, "nl-model"))} ` +
  `--module commonjs --target es2020 --lib es2020 --skipLibCheck --strict ` +
  `--ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: repoRoot, stdio: "pipe" },
);
const nlModel = require(path.join(tmp, "nl-model", "index.js"));

/* ── Fixtures ───────────────────────────────────────────────────────── */
const authored = [
  { id: "d1", type: "door", hostId: "wa1", params: {}, properties: {} },
  { id: "d2", type: "door", hostId: "wa2", params: {}, properties: {} },
  { id: "d3", type: "door", params: {}, properties: {} }, // unhosted
  { id: "w1", type: "window", hostId: "wa1", params: {}, properties: {} },
  { id: "wa1", type: "wall", params: { start: [0, 0], end: [10, 0] }, properties: {} },
  { id: "s1", type: "slab", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]] }, properties: {} },
];
let selection = [];
const notices = [];
const registered = [];
const automationCalls = { ensure: 0, added: [], runs: [] };
const nlCalls = [];
const savedCalls = [];
const curveCalls = [];
const sharedAdded = [];
let sharedList = [];
const paramCalls = { parse: [], format: [], symbols: [] };
const twinRows = [{ type: "wall", canResize: true }, { type: "door", canResize: false }];

const createdElements = [];
const ctxMock = {
  ctx: {
    features: {
      authoring: {
        getElements: () => authored,
        getLevels: () => [{ id: "L0", name: "Ground", elevation: 0 }],
        getGrids: () => [{ id: "A", start: [-1, 0], end: [12, 0] }],
        getSelectedIds: () => [...selection],
        setSelectedAuthored: (ids) => { selection = ids.map(String); },
        // Real createElementByType contract: (type, params, hostId?) → id | null.
        // The fake commits into the fixture so later reads see the room.
        createElementByType: async (type, params, hostId) => {
          const id = `new-${type}-${createdElements.length + 1}`;
          const el = { id, type, params: { ...(params ?? {}) }, ...(hostId ? { hostId } : {}), properties: {} };
          createdElements.push(el);
          authored.push(el);
          return id;
        },
      },
    },
  },
};

/* ── Stub every module pack 8 imports (specifiers stay literal because
   the pack is compiled with --noResolve) ────────────────────────────── */
// three.js lives in node_modules, unreachable from /tmp — permissive proxy.
const threeStub = new Proxy({}, {
  get: (_t, prop) => {
    if (prop === "__esModule") return false;
    if (prop === "Box3" || prop === "Vector3") {
      // minimal shape for frameSelection: union/expandByPoint/isEmpty/getCenter/getSize
      const vec = { x: 0, y: 0, z: 0, copy() {}, set() { return this; } };
      return function () {
        return {
          isEmpty: () => false,
          union: () => {},
          expandByPoint: () => {},
          getCenter: () => vec,
          getSize: () => vec,
          min: vec, max: vec,
        };
      };
    }
    return function Ctor(..._args) { return { isProxyThree: true, type: String(prop) }; };
  },
});

const stubs = {
  "three": threeStub,
  "../../core/context": ctxMock,
  "../../features/command-palette": {
    registerCommand: (cmd) => registered.push(cmd),
    unregisterCommand: () => {},
    listCommands: () => registered,
  },
  "../../core/notify": {
    notify: (kind, msg) => notices.push({ kind, msg }),
  },
  "../automation/rules": {
    ensureDefaultRules: () => { automationCalls.ensure++; },
    listRules: () => [{ name: "built-in-1" }, ...automationCalls.added.map((r) => ({ name: r.name }))],
    addRule: (r) => { automationCalls.added.push(r); },
    runRulesByTrigger: (trg) => { automationCalls.runs.push(trg); return 2; },
  },
  "../cde/registry": {
    listCdeProviders: () => [{ id: "acc", name: "ACC" }, { id: "bimplus", name: "Bimplus" }],
  },
  "../cde/providers": { registerCdeProviders: () => {} },
  "../navigation/framing": { frameBox: () => true },
  "../nl-query/executor": {
    // Real contract: executeNLQuery(rawQuery: string, elements?: {id, category,
    // properties?}[]) → { parsed, matchedCount, matchedIds, durationMs }.
    // authoredToQueryElement maps an authored element (geometry in params)
    // to that shape — Height/Width/Length come from the live params.
    authoredToQueryElement: (el) => {
      const params = el.params ?? {};
      const properties = { ...(el.properties ?? {}) };
      if (typeof params.height === "number") properties.Height = params.height;
      if (typeof params.thickness === "number") properties.Width = params.thickness;
      else if (typeof params.width === "number") properties.Width = params.width;
      if (Array.isArray(params.start) && Array.isArray(params.end)) {
        properties.Length = Math.hypot(params.end[0] - params.start[0], params.end[1] - params.start[1]);
      }
      return { id: String(el.id), category: String(el.category ?? el.type ?? "").toUpperCase(), properties };
    },
    executeNLQuery: (rawQuery, elements) => {
      nlCalls.push({ rawQuery, elements });
      assert.strictEqual(typeof rawQuery, "string", "executor must receive the RAW STRING, not a parsed object");
      assert.ok(Array.isArray(elements), "executor must receive the element array");
      for (const el of elements) {
        assert.ok(el && typeof el.id === "string" && typeof el.category === "string", "elements must be {id, category, properties}");
      }
      const walls = elements.filter((el) => el.category.includes("IFCWALL") || el.category === "WALL");
      return {
        parsed: { rawQuery, targetCategories: ["IFCWALL"], action: "select" },
        matchedCount: walls.length,
        matchedIds: walls.map((el) => el.id),
        durationMs: 1,
      };
    },
  },
  "../nl-query/saved-queries": {
    saveQuery: (q) => { savedCalls.push(q); },
    getSavedQueries: () => savedCalls,
  },
  "../model-curves/types": {
    // Real contract: addModelCurve(hostElementId, faceIndex, points, closed?, color?).
    addModelCurve: (hostElementId, faceIndex, points, closed, color) => {
      curveCalls.push({ hostElementId, faceIndex, points, closed, color });
      assert.strictEqual(typeof hostElementId, "string", "host id must be a string");
      assert.strictEqual(faceIndex, 0, "reference axes go on face 0");
      assert.ok(Array.isArray(points) && points.length === 2, "reference axis = 2-point polyline");
      return { id: `mc-${curveCalls.length}`, hostElementId, faceIndex, points };
    },
  },
  "../shared-params/shared-params": {
    sharedParamsStore: {
      listShared: () => sharedList.map((p) => ({ ...p })),
      addShared: (input) => {
        assert.ok(input && typeof input.name === "string", "addShared needs {name, type, group, instance}");
        assert.ok(input.type === "text" || input.type === "number", `unexpected ParameterType ${input.type}`);
        assert.strictEqual(input.instance, true, "seeded params are instance params");
        const p = { guid: `g-${sharedAdded.length + 1}`, ...input };
        sharedList.push(p);
        sharedAdded.push(input);
        return p;
      },
    },
  },
  "../parameter-engine/index": {
    parseParameterValue: (def, input) => {
      paramCalls.parse.push({ dataType: def.dataType, input });
      assert.strictEqual(def.dataType, "number", "ping must exercise the numeric parser");
      const num = Number(String(input).trim());
      if (!Number.isFinite(num)) return { value: null, problem: { parameter: def.id, code: "type-mismatch" } };
      return { value: num, problem: null };
    },
    formatParameterValue: (def, value) => {
      paramCalls.format.push({ value });
      return String(value);
    },
    referencedSymbols: (formula, defs) => {
      paramCalls.symbols.push({ formula, defs: defs.length });
      return formula.match(/[A-Za-z_]/g) ?? [];
    },
  },
  "../native-twin/capabilities": { capabilityMatrixRows: () => twinRows },
  "../nl-model/index": nlModel,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request];
  return originalLoad(request, parent, isMain);
};

const mod = new Module(compiledFile, module);
mod.filename = compiledFile;
mod.paths = Module._nodeModulePaths(path.dirname(compiledFile));
mod._compile(compiledSrc, compiledFile);
const pack = mod.exports;

/* ── A. registration ────────────────────────────────────────────────── */

t("A1 boot registers exactly 11 commands into the REAL palette", () => {
  registered.length = 0;
  pack.setupCriticalWorkflowPack8();
  assert.strictEqual(registered.length, 11);
  const ids = registered.map((c) => c.id);
  for (const want of ["rg-auto-seed", "rg-auto-run", "rg-cde-list", "rg-frame-sel", "rg-nl-walls", "rg-nl-room", "rg-hierarchy", "rg-curves", "rg-shared-p", "rg-param-eng", "rg-twin-caps"]) {
    assert.ok(ids.includes(want), `missing command ${want}`);
  }
  assert.ok(registered.every((c) => typeof c.label === "string" && typeof c.run === "function"));
});

  t("A2 the dead CustomEvent channel is gone from source and compiled output", () => {
    const src = fs.readFileSync(entry, "utf8");
    assert.ok(!src.includes("obs-register-command"), "source still dispatches the dead channel");
    assert.ok(!compiledSrc.includes("obs-register-command"), "compiled output still dispatches the dead channel");
    assert.ok(!/new\s+CustomEvent/.test(compiledSrc), "compiled output still constructs CustomEvents");
    assert.ok(src.includes('import { registerCommand } from "../../features/command-palette"'));
  });

t("A3 zero window.__obs* mentions in pack-8 source (ratchet guard)", () => {
  const src = fs.readFileSync(entry, "utf8");
  const hits = src.match(/__obs[A-Za-z0-9]+/g) ?? [];
  assert.strictEqual(hits.length, 0, `found ${hits.join(", ")}`);
  assert.ok(!/window\s*as\s*Any|window\./.test(src.replace(/globalThis/g, "")), "pack-8 should not touch window at all");
  assert.ok(!compiledSrc.includes("__obs"), "compiled output has __obs mentions");
});

/* ── B. command bodies on fixtures ─────────────────────────────────── */

t("B1 runNlQuery passes the RAW STRING to the executor and selects hits", () => {
  nlCalls.length = 0; selection = [];
  // Capture the fixture size now: later async tests append elements to the
  // shared fixture while this query is in flight.
  const beforeCount = authored.length;
  return Promise.resolve().then(async () => {
    const r = await pack.runNlQuery("select all walls");
    assert.strictEqual(nlCalls.length, 1);
    assert.strictEqual(nlCalls[0].rawQuery, "select all walls");
    // 2 walls in the fixture (wa1 + the IFC-wall categories from types)
    assert.strictEqual(nlCalls[0].elements.length, beforeCount);
    assert.deepStrictEqual(r.matchedIds, ["wa1"]);
    assert.deepStrictEqual(selection, ["wa1"]);
    assert.ok(savedCalls.includes("select all walls"), "query saved for reuse");
    assert.ok(pack.getLastNlQuery()?.text === "select all walls");
  });
});

t("B1b runNlModel models the 4×6 room through the REAL nl-model code", () => {
  createdElements.length = 0;
  notices.length = 0;
  const baseline = authored.length;
  return Promise.resolve().then(async () => {
    const r = await pack.runNlModel("draw a 4×6 room with a door and two windows");
    assert.strictEqual(r.ok, true, `runNlModel failed: ${r.error ?? ""}`);
    assert.strictEqual(r.wallIds.length, 4);
    assert.strictEqual(r.openingIds.length, 3);
    // 4 walls form the 4×6 rectangle, origin (0,0).
    const walls = createdElements.filter((e) => e.type === "wall");
    assert.strictEqual(walls.length, 4);
    assert.deepStrictEqual(walls[0].params.start, [0, 0]);
    assert.deepStrictEqual(walls[0].params.end, [4, 0]);
    assert.deepStrictEqual(walls[2].params.start, [4, 6]);
    // 1 door + 2 windows, each hosted on a real wall id from this run.
    const doors = createdElements.filter((e) => e.type === "door");
    const windows = createdElements.filter((e) => e.type === "window");
    assert.strictEqual(doors.length, 1);
    assert.strictEqual(windows.length, 2);
    for (const o of [...doors, ...windows]) {
      assert.ok(r.wallIds.includes(o.hostId), `${o.type} hosted on an unknown wall`);
      assert.ok(o.params.offsetAlongHost > 0, "hosted offset must be on the wall");
    }
    assert.strictEqual(doors[0].params.width, 0.9);
    assert.strictEqual(windows[0].params.width, 1.2);
    assert.ok(pack.getLastNlModel()?.text === "draw a 4×6 room with a door and two windows");
    assert.ok(notices.some((n) => n.kind === "success" && /4 × 6 m room/.test(n.msg)));

    // An unparseable sentence is an honest failure, not a hallucinated room.
    const before = createdElements.length;
    const bad = await pack.runNlModel("draw something nice");
    assert.strictEqual(bad.ok, false);
    assert.ok(/does not describe a room|no room size/.test(bad.error), `unexpected error: ${bad.error}`);
    assert.strictEqual(createdElements.length, before, "a failed parse must not create elements");
    // The room was committed into the shared fixture by the fake engine —
    // take it back out so later tests still see the original 6 elements.
    authored.length = baseline;
  });
});

t("B2 hierarchyReport: totals, byType and hosted counts on the fixture", () => {
  const r = pack.hierarchyReport();
  assert.strictEqual(r.total, authored.length);
  assert.strictEqual(r.byType.door, 3);
  assert.strictEqual(r.byType.window, 1);
  assert.strictEqual(r.byType.wall, 1);
  assert.strictEqual(r.byType.slab, 1);
  assert.strictEqual(r.hosted.doors, 2);   // d1, d2 hosted; d3 unhosted
  assert.strictEqual(r.hosted.windows, 1); // w1 hosted
  assert.strictEqual(r.hosted.unhosted, 1);
  assert.strictEqual(r.levels, 1);
  assert.strictEqual(r.grids, 1);
  assert.deepStrictEqual(pack.getLastHierarchyReport(), r);
});

t("B3 placeAxisModelCurves draws on the REAL host-bound signature (slab preferred)", async () => {
  curveCalls.length = 0;
  return Promise.resolve().then(async () => {
    const n = await pack.placeAxisModelCurves();
    assert.strictEqual(n, 2);
    assert.ok(curveCalls.every((c) => c.hostElementId === "s1"), "slab preferred as host");
    assert.ok(curveCalls.every((c) => Array.isArray(c.points) && c.points.length === 2));
  });
});

t("B4 seedSharedParams seeds the 5 BIM parameters through the real store", async () => {
  sharedList = []; sharedAdded.length = 0;
  return Promise.resolve().then(async () => {
    const n = await pack.seedSharedParams();
    assert.strictEqual(n, 5);
    const names = sharedAdded.map((p) => p.name);
    for (const want of ["FireRating", "Mark", "Comments", "Cost", "Area"]) {
      assert.ok(names.includes(want), `missing shared param ${want}`);
    }
    const n2 = await pack.seedSharedParams(); // idempotent
    assert.strictEqual(n2, 0, "second seed must not duplicate");
  });
});

t("B5 parameterEnginePing exercises parse→format and the symbol resolver", async () => {
  paramCalls.parse.length = 0; paramCalls.format.length = 0; paramCalls.symbols.length = 0;
  return Promise.resolve().then(async () => {
    const ok = await pack.parameterEnginePing();
    assert.strictEqual(ok, true);
    assert.strictEqual(paramCalls.parse.length, 1);
    assert.strictEqual(paramCalls.parse[0].dataType, "number");
    assert.strictEqual(paramCalls.format.length, 1);
    assert.strictEqual(paramCalls.symbols.length, 1);
  });
});

t("B6 CDE providers land on the module getter, not a window global", async () => {
  return Promise.resolve().then(async () => {
    const list = await pack.listCdeProvidersCmd();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(pack.getLastCdeProviders().length, 2);
  });
});

t("B7 twin capability matrix lands on the module getter", async () => {
  return Promise.resolve().then(async () => {
    const rows = await pack.twinCapabilityMatrix();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(pack.getLastTwinCaps().length, 2);
  });
});

t("B8 automation commands drive the real rules module", async () => {
  automationCalls.added.length = 0; automationCalls.runs.length = 0;
  const seeded = await pack.seedAutomationRules();
  assert.ok(automationCalls.ensure >= 1);
  assert.strictEqual(seeded, 3); // built-in-1 + 2 extras (pack returns the post-add total)
  assert.deepStrictEqual(automationCalls.added.map((r) => r.name), ["Warn unhosted doors", "Tag new walls"]);
  const ran = await pack.runOnOpenRules();
  assert.strictEqual(ran, 2);
  assert.ok(automationCalls.runs.includes("on-open"));
});

/* ── C. getter surface ─────────────────────────────────────────────── */

t("C1 the pack api exposes the five result getters", () => {
  pack.setupCriticalWorkflowPack8();
  const feats = ctxMock.ctx.features;
  assert.strictEqual(typeof feats.workflowPack8.getLastNlQuery, "function");
  assert.strictEqual(typeof feats.workflowPack8.getLastNlModel, "function");
  assert.strictEqual(typeof feats.workflowPack8.getLastHierarchyReport, "function");
  assert.strictEqual(typeof feats.workflowPack8.getLastCdeProviders, "function");
  assert.strictEqual(typeof feats.workflowPack8.getLastTwinCaps, "function");
});

/* ── D. no dead localStorage channels ──────────────────────────────── */

t("D1 pack-8 writes no dead localStorage keys (obs.modelCurves / obs.sharedParams gone)", () => {
  const src = fs.readFileSync(entry, "utf8");
  assert.ok(!src.includes("obs.modelCurves"), "dead localStorage channel for model curves still present");
  assert.ok(!src.includes("obs.sharedParams"), "dead localStorage channel for shared params still present");
  const before = [...lsStore.keys()];
  void before;
});

/* flush async command bodies before exiting */
Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
