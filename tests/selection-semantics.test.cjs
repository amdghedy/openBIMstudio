/**
 * tests/selection-semantics.test.cjs
 *
 * Node tests for Revit 2D gap G4 (selection semantics) + G15 context-menu
 * entries. Three parts:
 *
 * A. The pure shared module (src/features/selection-semantics.ts):
 *    click modifiers, set operations, previous-selection store, category
 *    filter, Select All Instances query.
 * B. The context-menu model (src/features/context-menu-model.ts): the
 *    Select flyout offers Select All Instances + Select Previous, wired
 *    to real commands, with the right enablement.
 * C. The 3D fragment selection manager (src/features/selection.ts),
 *    compiled with its heavy imports stubbed (same strip-and-stub pattern
 *    as tests/selection-box.test.cjs): Shift-click removes, Ctrl adds,
 *    Select Previous restores, fragment catalog / selection items feed
 *    the Filter dialog and Select All Instances.
 *
 * Run: `node tests/selection-semantics.test.cjs`
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

let pass = 0;
let fail = 0;
// Tests run sequentially in registration order (the 3D manager is a
// singleton, so async tests must not interleave). CJS has no top-level
// await: chain them and report at the end.
let chain = Promise.resolve();
function t(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn();
      pass++;
      console.log(`  PASS ${name}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL ${name}: ${e.message}`);
    }
  });
}

const repoRoot = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-g4-"));
const srcDir = path.join(tmpOut, "src");
fs.mkdirSync(srcDir, { recursive: true });

// ── Compile the pure module + the context-menu model ─────────────────────
// Preserve the repo's src/ layout (features/ + modules/) so relative imports resolve.
for (const rel of ["features/selection-semantics.ts", "features/context-menu-model.ts", "modules/modify/registry.ts"]) {
  const dest = path.join(srcDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "src", rel), dest);
}

const tsconfigPath = path.join(tmpOut, "tsconfig.json");
fs.writeFileSync(tsconfigPath, JSON.stringify({
  compilerOptions: {
    target: "ES2020", module: "commonjs", moduleResolution: "node",
    strict: false, skipLibCheck: true, esModuleInterop: true,
    outDir: path.join(tmpOut, "out"), rootDir: srcDir, types: [], lib: ["ES2020", "DOM"],
  },
  include: [path.join(srcDir, "**/*.ts")],
}, null, 2));
try {
  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  console.error("TS compilation failed:");
  console.error(e.stdout?.toString() || e.stderr?.toString() || e.message);
  process.exit(1);
}
const sem = require(path.join(tmpOut, "out", "features", "selection-semantics.js"));
const cm = require(path.join(tmpOut, "out", "features", "context-menu-model.js"));

// ── A. Pure shared module ────────────────────────────────────────────────
t("click modifiers: plain replaces, Ctrl/Meta adds, Shift/Alt removes, Shift wins over Ctrl", () => {
  assert.strictEqual(sem.resolveClickMode({}), "replace");
  assert.strictEqual(sem.resolveClickMode({ ctrl: true }), "add");
  assert.strictEqual(sem.resolveClickMode({ meta: true }), "add");
  assert.strictEqual(sem.resolveClickMode({ shift: true }), "remove");
  assert.strictEqual(sem.resolveClickMode({ alt: true }), "remove");
  assert.strictEqual(sem.resolveClickMode({ ctrl: true, shift: true }), "remove");
  assert.strictEqual(sem.resolveClickMode({ ctrl: true, meta: true, shift: true }), "remove");
});

t("Shift-click removes the clicked element from a multi-selection, nothing else", () => {
  const before = new Set(["w1", "w2", "c1"]);
  const after = sem.applyClickToSet(before, "w2", sem.resolveClickMode({ shift: true }));
  assert.deepStrictEqual([...after].sort(), ["c1", "w1"]);
  // Removing an element that is not selected leaves the set untouched.
  assert.deepStrictEqual([...sem.applyClickToSet(after, "w9", "remove")].sort(), ["c1", "w1"]);
  // Ctrl-click adds; plain click replaces.
  assert.deepStrictEqual([...sem.applyClickToSet(after, "w2", "add")].sort(), ["c1", "w1", "w2"]);
  assert.deepStrictEqual([...sem.applyClickToSet(after, "w2", "replace")], ["w2"]);
});

