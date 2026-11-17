/**
 * tests/ifc-interop-report.test.cjs
 *
 * Unit tests for the IFC interop report (src/modules/ifc-semantics/interop-report.ts)
 * — the per-entity inventory parsed from the STEP instance table
 * (ifc-import-export Phase 4 limitation).
 *
 * Run: `node tests/ifc-interop-report.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-interop-"));
execSync(
  `npx tsc src/modules/ifc-semantics/interop-report.ts --outDir ${out} --module commonjs --target es2020 ` +
  `--lib es2020,dom --skipLibCheck --strict --ignoreDeprecations 5.0 --noResolve --noCheck`,
  { cwd: path.resolve(__dirname, ".."), stdio: "inherit" },
);
const compiled = path.join(out, "interop-report.js");
assert.ok(fs.existsSync(compiled), "expected compiled module at interop-report.js");
const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../core/region") {
    return { fmtNumber: (v) => String(Math.round(Number(v) || 0)) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const m = require(compiled);
const { parseStepEntities, buildInteropReport, formatInteropReport } = m;

const SAMPLE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('sample.ifc','2026-01-01',('a'),('b'),'c','d','e');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('g',$,$,$,$,$,$,$,$);
#2=IFCSITE('h',$,$,$,$,$,$,$,$,$,$,$,$,$,$);
#3=IFCWALLSTANDARDCASE('i',$,$,$,$,$,$,$);
#4=IFCWALLSTANDARDCASE('j',$,$,$,$,$,$,$);
#5=IFCWALL('k',$,$,$,$,$,$,$);
#6=IFCDOOR('l',$,$,$,$,$,$,$,$,$,$);
#7=IFCPROPERTYSET('m',$,$,$,(#8,#9));
#8=IFCPROPERTYSINGLEVALUE('n',$,IFCLABEL('x'),$);
#9=IFCPROPERTYSINGLEVALUE('o',$,IFCLABEL('y'),$);
ENDSEC;
END-ISO-10303-21;`;

t("parse counts each STEP instance by type", () => {
  const r = parseStepEntities(SAMPLE);
  assert.strictEqual(r.total, 9, `total=${r.total}`);
  assert.strictEqual(r.counts.get("IFCWALLSTANDARDCASE"), 2);
  assert.strictEqual(r.counts.get("IFCWALL"), 1);
  assert.strictEqual(r.counts.get("IFCPROPERTYSINGLEVALUE"), 2);
  assert.strictEqual(r.truncated, false);
});
t("parse is whitespace-tolerant and only counts instance lines", () => {
  const r = parseStepEntities("#10=IFCSLAB('x',$,$,$,$,$,$,$); #11 = IFCBEAM( 'y',$);");
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.counts.get("IFCSLAB"), 1);
  assert.strictEqual(r.counts.get("IFCBEAM"), 1);
});
t("parse: lowercase tokens are not entity instances", () => {
  const r = parseStepEntities("IFCWALL(#1); IFCSLAB();");
  assert.strictEqual(r.total, 0);
});
t("parse: cap triggers truncated flag", () => {
  let text = "DATA;\n";
  for (let i = 1; i <= 50; i++) text += `#${i}=IFCWALL('w${i}',$,$,$,$,$,$,$);\n`;
  text += "ENDSEC;\nEND-ISO-10303-21;";
  const r = parseStepEntities(text, 10);
  assert.strictEqual(r.total, 10, `total=${r.total}`);
  assert.strictEqual(r.truncated, true);
});
t("build: report from latin1 bytes with schema + sorted types", () => {
  const bytes = Uint8Array.from(Buffer.from(SAMPLE, "latin1"));
  const rep = buildInteropReport("sample.ifc", bytes);
  assert.ok(rep, "report missing");
  assert.strictEqual(rep.schema, "IFC4");
  assert.strictEqual(rep.totalEntities, 9);
  // Both top types have count 2 — alphabetical tie-break puts
  // IFCPROPERTYSINGLEVALUE before IFCWALLSTANDARDCASE.
  assert.strictEqual(rep.types[0].type, "IFCPROPERTYSINGLEVALUE");
  assert.strictEqual(rep.types[0].count, 2);
  assert.strictEqual(rep.types[1].type, "IFCWALLSTANDARDCASE");
  assert.strictEqual(rep.types[1].count, 2);
  const names = rep.types.map((x) => x.type);
  assert.ok(names.includes("IFCPROJECT") && names.includes("IFCDOOR"), names.join(","));
});
t("build: non-STEP input returns null", () => {
  assert.strictEqual(buildInteropReport("a.ifc", Uint8Array.from(Buffer.from("hello world", "latin1"))), null);
  assert.strictEqual(buildInteropReport("a.ifc", new Uint8Array(0)), null);
  assert.strictEqual(buildInteropReport("a.ifc", null), null);
});
t("build: non-IFC extension content is still inventoried if STEP-shaped", () => {
  const bytes = Uint8Array.from(Buffer.from(SAMPLE, "latin1"));
  const rep = buildInteropReport("renamed.step", bytes);
  assert.ok(rep, "STEP-shaped content must report regardless of extension");
});
t("format: summary lines mention schema, counts and the honest caveat", () => {
  const bytes = Uint8Array.from(Buffer.from(SAMPLE, "latin1"));
  const rep = buildInteropReport("sample.ifc", bytes);
  const lines = formatInteropReport(rep);
  assert.ok(lines[0].includes("IFC4") && lines[0].includes("9"), lines[0]);
  const joined = lines.join("\n");
  assert.ok(/IFCWALLSTANDARDCASE: 2/.test(joined), joined);
  assert.ok(/not a per-type conversion guarantee/.test(joined), joined);
});
t("format: >12 types collapse into a rest line", () => {
  let text = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
  for (let i = 1; i <= 20; i++) text += `#${i}=IFCTYPE${i}('x',$);\n`;
  text += "ENDSEC;\nEND-ISO-10303-21;";
  const rep = buildInteropReport("many.ifc", Uint8Array.from(Buffer.from(text, "latin1")));
  const lines = formatInteropReport(rep);
  const restLine = lines.find((l) => l.includes("more type(s)"));
  assert.ok(restLine, "rest line missing: " + lines.join(" | "));
  assert.ok(/8 more type\(s\)/.test(restLine), restLine);
});

if (fail) process.exit(1);
console.log(`=== ifc-interop-report tests complete: ${pass} passed, ${fail} failed ===`);
