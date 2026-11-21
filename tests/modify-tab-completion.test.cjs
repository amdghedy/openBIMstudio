#!/usr/bin/env node
/**
 * Contextual Modify tab completion — Revit 2D environment audit gap G2.
 *
 * Pins the completed contextual Modify tab (src/shell/modify-tab-model.ts,
 * rendered by src/shell/ribbon.ts):
 *  1. The model is EXECUTED: modify-tab-model.ts is a pure, DOM-free module
 *     compiled with tsc and required here.
 *  2. Source pins prove ribbon.ts renders that model (Measure panel, Filter
 *     + Select Previous in the Select panel, linked-only view subset with
 *     disabled transforms), that the Filter dialog narrows a real selection,
 *     and that Select Previous restores a stored snapshot.
 *
 * Sensitivity: on the pre-G2 tree this fails — there is no
 * modify-tab-model.ts to compile, no Measure/Filter/Select Previous in the
 * contextual tab, and no linked-selection Modify tab at all.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the model ─────────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mtc-"));
execSync(`npx tsc src/shell/modify-tab-model.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "modify-tab-model.js"));

const native = (id, category) => ({ id, category, sourceKind: "native" });
const linked = (id, category) => ({ id, category, sourceKind: "linked" });
const panelsOf = (m) => Object.fromEntries(m.panels.map((p) => [p.label, p.buttons.map((b) => b.id)]));
const buttonOf = (m, panelLabel, buttonId) => {
  const panel = m.panels.find((p) => p.label === panelLabel);
  assert.ok(panel, `panel "${panelLabel}" missing`);
  const button = panel.buttons.find((b) => b.id === buttonId);
  assert.ok(button, `button "${buttonId}" missing from panel "${panelLabel}"`);
  return button;
};

const MIXED = [native("w1", "wall"), native("w2", "wall"), native("c1", "column"), native("d1", "duct")];

/* ── 2. Authored selection: full tab incl. Measure / Filter / Select Previous ── */
t("authored selection yields the full tab with all pre-existing panels intact", () => {
  const m = model.buildModifyTabModel([native("w1", "wall")]);
  assert.strictEqual(m.kind, "authored");
  assert.strictEqual(m.title, "Modify | Walls");
  assert.deepStrictEqual(m.panels.map((p) => p.label),
    ["Select", "Properties", "Clipboard", "Modify", "Geometry", "Constraints", "Create", "View", "Measure"]);
  const panels = panelsOf(m);
  assert.deepStrictEqual(panels.Select, ["modify", "select-similar", "select-all", "clear", "filter", "select-previous"]);
  assert.deepStrictEqual(panels.Properties, ["properties", "type-properties"]);
  assert.deepStrictEqual(panels.Clipboard, ["copy", "paste"]);
  assert.deepStrictEqual(panels.Modify, ["move", "copy-move", "rotate", "mirror", "array", "offset", "scale", "align-h", "align-v", "delete"]);
  assert.deepStrictEqual(panels.Geometry, ["trim-extend", "split-mid", "flip", "join-walls"]);
  assert.deepStrictEqual(panels.Constraints, ["pin", "unpin"]);
  assert.deepStrictEqual(panels.Create, ["create-similar", "match-props"]);
  assert.deepStrictEqual(panels.View, ["isolate", "hide", "reveal", "zoom"]);
  assert.deepStrictEqual(panels.Measure, ["measure", "clear-measurements"]);
  assert.strictEqual(m.note, undefined);
});

t("Measure panel is present in the Modify tab model", () => {
  const m = model.buildModifyTabModel(MIXED);
  assert.ok(m.panels.some((p) => p.label === "Measure"), "no Measure panel");
  assert.deepStrictEqual(panelsOf(m).Measure, ["measure", "clear-measurements"]);
  assert.ok(buttonOf(m, "Measure", "measure").enabled);
});

t("Filter + Select Previous sit in the Select panel", () => {
  const m = model.buildModifyTabModel(MIXED);
  const select = panelsOf(m).Select;
  assert.ok(select.includes("filter"), "Filter missing from Select panel");
  assert.ok(select.includes("select-previous"), "Select Previous missing from Select panel");
  assert.ok(buttonOf(m, "Select", "filter").enabled);
  assert.ok(buttonOf(m, "Select", "select-previous").enabled);
});

