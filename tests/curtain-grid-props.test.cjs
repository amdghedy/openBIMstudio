/**
 * tests/curtain-grid-props.test.cjs
 *
 * Closes the curtain-wall custom-grid gap with proof:
 *   - explicit grid positions sanitize (clamp, sort, dedupe, 0/1 endpoints);
 *   - garbage never reaches the engine (warnings instead of silent drops);
 *   - panel overrides filter to the real PanelType vocabulary;
 *   - metre inputs normalize against the wall span.
 *
 * Run: `node tests/curtain-grid-props.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "curtg-"));
execSync(`npx tsc src/modules/curtain-wall/grid-props.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const m = require(find(out, "grid-props.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${a} != ${b}`);
const seq = (arr, expected, label) => { assert.strictEqual(arr.length, expected.length, label + " length"); expected.forEach((v, i) => near(arr[i], v, 1e-6, label + "[" + i + "]")); };

t("sanitize clamps, sorts, de-dupes and injects 0/1 endpoints", () => {
  const w = [];
  const r = m.sanitizeGridPositions([0.3, 0.1, "0.2", 1.2, -0.1, 0.3], "vGrid", w);
  seq(r, [0, 0.1, 0.2, 0.3, 1], "cleaned grid");
  assert.ok(w.some((x) => x.includes("dropped")), "warns about dropped entries");
});

t("single interior position gains both endpoints", () => {
  const w = [];
  seq(m.sanitizeGridPositions([0.5], "vGrid", w), [0, 0.5, 1], "with endpoints");
});

t("empty/garbage input falls back to undefined with a warning", () => {
  const w1 = [];
  assert.strictEqual(m.sanitizeGridPositions("hello", "vGrid", w1), undefined);
  assert.ok(w1.some((x) => x.includes("expected an array")));
  const w2 = [];
  assert.strictEqual(m.sanitizeGridPositions(["x", null], "vGrid", w2), undefined);
  assert.ok(w2.some((x) => x.includes("no usable positions")));
});

t("absent input is silently ignored (no warning noise)", () => {
  for (const raw of [undefined, null, ""]) {
    const w = [];
    assert.strictEqual(m.sanitizeGridPositions(raw, "vGrid", w), undefined);
    assert.strictEqual(w.length, 0, "no warning for absent input");
  }
});

t("panel overrides keep only the real PanelType vocabulary", () => {
  const w = [];
  const parsed = m.parseCurtainGridProps(
    { panelOverrides: [{ col: 0, row: 0, type: "solid" }, { col: "x", row: 0, type: "glazed" }, { col: 1, row: 1, type: "banana" }, { col: 2, row: 0, type: "door" }] },
    w,
  );
  assert.strictEqual(parsed.panelOverrides.length, 2, "solid + door kept");
  assert.strictEqual(parsed.panelOverrides[0].type, "solid");
  assert.strictEqual(parsed.panelOverrides[1].type, "door");
  assert.ok(w.some((x) => x.includes("panelOverrides") && x.includes("dropped 2")));
});

t("parseCurtainGridProps passes a full bag through with axis warnings", () => {
  const w = [];
  const parsed = m.parseCurtainGridProps(
    { vGrid: [0.25, 0.75], hGrid: [1, 2, 3], panelOverrides: [{ col: 0, row: 0, type: "void" }] },
    w,
  );
  seq(parsed.vGrid, [0, 0.25, 0.75, 1], "vGrid gains the 0/1 endpoints (engine contract)");
  seq(parsed.hGrid, [0, 1], "hGrid 1/2/3 all clamp to 1 → dedupes to the [0,1] degenerate grid");
  assert.ok(w.some((x) => x.includes("hGrid") && x.includes("dropped")), "clamped duplicates are warned");
  assert.strictEqual(parsed.panelOverrides[0].type, "void");
  assert.strictEqual(parsed.warnings, w, "same warnings array");
});

t("metersToGridPositions normalizes against the wall span", () => {
  const w = [];
  const r = m.metersToGridPositions("2.4, 4.8", 6, "vGrid", w);
  seq(r, [0.4, 0.8], "2.4/6=0.4, 4.8/6=0.8");
  assert.strictEqual(w.length, 0);
});

t("metres out of range are dropped with a warning", () => {
  const w = [];
  const r = m.metersToGridPositions("0, 3, 7.5, abc", 6, "vGrid", w);
  seq(r, [0.5], "only 3 m (0.5) is valid");
  assert.ok(w.some((x) => x.includes("dropped 3")), "0, 7.5 and abc dropped");
});

t("metres with an invalid span refuse honestly", () => {
  const w = [];
  assert.strictEqual(m.metersToGridPositions("2", 0, "vGrid", w), undefined);
  assert.ok(w.some((x) => x.includes("cannot normalize")));
});

console.log(`\ncurtain-grid-props: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
