#!/usr/bin/env node
/**
 * Project Browser right-click menu — Revit 2D environment audit gap G11
 * (the menu itself; the tree ordering/grouping/filter is pinned by
 * tests/project-browser-g11.test.cjs).
 *
 * src/features/project-browser.ts claims "right-click actions" in its header
 * but wires zero contextmenu handlers: right-clicking a tree node does
 * nothing (or opens the viewport menu). This suite pins the menu model:
 *
 * Two layers, same style as tests/project-browser-g11.test.cjs:
 *  1. The menu model itself is EXECUTED: src/features/project-browser-menu.ts
 *     is a pure, DOM-free module compiled with tsc and required here.
 *     menuItemsForNode(node, caps) returns the exact items (id, label,
 *     danger, disabled) for every node kind, or null when the node has no
 *     applicable action and gets no menu rather than a fake one.
 *  2. Source pins prove src/features/project-browser.ts wires a contextmenu
 *     handler on tree rows, builds the menu from that model, executes every
 *     listed action for real (rename via promptLine, delete via
 *     confirmDialog — never native prompt/confirm), and that the stores the
 *     actions need actually expose the operations (sheet/view/phase/set
 *     duplicate + rename).
 *
 * Sensitivity: on the pre-menu tree this fails — there is no
 * project-browser-menu.ts to compile, no contextmenu handler in
 * project-browser.ts, and no duplicateSheet / renameView / duplicateView /
 * renameSet / duplicateSet exports in the stores.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the menu model ─────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pbm-"));
execSync(`npx tsc src/features/project-browser-menu.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "project-browser-menu.js"));
const { menuItemsForNode } = model;

/** Minimal node factory: only the fields the menu model reads. */
const node = (kind, id, label, meta, children) => ({
  id, kind, label, icon: "·", ...(meta ? { meta } : {}), ...(children ? { children } : {}),
});
const ids = (items) => (items ?? []).map((i) => i.id);
const byId = (items, id) => (items ?? []).find((i) => i.id === id);

/* ── 2. Leaf nodes: open / rename / duplicate / delete ────────────────── */
t("view-def, view-saved and sheet nodes get Open / Rename / Duplicate / Delete", () => {
  for (const n of [
    node("view-def", "viewdef-plan-level-0", "Level 0 Plan", { viewId: "plan-level-0" }),
    node("view-saved", "view-sv1", "Iso Overview", { viewId: "sv1" }),
    node("sheet", "sheet-sh1", "A-101 — Ground Floor Plan", { sheetId: "sh1" }),
  ]) {
    const items = menuItemsForNode(n);
    assert.deepStrictEqual(ids(items), ["open", "rename", "duplicate", "delete"]);
    assert.strictEqual(byId(items, "delete").danger, true, "Delete must be flagged danger");
    assert.strictEqual(byId(items, "open").label, "Open");
    assert.strictEqual(byId(items, "rename").label, "Rename…");
    assert.strictEqual(byId(items, "duplicate").label, "Duplicate");
    assert.strictEqual(byId(items, "delete").label, "Delete");
    assert.ok(!items.some((i) => i.disabled), "no item disabled for a plain leaf");
  }
});

t("family, family-type, group and phase nodes get Open / Rename / Duplicate / Delete", () => {
  for (const n of [
    node("family", "fam-door-1", "Single Door", { builtIn: false }),
    node("family-type", "famtype-door-1-t1", "900 x 2100mm", { familyId: "door-1", typeId: "t1" }),
    node("group", "grp-g1", "Core Walls", { setId: "g1" }),
    node("phase", "phase-p1", "Existing", { phaseId: "p1" }),
  ]) {
    const items = menuItemsForNode(n);
    assert.deepStrictEqual(ids(items), ["open", "rename", "duplicate", "delete"]);
    assert.strictEqual(byId(items, "delete").danger, true);
  }
});

t("built-in families keep Rename and Duplicate but Delete is disabled, not removed", () => {
  const items = menuItemsForNode(node("family", "fam-wall-1", "Basic Wall", { builtIn: true }));
  assert.deepStrictEqual(ids(items), ["open", "rename", "duplicate", "delete"]);
  const del = byId(items, "delete");
  assert.strictEqual(del.disabled, true, "the store refuses built-in removal, so the menu must not offer it as live");
  assert.ok((del.disabledReason ?? "").toLowerCase().includes("built-in"), "the reason must say why");
  assert.ok(!byId(items, "rename").disabled, "Rename stays live: the store allows updating built-ins");
  assert.ok(!byId(items, "duplicate").disabled, "Duplicate stays live: it creates a non-built-in copy");
});

