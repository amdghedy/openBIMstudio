/* Phase 5: incremental spatial-index append must be query-equivalent to a full rebuild. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "idxapp-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/cad-viewer/viewer-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const M = require(find(out, "viewer-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
let seed = 7; const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const mkLine = () => { const x = r() * 900 + 50, y = r() * 900 + 50; return { type: "LINE", layer: "0", start: { x, y }, end: { x: x + r() * 30, y: y + r() * 30 } }; };
const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
t("append within the frame equals a full rebuild for box and point queries", () => {
  const ents = Array.from({ length: 2000 }, mkLine); const idx = M.buildIndex(ents, bounds);
  const add = Array.from({ length: 300 }, mkLine); const from = ents.length; ents.push(...add);
  assert.strictEqual(M.indexAppend(idx, ents, from), true);
  const ref = M.buildIndex(ents, bounds);
  for (let k = 0; k < 200; k++) {
    const x = r() * 900, y = r() * 900, box = { minX: x, minY: y, maxX: x + 80, maxY: y + 80 };
    assert.deepStrictEqual(M.queryIndexBox(idx, ents, box), M.queryIndexBox(ref, ents, box));
    assert.deepStrictEqual(M.queryIndex(idx, x, y, 6).sort((a, b) => a - b), M.queryIndex(ref, x, y, 6).sort((a, b) => a - b));
  }
});
t("an entity outside the frame makes append refuse (caller rebuilds) and leaves the index untouched", () => {
  const ents = Array.from({ length: 50 }, mkLine); const idx = M.buildIndex(ents, bounds); const before = idx.boxes.length;
  ents.push({ type: "LINE", layer: "0", start: { x: -500, y: 0 }, end: { x: -400, y: 10 } });
  assert.strictEqual(M.indexAppend(idx, ents, 50), false); assert.strictEqual(idx.boxes.length, before);
});
t("append refuses when the index is not in sync with the list (stale `from`)", () => {
  const ents = Array.from({ length: 10 }, mkLine); const idx = M.buildIndex(ents, bounds); ents.push(mkLine());
  assert.strictEqual(M.indexAppend(idx, ents, 5), false);
});
t("rays stay in the infinite list; large entities go to the big list", () => {
  const ents = Array.from({ length: 10 }, mkLine); const idx = M.buildIndex(ents, bounds);
  ents.push({ type: "LINE", layer: "0", start: { x: 1, y: 1 }, end: { x: 990, y: 990 } });
  assert.strictEqual(M.indexAppend(idx, ents, 10), true); assert.ok(idx.big.includes(10));
});
t("extendBounds: first geometry replaces the blank-drawing placeholder, later geometry unions", () => {
  const ph = { minX: 0, minY: 0, maxX: 100, maxY: 100 }, a = { minX: 0, minY: 0, maxX: 10, maxY: 4 }, b = { minX: 20, minY: -5, maxX: 30, maxY: 1 };
  assert.deepStrictEqual(M.extendBounds(ph, true, a), a);
  assert.deepStrictEqual(M.extendBounds(null, false, a), a);
  assert.deepStrictEqual(M.extendBounds(a, false, b), { minX: 0, minY: -5, maxX: 30, maxY: 4 });
});
console.log(`\ncad-index-append: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