t("box selection: Ctrl adds the boxed ids, Shift removes them, plain replaces", () => {
  const before = new Set(["w1", "w2", "c1"]);
  assert.deepStrictEqual([...sem.applyClickToMany(before, ["w3", "w4"], "add")].sort(), ["c1", "w1", "w2", "w3", "w4"]);
  assert.deepStrictEqual([...sem.applyClickToMany(before, ["w1", "w2"], "remove")], ["c1"]);
  assert.deepStrictEqual([...sem.applyClickToMany(before, ["w3"], "replace")], ["w3"]);
  // Shift-removing ids that are not selected is a no-op.
  assert.deepStrictEqual([...sem.applyClickToMany(before, ["w9"], "remove")].sort(), ["c1", "w1", "w2"]);
});

t("Select Previous store: restores the snapshot before the last change and toggles back", () => {
  const store = new sem.PreviousSelectionStore();
  assert.strictEqual(store.hasPrevious(), false);
  assert.strictEqual(store.restore(["a"]), null);
  store.note([]);
  assert.strictEqual(store.hasPrevious(), true);
  // ["a"] was the selection before it became ["a", "b"].
  store.note(["a"]);
  assert.deepStrictEqual(store.restore(["a", "b"]), ["a"]);
  // The restore swapped: the current set is now the previous one.
  assert.deepStrictEqual(store.restore(["a"]), ["a", "b"]);
  // Noting an unchanged selection does not overwrite the previous set.
  store.note(["a", "b"]);
  store.note(["a", "b"]);
  assert.deepStrictEqual(store.restore(["a", "b"]), ["a", "b"]);
});

t("Filter: category counts over a mixed authored + fragment selection, IFC aliases match", () => {
  const items = [
    { key: "w1", source: "authored", category: "wall", type: "wall" },
    { key: "w2", source: "authored", category: "wall", type: "wall" },
    { key: "c1", source: "authored", category: "column", type: "column" },
    { key: "m:7", source: "fragment", category: "IfcWall", type: "IfcWall", modelId: "m", localId: 7 },
    { key: "m:8", source: "fragment", category: "IfcSlab", type: "IfcSlab", modelId: "m", localId: 8 },
  ];
  assert.deepStrictEqual(sem.selectionCategories(items), [
    { category: "wall", count: 2 },
    { category: "column", count: 1 },
    { category: "IfcSlab", count: 1 },
    { category: "IfcWall", count: 1 },
  ]);
  // "wall" matches both the authored walls and the IfcWall fragment.
  const kept = sem.filterSelectionByCategories(items, ["wall"]);
  assert.deepStrictEqual(kept.map((i) => i.key).sort(), ["m:7", "w1", "w2"]);
  assert.deepStrictEqual(sem.filterSelectionByCategories(items, ["column"]).map((i) => i.key), ["c1"]);
  assert.deepStrictEqual(sem.filterSelectionByCategories(items, []), []);
});

t("Select All Instances: same category + type only; view scope restricts to visible ids", () => {
  const catalog = [
    { key: "w1", source: "authored", category: "wall", type: "wall" },
    { key: "w2", source: "authored", category: "wall", type: "wall" },
    { key: "w3", source: "authored", category: "wall", type: "curtain-wall" },
    { key: "c1", source: "authored", category: "column", type: "column" },
    { key: "m:7", source: "fragment", category: "IfcWall", type: "IfcWall", modelId: "m", localId: 7 },
    { key: "m:8", source: "fragment", category: "IfcWall", type: "IfcWall", modelId: "m", localId: 8 },
  ];
  // Authored wall seed: matches authored walls only (fragment type is the IFC class).
  assert.deepStrictEqual(sem.selectAllInstances(catalog, "w1").map((i) => i.key).sort(), ["w1", "w2"]);
  // Fragment seed: matches the IFC class.
  assert.deepStrictEqual(sem.selectAllInstances(catalog, "m:7").map((i) => i.key).sort(), ["m:7", "m:8"]);
  // View scope: only the visible subset of the same category+type.
  const visible = new Set(["w1", "c1"]);
  assert.deepStrictEqual(sem.selectAllInstances(catalog, "w1", "view", visible).map((i) => i.key), ["w1"]);
  // View scope without a visible set falls back to the whole project.
  assert.deepStrictEqual(sem.selectAllInstances(catalog, "w1", "view").map((i) => i.key).sort(), ["w1", "w2"]);
  assert.deepStrictEqual(sem.selectAllInstances(catalog, "missing"), []);
});

