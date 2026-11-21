/* The budget gate must fail closed: missing/malformed/non-finite measurements → non-zero exit. */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), assert = require("node:assert");
const script = path.join(__dirname, "..", "bench", "check-budgets.mjs");
function mk({ dist, browser, node, budget } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "obs-bud-"));
  fs.mkdirSync(path.join(r, "scripts"), { recursive: true }); fs.mkdirSync(path.join(r, "bench", "results"), { recursive: true });
  fs.writeFileSync(path.join(r, "scripts", "budget.json"), budget ?? JSON.stringify({ import: { maxSeconds: 60, maxPeakMB: 1500 }, bundle: { maxMainJsKB: 10 } }));
  if (dist !== undefined) { fs.mkdirSync(path.join(r, "dist", "assets"), { recursive: true }); if (dist) fs.writeFileSync(path.join(r, "dist", "assets", "index-abc.js"), "x".repeat(dist)); }
  if (browser !== undefined) fs.writeFileSync(path.join(r, "bench", "results", "browser-after.json"), typeof browser === "string" ? browser : JSON.stringify(browser));
  if (node !== undefined) fs.writeFileSync(path.join(r, "bench", "results", "node-after.json"), typeof node === "string" ? node : JSON.stringify(node));
  return r;
}
const run = (root, ...args) => spawnSync(process.execPath, [script, ...args], { env: { ...process.env, OBS_BENCH_ROOT: root }, encoding: "utf8" });
const B = (ms, heap) => ({ suites: { "ifc-load": { large: { loadTotalMs: ms, heapAfterMB: heap } } } });
const N = (ms) => ({ suites: { "ifc-parse": { large: { parseMs: { median: ms } } } } });
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  PASS", name); };

t("missing dist fails when bundle is required (default)", () => assert.notStrictEqual(run(mk()).status, 0));
t("bundle within budget passes", () => assert.strictEqual(run(mk({ dist: 2048 })).status, 0));
t("bundle over budget fails", () => assert.notStrictEqual(run(mk({ dist: 20000 })).status, 0));
t("dist without a main chunk fails", () => assert.notStrictEqual(run(mk({ dist: 0 })).status, 0));
t("missing browser results fail when import required", () => assert.notStrictEqual(run(mk({ dist: 2048 }), "--require", "bundle,import").status, 0));
t("missing node results fail when node required", () => assert.notStrictEqual(run(mk({ dist: 2048 }), "--require", "bundle,node").status, 0));
t("not-required missing input is a visible skip, not a failure", () => { const r = run(mk({ dist: 2048 })); assert.strictEqual(r.status, 0); assert.match(r.stderr, /SKIPPED import/); });
t("malformed browser JSON fails safely", () => assert.notStrictEqual(run(mk({ dist: 2048, browser: "{oops" }), "--require", "bundle,import").status, 0));
t("no large entry fails when required", () => assert.notStrictEqual(run(mk({ dist: 2048, browser: { suites: {} } }), "--require", "bundle,import").status, 0));
t("non-finite / negative metrics fail", () => { for (const bad of [null, -5, 0, "12", NaN]) assert.notStrictEqual(run(mk({ dist: 2048, browser: B(bad, 100) }), "--require", "bundle,import").status, 0, String(bad)); });
t("missing heap measurement fails when required", () => assert.notStrictEqual(run(mk({ dist: 2048, browser: B(1000, null) }), "--require", "bundle,import").status, 0));
t("import over time budget fails", () => assert.notStrictEqual(run(mk({ dist: 2048, browser: B(90000, 100) }), "--require", "bundle,import").status, 0));
t("import over heap budget fails", () => assert.notStrictEqual(run(mk({ dist: 2048, browser: B(1000, 5000) }), "--require", "bundle,import").status, 0));
t("good browser + node results pass when all required", () => assert.strictEqual(run(mk({ dist: 2048, browser: B(1000, 100), node: N(2000) }), "--require", "bundle,import,node").status, 0));
t("node parse over budget fails", () => assert.notStrictEqual(run(mk({ dist: 2048, node: N(120000) }), "--require", "bundle,node").status, 0));
t("malformed budget.json fails", () => assert.notStrictEqual(run(mk({ dist: 2048, budget: "{" })).status, 0));
console.log(`=== perf budget gate: ${n} passed ===`);
