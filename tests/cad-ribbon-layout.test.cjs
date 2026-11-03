/**
 * CAD editor AutoCAD-style SHELL RIBBON layout suite.
 *
 * Pins the AutoCAD MDI chrome stacking order and wiring after the ribbon was
 * hoisted out of the per-drawing page into the shared shell:
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

// ── 1. Shell stacking order: ribbon tabs row → ribbon panels → drawing tabs → pages ──
t("shell mounts chrome in AutoCAD order: ribbon tabs, panels, drawing tabs, pages", () => {
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
  assert.ok(iStrip < iFiles, "drawing file tabs must be BELOW the ribbon (AutoCAD layout)");
  assert.ok(iFiles < iPages, "drawing tabs must be ABOVE the drawing pages");
});

// ── 2. Ribbon tabs row content ──
t("ribbon tabs: Home / Annotate / View / Manage / Output", () => {
  const m = src.match(/const RIBBON_TABS: ReadonlyArray<\{ id: string; label: string \}> = \[([\s\S]*?)\];/);
  assert.ok(m, "RIBBON_TABS definition missing");
  for (const id of ["home", "annotate", "view", "manage", "output"]) {
    assert.ok(m[1].includes(`id: "${id}"`), `ribbon tab "${id}" missing`);
  }
  assert.ok(!/id: "(file|insert)"/.test(m[1]), "no invented tabs: every tab maps to real panel groups");
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
t("every ribbon group is tagged with exactly one of the five tabs", () => {
  const expected = {
    File: "home", Draw: "home", Select: "home", Modify: "home", History: "home", Layers: "home", Styles: "home",
    Measure: "annotate", Markup: "annotate", "Markup Files": "annotate",
    Navigate: "view", Modes: "view", Show: "view",
    Settings: "manage",
    Export: "output", Window: "output",
  };
  const found = {};
  const re = /rg\(\s*(?:\n\s*)?"((?:[^"\\]|\\.)+)",([\s\S]*?)"(home|annotate|view|manage|output)"\s*\)?/g;
  let m;
  while ((m = re.exec(src)) !== null) found[m[1]] = m[3];
  for (const [label, tab] of Object.entries(expected)) {
    assert.strictEqual(found[label], tab, `group "${label}" expected on tab "${tab}", got "${found[label]}"`);
  }
  const extra = Object.keys(found).filter((k) => !(k in expected));
  assert.deepStrictEqual(extra, [], "untagged/unexpected ribbon groups");
});
t("CSS filters panels per active ribbon tab", () => {
  for (const id of ["home", "annotate", "view", "manage", "output"]) {
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
  for (const k of ["tText", "tHatch", "tLt", "lyr-mgr", "help", "close", "takeoff", "save-mk", "load-mk", "info", "svg", "csv"]) {
    assert.ok(src.includes(`"${k}"`), `action "${k}" not forwarded via act2`);
  }
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
});
t("all 16 ribbon groups still exist after the tab reorganization", () => {
  for (const label of ["File", "Draw", "Select", "Modify", "History", "Measure", "Markup", "Navigate", "Modes", "Settings", "Layers", "Styles", "Show", "Markup Files", "Export", "Window"]) {
    assert.ok(src.includes(`"${label}"`), `group "${label}" lost`);
  }
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