t("multi-type authored selection is titled Multi-Select; single duct type keeps its plural", () => {
  assert.strictEqual(model.buildModifyTabModel(MIXED).title, "Modify | Multi-Select");
  assert.strictEqual(model.buildModifyTabModel([native("d1", "duct")]).title, "Modify | Ducts");
  assert.strictEqual(model.buildModifyTabModel([native("c1", "column"), native("c2", "column")]).title, "Modify | Columns");
});

t("wall-only geometry keeps Join Walls; MEP selection gains Branch / Network", () => {
  assert.ok(panelsOf(model.buildModifyTabModel([native("w1", "wall")])).Geometry.includes("join-walls"));
  assert.ok(!panelsOf(model.buildModifyTabModel([native("c1", "column")])).Geometry.includes("join-walls"));
  assert.ok(panelsOf(model.buildModifyTabModel([native("d1", "duct")])).Geometry.includes("branch-network"));
  assert.ok(!panelsOf(model.buildModifyTabModel([native("w1", "wall")])).Geometry.includes("branch-network"));
});

/* ── 3. Linked selection: view-only honest subset ── */
t("linked selection yields the view-only subset with transforms disabled + reason", () => {
  const m = model.buildModifyTabModel([linked("m1:1", "IfcWall"), linked("m1:2", "IfcSlab")]);
  assert.strictEqual(m.kind, "linked");
  assert.strictEqual(m.title, "Modify | Linked Selection");
  assert.deepStrictEqual(m.panels.map((p) => p.label), ["View", "Linked", "Modify"]);
  assert.deepStrictEqual(panelsOf(m).View, ["isolate", "hide", "reveal", "zoom"]);
  assert.ok(panelsOf(m).View.every((id) => buttonOf(m, "View", id).enabled), "view commands must stay enabled for linked selection");
  assert.deepStrictEqual(panelsOf(m).Linked, ["make-editable"]);
  assert.ok(buttonOf(m, "Linked", "make-editable").enabled);
  for (const id of ["move", "copy-move", "rotate", "mirror", "array", "offset", "scale", "delete"]) {
    const b = buttonOf(m, "Modify", id);
    assert.strictEqual(b.enabled, false, `${id} must be disabled for linked selection`);
    assert.ok(b.reason && /not editable/i.test(b.reason), `${id} must carry the not-editable reason`);
    assert.ok(/Make Editable/.test(b.reason), `${id} reason must point at Make Editable`);
  }
  assert.ok(m.note && /not editable/i.test(m.note), "linked model must carry the explanatory note");
  assert.strictEqual(m.linkedCount, 2);
  assert.strictEqual(m.authoredCount, 0);
});

t("mixed selection keeps the full authored tab and notes the linked elements transforms skip", () => {
  const m = model.buildModifyTabModel([native("w1", "wall"), linked("m1:1", "IfcWall")]);
  assert.strictEqual(m.kind, "mixed");
  assert.ok(panelsOf(m).Measure.includes("measure"), "mixed selection must keep the Measure panel");
  assert.ok(m.note && /1 linked element/.test(m.note) && /authored elements only/.test(m.note));
  assert.strictEqual(m.linkedCount, 1);
  assert.strictEqual(m.authoredCount, 1);
});

/* ── 4. Filter actually filters ── */
t("Filter narrows a mixed authored selection by category (Walls vs Columns)", () => {
  const kept = model.filterElementsByCategories(MIXED, ["wall"]);
  assert.deepStrictEqual(kept.map((e) => e.id), ["w1", "w2"]);
  assert.deepStrictEqual(model.filterElementsByCategories(MIXED, ["wall", "column"]).map((e) => e.id), ["w1", "w2", "c1"]);
  assert.deepStrictEqual(model.filterElementsByCategories(MIXED, []), []);
});

