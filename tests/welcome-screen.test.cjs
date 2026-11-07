// Welcome screen (Project Center) — 2D/3D quick-launch + showcase pages.
//
// The user's CAD engine used to sit behind ribbon tabs and dialogs. This
// suite guards the welcome-screen surface that makes it the headline of the
// app (v53):
//
//   1. Hero section with two mega CTA buttons:
//        #obs-hero-2d  → dynamic-imports cad-viewer and calls openCadViewer()
//        #obs-hero-3d  → hideHome() when a project is current, otherwise
//                        emitWorkspace("coordination") (same path as the
//                        workspace cards — no silent project creation)
//   2. A "2D CAD Studio" card pinned to the top of the Fast Access grid.
//   3. Three showcase pages (01/02/03) whose every claim is backed by real
//      modules: 2D drafting & CAD, 3D BIM & coordination, deliver & automate.
//   4. The stylesheet ships the hero/page/fcard/mega styles + responsive
//      breakpoints and respects prefers-reduced-motion.
const fs = require("fs"), path = require("path"), assert = require("assert");

const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
const home = read("src", "shell", "home-screen.ts");
const css = read("src", "style.css");

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

// ── 2. Fast Access: 2D CAD Studio card ───────────────────────────────────
t("fast access: 2D CAD Studio card wired to the engine", () => {
  assert.ok(home.includes("obs-workspace-card--cad"), "missing CAD highlight card");
  assert.ok(home.includes('data-cad2d'), "missing data-cad2d trigger");
  assert.ok(/querySelectorAll<HTMLButtonElement>\("\[data-cad2d\]"\)\.forEach\(\(button\) => \{\s*button\.onclick = open2dEngine;/.test(home),
    "CAD card must call open2dEngine");
});

// ── 3. Three showcase pages, truthful claims only ────────────────────────
t("showcase: three pages numbered 01/02/03 with distinct accents", () => {
  assert.ok(home.includes("obs-page--2d") && home.includes("obs-page--3d") && home.includes("obs-page--del"));
  for (const n of ['num: "01"', 'num: "02"', 'num: "03"']) assert.ok(home.includes(n), `missing ${n}`);
});

t("showcase: every claim maps to a real module surface", () => {
  // Verified against the repository (do not loosen without evidence):
  const claims = [
    "106-command",                 // CAD_COMMANDS length = 106 (cad-viewer.ts)
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

// ── 4. Stylesheet ships the visual system ────────────────────────────────
t("css: hero + mega button styles with shine + focus states", () => {
  for (const sel of [".obs-hero {", ".obs-hero__title", ".obs-mega {", ".obs-mega--2d", ".obs-mega--3d",
    ".obs-mega:hover::after", ".obs-mega__glyph", ".obs-hero__trust", ".obs-trust-chip--hot"]) {
    assert.ok(css.includes(sel), `missing css: ${sel}`);
  }
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

t("version badge bumped to v53", () => {
  assert.ok(home.includes("v53"), "header version badge should read v53");
});

console.log(`\nwelcome-screen: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
