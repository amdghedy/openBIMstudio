/**
 * verify-v62.mjs — IFC Origin-to-Origin positioning fix verification.
 *
 * Asserts the COORDINATE_TO_ORIGIN = false override is in place in
 * src/features/importer.ts so web-ifc preserves absolute IFC world
 * coordinates. Without this fix, two IFC files exported from the same
 * BIM project (linked origin-to-origin in BIM) end up at different
 * local origins in openBIMstudio, appearing far apart.
 *
 * Run: `node scripts/verify-v62.mjs`
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

console.log("\n=== verify-v62: IFC Origin-to-Origin Positioning Fix ===\n");

console.log("COORDINATE_TO_ORIGIN override (src/features/importer.ts):");
const fixChecks = [
  ["CO_COORDINATE_TO_ORIGIN = false override", "src/features/importer.ts",
    /webIfcSettings\.COORDINATE_TO_ORIGIN\s*=\s*false/],
  ["Critical fix comment present", "src/features/importer.ts",
    /CRITICAL FIX:\s*Force COORDINATE_TO_ORIGIN\s*=\s*false/i],
  ["Explanation of default=true behavior", "src/features/importer.ts",
    /defaults to[\s\S]*?COORDINATE_TO_ORIGIN:\s*true/],
  ["Explanation of breaking symptom", "src/features/importer.ts",
    /breaks .*Origin to Origin.*linking/i],
  ["User-perceived bug description", "src/features/importer.ts",
    /appearing far apart/i],
  ["Safe try/catch around override", "src/features/importer.ts",
    /try\s*{\s*ifcImporter\.webIfcSettings/i],
  ["Warning log on override failure", "src/features/importer.ts",
    /could not override COORDINATE_TO_ORIGIN/],
];
for (const [label, file, regex] of fixChecks) {
  if (check(label, file, regex)) pass++; else fail++;
}

// Also confirm no leftover accidental COORDINATE_TO_ORIGIN=true anywhere
const importerContent = fs.readFileSync(
  path.join(root, "src/features/importer.ts"),
  "utf8",
);
const trueOverride = /COORDINATE_TO_ORIGIN\s*=\s*true/.test(importerContent);
if (!trueOverride) {
  console.log("  ✓ No accidental COORDINATE_TO_ORIGIN = true in importer.ts");
  pass++;
} else {
  console.error("  ✗ Found COORDINATE_TO_ORIGIN = true in importer.ts — would re-introduce the bug");
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
try {
  execSync("node scripts/verify-v60.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v60 still passes (Hatch patterns intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v60 regressed");
  fail++;
}
try {
  execSync("node scripts/verify-v61.mjs", { cwd: root, stdio: "ignore" });
  console.log("  ✓ verify-v61 still passes (Camera MMB snap-back fix intact)");
  pass++;
} catch {
  console.error("  ✗ verify-v61 regressed");
  fail++;
}

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