t("Filter matches IFC classes to the same category (IfcWall == wall)", () => {
  const els = [linked("m1:1", "IfcWall"), linked("m1:2", "IfcSlab"), native("w1", "wall")];
  assert.deepStrictEqual(model.filterElementsByCategories(els, ["wall"]).map((e) => e.id), ["m1:1", "w1"]);
  assert.deepStrictEqual(model.filterElementsByCategories(els, ["IfcSlab"]).map((e) => e.id), ["m1:2"]);
});

t("fragment-side Filter keeps only ids whose category is chosen; unknown ids drop", () => {
  const byId = new Map([[1, "IfcWall"], [2, "IfcWall"], [3, "IfcSlab"]]);
  assert.deepStrictEqual(model.filterFragmentIdsByCategories(byId, [1, 2, 3, 99], ["wall"]), [1, 2]);
  assert.deepStrictEqual(model.filterFragmentIdsByCategories(byId, [1, 2, 3], ["IfcSlab"]), [3]);
  assert.deepStrictEqual(model.filterFragmentIdsByCategories(byId, [1, 2, 3], []), []);
});

t("selectionCategories counts categories, most-common first", () => {
  assert.deepStrictEqual(model.selectionCategories(MIXED), [
    { category: "wall", count: 2 },
    { category: "column", count: 1 },
    { category: "duct", count: 1 },
  ]);
});

/* ── 5. Select Previous store ── */
t("Select Previous restores the stored snapshot and toggles back", () => {
  const store = new model.PreviousSelectionStore();
  assert.strictEqual(store.hasPrevious, false);
  const empty = { authoredIds: [], linked: {} };
  const A = { authoredIds: ["w1"], linked: {} };
  const B = { authoredIds: ["w1", "c1"], linked: { m1: [7] } };
  store.noteCurrent(empty);
  store.noteCurrent(A);
  assert.strictEqual(store.hasPrevious, true);
  assert.ok(model.selectionSnapshotsEqual(store.previousSnapshot, empty));
  store.noteCurrent(B);
  assert.ok(model.selectionSnapshotsEqual(store.previousSnapshot, A));
  assert.ok(model.selectionSnapshotsEqual(store.currentSnapshot, B));
  // Restore B -> A: recording the restored snapshot shifts previous to B.
  store.noteCurrent(A);
  assert.ok(model.selectionSnapshotsEqual(store.previousSnapshot, B));
  assert.ok(model.selectionSnapshotsEqual(store.currentSnapshot, A));
});

t("Select Previous ignores unchanged snapshots and normalises order/duplicates", () => {
  const store = new model.PreviousSelectionStore();
  store.noteCurrent({ authoredIds: ["w1"], linked: {} });
  store.noteCurrent({ authoredIds: ["w1"], linked: {} });
  store.noteCurrent({ authoredIds: ["w1"], linked: {} });
  assert.strictEqual(store.hasPrevious, false, "unchanged snapshots must not shift the previous slot");
  assert.ok(model.selectionSnapshotsEqual(
    { authoredIds: ["b", "a", "a"], linked: { m1: [2, 1, 1] } },
    { authoredIds: ["a", "b"], linked: { m1: [1, 2] } }));
  assert.ok(!model.selectionSnapshotsEqual(
    { authoredIds: ["a"], linked: {} },
    { authoredIds: ["a"], linked: { m1: [1] } }));
});

/* ── 6. Source pins: ribbon + helpers really wire the model ── */
const ribbon = fs.readFileSync(path.join(ROOT, "src/shell/ribbon.ts"), "utf8");
const modifyOptions = fs.readFileSync(path.join(ROOT, "src/features/modify-options.ts"), "utf8");
const filterDialog = fs.readFileSync(path.join(ROOT, "src/features/selection-filter-dialog.ts"), "utf8");
const selectPrevious = fs.readFileSync(path.join(ROOT, "src/features/select-previous.ts"), "utf8");

t("ribbon renders the model for authored + linked selections", () => {
  assert.ok(/buildModifyTabModel\(elements\)/.test(ribbon), "ribbon must build the tab from the model");
  assert.ok(/function selectionItems\(elements: ModifyTabElement\[\]\)/.test(ribbon));
  assert.ok(/function linkedSelectionItems\(elements: ModifyTabElement\[\]\)/.test(ribbon));
  assert.ok(/build = \(\) => \(authored\.length \? selectionItems\(elements\) : linkedSelectionItems\(elements\)\)/.test(ribbon));
});

