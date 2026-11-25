/*
 * Layer-lock enforcement (AutoCAD parity A3) — node test.
 *
 * The CAD viewer stored `layer.locked` as a flag + icon only: `visible()`
 * and every pick/select/edit path ignored it, so locked-layer entities
 * stayed selectable and editable. The fix gates those paths on the lock:
 * a `pickable` predicate (visible AND unlocked) at the click pick, the
 * staged pick tools, offset/modify selection, MATCHPROP/erase picks and
 * window/crossing selection; `setSel` filters locked indices out of every
 * selection; grips are painted and hit-tested only for pickable entities;
 * commitModify/commitReplace/eraseSelected refuse locked input; bulk
 * deletes (ERASEOUT, AUDITZL) and the mirror erase-source step skip locked
 * layers; locking a layer prunes the live selection. Locked layers stay
 * rendered — `visible()` itself has no lock check.
 *
 * Strategy (repo precedent: cad-layer-visibility.test.cjs for the tsc
 * compile, cad-ui-wiring.test.cjs for source markers):
 *   1. Compile the real layer-lock.ts + viewer-math.ts with tsc and test
 *      the real helpers behaviourally.
 *   2. Compose the real helpers with the real viewer-math pickers
 *      (pickEntities / pickEntity / selectInRect) exactly as cad-viewer.ts
 *      calls them: a click on a locked line finds nothing, a window over
 *      both lines returns only the unlocked one.
 *   3. Source markers prove cad-viewer.ts actually wires the gate at each
 *      choke point — these fail on the unfixed tree, where the predicates
 *      and guards do not exist.
 *
 * No mocks of the decision logic: the helpers under test are the shipped
 * ones, and the pickers are the shipped viewer-math functions.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-layer-lock-"));
execSync(
  `npx tsc src/modules/cad-viewer/layer-lock.ts src/modules/cad-viewer/viewer-math.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const L = require(path.join(out, "cad-viewer", "layer-lock.js"));
const M = require(path.join(out, "cad-viewer", "viewer-math.js"));
const viewer = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

/* Two lines: one on a locked layer, one on an unlocked layer. */
const layers = [
  { name: "0", color: 7 },
  { name: "Locked", color: 7, locked: true },
  { name: "Free", color: 7, locked: false },
];
const ents = [
  { type: "LINE", layer: "Locked", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  { type: "LINE", layer: "0", start: { x: 0, y: 10 }, end: { x: 10, y: 10 } },
  { type: "CIRCLE", layer: "Free", center: { x: 20, y: 5 }, radius: 2 },
];
const bounds = { minX: 0, minY: 0, maxX: 22, maxY: 10 };
const idx = M.buildIndex(ents, bounds);
const visibleAll = () => true;
const pickable = (e) => L.isPickable(e, layers, visibleAll);

// ── 1. Pure helpers ──
t("isLayerLocked: locked layer true, unlocked/unknown/missing table false", () => {
  assert.equal(L.isLayerLocked(layers, "Locked"), true);
  assert.equal(L.isLayerLocked(layers, "0"), false);
  assert.equal(L.isLayerLocked(layers, "Free"), false);
  assert.equal(L.isLayerLocked(layers, "NoSuchLayer"), false);
  assert.equal(L.isLayerLocked(undefined, "Locked"), false);
  assert.equal(L.isLayerLocked(null, "Locked"), false);
  assert.equal(L.isLayerLocked([], "Locked"), false);
});

t("lockedLayerNames: only the locked layer", () => {
  assert.deepEqual([...L.lockedLayerNames(layers)], ["Locked"]);
  assert.deepEqual([...L.lockedLayerNames(undefined)], []);
});

t("isEntityLocked follows the entity layer", () => {
  assert.equal(L.isEntityLocked(ents[0], layers), true);
  assert.equal(L.isEntityLocked(ents[1], layers), false);
  assert.equal(L.isEntityLocked(ents[2], layers), false);
});

t("isPickable: visible + unlocked passes, locked or hidden fails", () => {
  assert.equal(L.isPickable(ents[0], layers, visibleAll), false);
  assert.equal(L.isPickable(ents[1], layers, visibleAll), true);
  assert.equal(L.isPickable(ents[2], layers, visibleAll), true);
  assert.equal(L.isPickable(ents[1], layers, () => false), false);
  assert.equal(L.isPickable(ents[1], layers, (e) => e.type === "CIRCLE"), false);
});

t("filterUnlockedIndices: drops locked, keeps unlocked, drops missing, keeps order", () => {
  assert.deepEqual(L.filterUnlockedIndices(ents, layers, [0, 1, 2]), [1, 2]);
  assert.deepEqual(L.filterUnlockedIndices(ents, layers, [2, 0, 1]), [2, 1]);
  assert.deepEqual(L.filterUnlockedIndices(ents, layers, [0]), []);
  assert.deepEqual(L.filterUnlockedIndices(ents, layers, [1, 99, -1]), [1]);
  assert.deepEqual(L.filterUnlockedIndices(ents, layers, []), []);
  assert.deepEqual(L.filterUnlockedIndices(ents, undefined, [0, 1, 2]), [0, 1, 2]);
});

// ── 2. Composed with the real viewer-math pickers ──
t("pickEntities with pickable: click on the locked line finds nothing", () => {
  assert.deepEqual(M.pickEntities(idx, ents, 5, 0, 0.5, pickable, 32), []);
  assert.deepEqual(M.pickEntities(idx, ents, 5, 0, 0.5, visibleAll, 32).map((c) => c.index), [0],
    "sanity: the same click WITHOUT the gate finds the locked line (the old behaviour)");
});

t("pickEntities with pickable: click on the unlocked line finds it", () => {
  assert.deepEqual(M.pickEntities(idx, ents, 5, 10, 0.5, pickable, 32).map((c) => c.index), [1]);
  assert.deepEqual(M.pickEntities(idx, ents, 22, 5, 0.5, pickable, 32).map((c) => c.index), [2]);
});

t("pickEntity with pickable: locked line is never the nearest hit", () => {
  assert.equal(M.pickEntity(idx, ents, 5, 0, 0.5, pickable), -1);
  assert.equal(M.pickEntity(idx, ents, 5, 10, 0.5, pickable), 1);
});

t("selectInRect with pickable: window/crossing over both lines returns only the unlocked one", () => {
  const rect = { minX: -1, minY: -1, maxX: 23, maxY: 11 };
  assert.deepEqual(M.selectInRect(idx, ents, rect, "window", pickable), [1, 2]);
  assert.deepEqual(M.selectInRect(idx, ents, rect, "crossing", pickable), [1, 2]);
  assert.deepEqual(M.selectInRect(idx, ents, rect, "crossing", visibleAll), [0, 1, 2],
    "sanity: without the gate the window returns the locked line too (the old behaviour)");
});

t("selectInRect with pickable: a window over only the locked line selects nothing", () => {
  const rect = { minX: -1, minY: -1, maxX: 11, maxY: 1 };
  assert.deepEqual(M.selectInRect(idx, ents, rect, "window", pickable), []);
});

// ── 3. Source wiring in cad-viewer.ts (fails on the unfixed tree) ──
const mustContain = (needle, label) => {
  assert.ok(viewer.includes(needle), `cad-viewer.ts drift: missing ${label}: ${needle}`);
};
const mustNotContain = (needle, label) => {
  assert.ok(!viewer.includes(needle), `cad-viewer.ts drift: still has unguarded ${label}: ${needle}`);
};

t("wiring: lock predicates defined next to visible()", () => {
  mustContain("const isLayerLocked = (layer: string): boolean => LayerLock.isLayerLocked(doc?.layers, layer);", "isLayerLocked");
  mustContain("const pickable = (e: DxfEntity): boolean => visible(e) && !isLayerLocked(e.layer);", "pickable");
  mustContain("function pruneLockedFromSel(): void {", "pruneLockedFromSel");
});

t("wiring: locked layers stay rendered — visible() has no lock check", () => {
  mustContain("const visible = (e: DxfEntity) => !hidden.has(e.layer) && !hiddenEntities.has(e) && (typeFilter.size === 0 || typeFilter.has(e.type));", "visible()");
  mustNotContain("!isLayerLocked(e.layer) && !hidden.has", "lock check inside visible()");
});

t("wiring: click pick uses pickable, old unguarded call is gone", () => {
  mustContain("M.pickEntities(idx, ents, wp.x, wp.y, 8 / view.scale, pickable, 32)", "handleSelectionClick");
  mustNotContain("M.pickEntities(idx, ents, wp.x, wp.y, 8 / view.scale, visible, 32)", "unguarded click pick");
});

t("wiring: staged pick tools use pickable except layer-state tools", () => {
  mustContain('pick.kind === "layiso" || pick.kind === "layoff" || pick.kind === "laylck" || pick.kind === "layunlck"', "layer-state pick exception");
  mustContain("M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, layerStatePick ? visible : pickable)", "onPickClick predicate");
});

t("wiring: window/crossing selection and stretch window use pickable", () => {
  mustContain('M.selectInRect(idx, ents, rect, mode, pickable)', "box select");
  mustContain('M.selectInRect(idx, ents, rect, "crossing", pickable)', "stretch window");
  mustNotContain('M.selectInRect(idx, ents, rect, mode, visible)', "unguarded box select");
});

t("wiring: setSel filters locked indices out of every selection", () => {
  mustContain("const allowed = LayerLock.filterUnlockedIndices(ents, doc?.layers, ids);", "setSel gate");
  mustContain("if (add && allowed.length === 1 && sel.has(allowed[0])) sel.delete(allowed[0]);", "setSel toggle-off on the filtered list");
});

t("wiring: grips are painted and hit-tested only for pickable entities", () => {
  mustContain("if (!e || !pickable(e)) continue;\n          const grips = M.entityGrips(e);", "grip paint");
  mustContain("if (!e || !pickable(e)) continue;\n      const grips = M.entityGrips(e);", "gripAt");
});

t("wiring: modify commits and erase refuse locked input", () => {
  mustContain('logCmd("LAYER: an object is on a locked layer — unlock the layer to edit it.");', "commit guard message");
  mustContain('logCmd("LAYER: locked-layer object(s) in the selection — unlock the layer to erase them.");', "erase guard message");
  mustContain('logCmd("LAYER: source objects are on a locked layer — unlock the layer to erase them.");', "mirror erase-source guard");
});

t("wiring: locking a layer prunes the live selection (manager + LAYLCK)", () => {
  mustContain("if (lyr.locked) pruneLockedFromSel();", "prune on lock");
  const occurrences = viewer.split("if (lyr.locked) pruneLockedFromSel();").length - 1;
  assert.equal(occurrences, 2, `expected pruneLockedFromSel at both lock sites, found ${occurrences}`);
});

t("wiring: offset / modify-select / match / erase picks use pickable", () => {
  mustContain("offTarget = i;", "offset pick target");
  const offsetPick = viewer.includes("M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, pickable) : -1;\n        if (i < 0) {\n          logCmd(\"0 found\");\n          return true;\n        }\n        offTarget = i;");
  assert.ok(offsetPick, "offset pickObj not gated on pickable");
  const modPick = viewer.includes('if (mod.stage === "select") {\n      const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, pickable) : -1;');
  assert.ok(modPick, "modify select-stage pick not gated on pickable");
  const matchPick = viewer.includes('case "match": {\n        const mi = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, pickable) : -1;');
  assert.ok(matchPick, "MATCHPROP pick not gated on pickable");
  const erasePick = viewer.includes('case "erase": {\n        const i = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, pickable) : -1;');
  assert.ok(erasePick, "erase-tool pick not gated on pickable");
});

t("wiring: bulk deletes and by-layer selects skip locked layers", () => {
  mustContain("const rm = new Set(outside.filter((i) => !isLayerLocked(ents[i]?.layer ?? \"\")));", "ERASEOUT filter");
  mustContain("const rm = new Set(zeroLen.filter((i) => !isLayerLocked(ents[i]?.layer ?? \"\")));", "AUDITZL filter");
  mustContain("for (const i of ids) if (selAccept(i)) sel.add(i);", "LAYSEL/TYPESEL gate");
  mustContain("if (isLayerLocked(e.layer)) continue;", "SELECTALL gate");
  mustContain("if (ents[i]?.layer && layers.has(ents[i].layer) && !isLayerLocked(ents[i].layer)) sel.add(i);", "SELBYLAYER gate");
  mustContain("for (const i of existing) if (ents[i] && selAccept(i)) { sel.add(i); n++; }", "GROUP recall gate");
});

t("wiring: locked-layer associative dims do not follow a move", () => {
  mustContain("if (old.some((e) => isLayerLocked(e.layer))) continue; // locked-layer dims do not follow a move", "withAssociativeDims guard");
});

t("wiring: reference-only picks stay ungated (snap/dimension/hatch/QMEASURE read geometry)", () => {
  // DIMRADIUS / DIMARC / DIMDIA / DIMCENTER / ARRAYPATH / HATCH reference a
  // locked object without editing it, and QMEASURE only reports on it —
  // AutoCAD likewise lets you snap to and dimension locked geometry.
  const dimRadius = viewer.includes('const ri = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;');
  const hatch = viewer.includes('const hi = idx ? M.pickEntity(idx, ents, wp.x, wp.y, 10 / view.scale, visible) : -1;');
  const qmeasure = viewer.includes('const hit = M.pickEntity(idx, ents, point.x, point.y, 10 / view.scale, visible);');
  assert.ok(dimRadius && hatch && qmeasure, "reference picks unexpectedly gated — they must stay visible-only");
});

console.log(`\nlayer-lock-enforcement: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
