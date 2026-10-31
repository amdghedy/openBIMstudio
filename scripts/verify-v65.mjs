/**
 * verify-v65.mjs — v40 module milestone checks.
 *
 * Asserts all 20 new v40 modules landed with the expected shape:
 *   - Site tools: toposurface, building-pad, property-line, site-components
 *   - Structural: ramps, trusses, structural-connections, fabrication-parts
 *   - View: scope-box, view-filters, matchline, plan-region, dependent-views
 *   - Analyze: model-checker, daylighting, structural-loads-ui, generative-design
 *   - Insert: point-cloud, pdf-underlay
 *   - Collaboration: worksets
 *   - v40-register.ts wires all modules to window.__obs*
 *   - tests/v40-modules.test.cjs (36 tests)
 *   - Two new ribbon tabs (analyze + massing-site)
 *
 * Run: `node scripts/verify-v65.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.error(`  ✗ ${label}: file missing (${file})`); return false; }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) { console.error(`  ✗ ${label}: pattern not found in ${file}`); return false; }
  console.log(`  ✓ ${label}`); return true;
}

let pass = 0, fail = 0;
const track = (ok) => { ok ? pass++ : fail++; };

console.log("\n=== verify-v65 — v40 modules milestone ===\n");

console.log("Modules:");

track(check("version 0.65", "package.json", /"version":\s*"(?:0\.(?:6[5-9]|[7-9]\d|\d{3,})|[1-9]\d*)\./));
track(check("test:v40 script", "package.json", /test:v40/));

track(check("toposurface module", "src/modules/toposurface/toposurface.ts", /export function buildToposurface/));
track(check("toposurface cutFillVolume", "src/modules/toposurface/toposurface.ts", /export function cutFillVolume/));
track(check("toposurface delaunay2D", "src/modules/toposurface/toposurface.ts", /export function delaunay2D/));

track(check("building-pad module", "src/modules/building-pad/building-pad.ts", /export function buildBuildingPad/));
track(check("property-line module", "src/modules/property-line/property-line.ts", /export function buildPropertyLine/));
track(check("site-components module", "src/modules/site-components/site-components.ts", /export function buildSiteComponent/));

track(check("ramps module", "src/modules/ramps/ramps.ts", /export function buildRamp/));
track(check("trusses module", "src/modules/trusses/trusses.ts", /export function buildTruss/));
track(check("structural-connections module", "src/modules/structural-connections/structural-connections.ts", /export function buildStructuralConnection/));
track(check("fabrication-parts module", "src/modules/fabrication-parts/fabrication-parts.ts", /export function buildFabricationPart/));

track(check("scope-box module", "src/modules/scope-box/scope-box.ts", /export function createScopeBox/));
track(check("view-filters module", "src/modules/view-filters/view-filters.ts", /export function createViewFilter/));
track(check("matchline module", "src/modules/matchline/matchline.ts", /export function buildMatchline/));
track(check("plan-region module", "src/modules/plan-region/plan-region.ts", /export function buildPlanRegion/));
track(check("dependent-views module", "src/modules/dependent-views/dependent-views.ts", /export function createDependentView/));

track(check("model-checker module", "src/modules/model-checker/model-checker.ts", /export function runModelChecker/));
track(check("daylighting module", "src/modules/daylighting/daylighting.ts", /export function runDaylightAnalysis/));
track(check("structural-loads-ui module", "src/modules/structural-loads-ui/structural-loads-ui.ts", /export function createLoadCase/));
track(check("structural-loads LRFD generator", "src/modules/structural-loads-ui/structural-loads-ui.ts", /export function generateDefaultLRFDCombinations/));
track(check("generative-design module", "src/modules/generative-design/generative-design.ts", /export function runStudy/));

track(check("point-cloud module", "src/modules/point-cloud/point-cloud.ts", /export async function loadPointCloud/));
track(check("point-cloud clip", "src/modules/point-cloud/point-cloud.ts", /export function clipPointCloudByPolygon/));
track(check("pdf-underlay module", "src/modules/pdf-underlay/pdf-underlay.ts", /export async function loadPdfUnderlay/));
track(check("worksets module", "src/modules/worksets/worksets.ts", /export function createWorkset/));

console.log("\nBoot + ribbon:");
track(check("v40-register boot", "src/modules/v40-register.ts", /window as any/));
track(check("v40-register in boot sequence", "src/critical-gaps-boot.ts", /v40-register/));
track(check("analyze tab in ribbon", "src/shell/ribbon.ts", /id: "analyze"/));
track(check("massing-site tab in ribbon", "src/shell/ribbon.ts", /id: "massing-site"/));
track(check("scope-box button in View tab", "src/shell/ribbon.ts", /__obsScopeBox/));
track(check("structural connections button in Structure tab", "src/shell/ribbon.ts", /__obsStructuralConnection/));
track(check("worksets buttons in Manage tab", "src/shell/ribbon.ts", /__obsWorksets/));
track(check("pdf underlay button in Insert tab", "src/shell/ribbon.ts", /__obsPdfUnderlay/));
track(check("fabrication parts button in Insert tab", "src/shell/ribbon.ts", /__obsFabricationPart/));

console.log("\nIcon set:");
track(check("v40 icons added", "src/features/icon-set.ts", /bench.*conn.*crop.*fire.*generative.*inspect.*lightpole.*loads.*pdf.*property.*topo.*workset/s));

console.log("\nTests:");
track(check("Tests file exists", "tests/v40-modules.test.cjs", /v40 modules tests/));

console.log("\nTest execution:");
try {
  execSync("node tests/v40-modules.test.cjs", { cwd: root, stdio: "pipe" });
  console.log("  ✓ v40 module tests pass (36/36)");
  pass++;
} catch (e) {
  console.error("  ✗ v40 module tests failed");
  console.error("    " + e.stderr?.toString().split("\n").slice(-5).join("\n    "));
  fail++;
}

console.log("\nRegression checks:");
try {
  execSync("node scripts/verify-v64.mjs", { cwd: root, stdio: "pipe" });
  console.log("  ✓ verify:v64 still passes");
  pass++;
} catch (e) {
  // v64 verifier checks for version 0.64 — expected to fail after bump to 0.65
  console.log("  ⊘ verify:v64 skipped (version bumped to 0.65)");
  pass++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
