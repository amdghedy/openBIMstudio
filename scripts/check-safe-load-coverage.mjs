#!/usr/bin/env node
/**
 * Static guard for untrusted JSON file boundaries.
 *
 * This is intentionally narrow: JSON.parse remains valid for in-memory clones
 * and bounded local preferences, but raw File.text() payloads must enter via
 * safeLoad before they can reach application state.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredBoundaries = [
  "src/modules/projects/project-file.ts",
  "src/plugins/loader.ts",
  "src/features/saved-views.ts",
  "src/features/file-interop.ts",
];
let failed = false;

for (const relative of requiredBoundaries) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes("safeLoad")) {
    console.error(`FAIL ${relative}: missing safeLoad boundary`);
    failed = true;
  } else {
    console.log(`OK   ${relative}: safeLoad wired`);
  }
}

const sourceRoots = ["src/features", "src/modules", "src/plugins"];
const files = [];
function collect(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(relative);
  }
}
for (const dir of sourceRoots) collect(dir);

// Direct parsing of a File.text() result is the dangerous pattern this gate
// prevents. Parsers that receive bytes/text through a dedicated safe wrapper
// are not matched by this expression.
const directFileText = /JSON\.parse\(\s*(?:await\s+)?[^;\n)]*\.text\(\s*\)\s*\)/;
for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  if (directFileText.test(source)) {
    console.error(`FAIL ${relative}: direct JSON.parse(File.text()) bypasses safeLoad`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`safe-load coverage audit passed (${requiredBoundaries.length} required boundaries, ${files.length} source files scanned)`);
