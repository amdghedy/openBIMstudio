/** Regression tests for Part 21 syntax preflight (no web-ifc/WASM startup). */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-ifc-preflight-"));
execFileSync("npx", [
  "tsc", "src/modules/ifc-semantics/step-preflight.ts",
  "--outDir", out, "--module", "commonjs", "--target", "es2020",
  "--skipLibCheck", "--ignoreDeprecations", "5.0",
], { cwd: root, stdio: "inherit" });
const { validateIfcStepSyntax } = require(path.join(out, "step-preflight.js"));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}
const valid = (text) => assert.deepEqual(validateIfcStepSyntax(text), []);
const invalid = (text, pattern) => {
  const errors = validateIfcStepSyntax(text);
  assert.ok(errors.length > 0, "malformed input unexpectedly passed");
  if (pattern) assert.ok(errors.some((e) => pattern.test(e)), errors.join("; "));
};

const corpus = path.join(root, "tests/fixtures/ifc-corpus");
for (const file of [
  "arch-classified.ifc", "generated-2x3.ifc", "generated-small.ifc",
  "generated-structural.ifc", "mep-model.ifc",
  "invalid/bad-guid.ifc", "invalid/dangling-ref.ifc", "invalid/missing-units.ifc",
]) {
  test("well-formed corpus accepted: " + file, () => valid(fs.readFileSync(path.join(corpus, file))));
}
test("truncated corpus file is rejected", () => {
  invalid(fs.readFileSync(path.join(corpus, "invalid/truncated.ifc")));
});

const minimal = [
  "ISO-10303-21;", "HEADER;",
  "FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');",
  "FILE_NAME('model.ifc','2026-11-20T00:00:00',('OpenBIMStudio'),('OpenBIMStudio'),'writer','writer','');",
  "FILE_SCHEMA(('IFC4'));", "ENDSEC;", "DATA;",
  "#1=IFCPROJECT('0123456789012345678901',$,'contains ENDSEC; as text',$,$,$,$,$,$);",
  "#2=(IFCWALL('0123456789012345678902',$,$,$,$,$,$,$) IFCSOMETHING($));",
  "/* a comment with ; DATA; and ) */",
  "ENDSEC;", "END-ISO-10303-21;",
].join("\n");
test("accepts normal and complex instances, comments, and section words inside strings", () => valid(minimal));
test("accepts a UTF-8 BOM", () => valid("\uFEFF" + minimal));
test("accepts semantic errors without treating them as syntax errors", () => {
  const badGuid = minimal.replace("0123456789012345678901", "BAD-GUID");
  valid(badGuid);
});
test("rejects malformed FILE_NAME delimiter", () => {
  invalid(minimal.replace("FILE_NAME(", "FILE_NAME)"), /FILE_NAME/);
});
test("rejects invalid entity identifier framing", () => {
  invalid(minimal.replace("#1=IFCPROJECT", '"#1=IFCPROJECT'), /quoted|unterminated|DATA/);
});
test("rejects illegal unquoted token characters", () => {
  invalid(minimal.replace("IFCPROJECT(", "IFC&PROJECT("), /illegal unquoted/);
});
test("rejects unterminated strings", () => {
  invalid(minimal.replace("'model.ifc'", "'model.ifc"), /unterminated/);
});
test("rejects an entity missing its semicolon", () => {
  invalid(minimal.replace("#1=IFCPROJECT('0123456789012345678901',$,'contains ENDSEC; as text',$,$,$,$,$,$);", "#1=IFCPROJECT('0123456789012345678901',$,'contains ENDSEC; as text',$,$,$,$,$,$)"), /semicolon/);
});
console.log(`IFC STEP preflight: ${passed} tests passed.`);
fs.rmSync(out, { recursive: true, force: true });
