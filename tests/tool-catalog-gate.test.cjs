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
t("concrete dynamic:true entry without a registration fails", () => { const r = run(mk([E("a.one"), E("table.x", { dynamic: true })], { "src/a.ts": reg("a.one") })); assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /"dynamic": true on a concrete id/); });
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

// --- #102: dynamic registrations are gate-enforced, not documented-only ---
const tableLoop = (rows) => `const cmds = [\n${rows.map(([id, label]) => `  ["${id}", "${label}", "C", () => {}],`).join("\n")}\n];\nfor (const [id, label, category, run] of cmds) registerCommand({ id, label, category, run });\n`;
t("unregistered dynamic command (table loop) fails the gate", () => {
  // catalog has dyn.one but the loop also registers dyn.two
  const r = run(mk([E("a.one"), E("dyn.one")], { "src/a.ts": reg("a.one") + tableLoop([["dyn.one", "One"], ["dyn.two", "Two"]]) }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /not in catalog: dyn\.two/);
});
t("dynamic command in the catalog passes", () => {
  assert.strictEqual(run(mk([E("a.one"), E("dyn.one"), E("dyn.two")], { "src/a.ts": reg("a.one") + tableLoop([["dyn.one", "One"], ["dyn.two", "Two"]]) })).status, 0);
});
t("duplicate dynamic id across files fails", () => {
  const r = run(mk([E("dyn.one")], { "src/a.ts": tableLoop([["dyn.one", "One"]]), "src/b.ts": tableLoop([["dyn.one", "One again"]]) }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /registered 2×.*dyn\.one/s);
});
t("template-prefix dynamic ids are enumerated (helper call sites)", () => {
  const src = `function tool(name, id) { registerCommand({ id: "tool." + id, label: name, category: "T", run: () => {} }); }\ntool("Wall", "wall");\ntool("Slab", "slab");\n`;
  assert.strictEqual(run(mk([E("tool.wall"), E("tool.slab")], { "src/a.ts": src })).status, 0);
  const r = run(mk([E("tool.wall")], { "src/a.ts": src }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /not in catalog: tool\.slab/);
});
t("unresolved dynamic registration site fails the gate", () => {
  const r = run(mk([E("a.one")], { "src/a.ts": reg("a.one") + `registerCommand({ id: someVar, label: "X", category: "C", run: () => {} });\n` }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /unresolved dynamic registration site/);
});
const dataDriven = `for (const s of listScenarios()) registerCommand({ id: "clash.scenario." + s.id, label: s.name, category: "C", run: () => {} });\n`;
t("data-driven template without a pattern entry fails; with one it passes", () => {
  const r = run(mk([E("a.one")], { "src/a.ts": reg("a.one") + dataDriven }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /dynamic template has no catalog pattern entry: clash\.scenario\.\*/);
  assert.strictEqual(run(mk([E("a.one"), E("clash.scenario.*", { dynamic: true, name: "Dynamic commands (clash.scenario.*)" })], { "src/a.ts": reg("a.one") + dataDriven })).status, 0);
});
t("dead pattern entry fails", () => {
  const r = run(mk([E("a.one"), E("ghost.*", { dynamic: true })], { "src/a.ts": reg("a.one") }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /dead pattern/);
});
t("prefix-concat template is a pattern, not a literal phantom id", () => {
  const src = `for (const lv of levels.list()) registerCommand({ id: "level.activate." + lv.id, label: lv.name, category: "C", run: () => {} });\n`;
  // pattern entry alone is enough — the gate must NOT demand a literal "level.activate." entry
  assert.strictEqual(run(mk([E("level.activate.*", { dynamic: true })], { "src/a.ts": src })).status, 0);
  // ...and a literal "level.activate." entry is dead (no such command exists)
  const r = run(mk([E("level.activate.")], { "src/a.ts": src }));
  assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /dead entry/);
});
t("REAL repository catalog is consistent", () => { const r = spawnSync(process.execPath, [script], { encoding: "utf8" }); assert.strictEqual(r.status, 0, r.stderr); });
t("REAL repository counts are pinned (gate sees every registration)", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  // 616 registered commands: 477 with a literal id at the call site (incl.
  // table rows resolved from literal tables) + 139 resolved through
  // indirection (bridge tables, BimCommand catalog, modify map,
  // fallback-chain tables). 619 catalog entries incl. 3 pattern entries
  // for the data-driven templates (clash.scenario.*, level.activate.*,
  // schedule.saved.*). 0 unresolved dynamic sites.
  assert.match(r.stdout, /616 registered commands \(477 literal \+ 139 dynamic\)/);
  assert.match(r.stdout, /619 catalog entries \(3 pattern\)/);
  assert.match(r.stdout, /0 unresolved dynamic site\(s\)/);
});
console.log(`=== tool catalog gate: ${n} passed ===`);
