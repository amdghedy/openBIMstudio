/**
 * verify-v57.mjs — Hosted-element recut fix verification.
 *
 * Asserts that the wall opening CSG bug is fixed:
 *   - The hole `BoxGeometry` dims are ordered (width, thickness, height),
 *     not the buggy (width, height, thickness).
 *   - The fix is documented inline.
 *   - No regressions to v55 (Plugin SDK) or v56 (Family Library).
 *
 * Run: `node scripts/verify-v57.mjs`
 * Exit code: 0 = pass, 1 = fail.
 */

import fs from "node:fs";
import path from "node:path";

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

console.log("\n=== verify-v57: Hosted-Element Recut Fix ===\n");

console.log("Fix in authoring.ts:");
const checks = [
  // The actual fix: hole box dimensions are now (width, T+0.2, height)
  // in local wall coords where local Y = wall normal, local Z = world up.
  ["Hole box uses (width, T+0.2, height) ordering", "src/features/authoring.ts",
    /new THREE\.BoxGeometry\(op\.width,\s*T\s*\+\s*0\.2,\s*op\.height\)/],
  ["Inline comment explaining local X axis (wall direction)", "src/features/authoring.ts",
    /local X\s*->\s*wall direction/],
  ["Inline comment explaining local Y axis (wall normal)", "src/features/authoring.ts",
    /local Y\s*->\s*wall normal/],
  ["Inline comment explaining local Z axis (world up)", "src/features/authoring.ts",
    /local Z\s*->\s*world up/],
  ["Regression note in comments", "src/features/authoring.ts",
    /recut regression/i],
];
for (const [label, file, regex] of checks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// Explicitly assert the OLD buggy pattern is GONE
const authoringContent = fs.readFileSync(path.join(root, "src/features/authoring.ts"), "utf8");
const buggyPattern = /new THREE\.BoxGeometry\(op\.width,\s*op\.height,\s*T\s*\+\s*0\.2\)/;
if (!buggyPattern.test(authoringContent)) {
  console.log("  ✓ Buggy BoxGeometry(op.width, op.height, T+0.2) pattern is no longer present");
  pass++;
} else {
  console.error("  ✗ Buggy BoxGeometry(op.width, op.height, T+0.2) pattern still present — fix not applied");
  fail++;
}

console.log("\nRegression checks:");
// Re-run v55 + v56 milestone verifiers
import { execSync } from "node:child_process";
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

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
