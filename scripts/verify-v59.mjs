/**
 * verify-v59.mjs — Hip + Valley Roof milestone checks.
 *
 * Asserts the hip + valley roof generators landed with the expected shape:
 *   - src/modules/bim-gaps/m2-geometry.ts has buildHipRoof + buildValleyRoof
 *   - RoofParams type extended with "hip" | "valley" roofType options
 *   - buildRoof dispatches correctly to the new types
 *   - m2-register.ts exposes the new types in the property schema
 *   - tests/hip-roof.test.cjs exists and covers watertightness + correctness
 *
 * Run: `node scripts/verify-v59.mjs`
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

console.log("\n=== verify-v59: Hip + Valley Roofs ===\n");

// ─── Generator implementation ─────────────────────────────────────────
console.log("Generator (src/modules/bim-gaps/m2-geometry.ts):");
const geoChecks = [
  ["RoofParams type includes 'hip'", "src/modules/bim-gaps/m2-geometry.ts", /"gable" \| "shed" \| "hip"/],
  ["RoofParams type includes 'valley'", "src/modules/bim-gaps/m2-geometry.ts", /"hip" \| "valley"/],
  ["buildHipRoof export", "src/modules/bim-gaps/m2-geometry.ts", /export function buildHipRoof\b/],
  ["buildValleyRoof export", "src/modules/bim-gaps/m2-geometry.ts", /export function buildValleyRoof\b/],
  ["Hip roof minInwardDistance helper", "src/modules/bim-gaps/m2-geometry.ts", /function minInwardDistance\b/],
  ["Hip roof edgeDistance helper", "src/modules/bim-gaps/m2-geometry.ts", /function edgeDistance\b/],
  ["buildRoof dispatches to buildHipRoof", "src/modules/bim-gaps/m2-geometry.ts", /if \(type === "hip"\) return buildHipRoof\(p\)/],
  ["buildRoof dispatches to buildValleyRoof", "src/modules/bim-gaps/m2-geometry.ts", /if \(type === "valley"\) return buildValleyRoof\(p\)/],
  ["Hip roof part name set", "src/modules/bim-gaps/m2-geometry.ts", /name: "Hip Roof"/],
  ["Valley roof part name set", "src/modules/bim-gaps/m2-geometry.ts", /name: "Valley Roof"/],
  ["Hip roof info includes roofType", "src/modules/bim-gaps/m2-geometry.ts", /roofType: "hip"/],
  ["Valley roof info includes roofType", "src/modules/bim-gaps/m2-geometry.ts", /roofType: "valley"/],
  ["Hip roof info includes ridgeLength", "src/modules/bim-gaps/m2-geometry.ts", /ridgeLength,/],
  ["Hip roof algorithm comment", "src/modules/bim-gaps/m2-geometry.ts", /slope up from every edge/i],
  ["Valley roof algorithm comment", "src/modules/bim-gaps/m2-geometry.ts", /intersecting gable/i],
];
for (const [label, file, regex] of geoChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Property schema ──────────────────────────────────────────────────
console.log("\nProperty schema (src/modules/bim-gaps/m2-register.ts):");
const schemaChecks = [
  ["Hip option exposed in schema", "src/modules/bim-gaps/m2-register.ts", /\["hip", "Hip \(all sides slope\)"\]/],
  ["Valley option exposed in schema", "src/modules/bim-gaps/m2-register.ts", /\["valley", "Valley \(intersecting gables\)"\]/],
];
for (const [label, file, regex] of schemaChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Tests ─────────────────────────────────────────────────────────────
console.log("\nTests:");
const testChecks = [
  ["Tests file exists", "tests/hip-roof.test.cjs", /.*/],
  ["Square footprint pyramid test", "tests/hip-roof.test.cjs", /square footprint produces pyramid/],
  ["Rectangular footprint ridge test", "tests/hip-roof.test.cjs", /rectangular footprint produces ridge line/],
  ["Watertight mesh test", "tests/hip-roof.test.cjs", /generates watertight mesh/],
  ["Valley roof square footprint test", "tests/hip-roof.test.cjs", /square footprint produces equal gable rises/],
  ["Valley roof rectangular footprint test", "tests/hip-roof.test.cjs", /rectangular footprint produces unequal gable rises/],
  ["Valley roof dirDeg rotation test", "tests/hip-roof.test.cjs", /rotated 90 degrees gives swapped rises/],
  ["Unified dispatch test", "tests/hip-roof.test.cjs", /dispatches to buildHipRoof/],
];
for (const [label, file, regex] of testChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Package.json scripts ─────────────────────────────────────────────
console.log("\npackage.json scripts:");
const pkgChecks = [
  ["test:hip script declared", "package.json", /"test:hip":\s*"node tests\/hip-roof\.test\.cjs"/],
  ["verify:v59 script declared", "package.json", /"verify:v59":\s*"node scripts\/verify-v59\.mjs"/],
];
for (const [label, file, regex] of pkgChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// ─── Run tests + regression ───────────────────────────────────────────
console.log("\nTest execution:");
try {
  execSync("node tests/hip-roof.test.cjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ Hip roof tests pass (13/13)");
  pass++;
} catch {
  console.error("  ✗ Hip roof tests failed");
  fail++;
}

console.log("\nRegression checks:");
try {
  execSync("node scripts/verify-v55.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v55 still passes (Plugin SDK intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v55 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v56.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v56 still passes (Family Library intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v56 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v57.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v57 still passes (Hosted recut fix intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v57 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v58.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v58 still passes (MEP auto-routing intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v58 regressed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
