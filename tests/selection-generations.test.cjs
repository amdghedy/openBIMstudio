/**
 * tests/selection-generations.test.cjs
 *
 * Hardening item 20, first pair: the two "selection" generations.
 *
 * FINDING — not a true duplicate pair, so nothing is deleted here.
 * The two implementations share the word "selection" but serve disjoint
 * element universes with disjoint state, and both are live:
 *
 *   1. src/features/selection.ts — SelectionManager singleton `selection`.
 *      Fragment (IFC) selection: modelId -> Set<number> local ids, OBC
 *      highlighter bridge, click-to-select on the 3D canvas. Registered
 *      as the canonical `services` SelectionService AND as
 *      ctx.features.selection; main.ts boots it in steps "selection" and
 *      "selection-click". Consumers: main.ts, box-selection.ts,
 *      default-shortcuts.ts, viewport-toolbar.ts, workshare-locks.ts.
 *
 *   2. src/modules/selection/index.ts — pure SelectionEngine (MODIFY
 *      GROUP 1 spec §2). Authored-element selection: string ids + plan
 *      geometry (aabb/curve/point), hit priority vertex > edge >
 *      connector > datum > body, MOD-SEL diagnostics, hosted expansion.
 *      Its ONLY live consumer is the "Sel Inspector" ribbon dialog
 *      (openSelectionInspectorDialog in engine-ui.ts); the Group 1
 *      Move/Rotate/Mirror dialogs read the authored selection from
 *      authoring state instead (selectedAuthoredIds -> __obsAuthoring),
 *      never from the engine. authoring-core exposes the engine CLASS
 *      only (no instance) as a global for the spec's global-exposure
 *      table (pinned by scripts/verify-v71.mjs).
 *
 * Deleting either copy would delete a live feature with no replacement:
 * the manager cannot do plan hit-testing (no geometry, no priority, no
 * MOD-SEL codes) and the engine cannot do fragment selection (no
 * modelId/localId model, no highlighter, no click wiring). The
 * resolution recorded here is therefore: BOTH STAY, the boundary is
 * pinned by this test. The one place the generations were confused
 * (modify-actions "select-similar" read the engine-class global and
 * could never run) was fixed by the select-similar follow-up: it now
 * runs authored select-similar semantics (same type, via the
 * authoring selection) — see the pinned assertion below — and was
 * never silently rewired to the wrong-typed live service.
 *
 * This test exercises the REAL live path, not mocks: it compiles the
 * real src/features/selection.ts (the actual singleton the boot chain
 * registers) and the real src/modules/selection/index.ts with tsc and
 * requires both, then proves — behaviourally and from the wiring —
 * which copy runs where. It must fail if the live path is swapped to
 * the wrong copy (see the sensitivity checks in the PR description).
 *
 * What it does NOT prove (browser level): click-to-select on a real
 * canvas with a loaded fragment model needs the browser harness
 * (items 6-8 exist only as unmerged branches; no browser test pins the
 * live path on main). The fragment methods that need a real
 * FragmentsManager (selectAll / invert / selectSimilar /
 * reconcileFilter with loaded models) are therefore NOT exercised
 * here; only the manager's pure in-memory core (applyClick / snapshot
 * / filter) runs in Node.
 *
 * Run: `node tests/selection-generations.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "not equal"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertDeepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "not deep-equal"}: expected ${e}, got ${a}`);
}
function snapshotPlain(snap) {
  return Object.fromEntries(
    Object.entries(snap).map(([k, v]) => [k, [...v].sort((x, y) => x - y)]),
  );
}

const root = path.resolve(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

// ── Compile the REAL sources ──────────────────────────────────────────────
// Same pattern as tests/v71-modify-group1.test.cjs (tsc --noCheck into a
// temp dir). features/selection.ts pulls the services/context closure, so
// the emit is the whole reachable graph; requiring it executes the real
// module-level register("selection", ...) call.
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-selection-generations-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/features/selection.ts src/modules/selection/index.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

// The compiled modules live outside the repo, so teach Node to resolve
// "three" / "@thatopen/components" from the repo's node_modules
// (pattern from tests/v72-viewcube-navigation.test.cjs).
process.env.NODE_PATH = path.join(root, "node_modules");
require("node:module").Module._initPaths();

const live = require(path.join(tmpOut, "features/selection.js"));
const { selection } = live;
const { tryUse } = require(path.join(tmpOut, "core/services.js"));
const { ctx } = require(path.join(tmpOut, "core/context.js"));
const engMod = require(path.join(tmpOut, "modules/selection/index.js"));
const { SelectionEngine, HIT_PRIORITY } = engMod;

// The manager's category reconciliation reads ctx.fragments.list. In the
// app that is a real FragmentsManager; here no model is loaded, so the
// list is an empty Map and reconciliation is a clean no-op. This is the
// environment the manager expects, not a stub of the code under test:
// selectAll / invert / selectSimilar (which need real fragment models)
// are deliberately NOT exercised here.
ctx.fragments = { list: new Map() };

// ═══ A. The live fragment manager — behaviour only it has ═══════════════
console.log("── live manager (src/features/selection.ts) ──");

t("manager: replace/snapshot use modelId -> Set<number> (fragment model)", () => {
  selection.clear();
  selection.replace({ modelA: new Set([1, 2]) });
  assertEq(selection.size(), 2, "size");
  assertEq(selection.modelCount(), 1, "modelCount");
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelA: [1, 2] }, "snapshot");
  assert(selection.has("modelA", 1), "has(1)");
  assert(!selection.has("modelA", 9), "not has(9)");
  assert(!selection.isEmpty(), "not empty");
});

t("manager: applyClick plain=replace, ctrl=add, shift=remove, alt=remove (live click semantics)", () => {
  selection.clear();
  selection.replace({ modelA: new Set([1, 2]) });
  selection.applyClick("modelA", 3, {});
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelA: [3] }, "plain click replaces");
  selection.applyClick("modelA", 1, { ctrl: true });
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelA: [1, 3] }, "ctrl adds");
  selection.applyClick("modelA", 3, { shift: true });
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelA: [1] }, "shift removes");
  selection.applyClick("modelA", 2, { ctrl: true });
  selection.applyClick("modelA", 2, { alt: true });
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelA: [1] }, "alt removes");
});

t("manager: addMany/removeMany/toggle/clear", () => {
  selection.clear();
  selection.addMany("modelA", [5, 6]);
  selection.addMany("modelB", [1]);
  assertEq(selection.size(), 3, "size after addMany");
  assertEq(selection.modelCount(), 2, "two models");
  selection.toggle("modelA", 5);
  assert(!selection.has("modelA", 5), "toggle removes");
  selection.toggle("modelA", 5);
  assert(selection.has("modelA", 5), "toggle re-adds");
  selection.removeMany("modelA", [5, 6]);
  assertDeepEq(snapshotPlain(selection.snapshot()), { modelB: [1] }, "removeMany");
  selection.clear();
  assert(selection.isEmpty(), "clear empties");
});

t("manager: category filter normalises IFC names (IfcWall matches 'wall')", () => {
  // Selection must be empty here: with a filter set, reconciliation drops
  // selected ids whose category cannot be read from a (here unloaded) model.
  selection.clear();
  selection.setFilter(["wall"]);
  assertDeepEq(selection.getFilter(), ["wall"], "getFilter");
  assert(selection.matchesCategoryName("IfcWall"), "IfcWall matches wall");
  assert(selection.matchesCategoryName("wall"), "wall matches wall");
  assert(!selection.matchesCategoryName("IfcSlab"), "IfcSlab does not match wall");
  assert(
    selection.matchesAuthoredCategoryFilter("Wall", { ifcType: "IfcWall" }),
    "authored filter accepts IFC alias",
  );
  assert(
    !selection.matchesAuthoredCategoryFilter("Slab", { ifcType: "IfcSlab" }),
    "authored filter rejects other IFC type",
  );
  selection.setFilter(null);
  assertEq(selection.getFilter(), null, "filter cleared");
  assert(selection.matchesCategoryName("IfcSlab"), "no filter matches everything");
});

t("manager: has NONE of the engine's API (no HitTest/SelectSingle/SelectWindow/diagnostics)", () => {
  for (const m of ["HitTest", "SelectSingle", "SelectWindow", "SelectByCategory", "GetDiagnostics", "GetSelection", "ExpandHosted"]) {
    assertEq(typeof selection[m], "undefined", `selection.${m} must be undefined`);
  }
});

t("manager: the services registry delegates to this same singleton (live registration)", () => {
  const svc = tryUse("selection");
  assert(svc !== null, "tryUse('selection') must resolve");
  assert(ctx.features.selection === svc, "ctx.features.selection is the same service object");
  selection.clear();
  selection.replace({ modelA: new Set([7]) });
  assertDeepEq(snapshotPlain(svc.snapshot()), { modelA: [7] }, "service snapshot mirrors singleton");
  assertEq(svc.size(), 1, "service size mirrors singleton");
  svc.applyClick("modelA", 8, { ctrl: true });
  assertEq(selection.size(), 2, "service applyClick mutates the singleton");
  selection.clear();
});

// ═══ B. The authored-element engine — behaviour only it has ═════════════
console.log("── authored engine (src/modules/selection/index.ts) ──");

function makeEngine(elements, extra = {}) {
  return new SelectionEngine({ elements: () => elements, ...extra });
}

t("engine: vertex beats edge beats body at the same pick point (HIT_PRIORITY 100/90/40)", () => {
  assertEq(HIT_PRIORITY.vertex, 100, "vertex priority");
  assertEq(HIT_PRIORITY.edge, 90, "edge priority");
  assertEq(HIT_PRIORITY.body, 40, "body priority");
  const eng = makeEngine([
    { id: "wall", categoryId: "walls", pinned: false, hidden: false, editable: true,
      curve: { start: [0, 0], end: [10, 0] }, aabb: { min: [0, 0], max: [10, 1] } },
    { id: "slab", categoryId: "slabs", pinned: false, hidden: false, editable: true,
      aabb: { min: [-1, -1], max: [1, 1] } },
  ]);
  const hit = eng.SelectSingle([0, 0]);
  assert(hit !== null, "must hit at the shared point");
  assertEq(hit.elementId, "wall", "vertex element wins over body element");
  assertEq(hit.subKind, "vertex", "vertex sub-kind wins over edge/body");
  assertEq(hit.priority, 100, "vertex priority");
});

t("engine: pinned selectable with MOD-SEL-002; hidden invisible by default, force-select warns MOD-SEL-005", () => {
  const eng = makeEngine([
    { id: "pinned-wall", categoryId: "walls", pinned: true, hidden: false, editable: true,
      aabb: { min: [0, 0], max: [1, 1] } },
    { id: "hidden-wall", categoryId: "walls", pinned: false, hidden: true, editable: true,
      aabb: { min: [2, 0], max: [3, 1] } },
  ]);
  const hitPinned = eng.SelectSingle([0.5, 0.5]);
  assert(hitPinned !== null && hitPinned.elementId === "pinned-wall", "pinned is selectable");
  assert(
    eng.GetDiagnostics().some((d) => d.code === "MOD-SEL-002"),
    "pinned selection warns MOD-SEL-002",
  );
  assertEq(eng.SelectSingle([2.5, 0.5]), null, "hidden is invisible by default");
  eng.SetFilter({ includeHidden: true });
  const hitHidden = eng.SelectSingle([2.5, 0.5]);
  assert(hitHidden !== null && hitHidden.elementId === "hidden-wall", "filter override force-selects hidden");
  assert(
    eng.GetDiagnostics().some((d) => d.code === "MOD-SEL-005"),
    "force-selected hidden warns MOD-SEL-005",
  );
});

t("engine: window inside vs crossing semantics", () => {
  const eng = makeEngine([
    { id: "inside", categoryId: "walls", pinned: false, hidden: false, editable: true,
      aabb: { min: [1, 1], max: [2, 2] } },
    { id: "straddler", categoryId: "walls", pinned: false, hidden: false, editable: true,
      aabb: { min: [2, 1], max: [4, 2] } },
  ]);
  assertDeepEq(eng.SelectWindow([0, 0], [3, 3], "inside"), ["inside"], "inside picks only fully-contained");
  assertDeepEq(
    eng.SelectWindow([0, 0], [3, 3], "crossing").sort(),
    ["inside", "straddler"],
    "crossing picks intersecting too",
  );
});

t("engine: SelectByCategory over authored elements", () => {
  const eng = makeEngine([
    { id: "w1", categoryId: "walls", pinned: false, hidden: false, editable: true },
    { id: "w2", categoryId: "walls", pinned: false, hidden: false, editable: true },
    { id: "c1", categoryId: "columns", pinned: false, hidden: false, editable: true },
  ]);
  assertDeepEq(eng.SelectByCategory(["walls"]).sort(), ["w1", "w2"], "by-category picks walls only");
});

t("engine: has NONE of the manager's API (no applyClick/snapshot/selectSimilar/addMany)", () => {
  const eng = makeEngine([]);
  for (const m of ["applyClick", "snapshot", "selectSimilar", "addMany", "removeMany", "applyToHighlighter", "adoptFromHighlighter"]) {
    assertEq(typeof eng[m], "undefined", `engine.${m} must be undefined`);
  }
});

// ═══ C. Wiring — which copy the live path actually runs ══════════════════
console.log("── wiring (which copy runs where) ──");

const mainTs = readSrc("src/main.ts");
const engineUi = readSrc("src/features/engine-ui.ts");
const boxSelection = readSrc("src/features/box-selection.ts");
const servicesTs = readSrc("src/core/services.ts");
const authoringCore = readSrc("src/modules/authoring-core.ts");
const modifyActions = readSrc("src/features/modify-actions.ts");
const ribbonTs = readSrc("src/shell/ribbon.ts");
const managerSrc = readSrc("src/features/selection.ts");
const engineSrc = readSrc("src/modules/selection/index.ts");

function fnBody(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert(start !== -1, `marker not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : src.length;
  assert(end !== -1, `end marker not found: ${endMarker}`);
  return src.slice(start, end);
}

t("wiring: main.ts boots the fragment manager, never the engine", () => {
  assert(
    mainTs.includes('import { selection, setupClickToSelect } from "./features/selection";'),
    "main.ts must import selection + setupClickToSelect from features/selection",
  );
  assert(
    mainTs.includes('await step("selection", () => { (ctx.features as any).selection = selection; });'),
    "main.ts boot step 'selection' must publish the manager on ctx.features",
  );
  assert(
    mainTs.includes('await step("selection-click", () => { setupClickToSelect(); });'),
    "main.ts boot step 'selection-click' must install click-to-select",
  );
  assert(!mainTs.includes("modules/selection"), "main.ts must not reference the engine at all");
});

t("wiring: src importers of modules/selection are exactly engine-ui + authoring-core", () => {
  const found = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) {
        const text = fs.readFileSync(p, "utf8");
        const rel = path.relative(root, p).split(path.sep).join("/");
        // Real imports only — a doc comment merely NAMING the other file
        // (as the boundary notes in both selection files do) is not an
        // import and must not count here.
        if (/from\s+["'][^"']*modules\/selection["']/.test(text)) found.add(rel);
        if (/import\s*\(\s*["'][^"']*modules\/selection["']/.test(text)) found.add(rel);
        // authoring-core imports the sibling module as "./selection"
        if (p.includes(`${path.sep}modules${path.sep}`) && /from\s+["']\.\/selection["']/.test(text)) {
          found.add(rel);
        }
      }
    }
  };
  walk(path.join(root, "src"));
  assertDeepEq(
    [...found].sort(),
    ["src/features/engine-ui.ts", "src/modules/authoring-core.ts"],
    "importers of the engine",
  );
});

t("wiring: the engine's only call site is the Selection Inspector dialog", () => {
  const inspector = fnBody(
    engineUi,
    "export async function openSelectionInspectorDialog",
    "export async function openReferencePickerDialog",
  );
  assert(inspector.includes("const eng = selectionEngine();"), "inspector must drive selectionEngine()");
  assert(inspector.includes("eng.SelectSingle("), "inspector must use SelectSingle");
  assert(inspector.includes("eng.SelectWindow("), "inspector must use SelectWindow");
  assert(inspector.includes("eng.SelectByCategory("), "inspector must use SelectByCategory");
  const outside = engineUi.replace(inspector, "");
  const calls = outside.match(/selectionEngine\(\)/g) || [];
  assertEq(calls.length, 1, "exactly one selectionEngine() outside the inspector (its definition)");
  assert(outside.includes("export function selectionEngine(): SelectionEngine {"), "that one is the definition");
  assert(
    engineUi.includes("group1Undo, group1Redo, selectionEngine, toSelectable,"),
    "engine-ui must expose selectionEngine on the engine-ui API object only",
  );
});

t("wiring: Group 1 Move/Rotate/Mirror read authoring state, not the engine", () => {
  const move = fnBody(engineUi, "export async function openGroup1MoveDialog", "export async function openGroup1RotateDialog");
  const rotate = fnBody(engineUi, "export async function openGroup1RotateDialog", "export async function openGroup1MirrorDialog");
  const mirror = fnBody(engineUi, "export async function openGroup1MirrorDialog", "export async function openSelectionInspectorDialog");
  for (const [name, body] of [["Move", move], ["Rotate", rotate], ["Mirror", mirror]]) {
    assert(body.includes("selectedAuthoredIds()"), `${name} must read selectedAuthoredIds()`);
    assert(!body.includes("selectionEngine()"), `${name} must not touch the engine`);
  }
  assert(
    engineUi.includes("return (w.__obsAuthoring?.getSelectedIds?.() ?? []) as string[];"),
    "selectedAuthoredIds must read the authoring module's selection state",
  );
});

t("wiring: drag box-select commits through the fragment manager", () => {
  assert(boxSelection.includes('import { selection } from "./selection";'), "box-selection must import the manager");
  assert(boxSelection.includes("selection.replace(snap);"), "box-select must commit via manager.replace");
  assert(boxSelection.includes("selection.addMany(mid, ids);"), "box-select must commit via manager.addMany");
});

t("wiring: the canonical services SelectionService IS the manager's API", () => {
  const iface = fnBody(servicesTs, "export interface SelectionService {", "\n}\n");
  assert(iface.includes("snapshot(): SelectionMap;"), "SelectionService must have snapshot(): SelectionMap");
  assert(iface.includes("selectSimilar(modelId: string, localId: number): Promise<void>;"), "SelectionService must have selectSimilar(modelId, localId)");
  assert(iface.includes("applyClick("), "SelectionService must have applyClick");
  assert(!iface.includes("SelectSingle"), "SelectionService must not have the engine's SelectSingle");
  assert(!iface.includes("HitTest"), "SelectionService must not have the engine's HitTest");
});

t("wiring: authoring-core exposes the engine CLASS only, never an instance", () => {
  assert(authoringCore.includes("const selectionApi = { SelectionEngine };"), "authoring-core must expose { SelectionEngine }");
  assert(authoringCore.includes("w.__obsSelection = selectionApi;"), "authoring-core must publish it as the spec'd global");
  assert(!authoringCore.includes("new SelectionEngine"), "authoring-core must never instantiate the engine");
});

t("wiring: the engine is reachable in the live UI via the Sel Inspector ribbon button (not dead)", () => {
  assert(ribbonTs.includes('"Sel Inspector"'), "ribbon must have a Sel Inspector button");
  assert(ribbonTs.includes("openSelectionInspectorDialog"), "ribbon must wire it to openSelectionInspectorDialog");
});

t("wiring: modify-actions select-similar runs on the authoring selection, not the engine-class global", () => {
  // The "Select Similar" context-menu action (registry: "Select authored
  // elements similar to the selected source element") used to read the
  // global holding the SelectionEngine CLASS object and call
  // sel.selectSimilar("native", ids[0]). The class has no selectSimilar
  // method (and no instance is ever exposed), so `!sel?.selectSimilar`
  // was always true and the action always warned instead of selecting.
  // The follow-up landed (fix/2d-select-similar): the action now uses
  // authored select-similar semantics — same type as the seed, via the
  // authoring selection (setSelectedAuthored, replace) — and never the
  // fragment service, whose selectSimilar(modelId, numeric localId)
  // takes the wrong argument types for authored string ids.
  assert(
    !modifyActions.includes("const sel = (window as Any).__obsSelection;"),
    "modify-actions select-similar must not read the engine-class global",
  );
  assert(
    !modifyActions.includes('await sel.selectSimilar("native", ids[0]);'),
    "modify-actions select-similar must not call sel.selectSimilar",
  );
  assert(
    modifyActions.includes('setSelectedAuthored(match, "replace")'),
    "modify-actions select-similar must select through the authoring selection (replace)",
  );
  assert(
    modifyActions.includes("e.type === seed.type"),
    "modify-actions select-similar must match the seed's type",
  );
  assertEq(typeof engMod.SelectionEngine.selectSimilar, "undefined", "the SelectionEngine class has no selectSimilar");
});

t("wiring: both files document the boundary and point at this test", () => {
  assert(managerSrc.includes("src/modules/selection/index.ts"), "manager header must name the engine file");
  assert(managerSrc.includes("selection-generations.test.cjs"), "manager header must point at this test");
  assert(engineSrc.includes("src/features/selection.ts"), "engine header must name the manager file");
  assert(engineSrc.includes("selection-generations.test.cjs"), "engine header must point at this test");
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\nselection-generations: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("selection-generations FAILED");
  process.exitCode = 1;
}
