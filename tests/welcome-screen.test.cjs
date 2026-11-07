// Welcome screen (Project Center) — 2D/3D quick-launch + file zones + showcase.
//
// Guards the welcome-screen surface (v54):
//
//   1. Hero with two mega CTA buttons (2D left, 3D right):
//        #obs-hero-2d  → dynamic-imports cad-viewer and calls openCadViewer()
//        #obs-hero-3d  → hideHome() when a project is current, otherwise
//                        emitWorkspace("coordination")
//   2. Two file zones mirroring the hero buttons (the user's red/green split):
//        LEFT  .obs-zone--2d → 2D file options (New drawing / Open DWG·DXF),
//                              drawing HISTORY (recent drawings, one-click
//                              reopen from vaulted bytes), and engine INFO.
//        RIGHT .obs-zone--3d → 3D file options (create/open project),
//                              project HISTORY (recent projects) and
//                              platform INFO (BIM KPIs + workflows).
//   3. cad-recent.ts vault (IndexedDB) + cad-viewer hooks that record every
//      opened/saved drawing so the 2D history is real, not decorative.
//   4. Three showcase pages whose every claim is backed by real modules —
//      including the command count, which is parsed from cad-viewer.ts so the
//      copy can never drift from the engine.
//   5. The stylesheet ships all of it + responsive breakpoints + reduced-motion.
const fs = require("fs"), path = require("path"), assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const home = read("src", "shell", "home-screen.ts");
const css = read("src", "style.css");
const viewer = read("src", "features", "cad-viewer.ts");
const recent = read("src", "features", "cad-recent.ts");

// Single source of truth for the command count: parse the CAD_COMMANDS array
// out of cad-viewer.ts (balanced-bracket) and count `name:` entries.
function cadCommandCount() {
  const start = viewer.indexOf("const CAD_COMMANDS");
  const eq = viewer.indexOf("= [", start);
  let depth = 0, end = -1;
  for (let k = eq + 1; k < viewer.length; k++) {
    const ch = viewer[k];
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = k; break; } }
  }
  assert.ok(end > eq, "could not locate the CAD_COMMANDS array");
  const block = viewer.slice(eq, end + 1);
  const names = [...block.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 50, `suspiciously few commands parsed: ${names.length}`);
  return names.length;
}
const N = cadCommandCount();

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ── 1. Hero quick-launch wiring ──────────────────────────────────────────
t("hero: two mega CTA buttons exist with stable ids", () => {
  assert.ok(home.includes('id="obs-hero-2d"'), "missing #obs-hero-2d");
  assert.ok(home.includes('id="obs-hero-3d"'), "missing #obs-hero-3d");
  assert.ok(home.includes('class="obs-mega obs-mega--2d"'), "missing 2D mega class");
  assert.ok(home.includes('class="obs-mega obs-mega--3d"'), "missing 3D mega class");
});

t("hero: 2D button opens the real CAD editor", () => {
  assert.ok(home.includes('import("../features/cad-viewer").then((m) => m.openCadViewer())'),
    "open2dEngine must dynamic-import cad-viewer and call openCadViewer");
});

t("hero: 3D button keeps existing-project behavior consistent", () => {
  const start = home.indexOf("function open3dPlatform");
  const end = home.indexOf("/* Cumulative visit counter", start);
  const body = home.slice(start, end > -1 ? end : start + 600);
  assert.ok(body.includes("getCurrentProject()"), "must check for a current project");
  assert.ok(body.includes("hideHome()"), "with a project: leave the landing screen");
  assert.ok(body.includes('emitWorkspace("coordination")'), "without a project: default workspace path");
});

t("hero: trust rail lists real standards", () => {
  for (const chip of ["IFC", "BCF", "IDS", "DWG / DXF r13–r2018", "LOCAL-FIRST"]) {
    assert.ok(new RegExp(`<span class="obs-trust-chip[^"]*">${chip}</span>`).test(home), `missing trust chip ${chip}`);
  }
});