t("categoryOfAuthored prefers the element type, falls back to the IFC class", () => {
  assert.strictEqual(sem.categoryOfAuthored({ type: "wall", properties: {} }), "wall");
  assert.strictEqual(sem.categoryOfAuthored({ type: "", properties: { ifcType: "IfcColumn" } }), "IfcColumn");
  assert.strictEqual(sem.normalizeSelectionCategory("IfcWall"), sem.normalizeSelectionCategory("wall"));
});

// ── B. Context-menu model ────────────────────────────────────────────────
const DEFS = [["move", "Move", "MV", "s"], ["copy", "Copy", "CO", "s"], ["paste", "Paste", "Ctrl+V", ""], ["rotate", "Rotate", "RO", "s"], ["mirror", "Mirror", "MI", "s"], ["array", "Array", "AR", "s"], ["offset", "Offset", "OF", "s"], ["scale", "Scale", "SC", "s"], ["create-similar", "Create Similar", "", "s"], ["match-props", "Match Properties", "", "s"], ["select-similar", "Select Similar", "", "s"], ["align-x", "Align X", "", "m"], ["align-z", "Align Z", "", "m"], ["pin", "Pin", "", "s"], ["unpin", "Unpin", "", "s"], ["split-mid", "Split at Midpoint", "", "s"], ["join-walls", "Join Walls", "", "s"], ["delete", "Delete", "Del", "s"]]
  .map(([id, label, shortcut, k]) => ({ id, label, shortcut, needsSelection: k === "s", needsMulti: k === "m" }));
const CMDS = ["global.cancel", "global.repeat", "global.selectAll", "global.clearSelection", "global.undo", "global.redo", "view.fit", "view.home", "view.top", "view.front", "view.ortho", "view.perspective", "review.isolate", "review.hide", "review.reveal", "review.focus", "modify.trimExtend", "modify.typeProperties", "selection.selectPrevious", "selection.selectAllInstances", "selection.filter"];
const calls = [];
const deps = (o = {}) => ({
  authoredCount: 0, linkedCount: 0, clipboardCount: 0, modifyDefs: DEFS,
  activeModifyTool: () => false, runModify: (id) => calls.push(["modify", id]),
  command: (id) => calls.push(["cmd", id]), hasCommand: (id) => CMDS.includes(id),
  openDialog: (k) => calls.push(["dlg", k]), setTool: (x) => calls.push(["tool", x]),
  copyToClipboard: () => calls.push(["clip"]), makeNativeTwin: () => calls.push(["twin"]),
  openProperties: () => calls.push(["props"]), hasPreviousSelection: false, ...o,
});
const sub = (items, text) => items.find((i) => i.type === "sub" && i.text === text);
const acts = (items) => items.filter((i) => i.type === "action");
const flat = (items) => items.flatMap((i) => (i.type === "sub" ? flat(i.items) : [i]));

t("Select flyout offers Select All Instances and Select Previous (Ctrl+Left), wired to commands", () => {
  const sel = sub(cm.buildContextMenu(deps({ authoredCount: 2, hasPreviousSelection: true })), "Select").items;
  const names = acts(sel).map((a) => a.text);
  assert.ok(names.includes("Select All Instances"), "Select All Instances missing");
  assert.ok(names.includes("Select Previous"), "Select Previous missing");
  const prev = acts(sel).find((a) => a.text === "Select Previous");
  assert.strictEqual(prev.kbd, "Ctrl+Left");
  assert.strictEqual(prev.disabled, false);
  const sai = acts(sel).find((a) => a.text === "Select All Instances");
  assert.strictEqual(sai.disabled, false);
  calls.length = 0;
  prev.onclick();
  sai.onclick();
  assert.deepStrictEqual(calls, [["cmd", "selection.selectPrevious"], ["cmd", "selection.selectAllInstances"]]);
});

t("Select Previous is disabled with no previous selection; Select All Instances needs a selection", () => {
  const sel = sub(cm.buildContextMenu(deps({ authoredCount: 1 })), "Select").items;
  assert.strictEqual(acts(sel).find((a) => a.text === "Select Previous").disabled, true);
  const empty = sub(cm.buildContextMenu(deps()), "Select").items;
  assert.strictEqual(acts(empty).find((a) => a.text === "Select All Instances").disabled, true);
});

