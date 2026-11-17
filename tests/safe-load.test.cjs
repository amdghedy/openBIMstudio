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
});
t("project parser rejects a structurally invalid header through the safe loader", async () => {
  const header = JSON.stringify({ format: "obsproj", version: 1, savedAt: Date.now(), app: "Open BIM Studio", doc: {}, blobs: [{ modelId: "m1", name: "m.ifc", size: "5", type: "" }] });
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, new TextEncoder().encode(header).length, true);
  await assert.rejects(() => file.parseProjectFile(new Blob(["OBSPROJ1", len, header])), /invalid header|schema/);
});
(async () => {
  const doc = { id: "p", name: "P", createdAt: 1, updatedAt: 1, elements: [], models: [] };
  const blob = file.buildProjectFile(doc, [{ modelId: "m", name: "m.ifc", blob: new Blob(["abc"]) }]);
  const parsed = await file.parseProjectFile(blob);
  assert.strictEqual(parsed.blobs[0].blob.size, 3);
  console.log("  PASS valid project files still round-trip");
  console.log(`=== Result: ${pass + 1} passed, 0 failed ===`);
})().catch((e) => { console.error(e); process.exit(1); });
