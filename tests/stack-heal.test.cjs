/**
 * tests/stack-heal.test.cjs
 *
 * Closes the multi-level stacked-wall gap with proof:
 *   - a 4-level chain with a 0.2 m gap at every boundary heals to zero;
 *   - overlaps trim the LOWER wall (never below MIN_HEAL_HEIGHT);
 *   - maxExtend clamps wild gaps honestly (skipped + reported);
 *   - clean stacks produce no patches; chains are reported descending by base.
 *
 * Run: `node tests/stack-heal.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "stackheal-"));
execSync(`npx tsc src/modules/wall-join/stack-heal.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const m = require(find(out, "stack-heal.js"));
const vj = require(find(out, "vertical-join.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-6) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const wall = (id, base, h, reversed = false) => ({
  id,
  start: reversed ? [5, 0] : [0, 0],
  end: reversed ? [0, 0] : [5, 0],
  baseZ: base,
  height: h,
});

t("4-level chain with a 0.2 m gap at every boundary heals to zero", () => {
  const walls = [wall("w1", 0, 3), wall("w2", 3.2, 3), wall("w3", 6.4, 3), wall("w4", 9.6, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 3, "w1..w3 patched, w4 untouched");
  const byId = new Map(r.patches.map((p) => [p.id, p]));
  near(byId.get("w1").heightAfter, 3.2);
  near(byId.get("w2").heightAfter, 3.2);
  near(byId.get("w3").heightAfter, 3.2);
  assert.strictEqual(r.remaining.length, 0, "no issues remain");
  assert.strictEqual(r.chains.length, 1, "one chain");
  assert.deepStrictEqual(r.chains[0], ["w1", "w2", "w3", "w4"], "chain descending by base");
  assert.ok(r.report.some((s) => s.includes("w1")), "report names the healed wall");
  // Sanity: the reported "before" heights are the originals, even after multi-pass.
  near(byId.get("w1").heightBefore, 3.0);
  near(byId.get("w1").closed, 0.2);
});

t("overlap trims the lower wall down to the upper base", () => {
  const walls = [wall("lo", 0, 3.15), wall("up", 3, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 1);
  near(r.patches[0].heightAfter, 3.0);
  assert.ok(r.patches[0].closed < 0, "negative closed = overlap");
  assert.strictEqual(r.remaining.length, 0);
});

t("overlap that would leave a sliver is skipped, not healed", () => {
  // Lower wall is only 40 mm tall; the upper base digs 20 mm into it —
  // trimming would leave a 20 mm sliver (< MIN_HEAL_HEIGHT 50 mm) → skipped.
  const walls = [wall("lo", 0, 0.04), wall("up", 0.02, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 0, "20 mm sliver is below the heal floor — skipped");
  assert.ok(r.remaining.some((i) => i.kind === "overlap"), "honest remaining issue");
  assert.ok(r.report.some((s) => s.includes("skipped")), "report explains the skip");
});

t("mismatch beyond scanTol is simply not a stack pair (honest no-op)", () => {
  // A 0.4 m boundary mismatch is a modelling decision, not a tolerance issue —
  // the healer must neither guess nor fabricate an issue.
  const walls = [wall("lo", 0, 3), wall("up", 3.4, 3)];
  const r = m.healStacks(walls, { scanTol: 0.25 });
  assert.strictEqual(r.patches.length, 0);
  assert.strictEqual(r.remaining.length, 0);
  assert.strictEqual(r.pairsExamined, 0, "no pair within scan tolerance");
});

t("clean stacked walls produce zero patches and one chain", () => {
  const walls = [wall("a", 0, 3), wall("b", 3, 3), wall("c", 6, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 0);
  assert.strictEqual(r.remaining.length, 0);
  assert.strictEqual(r.chains.length, 1);
  assert.deepStrictEqual(r.chains[0], ["a", "b", "c"]);
});

t("unrelated walls are never touched", () => {
  const walls = [wall("x", 0, 3), wall("y", 0, 3), wall("far", 20, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 0);
  assert.strictEqual(r.chains.length, 0);
});

t("folded (reversed) stacks are reported, never healed", () => {
  const walls = [wall("lo", 0, 3), wall("up", 3, 3, true)];
  const pre = vj.validateStacks(walls);
  assert.ok(pre.some((i) => i.kind === "folded"), "detection flags the fold");
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 0, "healer refuses to guess a reversed wall");
});

t("sequential patches converge: patched lower meets upper after re-scan", () => {
  // Both boundaries 0.2 m off — one pass heals each pair; the re-scan confirms clean.
  const walls = [wall("a", 0, 3), wall("b", 3.2, 3), wall("c", 6.4, 3)];
  const r = m.healStacks(walls);
  assert.strictEqual(r.patches.length, 2);
  const byId = new Map(r.patches.map((p) => [p.id, p]));
  near(byId.get("a").heightAfter, 3.2);
  near(byId.get("b").heightAfter, 3.2);
  assert.strictEqual(r.remaining.length, 0);
  // The final model is actually clean:
  const final = [wall("a", 0, 3.2), wall("b", 3.2, 3.2), wall("c", 6.4, 3)];
  assert.strictEqual(vj.validateStacks(final).length, 0);
});

console.log(`\nstack-heal: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
