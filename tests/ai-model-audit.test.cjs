const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve("src/features/ai-model-audit.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const loaded = new Module(sourcePath, module);
loaded.filename = sourcePath;
loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
loaded._compile(output, sourcePath);
const { auditModelRecords } = loaded.exports;

function test(name, fn) {
  try { fn(); console.log("  PASS", name); }
  catch (error) { console.error("  FAIL", name, error); process.exitCode = 1; }
}

test("reports missing and duplicate GlobalIds with exact element references", () => {
  const result = auditModelRecords([
    { localId: 1, category: "IFCWALL", globalId: "same-id", name: "Wall A" },
    { localId: 2, category: "IFCWALL", globalId: "same-id", name: "Wall B" },
    { localId: 3, category: "IFCDOOR", globalId: "", name: "Door D01" },
  ], {
    modelId: "ARCH", modelName: "Architecture",
    totalGeometryElementCount: 3, scannedCount: 3,
  });
  assert.equal(result.summary.scanned, 3);
  assert.equal(result.summary.missingGlobalId, 1);
  assert.equal(result.summary.duplicateGlobalIdGroups, 1);
  assert.equal(result.findings[0].elements[0].localId, 3);
  assert.equal(result.findings[1].duplicateGroups[0].elements[1].modelId, "ARCH");
  assert.equal(result.scope.complete, true);
});

test("does not treat identical GlobalIds in separate audit calls as same-model duplicates", () => {
  const result = auditModelRecords([
    { localId: 1, category: "IFCWALL", globalId: "shared" },
  ], {
    modelId: "MODEL-B", modelName: "Model B",
    totalGeometryElementCount: 1, scannedCount: 1,
  });
  assert.equal(result.summary.duplicateGlobalIdGroups, 0);
});

test("marks truncated scans incomplete and states scope limitations", () => {
  const result = auditModelRecords([], {
    modelId: "A", modelName: "A",
    totalGeometryElementCount: 1000, scannedCount: 100,
    truncated: true,
  });
  assert.equal(result.scope.complete, false);
  assert.equal(result.scope.truncated, true);
  assert.match(result.scope.elementPopulation, /geometry-bearing/);
  assert.ok(result.limitations.some((line) => /project-specific exchange requirements/.test(line)));
});

test("reports read and category-index errors independently", () => {
  const result = auditModelRecords([], {
    modelId: "A", modelName: "A",
    totalGeometryElementCount: 10, scannedCount: 0,
    readErrorCount: 10, categoryReadFailed: true,
  });
  assert.equal(result.scope.readErrorCount, 10);
  assert.equal(result.scope.categoryReadFailed, true);
  assert.equal(result.scope.complete, false);
});

if (process.exitCode) process.exit(process.exitCode);
console.log("=== AI model audit tests complete ===");
