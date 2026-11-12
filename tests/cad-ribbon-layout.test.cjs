/**
 * CAD editor DWG-style SHELL RIBBON layout suite — native-engine edition.
 *
 * Pins the DWG MDI chrome stacking order, the full six-tab drafting
 * ribbon (Home / Insert / Annotate / View / Manage / Output) and the wiring
 * of every panel button to a real engine command or tool:
 *   application menu (red A) + ribbon tabs + Quick Access toolbar
 *   → active ribbon tab's panels (one set per open drawing)
 *   → drawing file tabs
 *   → viewport / command line / status bar.
 *
 * Static assertions (source-level) — the same style the DWG lifecycle suite
 * uses for its G5 main-thread section. cad-viewer.ts pulls three.js and the
 * cad-link stack, so DOM-booting it in Node would need a full browser stub.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); } };
const src = fs.readFileSync(path.join(ROOT, "src/features/cad-viewer.ts"), "utf8");
const icons = fs.readFileSync(path.join(ROOT, "src/features/icon-set.ts"), "utf8");

// ── 1. Shell stacking order: ribbon tabs row → ribbon panels → drawing tabs → pages ──
t("shell mounts chrome in DWG order: ribbon tabs, panels, drawing tabs, pages", () => {
  const ensure = src.slice(src.indexOf("function ensureShell"), src.indexOf("function createTab"));
  const iTabs = ensure.indexOf('data-r="ribbontabs"');
  const iStrip = ensure.indexOf('data-r="ribbonstrip"');
  const iFiles = ensure.indexOf('data-r="tabstrip"');
  const iPages = ensure.indexOf('data-r="pages"');
  assert.ok(iTabs >= 0, "ribbon tabs row missing from shell");
  assert.ok(iStrip >= 0, "ribbon panel strip missing from shell");
  assert.ok(iFiles >= 0, "drawing file tabstrip missing from shell");
  assert.ok(iPages >= 0, "pages host missing from shell");
  assert.ok(iTabs < iStrip, "ribbon tabs row must be ABOVE the ribbon panels");
  assert.ok(iStrip < iFiles, "drawing file tabs must be BELOW the ribbon (DWG layout)");
  assert.ok(iFiles < iPages, "drawing tabs must be ABOVE the drawing pages");
});

// ── 2. Ribbon tabs row content ──
t("ribbon tabs: Home / Insert / Annotate / Parametric / View / Manage / Output / Express Tools / Collaborate", () => {
  const m = src.match(/const RIBBON_TABS: ReadonlyArray<\{ id: string; label: string \}> = \[([\s\S]*?)\];/);
  assert.ok(m, "RIBBON_TABS definition missing");
  for (const id of ["home", "insert", "annotate", "parametric", "view", "manage", "output", "express", "collaborate"]) {
    assert.ok(m[1].includes(`id: "${id}"`), `ribbon tab "${id}" missing`);
  }
  assert.ok(!/id: "(file|data|settings)"/.test(m[1]), "no invented tabs: every tab maps to real panel groups");
});
t("tab row carries the red application menu button and the Quick Access toolbar", () => {
  const ensure = src.slice(src.indexOf("function ensureShell"), src.indexOf("function createTab"));
  assert.ok(ensure.includes('class="cad-appmenu"'), "app menu (red A) button missing");
  assert.ok(ensure.includes('class="cad-qat"'), "Quick Access toolbar missing");
  assert.ok(ensure.includes('data-r="appmenu"'), "app menu not wired to openAppMenu");
  assert.ok(ensure.includes('data-qat="${action}"'), "QAT button builder must emit data-qat");
  for (const [icon, a] of [["folder", "open"], ["save", "save-dxf"], ["print", "plot"], ["undo", "undo"], ["undo", "redo"], ["fit", "ext"]]) {
    assert.ok(ensure.includes(`qatBtn("${icon}", "${a}"`), `QAT action "${a}" missing`);
  }
});
t("A-menu dispatches to the active drawing and offers shell-level file ops", () => {
  const menu = src.slice(src.indexOf("function openAppMenu"), src.indexOf("function ensureShell"));
  for (const item of ["New Drawing", "Open…", "Save DXF", "Save All", "Plot…", "Export SVG", "Export Measurements CSV", "Quantity Takeoff (CSV)", "Drawing Information", "Close Drawing"]) {
    assert.ok(menu.includes(`item("${item}"`), `A-menu item "${item}" missing`);
  }
  assert.ok(menu.includes("ribbonActive?.exec("), "A-menu must dispatch to the active drawing's engine");
});

// ── 3. Ribbon tabs filter the panel groups of the active drawing ──
t("every ribbon group is tagged with exactly one of the nine tabs", () => {
  const expected = {
    // Home
    Clipboard: "home", Select: "home", Draw: "home", "Draw II": "home", Modify: "home", "Modify II": "home",
    Annotation: "home", Properties: "home", Utilities: "home", History: "home", Layers: "home", Styles: "home",
    "AI Copilot": "home",
    // Insert
    Block: "insert", "Open Drawing": "insert", "PDF Import": "insert", Import: "insert", Fields: "insert", Data: "insert",
    // Annotate
    Text: "annotate", Dimensions: "annotate", Markup: "annotate", Tables: "annotate", "Markup Files": "annotate",
    // Parametric
    Geometric: "parametric", Dimensional: "parametric", Manage: "parametric",
    // View
    Navigate: "view", "Saved Views": "view", "Visual Styles": "view", Modes: "view", UCS: "view", Show: "view", Palettes: "view",
    // Manage
    Units: "manage", Drawing: "manage", "Layer States": "manage", "DWG Inspect": "manage", Customization: "manage", "CAD Standards": "manage",
    // Output
    Plot: "output", "DWG Data": "output", Export: "output", Window: "output",
    // Express Tools
    "Text": "express", Modify: "express", Layers: "express", Tools: "express",
    // Collaborate
    Publish: "collaborate", Share: "collaborate", History: "collaborate", Standards: "collaborate",
  };
  const found = {};
  const re = /rg\(\s*(?:\n\s*)?"((?:[^"\\]|\\.)+)",([\s\S]*?)"(home|insert|annotate|parametric|view|manage|output|express|collaborate)"\s*\)?/g;
  let m;
  while ((m = re.exec(src)) !== null) found[m[1]] = m[3];
  for (const [label, tab] of Object.entries(expected)) {
    assert.strictEqual(found[label], tab, `group "${label}" expected on tab "${tab}", got "${found[label]}"`);
  }
  const extra = Object.keys(found).filter((k) => !(k in expected));
  assert.deepStrictEqual(extra, [], "untagged/unexpected ribbon groups");
});
t("CSS filters panels per active ribbon tab", () => {
  for (const id of ["home", "insert", "annotate", "parametric", "view", "manage", "output", "express", "collaborate"]) {
    assert.ok(
      src.includes(`.cadrb-strip[data-ribbon-tab="${id}"] .cadrg[data-cadtab="${id}"]`),
      `no CSS rule shows panels for tab "${id}"`,
    );
  }
});
t("ribbon tab selection persists and is applied on boot", () => {
  assert.ok(src.includes('localStorage.getItem("obs.cad.ribbon.tab")'), "tab choice not restored");
  assert.ok(src.includes('localStorage.setItem("obs.cad.ribbon.tab", ribbonTab)'), "tab choice not saved");
  assert.ok(src.includes("applyRibbonTab();"), "tab choice not applied");
});

// ── 4. Per-drawing panels mount into the shell ──
t("engine no longer embeds its own toolbar strip; panels mount into shell chrome", () => {
  assert.ok(!/root\.innerHTML\s*=\s*`[^`]*cadrb-strip/s.test(src), "per-page .cadrb-strip must be gone");
  const api = src.slice(src.indexOf("const api: CadEngineApi"));
  assert.ok(api.includes("showRibbonEngine(ribbonWrap, api)"), "activate() must mount this drawing's panels");
  assert.ok(api.includes("registerRibbonEngine(ribbonWrap, api)"), "engine must register its panels with the shell");
});
t("closing a drawing removes its ribbon panels and releases the active engine", () => {
  const close = src.slice(src.indexOf("function closeTab"), src.indexOf("function closeOthers"));
  assert.ok(close.includes("ribbonEngines.delete(tab.engine)"), "panels not removed on close");
  assert.ok(close.includes("ribbonActive"), "active engine not released on close");
});
t("only the active drawing's panels are visible", () => {
  const show = src.slice(src.indexOf("function showRibbonEngine"), src.indexOf("export function openCadViewer"));
  assert.ok(show.includes('w.classList.toggle("on", w === wrap)'), "showRibbonEngine must toggle the .on class per wrap");
});

// ── 5. exec() bridges shell chrome → engine actions ──
t("engine exposes exec() covering left-ribbon and right-ribbon actions", () => {
  assert.ok(src.includes("exec: (a: string) => {"), "exec() missing on the engine API");
  assert.ok(src.includes("const act: Record<string, () => void> = {};"), "left action map not hoisted");
  assert.ok(src.includes("const act2: Record<string, () => void> = {};"), "right action map not hoisted");
  for (const k of ["tText", "tHatch", "tLt", "help", "close", "takeoff", "save-mk", "load-mk", "info", "svg", "csv"]) {
    assert.ok(src.includes(`"${k}"`), `action "${k}" not forwarded via act2`);
  }
  // Layers / Styles managers moved to buildBar's act map when the panels moved
  assert.ok(src.includes('"lyr-mgr": openLayerPropertiesManager'), "lyr-mgr must dispatch through act");
  assert.ok(src.includes('"lt-mgr": () => openLinetypeManager(styleApi)'), "lt-mgr must dispatch through act");
  assert.ok(src.includes('"ts-mgr": () => openTextStyleManager(styleApi)'), "ts-mgr must dispatch through act");
});
t("QAT and A-menu route through ribbonActive, Open uses the shell picker", () => {
  const ensure = src.slice(src.indexOf("function ensureShell"), src.indexOf("function createTab"));
  assert.ok(ensure.includes('if (a === "open") picker!.click();'), "QAT/A-menu Open must use the multi-file shell picker");
  assert.ok(ensure.includes("ribbonActive?.exec(a)"), "QAT must dispatch to the active drawing");
});
t("toolbar actions still wired: tool buttons, toggles, selects", () => {
  assert.ok(src.includes('tools.querySelectorAll<HTMLButtonElement>("[data-t]").forEach((b) => (b.onclick = () => setTool(b.dataset.t as Tool)));'), "tool buttons not wired");
  assert.ok(src.includes('tools.querySelectorAll<HTMLElement>("button[data-a]").forEach'), "action buttons not wired");
  assert.ok(src.includes('sel("bg").onchange'), "background select not wired");
  assert.ok(src.includes('sel("du").onchange'), "units select not wired");
  assert.ok(src.includes('sel("ecol").onchange'), "entity color select not wired");
  assert.ok(src.includes('sel("elt").onchange'), "entity linetype select not wired");
});

// ── 6. Native-engine drafting ribbon: every button lands on a real tool ──
t("all 33 ribbon groups exist after the native-engine reorganization", () => {
  for (const label of [
    "Clipboard", "Select", "Draw", "Draw II", "Modify", "Modify II", "Annotation", "Properties", "Utilities", "History", "Layers", "Styles",
    "Block", "Import", "Fields", "Data",
    "Text", "Dimensions", "Markup", "Tables", "Markup Files",
    "Navigate", "Saved Views", "Visual Styles", "Modes", "UCS", "Show",
    "Units", "Drawing", "Layer States",
    "Plot", "Export", "Window",
  ]) {
    assert.ok(src.includes(`"${label}"`), `group "${label}" lost`);
  }
});
t("Home Draw + Modify panels carry the full DWG tool set", () => {
  const bar = src.slice(src.indexOf("tools.innerHTML ="), src.indexOf('tools.querySelectorAll<HTMLButtonElement>("[data-t]")'));
  for (const tool of ["line", "poly", "polygon", "rect", "arc", "circle", "spline", "ellipse", "donut", "point",
    "hatch", "wipeout", "xline", "ray",
    "move", "copy", "rotate", "scale", "stretch", "mirror", "offset", "trim", "extend", "break",
    "join", "fillet", "chamfer", "explode", "align"]) {
    assert.ok(bar.includes(`tb("${tool}"`), `tool "${tool}" not on the ribbon`);
  }
});
t("typed commands dispatch to the staged pick machine and draw tools", () => {
  const disp = src.slice(src.indexOf("function executeDrawingCommand"));
  const must = ["TRIM", "EXTEND", "BREAK", "FILLET", "CHAMFER", "JOIN", "EXPLODE", "STRETCH", "ALIGN",
    "MATCHLAYER", "XLINE", "RAY", "POLYGON", "SPLINE", "ELLIPSE", "DONUT", "POINT", "HATCH", "WIPEOUT",
    "DIMANGULAR", "DIMARC", "DIMDIAMETER", "DIMCENTER", "DIMCONTINUE", "DIMBASELINE", "TABLE", "ARRAY", "ARRAYPOLAR", "FIND", "VIEW", "LAYERSTATE", "IMPORT"];
  for (const c of must) assert.ok(disp.includes(`"${c}"`), `command "${c}" not dispatched`);
});
t("rectangular and polar array controls are exposed and wired in Modify II", () => {
  const bar = src.slice(src.indexOf("function buildBar()"), src.indexOf("function buildBar2()"));
  for (const control of ['data-a="array-rect"', 'data-a="array-polar"', 'data-a="selsim"']) assert.ok(bar.includes(control), `missing ribbon control ${control}`);
  assert.ok(src.includes('"array-rect": () => executeDrawingCommand("ARRAY")'), "rectangular array action not wired");
  assert.ok(src.includes('"array-polar": () => executeDrawingCommand("ARRAYPOLAR")'), "polar array action not wired");
  assert.ok(src.includes('selsim: () => executeDrawingCommand("SELECTSIMILAR")'), "Select Similar action not wired");
});
t("quick selection accepts type, layer, colour, linetype and text filters", () => {
  for (const filter of ['what === "COLOR"', 'what === "LINETYPE"', 'what === "LINEWEIGHT"', 'what === "TEXT"', 'mode === "COLOR"', 'mode === "LINETYPE"', 'mode === "LINEWEIGHT"']) {
    assert.ok(src.includes(filter), `selection filter missing: ${filter}`);
  }
});
t("dimension family renders on canvas: angular, arc-length, diameter, center mark", () => {
  const render = src.slice(src.indexOf("function render("));
  for (const k of ['m.kind === "dimang"', 'm.kind === "dimarc"', 'm.kind === "dimdia"', 'm.kind === "dimcenter"']) {
    assert.ok(render.includes(k), `markup renderer for ${k} missing`);
  }
  assert.ok(src.includes('"dimang" | "dimarc" | "dimdia" | "dimcenter"'), "Markup kind union missing the dim variants");
});
t("PURGE / AUDIT / OVERKILL are real database operations, not stubs", () => {
  assert.ok(!src.includes('0 unreferenced objects purged'), "PURGE stub must be gone");
  assert.ok(src.includes("function purgeDrawing()"), "purgeDrawing missing");
  assert.ok(src.includes("function auditDrawing("), "auditDrawing missing");
  const audit = src.slice(src.indexOf("function auditDrawing("));
  for (const need of ["fixedLayer", "zeroLen", "dupes", "commitReplace(before, repaired)"]) {
    assert.ok(audit.includes(need), `auditDrawing lacks ${need}`);
  }
  assert.ok(src.includes('cmd === "OVERKILL"'), "OVERKILL command missing");
});
t("new drawings boot into a live empty document with a replace-aware undo stack", () => {
  assert.ok(src.includes("function startBlank()"), "startBlank missing");
  assert.ok(/buildBar\(\);\s*\n\s*buildBar2\(\);[\s\S]{0,120}startBlank\(\);/.test(src), "startBlank must run at engine init");
  assert.ok(src.includes('type: "add" | "delete" | "modify" | "replace"'), "UndoAction must support replace");
  const undoFn = src.slice(src.indexOf("function undo()"), src.indexOf("function redo()"));
  assert.ok(undoFn.includes('act.type === "replace"'), "undo must handle replace actions");
  const redoFn = src.slice(src.indexOf("function redo()"));
  assert.ok(redoFn.includes('act.type === "replace"'), "redo must handle replace actions");
});
t("the 33 native-engine icons exist in the union and the path table", () => {
  const names = ["cut", "paste", "polygon", "spline", "ellipse", "donut", "point", "hatch", "wipeout",
    "xline", "ray", "trim", "extend", "break", "stretch", "join", "fillet", "chamfer", "explode", "align",
    "matchprop", "find", "table", "center-mark", "dim-arclen", "dim-diameter", "dim-baseline", "dim-continue",
    "ucs", "purge", "audit", "layer-state", "import"];
  assert.strictEqual(names.length, 33, "icon list drifted");
  for (const n of names) {
    assert.ok(new RegExp(`\\|\\s*"${n}"`).test(icons), `icon "${n}" missing from IconName union`);
    assert.ok(new RegExp(`^\\s{2}"?${n}"?:\\s*\`<`, "m").test(icons), `icon "${n}" missing from PATHS`);
  }
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
