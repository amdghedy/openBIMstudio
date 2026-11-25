#!/usr/bin/env node
/**
 * AutoCAD 2D parity A12 — main-shell ribbon completion.
 *
 * Pins the A12 contract in the main shell (src/shell/ribbon.ts):
 *  1. Home / Parametric / Output tabs exist in the order model with the
 *     A12 groups, Home first and the default tab at startup.
 *  2. All 14 planned() buttons are resolved: 13 removed, Manage Energy
 *     wired to the real heat-loss report (same as Analyze ▸ Heat Loss).
 *  3. The parametric toolkit + family tools MOVED (not copied) to the
 *     Parametric tab; constraint tools are shared builders.
 *  4. Global Undo/Redo buttons (Home tab) + a quick access toolbar
 *     (New / Open / Save / Undo / Redo) call the real history stack and
 *     reflect its state.
 *  5. The Output tab's Print calls the file menu's printView.
 *
 * Two layers, same style as tests/ribbon-tab-order.test.cjs:
 *  1. The order model itself is EXECUTED: src/shell/ribbon-order.ts is a
 *     pure, DOM-free module compiled with tsc and required here.
 *  2. Source pins prove ribbon.ts matches that model and that every
 *     button above is wired to a real handler (or gone).
 *
 * Sensitivity: on the pre-A12 tree this fails — there is no Home /
 * Parametric / Output tab, 14 planned() calls exist, and there is no QAT.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the order model ────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ra12-"));
execSync(`npx tsc src/shell/ribbon-order.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "ribbon-order.js"));
const ORDER = model.RIBBON_TAB_ORDER;

/* ── 2. Parse ribbon.ts ──────────────────────────────────────────────── */
const ribbonSrc = fs.readFileSync(path.join(ROOT, "src/shell/ribbon.ts"), "utf8");
const noComments = ribbonSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const t0 = noComments.indexOf("const TABS:");
const t1 = noComments.indexOf("\n];", t0);
assert.ok(t0 >= 0 && t1 > t0, "TABS array not found in ribbon.ts");
const region = noComments.slice(t0, t1);
const tabChunks = region.split(/^  \{$/m).slice(1);
const tabId = (c) => { const m = c.match(/^    id: "([^"]+)",$/m); assert.ok(m, "tab chunk without id"); return m[1]; };
const chunk = (id) => {
  const c = tabChunks.find((x) => tabId(x) === id);
  assert.ok(c, `${id} tab missing from TABS`);
  return c;
};
const homeChunk = chunk("home");
const parametricChunk = chunk("parametric");
const outputChunk = chunk("output");
const archChunk = chunk("architecture");
const insertChunk = chunk("insert");
const annotateChunk = chunk("annotate");
const manageChunk = chunk("manage");
const massingChunk = chunk("massing-site");
const editChunk = chunk("edit");

t("model: Home first, Parametric after Annotate, Output after Manage", () => {
  assert.strictEqual(ORDER[0].id, "home");
  assert.deepStrictEqual([...ORDER[0].groups], ["Draw", "Modify", "Annotate", "History", "Properties"]);
  const ann = ORDER.findIndex((x) => x.id === "annotate");
  assert.strictEqual(ORDER[ann + 1].id, "parametric");
  assert.deepStrictEqual([...ORDER.find((x) => x.id === "parametric").groups],
    ["Parametric", "Families", "Constraints"]);
  const man = ORDER.findIndex((x) => x.id === "manage");
  assert.strictEqual(ORDER[man + 1].id, "output");
  assert.deepStrictEqual([...ORDER.find((x) => x.id === "output").groups], ["Plot", "Export", "Sheets"]);
});

t("Home is the default tab at startup", () => {
  assert.ok(ribbonSrc.includes('let activeTab = "home"'), "activeTab must default to home");
  assert.ok(ribbonSrc.includes('activeTab = workspaceSaved ? getWorkspaceDefinition(activeWorkspace).tab : "home"'),
    "a saved workspace still lands on its tab; a first boot lands on Home");
});

t("Home tab holds the draw/modify essentials + History + Properties", () => {
  for (const tool of ["Wall", "Door", "Window", "Column", "Floor", "Grid", "Level", "Model Line"]) {
    assert.ok(homeChunk.includes(`"${tool}"`), `Home tab lost draw tool "${tool}"`);
  }
  for (const tool of ["Select", "Move", "Copy", "Rotate", "Mirror", "Array", "Offset", "Delete"]) {
    assert.ok(homeChunk.includes(`"${tool}"`), `Home tab lost modify tool "${tool}"`);
  }
  for (const tool of ["Aligned", "Linear", "Tag", "Text"]) {
    assert.ok(homeChunk.includes(`"${tool}"`), `Home tab lost annotate tool "${tool}"`);
  }
  assert.ok(homeChunk.includes("historyUndoButton()"), "Home tab lacks the global Undo button");
  assert.ok(homeChunk.includes("historyRedoButton()"), "Home tab lacks the global Redo button");
  assert.ok(homeChunk.includes("propertiesButton()"), "Home tab lacks Properties");
});

t("no planned() button survives anywhere in the ribbon", () => {
  assert.ok(!ribbonSrc.includes("planned("), "a planned() call still exists in ribbon.ts");
  assert.ok(!ribbonSrc.includes("function planned("), "the planned() helper still exists");
  for (const label of ["Space", "View Ref", "Tread", "Spell", "Find / Replace",
    "Duct", "Pipe", "Color Fill", "Symbol"]) {
    assert.ok(!annotateChunk.includes(`"${label}"`), `Annotate still shows dead button "${label}"`);
  }
  assert.ok(!massingChunk.includes('"Subregion"'), "Massing & Site still shows dead button Subregion");
  assert.ok(!editChunk.includes('"By Face"'), "Edit still shows dead button By Face");
  assert.ok(!editChunk.includes('"Drag Sel"'), "Edit still shows dead button Drag Sel");
});

t("Manage Energy is wired to the real heat-loss report", () => {
  assert.ok(manageChunk.includes('b("energy", "Energy"'), "Manage Energy button missing");
  assert.ok(manageChunk.includes("runHeatLossReport"), "Manage Energy must call runHeatLossReport");
  assert.ok(!manageChunk.includes("planned("), "Manage still has a planned() button");
});

t("parametric toolkit + family tools moved to Parametric, not copied", () => {
  assert.ok(parametricChunk.includes("parametricToolkitButton()"), "Parametric tab lacks the toolkit button");
  assert.ok(!archChunk.includes("parametricToolkitButton()"), "toolkit button still in Architecture (copied, not moved)");
  for (const label of ["Family Creator", "Sketch Family", "Family Panel"]) {
    assert.ok(parametricChunk.includes(`"${label}"`), `Parametric tab lacks "${label}"`);
    assert.ok(!insertChunk.includes(`"${label}"`), `"${label}" still in Insert (copied, not moved)`);
  }
  // "Family" (types & materials) and "Materials" stay in Insert.
  assert.ok(insertChunk.includes('"Family"'), "Insert lost the Family library button");
  assert.ok(insertChunk.includes('"Materials"'), "Insert lost the Materials button");
});

t("constraint tools are shared builders, not duplicated closures", () => {
  assert.strictEqual((ribbonSrc.match(/function lockDimensionButton/g) || []).length, 1,
    "lockDimensionButton must be defined once");
  assert.strictEqual((ribbonSrc.match(/function equalityButton/g) || []).length, 1,
    "equalityButton must be defined once");
  assert.ok(archChunk.includes("lockDimensionButton()"), "Architecture lost Lock Dim");
  assert.ok(archChunk.includes("equalityButton()"), "Architecture lost Equality");
  assert.ok(parametricChunk.includes("lockDimensionButton()"), "Parametric lacks Lock Dim");
  assert.ok(parametricChunk.includes("equalityButton()"), "Parametric lacks Equality");
});

t("global Undo/Redo call the real history stack and reflect its state", () => {
  assert.ok(ribbonSrc.includes("await history.undo()"), "Undo button must call history.undo()");
  assert.ok(ribbonSrc.includes("await history.redo()"), "Redo button must call history.redo()");
  assert.ok(ribbonSrc.includes("disabled: !history.canUndo()"), "Undo must disable when nothing to undo");
  assert.ok(ribbonSrc.includes("disabled: !history.canRedo()"), "Redo must disable when nothing to redo");
  assert.ok(ribbonSrc.includes("history.onChange(() => updateHistoryButtons())"),
    "Undo/Redo state must refresh on history changes");
  assert.ok(ribbonSrc.includes("function updateHistoryButtons()"), "updateHistoryButtons missing");
});

t("quick access toolbar: New / Open / Save / Undo / Redo in the tabs row", () => {
  assert.ok(ribbonSrc.includes('qat.className = "obs-qat"'), "QAT element missing");
  for (const action of ["new", "open", "save", "undo", "redo"]) {
    assert.ok(ribbonSrc.includes(`"${action}"`), `QAT lacks action "${action}"`);
  }
  assert.ok(ribbonSrc.includes("tabsRow.appendChild(qat)"), "QAT must live in the tabs row");
  assert.ok(ribbonSrc.includes("if (a === \"new\") showHome()"), "QAT New must open the home screen");
  assert.ok(ribbonSrc.includes("void pickAndImport()"), "QAT Open must pick and import a file");
  assert.ok(ribbonSrc.includes("void saveProject()"), "QAT Save must save the project");
  assert.ok(ribbonSrc.includes("void history.undo()"), "QAT Undo must call history.undo()");
  assert.ok(ribbonSrc.includes("void history.redo()"), "QAT Redo must call history.redo()");
});

t("Output tab: Print calls the file menu; Batch Plot + Export + Sheets present", () => {
  assert.ok(outputChunk.includes('b("print", "Print"'), "Output tab lacks Print");
  assert.ok(outputChunk.includes("printView()"), "Output Print must call printView()");
  assert.ok(outputChunk.includes('"Batch Plot"'), "Output tab lacks Batch Plot");
  assert.ok(outputChunk.includes("openBatchPlotPanel"), "Batch Plot must open the batch plot panel");
  for (const label of ["IFC4", "IFC2X3", "FRAG", "Sheets", "New Sheet", "Drawing Register"]) {
    assert.ok(outputChunk.includes(`"${label}"`), `Output tab lacks "${label}"`);
  }
  const fileMenu = fs.readFileSync(path.join(ROOT, "src/shell/file-menu.ts"), "utf8");
  assert.ok(fileMenu.includes("export function printView()"), "file-menu must export printView for the Output tab");
});

t("no planned() references survive in the docs or styles contract", () => {
  const distinctions = fs.readFileSync(path.join(ROOT, "src/modules/views/annotate-distinctions.ts"), "utf8");
  assert.ok(!distinctions.includes("planned()"), "annotate-distinctions still references planned() stubs");
  const css = fs.readFileSync(path.join(ROOT, "src/style.css"), "utf8");
  assert.ok(css.includes(".obs-qat"), "style.css lacks the QAT rules");
  assert.ok(css.includes(".obs-qat__btn"), "style.css lacks the QAT button rules");
});

console.log(`\nribbon-a12: ${pass} assertions passed`);
