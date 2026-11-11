/**
 * Schedule totals policy unit tests — pure predicate from
 * src/modules/schedules/schedule-totals.ts (house pattern: compile the
 * module with tsc and require it).
 *
 * Locks the Revit-parity semantics: totals rows sum quantities, never
 * per-element dimensions. Before this policy existed the wall schedule's
 * subtotal row summed Thickness (0.200 × 2 → "0.400") and Height
 * (3.000 × 2 → "6.000 m of wall height"), which is meaningless.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "schedtotals-"));
execSync(
  `npx tsc src/modules/schedules/schedule-totals.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "schedule-totals.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ── quantity columns are summable ────────────────────────────────────────
t("length/area/volume/count/netArea/lineCost are summable", () => {
  for (const key of ["length", "area", "volume", "count", "netArea", "lineCost"]) {
    assert.ok(m.isSummableColumn({ key, format: "number" }), key + " should be summable");
  }
});

t("qty/quantity/total/cost/weight/mass aliases are summable", () => {
  for (const key of ["qty", "quantity", "total", "cost", "weight", "mass"]) {
    assert.ok(m.isSummableColumn({ key }), key + " should be summable");
  }
});

// ── per-element dimensions are never totalled ────────────────────────────
t("width/height/thickness/depth/elevation are NOT summable", () => {
  for (const key of ["width", "height", "thickness", "depth", "elevation"]) {
    assert.ok(!m.isSummableColumn({ key, format: "number" }), key + " must not be totalled");
  }
});

// ── format gates ─────────────────────────────────────────────────────────
t("text and date formats are never summable, even for a quantity key", () => {
  assert.ok(!m.isSummableColumn({ key: "area", format: "text" }));
  assert.ok(!m.isSummableColumn({ key: "volume", format: "date" }));
});

t("formula columns are summable (derived quantities)", () => {
  assert.ok(m.isSummableColumn({ key: "netArea", format: "formula" }));
  assert.ok(m.isSummableColumn({ key: "someCustomTakeoff", format: "formula" }));
});

// ── key normalization ────────────────────────────────────────────────────
t("keys are normalized (case, spaces, punctuation)", () => {
  assert.ok(m.isSummableColumn({ key: "Net Area" }));
  assert.ok(m.isSummableColumn({ key: "Line_Cost" }));
  assert.ok(m.isSummableColumn({ key: "TOTAL" }));
  assert.ok(!m.isSummableColumn({ key: "Wall Height (m)" }));
});

// ── summableColumnKeys ───────────────────────────────────────────────────
t("summableColumnKeys filters a wall-schedule column set in order", () => {
  const cols = [
    { key: "type", format: "text" },
    { key: "level", format: "text" },
    { key: "length", format: "number" },
    { key: "thickness", format: "number" },
    { key: "height", format: "number" },
    { key: "area", format: "number" },
    { key: "volume", format: "number" },
    { key: "netArea", format: "formula" },
    { key: "costItem", format: "text" },
    { key: "lineCost", format: "currency" },
  ];
  assert.deepStrictEqual(
    m.summableColumnKeys(cols),
    ["length", "area", "volume", "netArea", "lineCost"],
  );
});

t("SUMMABLE_KEYS is exposed with the expected contents", () => {
  assert.ok(m.SUMMABLE_KEYS.has("area"));
  assert.ok(m.SUMMABLE_KEYS.has("volume"));
  assert.ok(!m.SUMMABLE_KEYS.has("height"));
  assert.ok(m.SUMMABLE_KEYS.size >= 12);
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
