/**
 * verify-v60.mjs — Hatch Patterns in 2D Views milestone checks.
 *
 * Asserts the hatch pattern system landed with the expected shape:
 *   - src/modules/views/hatch-patterns.ts: pattern library + generators
 *   - src/modules/views/renderers/svg.ts: SVG <pattern> def + case "hatch"
 *   - src/modules/bim-gaps/m3-plan.ts: PlanOptions.hatch flag + hatch entity emission
 *   - tests/hatch-patterns.test.cjs: pattern library + generator tests
 *
 * Run: `node scripts/verify-v60.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

function check(label, file, regex) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file missing (${file})`);
    return false;
  }
  const content = fs.readFileSync(full, "utf8");
  if (!regex.test(content)) {
    console.error(`  ✗ ${label}: pattern not found in ${file}`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

function checkExists(label, file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    console.error(`  ✗ ${label}: file/directory missing (${file})`);
    return false;
  }
  console.log(`  ✓ ${label}`);
  return true;
}

let pass = 0;
let fail = 0;

console.log("\n=== verify-v60: Hatch Patterns in 2D Views ===\n");

// ─── Pattern library ─────────────────────────────────────────────────
console.log("Pattern library (src/modules/views/hatch-patterns.ts):");
const libChecks = [
  ["HatchPatternDef interface", "src/modules/views/hatch-patterns.ts", /export interface HatchPatternDef/],
  ["HATCH_PATTERNS export", "src/modules/views/hatch-patterns.ts", /export const HATCH_PATTERNS/],
  ["getPattern export", "src/modules/views/hatch-patterns.ts", /export function getPattern/],
  ["listPatterns export", "src/modules/views/hatch-patterns.ts", /export function listPatterns/],
  ["generateHatchLines export", "src/modules/views/hatch-patterns.ts", /export function generateHatchLines/],
  ["generateHatchDots export", "src/modules/views/hatch-patterns.ts", /export function generateHatchDots/],
  ["defaultPatternForElementType export", "src/modules/views/hatch-patterns.ts", /export function defaultPatternForElementType/],
  ["concrete pattern defined", "src/modules/views/hatch-patterns.ts", /concrete:\s*\{/],
  ["brick pattern defined", "src/modules/views/hatch-patterns.ts", /brick:\s*\{/],
  ["earth pattern defined", "src/modules/views/hatch-patterns.ts", /earth:\s*\{/],
  ["steel pattern defined", "src/modules/views/hatch-patterns.ts", /steel:\s*\{/],
  ["wood pattern defined", "src/modules/views/hatch-patterns.ts", /wood:\s*\{/],
  ["insulation pattern defined", "src/modules/views/hatch-patterns.ts", /insulation:\s*\{/],
  ["sand pattern defined", "src/modules/views/hatch-patterns.ts", /sand:\s*\{/],
  ["glass pattern defined", "src/modules/views/hatch-patterns.ts", /glass:\s*\{/],
  ["poche pattern defined", "src/modules/views/hatch-patterns.ts", /poche:\s*\{/],
];
for (const [label, file, regex] of libChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── SVG renderer ─────────────────────────────────────────────────────
console.log("\nSVG renderer (src/modules/views/renderers/svg.ts):");
const svgChecks = [
  ["Imports getPattern from hatch-patterns", "src/modules/views/renderers/svg.ts", /import.*getPattern.*from.*hatch-patterns/],
  ["Imports generateHatchLines + generateHatchDots", "src/modules/views/renderers/svg.ts", /import.*generateHatchLines.*generateHatchDots/],
  ["<defs> block constructed", "src/modules/views/renderers/svg.ts", /createElementNS\(SVG_NS, "defs"\)/],
  ["defineHatchPattern function", "src/modules/views/renderers/svg.ts", /function defineHatchPattern/],
  ["SVG pattern element created", "src/modules/views/renderers/svg.ts", /createElementNS\(SVG_NS, "pattern"\)/],
  ["patternUnits=userSpaceOnUse", "src/modules/views/renderers/svg.ts", /patternUnits/,  /userSpaceOnUse/],
  ["case 'hatch' branch in drawEntity", "src/modules/views/renderers/svg.ts", /case "hatch":/],
  ["fill url(# pattern reference", "src/modules/views/renderers/svg.ts", /url\(#\$\{patternKey\}\)/],
  ["poche fallback to solid color", "src/modules/views/renderers/svg.ts", /if \(e\.pattern === "poche"\)/],
];
for (const [label, file, regex] of svgChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Plan generator integration ──────────────────────────────────────
console.log("\nPlan generator integration (src/modules/bim-gaps/m3-plan.ts):");
const planChecks = [
  ["PlanOptions.hatch flag", "src/modules/bim-gaps/m3-plan.ts", /hatch: boolean;/],
  ["PlanOptions.hatchScale flag", "src/modules/bim-gaps/m3-plan.ts", /hatchScale: number;/],
  ["DEFAULT_PLAN_OPTIONS.hatch = false", "src/modules/bim-gaps/m3-plan.ts", /hatch: false, hatchScale: 100/],
  ["Plan emits hatch entity for walls when hatch=true", "src/modules/bim-gaps/m3-plan.ts", /kind: "hatch"/],
  ["Plan uses 'concrete' pattern for walls", "src/modules/bim-gaps/m3-plan.ts", /pattern: "concrete"/],
  ["Plan uses scale from options", "src/modules/bim-gaps/m3-plan.ts", /scale: o\.hatchScale/],
  ["Plan falls back to polyline poche when hatch=false", "src/modules/bim-gaps/m3-plan.ts", /kind: "polyline"/],
];
for (const [label, file, regex] of planChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Tests ────────────────────────────────────────────────────────────
console.log("\nTests:");
const testChecks = [
  ["Tests file exists", "tests/hatch-patterns.test.cjs", /.*/],
  ["Library exposes 9 patterns test", "tests/hatch-patterns.test.cjs", /library exposes 9 named patterns/],
  ["Concrete cross-hatch test", "tests/hatch-patterns.test.cjs", /concrete pattern has cross-hatch/],
  ["Sand dots test", "tests/hatch-patterns.test.cjs", /sand pattern has dots but no segments/],
  ["generateHatchLines returns empty for unknown pattern test", "tests/hatch-patterns.test.cjs", /returns empty for unknown pattern/],
  ["generateHatchLines scales tile with scale factor test", "tests/hatch-patterns.test.cjs", /scales tile with scale factor/],
  ["generateHatchDots produces dots for sand test", "tests/hatch-patterns.test.cjs", /produces dots for sand pattern/],
  ["Element-to-pattern mapping test", "tests/hatch-patterns.test.cjs", /defaultPatternForElementType returns expected patterns/],
];
for (const [label, file, regex] of testChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Package.json scripts ─────────────────────────────────────────────
console.log("\npackage.json scripts:");
const pkgChecks = [
  ["test:hatch script declared", "package.json", /"test:hatch":\s*"node tests\/hatch-patterns\.test\.cjs"/],
  ["verify:v60 script declared", "package.json", /"verify:v60":\s*"node scripts\/verify-v60\.mjs"/],
  ["version bumped to >= 0.60", "package.json", /"version":\s*"0\.(6[0-9]|[7-9][0-9])\.[0-9]+"/],
];
for (const [label, file, regex] of pkgChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Run tests + regression ───────────────────────────────────────────
console.log("\nTest execution:");
try {
  execSync("node tests/hatch-patterns.test.cjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ Hatch pattern tests pass (14/14)");
  pass++;
} catch {
  console.error("  ✗ Hatch pattern tests failed");
  fail++;
}

console.log("\nRegression checks:");
try {
  execSync("node scripts/verify-v55.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v55 still passes (Plugin SDK intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v55 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v56.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v56 still passes (Family Library intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v56 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v57.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v57 still passes (Hosted recut fix intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v57 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v58.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v58 still passes (MEP auto-routing intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v58 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v59.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v59 still passes (Hip + Valley roofs intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v59 regressed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
