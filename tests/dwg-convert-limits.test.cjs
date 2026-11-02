/* Converter guard-rail tests for real-world DWG files that used to blow the
 * 120s reader timeout (huge INSERT/MINSERT multiplications, oversized arrays).
 *
 * Pins the contract added after two production drawings timed out:
 *   1. MINSERT grids beyond MAX_INSERT_CELLS are truncated to one placement
 *   2. a global entity budget stops runaway INSERT expansion (injectable for tests)
 *   3. a conversion deadline stops pathological lists early (injectable for tests)
 *   4. very large blocks/hatch loops convert without hitting the JS argument
 *      limit (the old `push(...hugeArray)` threw RangeError and silently
 *      dropped the entity)
 */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "dwglimit-"));
execSync(`npx tsc src/modules/drawings/dwg-convert.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const { dwgDatabaseToDxfDocument } = require(find(out, "dwg-convert.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };

const LN = (i) => ({ type: "LINE", layer: "0", startPoint: { x: i, y: 0 }, endPoint: { x: i + 1, y: 1 } });
const mkDb = (entities, blocks = []) => ({ tables: { LAYER: { entries: [{ name: "0", colorIndex: 7 }] }, BLOCK_RECORD: { entries: blocks } }, header: {}, entities });
const ins = (name, o = {}) => ({ type: "INSERT", name, insertionPoint: { x: 0, y: 0 }, ...o });

t("MINSERT grid beyond the cell cap is placed once, not 250k times", () => {
  // 500 × 500 = 250,000 cells × 3 block entities — the old unbounded path
  // demanded 750k transformed objects from a single INSERT.
  const blk = { name: "GRID", entities: [LN(0), LN(1), LN(2)] };
  const r = dwgDatabaseToDxfDocument(mkDb([ins("GRID", { rowCount: 500, columnCount: 500, rowSpacing: 10, columnSpacing: 10 })], [blk]));
  assert.strictEqual(r.doc.entities.length, 3, "expected exactly one placement of 3 entities");
  assert.ok(Object.keys(r.doc.skipped ?? {}).some((k) => k.includes("MINSERT")), "skipped should record the truncated grid");
});

t("MINSERT grids within the cap still multiply normally", () => {
  const blk = { name: "FX", entities: [LN(0), LN(1)] };
  const r = dwgDatabaseToDxfDocument(mkDb([ins("FX", { rowCount: 2, columnCount: 3, rowSpacing: 5, columnSpacing: 5 })], [blk]));
  assert.strictEqual(r.doc.entities.length, 12, "2 rows × 3 cols × 2 entities");
});

t("entity budget stops runaway INSERT expansion and is reported", () => {
  // 3,000 inserts × 90 entities = 270k demanded, budget 5,000 -> conversion
  // must stop cleanly (and quickly) with an honest skipped note.
  const blk = { name: "HEAVY", entities: Array.from({ length: 90 }, (_, i) => LN(i)) };
  const ents = Array.from({ length: 3000 }, () => ins("HEAVY"));
  const t0 = Date.now();
  const r = dwgDatabaseToDxfDocument(mkDb(ents, [blk]), { entityBudget: 5000 });
  assert.ok(r.doc.entities.length <= 5000 + 90, `got ${r.doc.entities.length}, expected ~budget`);
  assert.ok(Date.now() - t0 < 15000, "budget conversion must not stall");
  assert.ok(Object.keys(r.doc.skipped ?? {}).some((k) => k.includes("entity budget")), "skipped should record the budget stop");
  assert.ok(r.summary.includes("entity budget"), "summary should surface the truncation");
});

t("conversion deadline returns a partial document instead of hanging", () => {
  // Deadline already in the past: the loop must bail at its first checkpoint
  // (i = 511) instead of converting all 300,000 lines.
  const ents = Array.from({ length: 300000 }, (_, i) => LN(i));
  const r = dwgDatabaseToDxfDocument(mkDb(ents), { deadlineMs: Date.now() - 1 });
  assert.ok(r.doc.entities.length < 2000, `got ${r.doc.entities.length}, expected early bail`);
  assert.ok(Object.keys(r.doc.skipped ?? {}).some((k) => k.includes("time budget")), "skipped should record the deadline stop");
});

t("oversized block content converts without RangeError (push argument limit)", () => {
  // 80k entities flowing through one DIMENSION block — the old
  // `out.push(...convertList(...))` spread threw RangeError above ~65k args
  // and the per-entity catch silently dropped the whole dimension.
  const blk = { name: "DIMPTR", entities: Array.from({ length: 80000 }, (_, i) => LN(i)) };
  const r = dwgDatabaseToDxfDocument(mkDb([{ type: "DIMENSION", name: "DIMPTR", layer: "0" }], [blk]));
  assert.strictEqual(r.doc.entities.length, 80000, "all 80k entities must survive");
});

t("oversized hatch boundary converts without RangeError", () => {
  const verts = Array.from({ length: 80000 }, (_, i) => ({ x: i, y: i % 7 }));
  const r = dwgDatabaseToDxfDocument(mkDb([{ type: "HATCH", layer: "0", boundaryPaths: [{ polylineVertices: verts }] }]));
  assert.strictEqual(r.doc.entities.length, 1, "hatch becomes one polyline");
  assert.strictEqual(r.doc.entities[0].points.length >= 79000, true, "boundary points preserved");
});

t("normal drawings are unaffected by the guard rails", () => {
  const blk = { name: "SMALL", entities: [LN(0)] };
  const ents = Array.from({ length: 500 }, (_, i) => ins("SMALL", { insertionPoint: { x: i, y: 0 } }));
  const r = dwgDatabaseToDxfDocument(mkDb(ents, [blk]));
  assert.strictEqual(r.doc.entities.length, 500);
  assert.strictEqual(r.doc.skipped, undefined, "no guard-rail notes for well-behaved files");
});

console.log(`dwg-convert-limits: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
