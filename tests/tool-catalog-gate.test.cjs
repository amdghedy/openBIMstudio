const { spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert");
const script = path.join(__dirname, "..", "scripts", "check-tool-catalog.mjs");
function mk(tools, files) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cat-"));
  fs.mkdirSync(path.join(r, "documentation"), { recursive: true }); fs.mkdirSync(path.join(r, "src"), { recursive: true }); fs.mkdirSync(path.join(r, "tests"), { recursive: true });
  fs.writeFileSync(path.join(r, "documentation", "tool-catalog.json"), typeof tools === "string" ? tools : JSON.stringify({ tools }));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), c); }
  return r;
}
const run = (r) => spawnSync(process.execPath, [script], { env: { ...process.env, OBS_CATALOG_ROOT: r }, encoding: "utf8" });
const reg = (id, label = "L", cat = "C") => `registerCommand({ id: "${id}", label: "${label}", category: "${cat}", run: () => {} });\n`;
const E = (id, o = {}) => ({ id, name: id, discipline: "D", module: "src/a.ts", status: "unverified", ...o });
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  PASS", name); };
const good = () => mk([E("a.one")], { "src/a.ts": reg("a.one") });

t("consistent catalog passes", () => assert.strictEqual(run(good()).status, 0));
t("uncatalogued registered command fails", () => { const r = run(mk([E("a.one")], { "src/a.ts": reg("a.one") + reg("a.two") })); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /not in catalog: a\.two/); });
t("dead catalog entry fails", () => { const r = run(mk([E("a.one"), E("ghost")], { "src/a.ts": reg("a.one") })); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /dead entry/); });
t("dynamic:true entry is allowed", () => assert.strictEqual(run(mk([E("a.one"), E("table.x", { dynamic: true })], { "src/a.ts": reg("a.one") })).status, 0));
t("duplicate catalog id fails", () => assert.notStrictEqual(run(mk([E("a.one"), E("a.one")], { "src/a.ts": reg("a.one") })).status, 0));
t("duplicate registration across files fails", () => { const r = run(mk([E("a.one")], { "src/a.ts": reg("a.one"), "src/b.ts": reg("a.one") })); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /registered 2×/); });
t("tested without tests fails; with missing file fails; with real file passes", () => {
  assert.notStrictEqual(run(mk([E("a.one", { status: "tested" })], { "src/a.ts": reg("a.one") })).status, 0);
  assert.notStrictEqual(run(mk([E("a.one", { status: "tested", tests: ["tests/nope.cjs"] })], { "src/a.ts": reg("a.one") })).status, 0);
  assert.strictEqual(run(mk([E("a.one", { status: "tested", tests: ["tests/x.cjs"] })], { "src/a.ts": reg("a.one"), "tests/x.cjs": "" })).status, 0);
});
t("partial/experimental need knownLimitation", () => { for (const s of ["partial", "experimental"]) { assert.notStrictEqual(run(mk([E("a.one", { status: s })], { "src/a.ts": reg("a.one") })).status, 0); assert.strictEqual(run(mk([E("a.one", { status: s, knownLimitation: "x" })], { "src/a.ts": reg("a.one") })).status, 0); } });
t("invalid status, missing module file, missing discipline fail", () => {
  assert.notStrictEqual(run(mk([E("a.one", { status: "verified" })], { "src/a.ts": reg("a.one") })).status, 0);
  assert.notStrictEqual(run(mk([E("a.one", { module: "src/zz.ts" })], { "src/a.ts": reg("a.one") })).status, 0);
  assert.notStrictEqual(run(mk([{ ...E("a.one"), discipline: undefined }], { "src/a.ts": reg("a.one") })).status, 0);
});
t("malformed catalog JSON fails", () => assert.notStrictEqual(run(mk("{", { "src/a.ts": reg("a.one") })).status, 0));
t("REAL repository catalog is consistent", () => { const r = spawnSync(process.execPath, [script], { encoding: "utf8" }); assert.strictEqual(r.status, 0, r.stderr); });
console.log(`=== tool catalog gate: ${n} passed ===`);