// ── 2. File zones: 2D left / 3D right, each with options + history + info ──
t("zones: two-zone layout exists, 2D first (left), 3D second (right)", () => {
  assert.ok(home.includes('class="obs-zones"'), "missing .obs-zones section");
  const i2 = home.indexOf('class="obs-zone obs-zone--2d"');
  const i3 = home.indexOf('class="obs-zone obs-zone--3d"');
  assert.ok(i2 > -1 && i3 > i2, "2D zone must precede the 3D zone in the markup");
});

t("2D zone: file options — New drawing + Open DWG/DXF with a real file input", () => {
  assert.ok(home.includes('id="obs-2d-new"'), "missing New drawing button");
  assert.ok(home.includes('id="obs-2d-open"'), "missing Open DWG/DXF button");
  assert.ok(/id="obs-2d-file"[^>]*accept="\.dwg,\.dxf/.test(home), "hidden file input must accept .dwg/.dxf");
  assert.ok(home.includes("file2d?.click()"), "Open button must trigger the file picker");
  assert.ok(/for \(const f of files\) m\.openCadViewer\(f\);/.test(home),
    "picked files must be handed to openCadViewer (records history + opens engine)");
});

t("2D zone: drawing history list + clear, wired to the cad-recent vault", () => {
  assert.ok(home.includes('id="obs-2d-history"'), "missing #obs-2d-history");
  assert.ok(home.includes('id="obs-2d-clear"'), "missing Clear button");
  assert.ok(home.includes("listRecentDrawings()"), "history must come from the cad-recent vault");
  assert.ok(home.includes("getRecentDrawingBlob(name)"), "reopen must fetch vaulted bytes");
  assert.ok(home.includes("new File([blob], name)"), "reopen must rebuild a File from vaulted bytes");
  assert.ok(home.includes("clearRecentDrawings()"), "Clear must call clearRecentDrawings");
  assert.ok(home.includes("No drawings yet"), "empty state must guide the user");
});

t("2D zone: engine info chips are real capabilities", () => {
  for (const chip of ["DWG / DXF r13–r2018", "BATCH PLOT → PDF", "AUDIT · TABLES · CENSUS"]) {
    assert.ok(home.includes(`<span class="obs-chip">${chip}</span>`), `missing 2D info chip: ${chip}`);
  }
  assert.ok(home.includes('id="obs-2d-stats"'), "missing 2D stat cards container");
});

t("3D zone: file options — the project creation form lives here", () => {
  const zone = home.slice(home.indexOf('class="obs-zone obs-zone--3d"'), home.indexOf("</section>", home.indexOf('class="obs-zone obs-zone--3d"')));
  for (const id of ['id="obs-new-name"', 'id="obs-template"', 'id="obs-create-project"', 'id="obs-open-file"', 'id="obs-template-note"']) {
    assert.ok(zone.includes(id), `3D zone must contain ${id}`);
  }
});

t("3D zone: history (recent projects) + info (KPIs + workflows) live here", () => {
  const zone = home.slice(home.indexOf('class="obs-zone obs-zone--3d"'), home.indexOf("</section>", home.indexOf('class="obs-zone obs-zone--3d"')));
  for (const id of ['id="obs-grid"', 'id="obs-count"', 'id="obs-3d-stats"', 'id="obs-workspaces"']) {
    assert.ok(zone.includes(id), `3D zone must contain ${id}`);
  }
  assert.ok(zone.includes("History — recent projects"), "3D history heading missing");
  assert.ok(zone.includes("Platform info"), "3D info heading missing");
});

t("zones: the old mixed layout is fully retired", () => {
  assert.ok(!home.includes("obs-kpi-grid"), "standalone KPI grid must be gone (KPIs moved into the 3D zone)");
  assert.ok(!home.includes("obs-command-grid"), "standalone command grid must be gone");
  assert.ok(!home.includes("obs-command-card"), "command cards must be gone");
  assert.ok(!home.includes("data-cad2d"), "2D CAD Studio fast-access card must be gone (2D has its own zone)");
  assert.ok(!home.includes("obs-workspace-card--cad"), "CAD highlight card style usage must be gone");
  assert.ok(!home.includes("Set up a BIM workspace"), "old 3D form heading must be gone");
  const standalone = home.indexOf("obs-home__section-title");
  assert.ok(standalone === -1, "standalone Recent-projects section must be gone (history lives in the 3D zone)");
});

t("zones: BIM KPI stats render into the 3D zone", () => {
  assert.ok(home.includes('#obs-3d-stats"'), "renderKpis must target #obs-3d-stats");
  assert.ok(!home.includes("#obs-kpis"), "old #obs-kpis target must be gone");
});

// ── 3. cad-recent vault + cad-viewer hooks (real 2D history) ─────────────
t("cad-recent: vault exports with caps and fail-soft design", () => {
  for (const fn of ["export async function recordRecentDrawing", "export async function listRecentDrawings",
    "export async function getRecentDrawingBlob", "export async function clearRecentDrawings",
    "export function recentFormatOf"]) {
    assert.ok(recent.includes(fn), `cad-recent must export ${fn}`);
  }
  assert.ok(recent.includes("MAX_RECENT_DRAWINGS = 12"), "history must be capped");
  assert.ok(recent.includes("MAX_RECENT_BYTES"), "byte guard missing");
  assert.ok(recent.includes('DB_NAME = "obs-cad-recent"'), "must use a dedicated IndexedDB vault");
  assert.ok((recent.match(/catch/g) || []).length >= 5, "storage failures must be swallowed (fail soft)");
  assert.ok(/hasBytes: !!blob/.test(recent), "metadata must expose whether reopen is possible");
});

t("cad-viewer: opening a drawing records it in the 2D history", () => {
  assert.ok(viewer.includes('import { recordRecentDrawing, recentFormatOf } from "./cad-recent";'),
    "cad-viewer must import the vault");
  assert.ok(/void tab\.engine\.load\(file\);\s*\n[\s\S]{0,200}recordRecentDrawing\(\{ name: file\.name, format: recentFormatOf\(file\.name\), size: file\.size, blob: file \}\)/.test(viewer),
    "openFile must record the opened file with its bytes");
});

t("cad-viewer: saving records fresh bytes (DXF via QSAVE, DWG via DWGSAVE)", () => {
  assert.ok(/const blob = new Blob\(\[text\], \{ type: "application\/dxf" \}\);\s*\n\s*download\(blob, fn\);\s*\n[\s\S]{0,120}recordRecentDrawing\(\{ name: fn, format: "DXF", size: blob\.size, blob \}\)/.test(viewer),
    "QSAVE must record the saved DXF bytes");
  assert.ok(/recordRecentDrawing\(\{ name: fn, format: "DWG", size: blob\.size, blob \}\)/.test(viewer),
    "DWGSAVE must record the exported DWG bytes");
});

// ── 4. Three showcase pages, truthful claims only ────────────────────────
t("showcase: three pages numbered 01/02/03 with distinct accents", () => {
  assert.ok(home.includes("obs-page--2d") && home.includes("obs-page--3d") && home.includes("obs-page--del"));
  for (const n of ['num: "01"', 'num: "02"', 'num: "03"']) assert.ok(home.includes(n), `missing ${n}`);
});

t(`showcase: command-count claims match the real engine (${N} commands)`, () => {
  assert.ok(home.includes(`${N} keyboard-first commands`), "showcase copy must state the real command count");
  assert.ok(home.includes(`${N}-command line`), "feature card must state the real command count");
  assert.ok(home.includes(`${N} COMMANDS`), "hero specs must state the real command count");
  for (const stale of ["118 COMMANDS", "118 command", "118-commands", "118 keyboard", "106 COMMANDS", "106 command", "106 keyboard"]) {
    assert.ok(!home.includes(stale), `stale claim "${stale}" must be gone`);
  }
});

t("showcase: every claim maps to a real module surface", () => {
  // Verified against the repository (do not loosen without evidence):
  const claims = [
    "r13–r2018",                   // LibreDWG toolkit version coverage
    "DWG 2000–2018",               // DWGVERSION export range
    "BVH/GJK clash engine",        // modules/clash: triangle-bvh + gjk
    "BCF issue round-trip",        // modules/bcf
    "4D", "5D",                    // schedule-4d + cost panels
    "plugin marketplace",          // plugin-marketplace
    "RTL Arabic",                  // dom-translate LANGS ar (rtl)
    "PWA",                         // core/pwa.ts
  ];
  for (const c of claims) assert.ok(home.includes(c), `missing showcase claim: ${c}`);
});

t("showcase: page CTAs are wired", () => {
  for (const attr of ["data-open2d", "data-open3d", "data-focus-create"]) {
    assert.ok(home.includes(attr), `missing CTA ${attr}`);
  }
  assert.ok(home.includes("nameInput.scrollIntoView"), "page-3 CTA must focus the create field");
});

// ── 5. Stylesheet ships the visual system ────────────────────────────────
t("css: hero + mega button styles with shine + focus states", () => {
  for (const sel of [".obs-hero {", ".obs-hero__title", ".obs-mega {", ".obs-mega--2d", ".obs-mega--3d",
    ".obs-mega:hover::after", ".obs-mega__glyph", ".obs-hero__trust", ".obs-trust-chip--hot"]) {
    assert.ok(css.includes(sel), `missing css: ${sel}`);
  }
});

t("css: file zones — 2D/3D accents, history rows, stats, responsive", () => {
  for (const sel of [".obs-zones {", ".obs-zone {", ".obs-zone--2d", ".obs-zone--3d", ".obs-zone__glyph",
    ".obs-zone__sub", ".obs-2d-history {", ".obs-2d-row {", ".obs-2d-row__fmt--dwg",
    ".obs-2d-empty {", ".obs-zone__stats {", ".obs-home__grid--inzone", ".obs-zone__linkbtn"]) {
    assert.ok(css.includes(sel), `missing css: ${sel}`);
  }
  const i940 = css.indexOf("@media (max-width: 940px) {", css.indexOf("v54"));
  assert.ok(i940 > -1 && css.slice(i940, i940 + 400).includes(".obs-zones { grid-template-columns: 1fr; }"),
    "zones must collapse to one column on narrow screens");
});

t("css: showcase pages + feature cards + chips + visuals", () => {
  for (const sel of [".obs-pages", ".obs-page {", ".obs-page__num", ".obs-fgrid", ".obs-fcard__icon",
    ".obs-chiprow", ".obs-page__visual", ".obsp-caret", ".obsp-clash", ".obsp-float"]) {
    assert.ok(css.includes(sel), `missing css: ${sel}`);
  }
});

t("css: responsive + reduced-motion respected", () => {
  assert.ok(css.includes("@media (prefers-reduced-motion: reduce)"), "missing reduced-motion guard");
  const idx940 = css.indexOf(".obs-hero__cta-row { grid-template-columns: 1fr; }");
  const idx680 = css.indexOf(".obs-fgrid { grid-template-columns: 1fr; }");
  assert.ok(idx940 > -1 && idx680 > idx940, "responsive breakpoints missing/out of order");
});

// ── 6. Version ───────────────────────────────────────────────────────────
t("version badge bumped to v54", () => {
  assert.ok(home.includes("v54"), "header version badge should read v54");
  assert.ok(!home.includes("v53"), "stale v53 badge must be gone");
});

console.log(`\nwelcome-screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
