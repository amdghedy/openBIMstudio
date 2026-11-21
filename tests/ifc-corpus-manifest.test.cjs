/* The IFC corpus manifest is complete and every file behaves as declared (no web-ifc needed: preflight + independent reader). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, ".."), CORPUS = path.join(__dirname, "fixtures", "ifc-corpus");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ifc-manifest-"));
execSync(`npx tsc src/modules/ifc-semantics/index.ts src/modules/ifc-semantics/step-preflight.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe", cwd: root });
const M = { ...require(path.join(out, "ifc-semantics", "index.js")), ...require(path.join(out, "ifc-semantics", "step-preflight.js")) }, V = require(path.join(out, "ifc-semantics", "validate.js"));
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, "manifest.json"), "utf8"));
const walk = (d, rel = "") => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "snapshots" ? [] : walk(path.join(d, e.name), rel + e.name + "/")) : e.name.endsWith(".ifc") ? [rel + e.name] : []);
let n = 0; const t = (name, fn) => { fn(); n++; };

const onDisk = walk(CORPUS).sort(), listed = manifest.files.map((f) => f.file).sort();
t("manifest lists exactly the .ifc files on disk", () => assert.deepStrictEqual(listed, onDisk));
t("at least 20 source IFC files, all kinds present", () => { assert.ok(onDisk.length >= 20, String(onDisk.length)); for (const k of ["valid", "invalid", "malformed"]) assert.ok(manifest.files.some((f) => f.kind === k), k); });
t("both schemas are covered by valid files", () => { for (const s of ["IFC4", "IFC2X3"]) assert.ok(manifest.files.filter((f) => f.kind === "valid" && f.schema === s).length >= 4, s); });
t("every entry declares source, licence, schema, purpose and expectation", () => { for (const f of manifest.files) for (const k of ["source", "licence", "schema", "purpose", "expect", "kind"]) assert.ok(f[k] !== undefined && f[k] !== "", `${f.file}: ${k}`); });
for (const f of manifest.files) {
  const bytes = fs.readFileSync(path.join(CORPUS, f.file));
  const pre = M.preflightStep(new Uint8Array(bytes));
  if (f.kind === "valid") t(`valid: ${f.file}`, () => {
    assert.ok(pre.ok, `${f.file} preflight: ${JSON.stringify(pre)}`);
    const m = M.buildSemanticModel(bytes.toString("utf8"));
    assert.strictEqual(m.schema, f.schema, "schema");
    assert.strictEqual(m.invalidGlobalIds.length, 0, "GUIDs");
    const errs = V.validateSemanticModel(m).filter((x) => x.severity === "error");
    assert.deepStrictEqual(errs.map((x) => x.code), [], "semantic errors");
    assert.ok(M.physicalElementIds(m).length >= 1, "has physical elements");
  });
  else if (f.kind === "malformed") t(`malformed: ${f.file}`, () => assert.strictEqual(pre.ok, false, "preflight must reject (web-ifc would hang)"));
  else t(`invalid: ${f.file}`, () => {
    if (f.expect.finding) assert.ok(V.validateSemanticModel(M.buildSemanticModel(bytes.toString("utf8"))).some((x) => x.code === f.expect.finding), f.expect.finding);
    else assert.strictEqual(pre.ok, false);
  });
}
console.log(`=== ifc corpus manifest: ${n} checks passed over ${onDisk.length} files ===`);
