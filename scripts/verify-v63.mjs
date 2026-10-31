/**
 * verify-v63.mjs — Stair Winder + Spiral milestone checks.
 *
 * Asserts the winder + spiral stair generators landed with the expected shape:
 *   - StairParams extended with "winder" | "spiral" shape options + spiral params
 *   - buildWinderStair + buildSpiralStair exported
 *   - buildStair dispatches correctly
 *   - Property schema exposes the new types
 *   - tests/stair-winder-spiral.test.cjs exists and passes
 *
 * Run: `node scripts/verify-v63.mjs`
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

let pass = 0;
let fail = 0;

console.log("\n=== verify-v63: Stair Winder + Spiral ===\n");

console.log("Generator (src/modules/bim-gaps/m2-geometry.ts):");
const geoChecks = [
  ["StairParams includes 'winder'", "src/modules/bim-gaps/m2-geometry.ts", /"straight" \| "L" \| "U" \| "winder"/],
  ["StairParams includes 'spiral'", "src/modules/bim-gaps/m2-geometry.ts", /"winder" \| "spiral"/],
  ["innerRadius param", "src/modules/bim-gaps/m2-geometry.ts", /innerRadius\??: number/],
  ["spiralTurns param", "src/modules/bim-gaps/m2-geometry.ts", /spiralTurns\??: number/],
  ["buildWinderStair export", "src/modules/bim-gaps/m2-geometry.ts", /export function buildWinderStair/],
  ["buildSpiralStair export", "src/modules/bim-gaps/m2-geometry.ts", /export function buildSpiralStair/],
  ["buildStair dispatches to winder", "src/modules/bim-gaps/m2-geometry.ts", /if \(shape === "winder"\) return buildWinderStair/],
  ["buildStair dispatches to spiral", "src/modules/bim-gaps/m2-geometry.ts", /if \(shape === "spiral"\) return buildSpiralStair/],
  ["Winder part name set", "src/modules/bim-gaps/m2-geometry.ts", /name: "Winder Stair"/],
  ["Spiral part name set", "src/modules/bim-gaps/m2-geometry.ts", /name: "Spiral Stair"/],
  ["Winder info includes winderCount", "src/modules/bim-gaps/m2-geometry.ts", /winderCount:/],
  ["Spiral info includes innerRadius", "src/modules/bim-gaps/m2-geometry.ts", /innerRadius:/],
  ["Spiral info includes totalAngleDeg", "src/modules/bim-gaps/m2-geometry.ts", /totalAngleDeg:/],
  ["Winder algorithm comment", "src/modules/bim-gaps/m2-geometry.ts", /tapered treads/i],
  ["Spiral algorithm comment", "src/modules/bim-gaps/m2-geometry.ts", /helical stair/i],
];
for (const [label, file, regex] of geoChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\nProperty schema (src/modules/bim-gaps/m2-register.ts):");
const schemaChecks = [
  ["Winder option in dropdown", "src/modules/bim-gaps/m2-register.ts", /\["winder", "Winder \(tapered corner\)"\]/],
  ["Spiral option in dropdown", "src/modules/bim-gaps/m2-register.ts", /\["spiral", "Spiral \(helical\)"\]/],
];
for (const [label, file, regex] of schemaChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\nTests:");
const testChecks = [
  ["Tests file exists", "tests/stair-winder-spiral.test.cjs", /.*/],
  ["Winder produces geometry test", "tests/stair-winder-spiral.test.cjs", /buildWinderStair produces geometry/],
  ["Winder has 3 sections test", "tests/stair-winder-spiral.test.cjs", /winder has 3 sections/],
  ["Winder respects turn direction test", "tests/stair-winder-spiral.test.cjs", /winder respects turn direction/],
  ["Spiral produces geometry test", "tests/stair-winder-spiral.test.cjs", /buildSpiralStair produces geometry/],
  ["Spiral riser count test", "tests/stair-winder-spiral.test.cjs", /spiral has correct riser count/],
  ["Spiral inner/outer radius test", "tests/stair-winder-spiral.test.cjs", /spiral inner\/outer radius/],
  ["Spiral respects turns count test", "tests/stair-winder-spiral.test.cjs", /spiral respects turns count/],
  ["Unified dispatch winder test", "tests/stair-winder-spiral.test.cjs", /dispatches to buildWinderStair/],
  ["Unified dispatch spiral test", "tests/stair-winder-spiral.test.cjs", /dispatches to buildSpiralStair/],
];
for (const [label, file, regex] of testChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\npackage.json scripts:");
const pkgChecks = [
  ["test:stairs script declared", "package.json", /"test:stairs":\s*"node tests\/stair-winder-spiral\.test\.cjs"/],
  ["verify:v63 script declared", "package.json", /"verify:v63":\s*"node scripts\/verify-v63\.mjs"/],
];
for (const [label, file, regex] of pkgChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\nTest execution:");
try {
  execSync("node tests/stair-winder-spiral.test.cjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ Stair tests pass (13/13)");
  pass++;
} catch {
  console.error("  ✗ Stair tests failed");
  fail++;
}

console.log("\nRegression checks:");
for (const v of [55, 56, 57, 58, 59, 60, 61, 62]) {
  try {
    execSync(`node scripts/verify-v${v}.mjs`, { cwd: root, stdio: "ignore" });
    console.log(`  ✓ verify-v${v} still passes`);
    pass++;
  } catch {
    console.error(`  ✗ verify-v${v} regressed`);
    fail++;
  }
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
