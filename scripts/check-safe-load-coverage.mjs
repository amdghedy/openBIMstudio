#!/usr/bin/env node
/**
 * Static guard for untrusted JSON file boundaries.
 *
 * This audit inventories all application TypeScript/JavaScript source, including
 * shell entry points. JSON.parse is allowed for in-memory clones and bounded
 * local preferences; data originating in File.text() must pass safeLoad first.
 *
 * Three shapes are rejected:
 *   1. direct `JSON.parse(await file.text())`;
 *   2. `const txt = await file.text(); ... JSON.parse(txt)` (assigned value);
 *   3. `.then()`-chain parses — `file.text().then((txt) => JSON.parse(txt))`
 *      and `file.text().then(JSON.parse)`. Shape 3 is the escape that hid the
 *      `.markups.json` loader in `src/features/cad-viewer.ts` (issue #90):
 *      the parse sat inside a promise callback, so shapes 1–2 never saw it.
 *
 * The per-file check is exported as `scanSource` so the regression suite
 * (`tests/safe-load-coverage-audit.test.cjs`) can prove the audit flags the
 * old markups pattern and passes on the fixed one without running the whole
 * audit. The CLI below only runs when the file is executed directly.
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
  ["src/features/cad-viewer.ts", "safeLoad("],
  // PE-20 — Zod discipline beyond JSON: each new boundary must keep its
  // schema wired into its actual load/import path.
  ["src/modules/drawings/dxf-reader.ts", "assertValidDxfDocument("],
  ["src/modules/ifc-semantics/step-preflight.ts", "parseStepHeader"],
  ["src/features/importer.ts", "assertValidStepPreflightResult("],
  ["src/features/importer.ts", "parseStepHeader("],
  ["src/features/importer.ts", "assertValidStepFileHeader("],
  ["src/modules/issues/bcf.ts", "validateBcfParsedTopic("],
  ["src/modules/issues/bcf.ts", "validateBcfViewpoint("],
  ["src/modules/families/safe-expr.ts", "validateFormulaExpression"],
  ["src/modules/families/formula-engine.ts", "validateFormulaExpression("],
];

/**
 * Schemas that must exist in the boundary hub (`src/core/safeLoad.ts`).
 * Guards the PE-20 regression where a boundary quietly falls back to
 * `z.unknown()` element/scenario contents: the hub must define the real
 * content schemas, and must not contain an unknown-typed elements or
 * scenarios array any more.
 */
const requiredSchemas = [
  "ProjectElementSchema",
  "ClashScenarioSchema",
  "DxfDocumentSchema",
  "StepPreflightResultSchema",
  "StepFileHeaderSchema",
  "BcfParsedTopicSchema",
  "BcfViewpointSchema",
  "FormulaParameterSchema",
  "FormulaExpressionSchema",
];
const forbiddenHubPatterns = [
  "z.array(z.unknown())",
];

// Detect direct JSON.parse(File.text()) and assigned File.text() values.
const directFileText = /JSON\.parse\(\s*(?:await\s+)?(?:file|f)\.text\(\s*\)\s*\)/;
const textAssignment = /\b(?:const|let|var)\s+(\w+)\s*=\s*await\s+(?:file|f)\.text\(\s*\)\s*;/g;
// `.text().then(JSON.parse)` — JSON.parse itself as the promise callback.
const thenBareParse = /\.text\(\s*\)\s*\.then\(\s*JSON\.parse\s*\)/;
// `.text().then((txt) => ...)` / `.text().then(txt => ...)` / `.text().then(async (txt) => ...)`
const thenArrowParam = /\.text\(\s*\)\s*\.then\(\s*(?:async\s+)?(?:\(\s*([A-Za-z_$][\w$]*)\s*\)|([A-Za-z_$][\w$]*))\s*=>/g;
// `.text().then(function (txt) ...)` / `.text().then(async function (txt) ...)`
const thenFunctionParam = /\.text\(\s*\)\s*\.then\(\s*(?:async\s+)?function\s*(?:[A-Za-z_$][\w$]*)?\s*\(\s*([A-Za-z_$][\w$]*)/g;

/**
 * Scan one source file. Returns the failure messages for every unguarded
 * File.text() → JSON.parse shape found (empty when the file is clean).
 * A parse counts as guarded when a `safeLoad(` call appears between the
 * binding that produced the value and the `JSON.parse` of that value.
 */
export function scanSource(source, relative) {
  const failures = [];
  if (directFileText.test(source)) {
    failures.push(relative + ": direct JSON.parse(File.text()) bypasses safeLoad");
  }
  for (const match of source.matchAll(textAssignment)) {
    const variable = match[1];
    const tail = source.slice(match.index + match[0].length);
    const parse = new RegExp("JSON\\.parse\\(\\s*" + variable + "\\s*[,)]");
    const parsed = parse.exec(tail);
    if (parsed) {
      const beforeParse = tail.slice(0, parsed.index);
      if (!beforeParse.includes("safeLoad(")) {
        failures.push(relative + ": File.text() value " + variable + " reaches JSON.parse without safeLoad");
      }
    }
  }
  if (thenBareParse.test(source)) {
    failures.push(relative + ": File.text().then(JSON.parse) bypasses safeLoad");
  }
  for (const pattern of [thenArrowParam, thenFunctionParam]) {
    for (const match of source.matchAll(pattern)) {
      const variable = match[1] ?? match[2];
      if (!variable) continue;
      const tail = source.slice(match.index + match[0].length);
      const parse = new RegExp("JSON\\.parse\\(\\s*" + variable + "\\s*[,)]");
      const parsed = parse.exec(tail);
      if (parsed) {
        const beforeParse = tail.slice(0, parsed.index);
        if (!beforeParse.includes("safeLoad(")) {
          failures.push(relative + ": File.text().then() value " + variable + " reaches JSON.parse without safeLoad");
        }
      }
    }
  }
  return failures;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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

  // PE-20: the hub must define every boundary schema, and element /
  // scenario contents must never again be z.unknown().
  const hubPath = path.join(root, "src/core/safeLoad.ts");
  const hub = fs.readFileSync(hubPath, "utf8");
  for (const schema of requiredSchemas) {
    if (!hub.includes(schema)) {
      console.error(`FAIL src/core/safeLoad.ts: missing schema ${schema}`);
      failed = true;
    } else {
      console.log(`OK   src/core/safeLoad.ts: schema ${schema} defined`);
    }
  }
  for (const pattern of forbiddenHubPatterns) {
    if (hub.includes(pattern)) {
      console.error(`FAIL src/core/safeLoad.ts: forbidden pattern ${pattern} (unvalidated contents)`);
      failed = true;
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

  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), "utf8");
    for (const failure of scanSource(source, relative)) {
      console.error("FAIL " + failure);
      failed = true;
    }
  }

  if (failed) process.exit(1);
  console.log(`safe-load coverage audit passed (${requiredBoundaries.length} required boundaries, ${files.length} source files scanned)`);
}