t("ribbon shows the linked tab when only linked elements are selected", () => {
  assert.ok(/const linked = selectedLinked\(\);/.test(ribbon));
  assert.ok(/if \(authored\.length \|\| linked\.length\)/.test(ribbon));
  assert.ok(/label = model\.title;/.test(ribbon));
});

t("ribbon subscribes to fragment selection changes (authoring change alone never fires for linked picks)", () => {
  assert.ok(/ensureFragmentSelectionSubscription\(\)/.test(ribbon));
  assert.ok(/selection\?\.onChange/.test(ribbon) || /\.onChange\(\(\) => \{ noteSelectionChange\(\); syncContextTab\(\); \}\)/.test(ribbon));
});

t("ribbon records every selection change for Select Previous", () => {
  assert.ok(/noteSelectionChange\(\);/.test(ribbon));
  assert.ok(/restorePreviousSelection\(\)/.test(ribbon), "Select Previous button must call the restore");
  assert.ok(!/ctrl\+left/i.test(ribbon) || /binding pending/i.test(ribbon),
    "Ctrl+Left must not be advertised as a working binding");
});

t("Measure panel is wired into both contextual tab modes (selection + placement)", () => {
  assert.ok(/groupLabel\("Measure"\)/.test(ribbon), "no Measure group in ribbon");
  const measureUses = ribbon.match(/toggleMeasure\(\)/g) ?? [];
  assert.ok(measureUses.length >= 3, `Measure must be wired in Coordinate + both contextual modes (found ${measureUses.length} toggleMeasure calls)`);
  assert.ok(/"measure":/.test(ribbon), "model-driven Measure button handler missing");
  assert.ok(/"clear-measurements":/.test(ribbon), "model-driven Clear Meas. handler missing");
});

t("disabled ribbon buttons exist and carry the reason as tooltip", () => {
  assert.ok(/disabled\?: boolean/.test(ribbon), "BtnOpts must support disabled");
  assert.ok(/el\.disabled = true/.test(ribbon), "b() must set native disabled");
  assert.ok(/opts\.disabled \? \(opts\.title \|\| label\)/.test(ribbon), "disabled buttons must show the reason as tooltip");
});

t("Filter dialog is a real one-shot filter, not a persistent profile", () => {
  assert.ok(/openFormModal\(\{/.test(filterDialog));
  assert.ok(/kind: "checkbox"/.test(filterDialog));
  assert.ok(/selectAllAuthored\(keptIds\)/.test(filterDialog), "authored Filter must narrow via selectAllAuthored");
  assert.ok(/sel\?\.replace\?\.\(next\)/.test(filterDialog), "linked Filter must narrow via fragment replace");
  assert.ok(!/setFilter\(/.test(filterDialog), "Filter must not set the persistent category filter");
  assert.ok(/withSelectionRecordingPaused/.test(filterDialog), "Filter must not corrupt the previous-selection slot mid-apply");
});

t("Select Previous restore covers authored + linked and skips deleted elements", () => {
  assert.ok(/selectAllAuthored\(authoredIds\)/.test(selectPrevious));
  assert.ok(/sel\?\.replace\?\.\(map\)/.test(selectPrevious));
  assert.ok(/droppedAuthored/.test(selectPrevious));
  assert.ok(/withSelectionRecordingPaused/.test(selectPrevious));
});

t("modify-options exposes the linked half of the selection", () => {
  assert.ok(/export function selectedLinked\(\)/.test(modifyOptions));
  assert.ok(/export function currentSelectionSnapshot\(\)/.test(modifyOptions));
  assert.ok(/selection\?\.snapshot/.test(modifyOptions));
});

t("no Ctrl+Left shortcut is registered anywhere for Select Previous", () => {
  const shortcuts = fs.readFileSync(path.join(ROOT, "src/shell/default-shortcuts.ts"), "utf8");
  assert.ok(!/select-previous|Select Previous/i.test(shortcuts),
    "Ctrl+Left binding belongs to G8 — this branch must not register it");
});

console.log(`\nmodify-tab-completion: ${pass} assertions passed`);