/* ── 3. Single-action leaves: Open only ───────────────────────────────── */
t("view-3d, view-plan, material, link and schedule entries get Open only", () => {
  for (const n of [
    node("view-3d", "view-3d", "3D View"),
    node("view-plan", "view-plan", "Floor Plan"),
    node("material", "mat-concrete", "Concrete C25/30", { materialId: "m1" }),
    node("link", "link-m1", "site.ifc", { modelId: "m1" }),
    node("schedule", "sch-open", "Open Schedules panel"),
    node("schedule", "sch-cost", "Cost / QTO"),
  ]) {
    assert.deepStrictEqual(ids(menuItemsForNode(n)), ["open"], `${n.kind} must offer exactly Open`);
  }
});

/* ── 4. Root and group nodes: creation actions, all real ──────────────── */
t("Views root offers New View + Expand All; kind subgroups offer New <kind> View", () => {
  assert.deepStrictEqual(ids(menuItemsForNode(node("views", "views", "Views (all)"))), ["new-view", "expand-all"]);
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("view-group", "views-plan", "Floor Plans"))),
    ["new-view", "expand-all"],
  );
  assert.strictEqual(byId(menuItemsForNode(node("view-group", "views-plan", "Floor Plans")), "new-view").label, "New Floor Plan View");
  assert.strictEqual(byId(menuItemsForNode(node("view-group", "views-elevation", "Elevations")), "new-view").label, "New Elevation View");
  assert.strictEqual(byId(menuItemsForNode(node("view-group", "views-3d", "3D Views")), "new-view").label, "New 3D View");
  assert.strictEqual(byId(menuItemsForNode(node("view-group", "views-section", "Sections")), "new-view").label, "New Section View");
});

t("Saved Views subgroup offers Save Current View, not a kind New View", () => {
  const items = menuItemsForNode(node("view-group", "views-saved", "Saved Views"));
  assert.deepStrictEqual(ids(items), ["save-view", "expand-all"]);
  assert.strictEqual(byId(items, "save-view").label, "Save Current View");
});

t("Sheets root offers New Sheet + Open Sheets Panel; Schedules root offers its two panels", () => {
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("sheets", "sheets", "Sheets (all)"))),
    ["new-sheet", "open-sheets", "expand-all"],
  );
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("schedules", "schedules", "Schedules/Quantities (all)"))),
    ["open-schedules", "open-cost"],
  );
});

t("Families root offers Open Properties; Materials subgroup offers New Material", () => {
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("families", "families", "Families"))),
    ["open-properties", "expand-all"],
  );
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("materials", "families-materials", "Materials"))),
    ["new-material", "expand-all"],
  );
});

t("Groups root offers New Selection Set — disabled with an empty selection, live with one", () => {
  const noSel = menuItemsForNode(node("groups", "groups", "Groups"), { hasSelection: false });
  assert.deepStrictEqual(ids(noSel), ["new-set", "expand-all"]);
  assert.strictEqual(byId(noSel, "new-set").disabled, true, "a set is saved from the selection; with none there is nothing to save");
  assert.ok((byId(noSel, "new-set").disabledReason ?? "").length > 0, "a disabled item must say why");
  const withSel = menuItemsForNode(node("groups", "groups", "Groups"), { hasSelection: true });
  assert.strictEqual(byId(withSel, "new-set").disabled, undefined);
});

t("Links root offers Open Model Tree; Phases root offers New Phase + Open Timeline", () => {
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("links", "links", "Models & Links"))),
    ["open-model-tree", "expand-all"],
  );
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("phases", "phases", "4D Phases"))),
    ["new-phase", "open-timeline", "expand-all"],
  );
});

/* ── 5. Empty placeholders and unknown kinds ──────────────────────────── */
t("empty placeholders offer only their creation action; guidance-only placeholders get no menu", () => {
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("sheet", "sheet-empty", "(no sheets — create default set)"))),
    ["create-default-sheets"],
  );
  assert.deepStrictEqual(
    ids(menuItemsForNode(node("phase", "phase-empty", "(create default phases)"))),
    ["create-default-phases"],
  );
  assert.strictEqual(menuItemsForNode(node("group", "grp-empty", "(save a selection set first)")), null);
  assert.strictEqual(menuItemsForNode(node("link", "link-empty", "(no models — Insert → Link IFC)")), null);
});

