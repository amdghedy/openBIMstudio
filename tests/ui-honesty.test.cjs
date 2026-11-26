// Guards against UI that pretends to work: toasts that tell the user to use the
// developer console, and fabricated marketplace statistics.
const fs = require("fs");
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS " + name); } else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); } };

const ribbon = fs.readFileSync("src/shell/ribbon.ts", "utf8");
const toasts = [...ribbon.matchAll(/toast\(\s*([\x60"'])((?:\\.|(?!\1)[\s\S])*)\1/g)].map((m) => m[2]);
const bad = toasts.filter((t) => /__obs[A-Za-z]+/.test(t) || (/console/i.test(t) && !/failed/i.test(t)));
ok("ribbon toasts never point users at the console or __obs* globals", bad.length === 0, bad.join(" | "));

const market = fs.readFileSync("src/modules/plugin-marketplace/types.ts", "utf8");
ok("plugin marketplace has no fabricated downloads/ratings", !/downloads\s*:|rating\s*:/.test(market));

const sweeps = fs.readFileSync("src/features/authoring.ts", "utf8");
ok("wall builder renders params.sweeps", /attachWallSweeps\(mesh, el\)/.test(sweeps));

// No blocking browser dialogs: alert() is gone; prompt()/confirm() may only decrease (ratchet).
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + "/" + e.name) : /\.ts$/.test(e.name) ? [d + "/" + e.name] : []);
const srcFiles = walk("src").filter((f) => !/form-modal\.ts$|core\/notify\.ts$/.test(f));
let alerts = 0, blocking = 0;
for (const f of srcFiles) {
  const t = fs.readFileSync(f, "utf8");
  alerts += (t.match(/(^|[^.\w])(window\.)?alert\(/gm) || []).length;
  blocking += (t.match(/(^|[^.\w])(window\.)?(prompt|confirm)\(/gm) || []).length;
}
ok("no blocking alert() calls in src (use uiAlert / notify)", alerts === 0, alerts + " found");
const BASELINE = 0;
ok("prompt()/confirm() count does not grow (baseline " + BASELINE + ", now " + blocking + ")", blocking <= BASELINE, "convert new ones to form-modal promptLine/confirmDialog");

// Legacy cross-feature globals (window.__obs*): the total may only go down. New code should use imports or core/services.
// Generated i18n dictionaries (src/core/i18n-catalogs/*.gen.ts) are excluded: their 72 matches are
// translated message STRINGS that mention global names (__obsWallSweeps, __obsEnergy), not window
// globals usage — a translated string cannot create or read a global. Counting them masked real
// reductions and tripped the guard on unrelated translation edits.
const srcFilesForGlobals = srcFiles.filter((f) => !/core\/i18n-catalogs\//.test(f));
let globalsUsed = 0;
for (const f of srcFilesForGlobals) globalsUsed += (fs.readFileSync(f, "utf8").match(/__obs[A-Za-z0-9]+/g) || []).length;
// The verified main-branch count on 2026-11-09 is 819. Keep this as a ratchet:
// any further increase must be justified by a compatibility need and reviewed.
const GLOBALS_BASELINE = 651; // 652 → 651 on 2026-11-27: the point-cloud window stash had no consumer anywhere (unreachable feature) — replaced by a typed palette command through the commandPalette service → 657 → 652 on 2026-11-27: dead __obsPlanView reads rewired to the typed ctx.features.planView (plan-grid-tool now uses the real clientToWorld, exported for the first time; the window chain never had a producer), plan-authoring-bridge dead branch removed, and __obsGetElementMesh reads simplified to el.mesh (also never produced) → 665 → 657 on 2026-11-26: dead palette/walk-mode globals rewired to the typed services (commandPalette is now actually registered; the window chains had no producer, so view-templates and auto-dimensions commands never reached the palette), and a mis-named local function renamed → 675 → 665 on 2026-11-26: the legacy notify globals (10 refs in 5 files) rewired to the central bus in core/notify — they never had a producer, so plugin/VG-dialog/auto-dims toasts silently never showed → re-based 2026-11-26: 747 counted, minus 72 matches in generated i18n catalogs (translated strings, not globals usage — see above) = 675 real. History: 819 on 2026-11-09 → 727 on 2026-11-13 (92 single-file globals converted) → 747 re-based on 2026-11-22: parallel feature work added +21 mentions across 11 files (ribbon.ts +6, plan-view-panel.ts +5, selection-filter-dialog.ts +2, critical-gaps-boot-strength.ts +2, and one each in mass-to-elements, property-palette, importer, feature-maturity, engine-ui, dblclick-fit, bim-input-compatibility; dwg-linking/types −1) → 748 re-based on 2026-11-23: Family Creator + workflow packs 11/12 had added +13 (760), of which 12 were dead window stashes with no consumer anywhere in the repo and were REMOVED, not re-based — pack-11 __obsModelCensus/__obsModelHealth/__obsToolCatalogRuntime/__obsPerfSel/__obsStandardsPacks/__obsWorkflowPack11 and pack-12 __obsLevelReport/__obsUnitsReport/__obsLinkedSummary/__obsWorkflowPack12 (each function still returns + logs + notifies its report; the pack apis stay wired on ctx.features), and the 2 dead reads were rewired to real services (pack-11 showIfcInteropReport now reads ctx.features.importer.interopReports() — __obsLastIfcInteropReport never had a producer, so the command could never show a report; pack-12 unitsReport now reads ctx.features.units + getConfig() — __obsUnits never had a producer, so it always reported the "metric-ish" fallback). The +1 that remains is __obsOpenFamilySketch (fc9f3bb9), a genuine compatibility bridge: the legacy plain-JS family editor public/js/obs-family-editor.js (loaded by index.html, cannot import TS) calls it to open the TS sketch module. Keep this as a ratchet: any further increase must be justified and reviewed.
ok("window.__obs* usage does not grow (baseline " + GLOBALS_BASELINE + ", now " + globalsUsed + ")", globalsUsed <= GLOBALS_BASELINE, "use imports / core/services instead of a new global");
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
