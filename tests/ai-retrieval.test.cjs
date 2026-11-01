const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve("src/features/ai-retrieval.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(output, sourcePath);
const { buildElementSearchText, rankHybridResults, tokenizeBimQuery } = loaded.exports;

function test(name, fn) {
  try { fn(); console.log("  PASS", name); }
  catch (error) { console.error("  FAIL", name, error); process.exitCode = 1; }
}

test("search text retains property names as well as values", () => {
  const text = buildElementSearchText("Supply duct", "IFCDUCTSEGMENT", {
    "Pset_DuctCommon.Reference": "SA-01",
    "NominalDiameter": "250",
  });
  assert.match(text, /IFC category: DUCTSEGMENT/);
  assert.match(text, /Pset_DuctCommon\.Reference: SA-01/);
  assert.match(text, /NominalDiameter: 250/);
});

test("search text is bounded", () => {
  const fields = Object.fromEntries(Array.from({ length: 100 }, (_, i) => ["Property" + i, "x".repeat(100)]));
  assert.ok(buildElementSearchText("Element", "IFCWALL", fields, 500).length <= 500);
});

test("hybrid ranking boosts exact BIM identifier and property matches", () => {
  const ranked = rankHybridResults("SA-01 fire rating", [
    { semanticScore: 0.78, text: "Supply air terminal diffuser type", value: "semantic" },
    { semanticScore: 0.64, text: "Tag: SA-01 · Pset_DoorCommon.FireRating: 60 min", value: "exact" },
  ]);
  assert.equal(ranked[0].value, "exact");
  assert.ok(ranked[0].lexicalScore > ranked[1].lexicalScore);
});

test("semantic relevance remains part of the combined score", () => {
  const ranked = rankHybridResults("duct", [
    { semanticScore: 0.9, text: "air distribution element", value: "semantic" },
    { semanticScore: 0.1, text: "unrelated object", value: "weak" },
  ]);
  assert.ok(ranked[0].score > ranked[1].score);
  assert.ok(ranked[0].semanticScore > ranked[1].semanticScore);
});

test("tokenization ignores common stop words and duplicate terms", () => {
  assert.deepEqual(tokenizeBimQuery("the door and door 60 MIN"), ["door", "60", "min"]);
});

if (process.exitCode) process.exit(process.exitCode);
console.log("=== AI hybrid retrieval tests complete ===");
