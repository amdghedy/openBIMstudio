/**
 * Plan temporary dimensions (Revit G13) — node tests.
 *
 * Asserts the pure plan-temp-dim geometry in src/features/plan-temp-dimensions.ts:
 * selecting an element in plan produces temp dims to the nearest references,
 * and editing a temp-dim value drives the element (move / resize).
 *
 * The module is dependency-free, so it is compiled standalone with tsc and
 * required — the same pattern as tests/plan-dim-geometry.test.cjs.
 * Sensitivity: this test FAILS on the unmodified tree because
 * src/features/plan-temp-dimensions.ts does not exist there (tsc cannot
 * compile it), and PASSES with the G13 change.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const ROOT = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ptd-"));
execSync(
  `npx tsc src/features/plan-temp-dimensions.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "plan-temp-dimensions.js"));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearPt = (p, x, z) => { near(p[0], x); near(p[1], z); };

const wall = (id, sx, sz, ex, ez, extra = {}) => ({
  id, type: "wall", name: `Wall ${id}`,
  params: { start: [sx, sz], end: [ex, ez], height: 3, thickness: 0.2, ...extra },
});
const column = (id, x, z, w = 0.4) => ({
  id, type: "column", name: `Column ${id}`,
  params: { point: [x, z], width: w, depth: w, height: 3 },
});

// Fixture: A (0..4, z=0), B (6..10, z=0) collinear, C (6..10, z=3) parallel.
const A = wall("A", 0, 0, 4, 0);
const B = wall("B", 6, 0, 10, 0);
const C = wall("C", 6, 3, 10, 3);

t("selecting a wall shows its own length", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const len = dims.find((d) => d.param === "length");
  assert.ok(len, "length dim missing");
  near(len.value, 4);
  assert.strictEqual(len.label, "4.000 m");
  assert.strictEqual(len.editable, true);
});

t("selecting a wall shows the gap to the nearest collinear reference at its start", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const gap = dims.find((d) => d.param === "gapStart");
  assert.ok(gap, "gapStart dim missing");
  near(gap.value, 2); // A ends at x=4, B starts at x=6
  assert.strictEqual(gap.refId, "A");
  near(gap.a.x, 4); near(gap.a.z, 0); // witness on the reference
  near(gap.b.x, 6); near(gap.b.z, 0); // witness on the selected end
});

t("no gap dim past an end with no reference beyond it", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  assert.strictEqual(dims.find((d) => d.param === "gapEnd"), undefined);
});

t("selecting a wall shows the perpendicular gap to the nearest parallel wall", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const gap = dims.find((d) => d.param === "gapPerp");
  assert.ok(gap, "gapPerp dim missing");
  near(gap.value, 3);
  assert.strictEqual(gap.refId, "C");
});

t("a lone wall shows only its length (no references, no invented dims)", () => {
  const dims = m.computePlanTempDims(B, []);
  assert.strictEqual(dims.length, 1);
  assert.strictEqual(dims[0].param, "length");
});

t("a shared corner is not a dimension (coincident reference skipped)", () => {
  const D = wall("D", 10, 0, 10, 4); // touches B's end
  const dims = m.computePlanTempDims(B, [A, C, D]);
  assert.strictEqual(dims.find((d) => d.param === "gapEnd"), undefined);
});

t("editing the start gap resizes the wall (other end fixed)", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const gap = dims.find((d) => d.param === "gapStart");
  const r = m.applyPlanTempDimEdit(B, gap, 3);
  assert.ok(r, "gap edit rejected");
  nearPt(r.start, 7, 0); // 3 m from A's end at x=4
  nearPt(r.end, 10, 0); // far end unmoved
});

t("editing the perpendicular gap moves the whole wall", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const gap = dims.find((d) => d.param === "gapPerp");
  const r = m.applyPlanTempDimEdit(B, gap, 4);
  assert.ok(r, "gap edit rejected");
  nearPt(r.start, 6, -1); // away from C (z=3), gap 3 -> 4
  nearPt(r.end, 10, -1);
});

t("editing the length keeps the right end fixed (same rule as 3D temp dims)", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const len = dims.find((d) => d.param === "length");
  const r = m.applyPlanTempDimEdit(B, len, 5);
  assert.ok(r, "length edit rejected");
  nearPt(r.end, 10, 0); // right end fixed
  nearPt(r.start, 5, 0);
});

t("editing the end gap moves only that end", () => {
  // Wall E (0..4) with a reference F starting at x=6 on the same axis.
  const E = wall("E", 0, 0, 4, 0);
  const F = wall("F", 6, 0, 9, 0);
  const dims = m.computePlanTempDims(E, [F]);
  const gap = dims.find((d) => d.param === "gapEnd");
  assert.ok(gap, "gapEnd dim missing");
  near(gap.value, 2);
  const r = m.applyPlanTempDimEdit(E, gap, 1);
  nearPt(r.start, 0, 0);
  nearPt(r.end, 5, 0); // end moves toward F
});

t("a point element shows its width and the gap to the nearest reference", () => {
  const col = column("K", 2, 2);
  const dims = m.computePlanTempDims(col, [A, B]);
  const w = dims.find((d) => d.param === "width");
  assert.ok(w, "width dim missing");
  near(w.value, 0.4);
  const gap = dims.find((d) => d.param === "gapPoint");
  assert.ok(gap, "gapPoint dim missing");
  // Nearest reference point is A's start (0,0) / end (4,0), both 2.828 m away.
  near(gap.value, Math.hypot(2, 2));
});

t("editing the point gap moves the whole point element", () => {
  const col = column("K", 2, 2);
  const dims = m.computePlanTempDims(col, [A, B]);
  const gap = dims.find((d) => d.param === "gapPoint");
  const before = gap.value;
  const r = m.applyPlanTempDimEdit(col, gap, before + 1);
  assert.ok(r, "gap edit rejected");
  // Moves 1 m further from the reference along the same direction.
  const dir = { x: (2 - gap.a.x) / before, z: (2 - gap.a.z) / before };
  near(r.point[0], 2 + dir.x, 1e-9);
  near(r.point[1], 2 + dir.z, 1e-9);
});

t("invalid edits are rejected, not applied", () => {
  const dims = m.computePlanTempDims(B, [A, C]);
  const len = dims.find((d) => d.param === "length");
  assert.strictEqual(m.applyPlanTempDimEdit(B, len, 0), null);
  assert.strictEqual(m.applyPlanTempDimEdit(B, len, -1), null);
  assert.strictEqual(m.applyPlanTempDimEdit(B, len, NaN), null);
  const gap = dims.find((d) => d.param === "gapStart");
  // Moving the start onto (or past) the far end would collapse the wall.
  assert.strictEqual(m.applyPlanTempDimEdit(B, gap, 6), null);
});

t("dimension input parses what the label shows", () => {
  assert.strictEqual(m.parsePlanTempDimInput("4.000 m"), 4);
  assert.strictEqual(m.parsePlanTempDimInput("200 mm"), 0.2);
  assert.strictEqual(m.parsePlanTempDimInput("35 cm"), 0.35);
  assert.strictEqual(m.parsePlanTempDimInput("2.5"), 2.5);
  assert.strictEqual(m.parsePlanTempDimInput("0 m"), 0);
  assert.strictEqual(m.parsePlanTempDimInput("abc"), null);
  assert.strictEqual(m.parsePlanTempDimInput(""), null);
  assert.strictEqual(m.parsePlanTempDimInput("-1 m"), null);
  assert.strictEqual(m.formatPlanTempDim(4), "4.000 m");
  assert.strictEqual(m.formatPlanTempDim(0.2), "200 mm");
  // Round-trip: the label parses back to the value it shows.
  for (const v of [0.05, 0.2, 2, 4.5]) {
    assert.strictEqual(m.parsePlanTempDimInput(m.formatPlanTempDim(v)), v);
  }
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