t("menu without the new commands registered omits them (old menus unchanged)", () => {
  const noNew = deps({ authoredCount: 2, hasCommand: (id) => CMDS.includes(id) && !id.startsWith("selection.") });
  const sel = sub(cm.buildContextMenu(noNew), "Select").items;
  const names = acts(sel).map((a) => a.text);
  assert.ok(!names.includes("Select All Instances") && !names.includes("Select Previous"));
  assert.ok(names.includes("Select All") && names.includes("Select Similar"));
});

// ── C. 3D fragment selection manager ─────────────────────────────────────
// Compile selection.ts with heavy imports stubbed (strip-and-stub pattern).
const selSrcDir = path.join(tmpOut, "sel-src");
fs.mkdirSync(selSrcDir, { recursive: true });
fs.copyFileSync(path.join(repoRoot, "src/features/selection-semantics.ts"), path.join(selSrcDir, "selection-semantics.ts"));
// G3 (landed ahead of this branch in the wave chain) added a real import
// of the pure tab-cycle model into selection.ts; copy the real module
// (dependency-free, no imports) and point the stripped copy at it, so the
// manager under test uses the real cycle object instead of a stub.
fs.copyFileSync(path.join(repoRoot, "src/modules/selection/selection-cycle.ts"), path.join(selSrcDir, "selection-cycle.ts"));
let selSrc = fs.readFileSync(path.join(repoRoot, "src/features/selection.ts"), "utf8");
selSrc = selSrc.replace(/^import \{ hoverPreselectCycle, emitTabCycleStatus \} from "\.\.\/modules\/selection\/selection-cycle";$/m,
  `import { hoverPreselectCycle, emitTabCycleStatus } from "./selection-cycle";`);
selSrc = selSrc.replace(/^import \{ authoredOwnsClick \} from "\.\/pick-arbiter";$/m,
  `function authoredOwnsClick(): boolean { return false; }`);
selSrc = selSrc.replace(/^import \* as THREE from "three";$/m,
  `const THREE: any = { Box3: class { isEmpty() { return true; } clone() { return this; } union() { return this; } applyMatrix4() { return this; } } };`);
selSrc = selSrc.replace(/^import \* as OBC from "@thatopen\/components";$/m,
  `const OBC: any = { Raycasters: class {} };`);
selSrc = selSrc.replace(/^import \{ ctx \} from "\.\.\/core\/context";$/m,
  `const ctx: any = (globalThis as any).__testCtx;`);
selSrc = selSrc.replace(/^import \{ register, tryUse, type SelectionService \} from "\.\.\/core\/services";$/m,
  `function register(): void {} function tryUse(): any { return undefined; }`);
selSrc = selSrc.replace(/^import \{ getSelectionPrefs \} from "\.\.\/core\/selection-prefs";$/m,
  `function getSelectionPrefs(): any { return { links: true }; }`);
selSrc = selSrc.replace(/^import \{ hoverGate \} from "\.\.\/core\/hover-gate";$/m,
  `function hoverGate(): any { return { clearStale: false, pick: false }; }`);
// Type-checking is covered by the repo-wide `tsc --noEmit`; here we only
// need the runtime behaviour, so suppress type errors in the stripped copy.
selSrc = `// @ts-nocheck\n${selSrc}`;
fs.writeFileSync(path.join(selSrcDir, "selection.ts"), selSrc);
const selTsconfig = path.join(tmpOut, "tsconfig-sel.json");
fs.writeFileSync(selTsconfig, JSON.stringify({
  compilerOptions: {
    target: "ES2020", module: "commonjs", moduleResolution: "node",
    strict: false, skipLibCheck: true, esModuleInterop: true,
    outDir: path.join(tmpOut, "sel-out"), rootDir: selSrcDir, types: [], lib: ["ES2020", "DOM"],
  },
  include: [path.join(selSrcDir, "**/*.ts")],
}, null, 2));
try {
  execSync(`npx tsc -p "${selTsconfig}"`, { cwd: repoRoot, stdio: "pipe" });
} catch (e) {
  console.error("selection.ts compilation failed:");
  console.error(e.stdout?.toString() || e.stderr?.toString() || e.message);
  process.exit(1);
}

