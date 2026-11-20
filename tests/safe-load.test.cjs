const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-safe-load-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execFileSync("npx", ["tsc", "src/core/safeLoad.ts", "src/modules/projects/project-file.ts", "--outDir", out, "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--skipLibCheck", "--noCheck"], { cwd: root, stdio: "inherit", env: { ...process.env, NODE_PATH: path.join(root, "node_modules") } });
const safe = require(path.join(out, "core", "safeLoad.js"));
const file = require(path.join(out, "modules", "projects", "project-file.js"));
const z = require("zod");
let pass = 0;
function t(name, fn) { fn(); pass++; console.log("  PASS " + name); }

t("safeLoad returns typed parse failures without throwing", () => {
  const r = safe.safeLoad("bad.json", "{", z.object({ ok: z.boolean() }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.stage, "parse");
  assert.match(r.error.issues[0], /Unexpected|JSON/);
});
t("safeLoad returns path-aware schema failures", () => {
  const r = safe.safeLoad("bad.json", JSON.stringify({ ok: "yes" }), z.object({ ok: z.boolean() }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.stage, "schema");
  assert.match(r.error.issues[0], /ok/);
});
t("safeLoad rejects oversized JSON before parsing", () => {
  const r = safe.safeLoad("large.json", JSON.stringify({ value: "123456" }), z.object({ value: z.string() }), 8);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.stage, "size");
});
t("saved-view schema rejects malformed camera data and caps the list", () => {
  const valid = { id: "v1", name: "Plan", pos: [0, 1, 2], target: [0, 0, 0], projection: "perspective", createdAt: 1 };
  assert.strictEqual(safe.safeLoad("saved views", JSON.stringify([valid]), safe.SavedViewsSchema).ok, true);
  const bad = safe.safeLoad("saved views", JSON.stringify([{ ...valid, pos: [0, "bad", 2] }]), safe.SavedViewsSchema);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error.stage, "schema");
  assert.strictEqual(safe.safeLoad("saved views", JSON.stringify(Array.from({ length: 65 }, () => valid)), safe.SavedViewsSchema).ok, false);
});
t("saved-view feature routes localStorage JSON through safeLoad", () => {
  const source = fs.readFileSync(path.join(root, "src/features/saved-views.ts"), "utf8");
  assert.match(source, /safeLoad\("saved views"/);
  assert.match(source, /SavedViewsSchema/);
});
t("legacy project JSON import routes text through safeLoad before storage", () => {
  const source = fs.readFileSync(path.join(root, "src/features/file-interop.ts"), "utf8");
  assert.match(source, /safeLoad\("legacy project JSON"/);
  assert.doesNotMatch(source, /const doc = JSON\.parse\(text\)/);
  assert.ok(source.indexOf("file.size > 20 * 1024 * 1024") < source.indexOf("await file.text()"), "size must be checked before reading the file");
  assert.ok(source.includes("LegacyProjectJsonSchema"), "all project JSON import routes share the same schema");
});
t("LibreDWG JSON dump import is bounded and schema-gated", () => {
  const source = fs.readFileSync(path.join(root, "src/features/libredwg-toolkit.ts"), "utf8");
  assert.match(source, /safeLoad\(/);
  assert.match(source, /entities: z\.array/);
  assert.doesNotMatch(source, /JSON\.parse\(await file\.text\(\)\)/);
});
t("project parser rejects a structurally invalid header through the safe loader", async () => {
  const header = JSON.stringify({ format: "obsproj", version: 1, savedAt: Date.now(), app: "Open BIM Studio", doc: {}, blobs: [{ modelId: "m1", name: "m.ifc", size: "5", type: "" }] });
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, new TextEncoder().encode(header).length, true);
  await assert.rejects(() => file.parseProjectFile(new Blob(["OBSPROJ1", len, header])), /invalid header|schema/);
});
t("safeLoad rejects deeply nested JSON without recursive traversal", () => {
  const nested = "[".repeat(80) + "0" + "]".repeat(80);
  const r = safe.safeLoad("deep.json", nested, z.unknown(), 1024, { maxDepth: 32, maxNodes: 1000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.stage, "complexity");
});
t("safeLoad rejects excessive JSON node counts", () => {
  const r = safe.safeLoad("wide.json", JSON.stringify(Array.from({ length: 100 }, () => 0)), z.unknown(), 4096, { maxNodes: 50 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.stage, "complexity");
});
t("legacy project JSON schema requires a usable id and bounded elements array", () => {
  assert.strictEqual(safe.safeLoad("project.json", JSON.stringify({ id: "p1", elements: [] }), safe.LegacyProjectJsonSchema).ok, true);
  assert.strictEqual(safe.safeLoad("project.json", JSON.stringify({ id: "", elements: [] }), safe.LegacyProjectJsonSchema).ok, false);
  assert.strictEqual(safe.safeLoad("project.json", JSON.stringify({ id: "p1", elements: {} }), safe.LegacyProjectJsonSchema).ok, false);
});
t("clash scenario import schema accepts only bounded array envelopes", () => {
  assert.strictEqual(safe.safeLoad("scenarios.json", JSON.stringify({ scenarios: [] }), safe.ClashScenarioImportSchema).ok, true);
  assert.strictEqual(safe.safeLoad("scenarios.json", JSON.stringify({ scenarios: "bad" }), safe.ClashScenarioImportSchema).ok, false);
});
t("legacy project and clash scenario File.text imports use safeLoad before mutation", () => {
  const menu = fs.readFileSync(path.join(root, "src/shell/file-menu.ts"), "utf8");
  const clash = fs.readFileSync(path.join(root, "src/features/clash.ts"), "utf8");
  assert.match(menu, /safeLoad\(f\.name, await f\.text\(\), LegacyProjectJsonSchema/);
  assert.match(menu, /if \(f\.size > 20 \* 1024 \* 1024\)/);
  assert.match(clash, /safeLoad\(file\.name, await file\.text\(\), ClashScenarioImportSchema/);
  assert.match(clash, /if \(file\.size > 2 \* 1024 \* 1024\)/);
  assert.doesNotMatch(menu, /JSON\.parse\(await f\.text\(\)\)/);
  assert.doesNotMatch(clash, /JSON\.parse\(text\)/);
  assert.ok(menu.indexOf("safeLoad(f.name") < menu.indexOf("store.putProject(parsed.doc)"), "project state must not mutate before validation");
  assert.ok(clash.indexOf("safeLoad(file.name") < clash.indexOf("persistScenarios([...byId.values()]"), "scenario state must not mutate before validation");
});
t("safe-load coverage audit includes shell and rejects assigned File.text bypasses", () => {
  const audit = fs.readFileSync(path.join(root, "scripts/check-safe-load-coverage.mjs"), "utf8");
  assert.match(audit, /src\/shell\/file-menu\.ts/);
  assert.match(audit, /src\/features\/clash\.ts/);
  assert.match(audit, /textAssignment/);
  assert.match(audit, /sourceRoots = \["src"\]/);
});

t("10 malformed import fixtures are rejected before any importer can consume them", () => {
  const dir = path.join(root, "tests/fixtures/malformed");
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  assert.strictEqual(names.length, 10, "malformed fixture corpus must contain exactly 10 named cases");
  const schemaFor = (name) => {
    if (name === "07-wrong-project-envelope.json") return safe.ProjectFileSchema;
    if (name === "10-wrong-scenarios-envelope.json") return safe.ClashScenarioImportSchema;
    return safe.LegacyProjectJsonSchema;
  };
  for (const name of names) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    const limits = name === "08-deeply-nested.json" ? { maxDepth: 32, maxNodes: 5000 } : {};
    const maxBytes = name === "09-oversized.json" ? 512 : 20 * 1024 * 1024;
    const result = safe.safeLoad(name, raw, schemaFor(name), maxBytes, limits);
    assert.strictEqual(result.ok, false, name + " must be rejected");
  }
});

(async () => {
  const doc = { id: "p", name: "P", createdAt: 1, updatedAt: 1, elements: [], models: [] };
  const blob = file.buildProjectFile(doc, [{ modelId: "m", name: "m.ifc", blob: new Blob(["abc"]) }]);
  const parsed = await file.parseProjectFile(blob);
  assert.strictEqual(parsed.blobs[0].blob.size, 3);
  console.log("  PASS valid project files still round-trip");
  console.log(`=== Result: ${pass + 1} passed, 0 failed ===`);
})().catch((e) => { console.error(e); process.exit(1); });
