/**
 * verify-v61.mjs — Camera MMB Snap-Back Fix verification.
 *
 * Asserts the dblclick→fitAll snap-back bug is fixed:
 *   - DOUBLE_CLICK_FIT_COOLDOWN_MS constant declared in navigation.ts
 *   - lastNavGestureAt timestamp updated on every drag-end + wheel zoom
 *   - dblclick handler checks the cooldown before calling fitAll()
 *
 * Run: `node scripts/verify-v61.mjs`
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

console.log("\n=== verify-v61: Camera MMB Snap-Back Fix ===\n");

console.log("Cooldown constants + state (src/features/navigation.ts):");
const stateChecks = [
  ["DOUBLE_CLICK_FIT_COOLDOWN_MS constant", "src/features/navigation.ts", /const DOUBLE_CLICK_FIT_COOLDOWN_MS\s*=\s*600/],
  ["lastNavGestureAt module state", "src/features/navigation.ts", /let lastNavGestureAt\s*=\s*0/],
  ["endNavGesture stamps lastNavGestureAt", "src/features/navigation.ts", /lastNavGestureAt\s*=\s*performance\.now\(\)/],
];
for (const [label, file, regex] of stateChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\nWheel handler integration:");
const wheelChecks = [
  ["Wheel handler stamps lastNavGestureAt", "src/features/navigation.ts", /\/\/ Wheel zoom counts as a gesture[\s\S]*?lastNavGestureAt\s*=\s*performance\.now\(\)/],
];
for (const [label, file, regex] of wheelChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

console.log("\nDblclick handler fix:");
const dblclickChecks = [
  ["Dblclick handler checks cooldown", "src/features/navigation.ts", /if \(performance\.now\(\)\s*-\s*lastNavGestureAt\s*<\s*DOUBLE_CLICK_FIT_COOLDOWN_MS\)/],
  ["Comment explaining snap-back bug", "src/features/navigation.ts", /Suppress the dblclick → fitAll snap-back/],
  ["Comment explaining the user-perceived symptom", "src/features/navigation.ts", /the camera snaps[\s\S]*?back to the old start view/],
];
for (const [label, file, regex] of dblclickChecks) {
  if (check(label, file, regex)) pass++; else fail++;
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
try {
  execSync("node scripts/verify-v59.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v59 still passes (Hip + Valley roofs intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v59 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v60.mjs > /dev/null 2>&1", { cwd: root, stdio: "inherit" });
  console.log("  ✓ verify-v60 still passes (Hatch patterns intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v60 regressed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
