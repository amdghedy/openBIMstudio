#!/usr/bin/env node
/**
 * Static guard for untrusted JSON file boundaries.
 *
 * This audit inventories all application TypeScript/JavaScript source, including
 * shell entry points. JSON.parse is allowed for in-memory clones and bounded
 * local preferences; data originating in File.text() must pass safeLoad first.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredBoundaries = [
  ["src/modules/projects/project-file.ts", "safeLoad("],
  ["src/plugins/loader.ts", "safeLoad("],
  ["src/features/saved-views.ts", "safeLoad("],
  ["src/features/file-interop.ts", "safeLoad("],
  ["src/shell/file-menu.ts", "safeLoad("],
  ["src/features/clash.ts", "safeLoad("],
  ["src/features/libredwg-toolkit.ts", "safeLoad("],
];
let failed = false;

for (const [relative, required] of requiredBoundaries) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    console.error(`FAIL ${relative}: required boundary file is missing`);
    failed = true;
    continue;
  }
  const source = fs.readFileSync(file, "utf8");
  if (!source.includes(required)) {
    console.error(`FAIL ${relative}: missing ${required} boundary`);
    failed = true;
  } else {
    console.log(`OK   ${relative}: validated boundary wired`);
  }
}

const sourceRoots = ["src"];
const files = [];
function collect(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !relative.includes("core/i18n-catalogs/")) files.push(relative);
  }
}
for (const dir of sourceRoots) collect(dir);

// Detect direct JSON.parse(File.text()) and assigned File.text() values.
const directFileText = /JSON\.parse\(\s*(?:await\s+)?(?:file|f)\.text\(\s*\)\s*\)/;
const textAssignment = /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+(?:file|f)\.text\(\s*\)\s*;/g;
for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  if (directFileText.test(source)) {
    console.error("FAIL " + relative + ": direct JSON.parse(File.text()) bypasses safeLoad");
    failed = true;
  }
  for (const match of source.matchAll(textAssignment)) {
    const variable = match[1];
    const tail = source.slice(match.index + match[0].length);
    const parse = new RegExp("JSON\\.parse\\(\\s*" + variable + "\\s*\\)");
    const parsed = parse.exec(tail);
    if (parsed) {
      const beforeParse = tail.slice(0, parsed.index);
      if (!beforeParse.includes("safeLoad(")) {
        console.error("FAIL " + relative + ": File.text() value " + variable + " reaches JSON.parse without safeLoad");
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log(`safe-load coverage audit passed (${requiredBoundaries.length} required boundaries, ${files.length} source files scanned)`);