function fakeModel(categories, geometryIds) {
  return {
    getItemsOfCategories: async () => categories,
    getItemsIdsWithGeometry: async () => geometryIds,
    getBoxes: async () => [],
    object: { matrixWorld: { clone: () => ({}) } },
  };
}
globalThis.__testCtx = {
  fragments: {
    list: new Map([
      ["model-a", fakeModel({ IfcWall: [1, 2, 3], IfcColumn: [4] }, [1, 2, 3, 4])],
      ["model-b", fakeModel({ IfcWall: [10, 11] }, [10, 11])],
    ]),
  },
  highlighter: { clear: async () => {}, highlightByID: async () => {}, events: { select: {} } },
  components: { get: () => ({ get: () => ({ castRay: async () => null }) }) },
  world: { renderer: { three: null } },
  features: {},
  rightHost: { addEventListener: () => {} },
};
const mgr = require(path.join(tmpOut, "sel-out", "selection.js")).selection;

const snapObj = (snap) => {
  const out = {};
  for (const [m, s] of Object.entries(snap)) out[m] = [...s].sort((a, b) => a - b);
  return out;
};

t("3D Select Previous reports false with no previous selection (fresh singleton)", async () => {
  // This must run before any other Part C test mutates the manager.
  assert.strictEqual(mgr.hasPreviousSelection(), false);
  assert.strictEqual(await mgr.selectPrevious(), false);
  assert.deepStrictEqual(snapObj(mgr.snapshot()), {});
});

t("3D click: Shift-click removes the element (applyClick), Ctrl adds, plain replaces", () => {
  mgr.replace({});
  mgr.add("model-a", 1);
  mgr.add("model-a", 2);
  mgr.add("model-a", 4);
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 2, 4] });
  mgr.applyClick("model-a", 2, { shift: true });
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 4] });
  mgr.applyClick("model-a", 3, { ctrl: true });
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 3, 4] });
  mgr.applyClick("model-a", 1, {});
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1] });
  // Alt removes like Shift (legacy alias kept by the 3D path).
  mgr.applyClick("model-a", 1, { alt: true });
  assert.deepStrictEqual(snapObj(mgr.snapshot()), {});
});

t("3D Shift-click on an unselected element changes nothing", () => {
  mgr.replace({ "model-a": new Set([1, 2]) });
  mgr.applyClick("model-a", 99, { shift: true });
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 2] });
});

t("3D Select Previous restores the set before the last change and toggles back", async () => {
  mgr.replace({});
  mgr.replace({ "model-a": new Set([1]) });
  mgr.add("model-a", 2);
  assert.strictEqual(mgr.hasPreviousSelection(), true);
  assert.strictEqual(await mgr.selectPrevious(), true);
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1] });
  assert.strictEqual(await mgr.selectPrevious(), true);
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 2] });
  // Clear also records the previous set.
  mgr.clear();
  assert.deepStrictEqual(snapObj(mgr.snapshot()), {});
  assert.strictEqual(await mgr.selectPrevious(), true);
  assert.deepStrictEqual(snapObj(mgr.snapshot()), { "model-a": [1, 2] });
});

t("fragment catalog + selection items feed Filter / Select All Instances with real categories", async () => {
  const catalog = await mgr.fragmentCatalog();
  assert.strictEqual(catalog.length, 6);
  const walls = catalog.filter((i) => i.category === "IfcWall");
  assert.strictEqual(walls.length, 5);
  assert.deepStrictEqual(walls.map((i) => i.key).sort(), ["model-a:1", "model-a:2", "model-a:3", "model-b:10", "model-b:11"]);
  mgr.replace({ "model-a": new Set([1, 4]), "model-b": new Set([10]) });
  const items = await mgr.selectionItems();
  assert.deepStrictEqual(items.map((i) => i.key).sort(), ["model-a:1", "model-a:4", "model-b:10"]);
  assert.deepStrictEqual(sem.selectionCategories(items).map((c) => c.category).sort(), ["IfcColumn", "IfcWall"]);
  // Select All Instances over the real catalog: seed wall 1 → all 5 walls.
  const all = sem.selectAllInstances(catalog, "model-a:1");
  assert.deepStrictEqual(all.map((i) => i.key).sort(), ["model-a:1", "model-a:2", "model-a:3", "model-b:10", "model-b:11"]);
});

chain.then(() => {
  console.log(`\nselection-semantics: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
