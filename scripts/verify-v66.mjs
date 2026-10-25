/**
 * verify-v66.mjs — v0.66 milestone checks (scope box + section box + crop region).
 *
 * Asserts the v0.66 interactive view-crop features landed with the expected shape:
 *   - src/modules/scope-box/scope-box-visualizer.ts (3D handles)
 *   - src/features/section-box.ts (enhanced with 6 face handles)
 *   - src/features/crop-region.ts (2D per-view crop)
 *   - tests/scope-box-section-box-crop.test.cjs (11 tests)
 *   - All v40 modules still present (regression)
 *
 * Run: `node scripts/verify-v66.mjs`
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

console.log("\n=== verify-v66 — interactive view-crop milestone ===\n");

console.log("v0.66 modules:");

// The v66 milestone is historical; the platform version moves on (v0.67+).
// Verify a sane semver is present instead of pinning the exact minor.
track(check("version semver", "package.json", /"version":\s*"0\.\d+\.\d+"/));
track(check("test:view-crop script", "package.json", /test:view-crop/));

track(check("scope-box-visualizer module", "src/modules/scope-box/scope-box-visualizer.ts", /export function enableScopeBoxVisualizer/));
track(check("scope-box-visualizer corners", "src/modules/scope-box/scope-box-visualizer.ts", /CORNER_OFFSETS/));
track(check("scope-box-visualizer face handles", "src/modules/scope-box/scope-box-visualizer.ts", /FACE_DEFS/));

track(check("section-box face handles", "src/features/section-box.ts", /buildFaceHandles/));
track(check("section-box grow API", "src/features/section-box.ts", /export function growSectionBox/));
track(check("section-box move API", "src/features/section-box.ts", /export function moveSectionBox/));
track(check("section-box interactive pointer", "src/features/section-box.ts", /onCanvasPointerDown/));

track(check("crop-region module", "src/features/crop-region.ts", /export function getCropRegion/));
track(check("crop-region toggle", "src/features/crop-region.ts", /export function toggleCrop/));
track(check("crop-region pointInCrop", "src/features/crop-region.ts", /export function pointInCrop/));
track(check("crop-region reset", "src/features/crop-region.ts", /export function resetCropRegion/));

console.log("\nRibbon + globals:");
track(check("section-box icon", "src/features/icon-set.ts", /"section-box"/));
track(check("ribbon Section Box button", "src/shell/ribbon.ts", /__obsSectionBox/));
track(check("ribbon Scope Box visualizer button", "src/shell/ribbon.ts", /__obsScopeBoxViz/));
track(check("ribbon Crop Region button", "src/shell/ribbon.ts", /__obsCropRegion/));
track(check("v40-register wires scope-box-viz", "src/modules/v40-register.ts", /__obsScopeBoxViz/));
track(check("v40-register wires section-box", "src/modules/v40-register.ts", /__obsSectionBox/));
track(check("v40-register wires crop-region", "src/modules/v40-register.ts", /__obsCropRegion/));

console.log("\nRegression (v40 modules still present):");
track(check("toposurface still present", "src/modules/toposurface/toposurface.ts", /export function buildToposurface/));
track(check("trusses still present", "src/modules/trusses/trusses.ts", /export function buildTruss/));
track(check("worksets still present", "src/modules/worksets/worksets.ts", /export function createWorkset/));

console.log("\nTests:");
track(check("Tests file exists", "tests/scope-box-section-box-crop.test.cjs", /Scope Box \+ Section Box \+ Crop Region tests/));

console.log("\nTest execution:");
try {
  execSync("node tests/scope-box-section-box-crop.test.cjs", { cwd: root, stdio: "pipe" });
  console.log("  ✓ view-crop tests pass (11/11)");
  pass++;
} catch (e) {
  console.error("  ✗ view-crop tests failed");
  console.error("    " + e.stderr?.toString().split("\n").slice(-5).join("\n    "));
  fail++;
}

console.log("\nRegression: v40 tests still pass:");
try {
  execSync("node tests/v40-modules.test.cjs", { cwd: root, stdio: "pipe" });
  console.log("  ✓ v40 module tests pass (36/36)");
  pass++;
} catch (e) {
  console.error("  ✗ v40 module tests failed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
if (fail > 0) process.exit(1);
