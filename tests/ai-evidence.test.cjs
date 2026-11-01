const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");

const sourcePath = path.resolve("src/features/ai-evidence.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const evidenceModule = new Module(sourcePath, module);
evidenceModule.filename = sourcePath;
evidenceModule.paths = Module._nodeModulePaths(path.dirname(sourcePath));
evidenceModule._compile(output, sourcePath);
const { buildElementEvidence, normalizeEvidenceValue } = evidenceModule.exports;

function test(name, fn) {
  try { fn(); console.log("  PASS", name); }
  catch (error) { console.error("  FAIL", name, error); process.exitCode = 1; }
}

test("preserves source model and model-scoped element identity", () => {
  const evidence = buildElementEvidence({
    modelId: "MEP-Model-A", modelName: "MEP Coordination",
    localId: 412, category: "IFCDUCTSEGMENT",
    item: { GlobalId: { value: "2Xabc" }, Name: { value: "Supply duct" } },
  });
  assert.equal(evidence.source.modelId, "MEP-Model-A");
  assert.equal(evidence.source.modelName, "MEP Coordination");
  assert.equal(evidence.identity.localId, 412);
  assert.equal(evidence.identity.globalId, "2Xabc");
  assert.equal(evidence.identity.name, "Supply duct");
  assert.equal(evidence.source.category, "IFCDUCTSEGMENT");
});

test("separates attributes from property sets", () => {
  const evidence = buildElementEvidence({
    modelId: "A", modelName: "A", localId: 7, category: "IFCDOOR",
    item: {
      Name: { value: "Door D01" },
      OverallHeight: { value: 2100 },
      psets: { Pset_DoorCommon: { FireRating: { value: "60 min" } } },
    },
  });
  assert.equal(evidence.attributes.OverallHeight, 2100);
  assert.equal(evidence.propertySets.Pset_DoorCommon.FireRating, "60 min");
  assert.equal(evidence.attributes.psets, undefined);
});

test("does not invent missing GlobalId or properties", () => {
  const evidence = buildElementEvidence({
    modelId: "A", modelName: "A", localId: 9, category: "IFCWALL", item: {},
  });
  assert.equal(evidence.identity.globalId, null);
  assert.equal(evidence.identity.name, null);
  assert.deepEqual(evidence.attributes, {});
  assert.deepEqual(evidence.propertySets, {});
});

test("normalizes IFC wrapped values and bounds nested structures", () => {
  assert.deepEqual(normalizeEvidenceValue({
    Length: { value: 2500 }, Flags: [true, false],
  }), { Length: 2500, Flags: [true, false] });
  const deep = { a: { b: { c: { d: { e: { f: "bounded" } } } } } };
  assert.equal(normalizeEvidenceValue(deep).a.b.c.d.e, "[nested value omitted]");
});

test("omits prototype-pollution keys", () => {
  const input = JSON.parse('{"Name":{"value":"Wall"},"__proto__":{"polluted":true},"constructor":"bad"}');
  const evidence = buildElementEvidence({
    modelId: "A", modelName: "A", localId: 1, category: "IFCWALL", item: input,
  });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence.attributes, "constructor"), false);
  assert.equal(evidence.attributes.Name, "Wall");
});

if (process.exitCode) process.exit(process.exitCode);
console.log("=== AI evidence tests complete ===");