t("an unknown kind gets no menu rather than a fake one", () => {
  assert.strictEqual(menuItemsForNode(node("no-such-kind", "x", "X")), null);
  assert.strictEqual(menuItemsForNode(node("root", "root", "Root")), null);
});

/* ── 6. Source pins: the panel wires the menu and executes it ─────────── */
const pbSrc = fs.readFileSync(path.join(ROOT, "src/features/project-browser.ts"), "utf8");

t("project-browser.ts imports the menu model and handles row right-clicks", () => {
  assert.ok(pbSrc.includes('from "./project-browser-menu"'), "must import the menu model");
  assert.ok(pbSrc.includes("menuItemsForNode"), "must build the menu from the model");
  assert.ok(
    pbSrc.includes('addEventListener("contextmenu"') || pbSrc.includes("oncontextmenu"),
    "tree rows need a contextmenu handler",
  );
  assert.ok(pbSrc.includes("obs-project-browser-menu"), "the menu element needs a stable id for tests and styling");
});

t("every menu action id is executed in project-browser.ts (no listed action is a stub)", () => {
  for (const id of [
    "open", "rename", "duplicate", "delete",
    "new-view", "save-view", "new-sheet", "new-phase", "new-material", "new-set",
    "create-default-sheets", "create-default-phases",
    "open-schedules", "open-cost", "open-sheets", "open-timeline", "open-model-tree",
    "open-properties", "expand-all",
  ]) {
    assert.ok(pbSrc.includes(`"${id}"`), `project-browser.ts never handles menu action "${id}"`);
  }
});

t("rename uses the app dialog and delete uses the app confirm — never native prompt/confirm/alert", () => {
  assert.ok(pbSrc.includes("promptLine"), "rename must prompt through the app form-modal, not window.prompt");
  assert.ok(pbSrc.includes("confirmDialog"), "delete must confirm through the app dialog, not window.confirm");
  assert.ok(!pbSrc.includes("window.prompt("), "native prompt is banned in the browser panel");
  assert.ok(!pbSrc.includes("window.confirm("), "native confirm is banned in the browser panel");
  assert.ok(!/alert\s*\(/.test(pbSrc), "native alert is banned in the browser panel");
  assert.ok(pbSrc.includes('new CustomEvent("obs-toast"'), "actions must report through the obs-toast system");
  assert.ok(!pbSrc.includes("planned"), "no 'planned' entries may appear in the menu path");
});

t("the stores expose the operations the menu needs", () => {
  const sheetsSrc = fs.readFileSync(path.join(ROOT, "src/modules/sheets/sheets.ts"), "utf8");
  assert.ok(sheetsSrc.includes("export function duplicateSheet"), "sheets store must export duplicateSheet");
  const viewsSrc = fs.readFileSync(path.join(ROOT, "src/modules/views/store.ts"), "utf8");
  assert.ok(viewsSrc.includes("export function duplicateView"), "views store must export duplicateView");
  const savedSrc = fs.readFileSync(path.join(ROOT, "src/features/saved-views.ts"), "utf8");
  assert.ok(savedSrc.includes("export function renameView"), "saved-views must export renameView");
  assert.ok(savedSrc.includes("export function duplicateView"), "saved-views must export duplicateView");
  const selSrc = fs.readFileSync(path.join(ROOT, "src/features/selection.ts"), "utf8");
  assert.ok(selSrc.includes("renameSet("), "selection manager must offer renameSet");
  assert.ok(selSrc.includes("duplicateSet("), "selection manager must offer duplicateSet");
  const treeSrc = fs.readFileSync(path.join(ROOT, "src/features/project-browser-tree.ts"), "utf8");
  assert.ok(treeSrc.includes("builtIn"), "family nodes must carry the built-in flag the menu needs");
});

/* ── 7. CI wiring pins ────────────────────────────────────────────────── */
t("the suite is wired into package.json, the CI battery and the smoke list", () => {
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  assert.ok(pkg.includes('"test:project-browser-menu-g11"'), "package.json needs the new suite script");
  const battery = fs.readFileSync(path.join(ROOT, "scripts/ci-unit-tests.mjs"), "utf8");
  assert.ok(battery.includes("test:project-browser-menu-g11"), "ci-unit-tests.mjs must run the new suite");
  const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/unit-tests.yml"), "utf8");
  assert.ok(workflow.includes("tests/e2e/project-browser-menu-g11.spec.ts"), "the browser smoke list must run the new spec");
});

console.log(`\nproject-browser-menu-g11: ${pass} passed`);
