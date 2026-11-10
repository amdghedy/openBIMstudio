/**
 * tests/constraint-persistence.test.cjs
 *
 * Closes the "constraints die on reload" gap with proof:
 *   - export produces a deep copy safe for ProjectDoc.parametricConstraints;
 *   - import round-trips ids/values exactly after a clear;
 *   - malformed entries are rejected (bogus type, single-element lock,
 *     missing lock value) with an honest imported count;
 *   - locked-dimension lookups (isLocked / getLockedValue) work after restore.
 *
 * Run: `node tests/constraint-persistence.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "consp-"));
execSync(`npx tsc src/modules/parametric-constraints/types.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const m = require(find(out, "types.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

t("seeded store exports a deep copy", () => {
  m.clearConstraints();
  m.lockDimension("a", "b", 3.0);
  m.lockDimension("b", "c", 2.5);
  m.addEquality(["d", "e"], "spacing");
  m.addParallel("f", "g");
  const exported = m.exportConstraints();
  assert.strictEqual(exported.length, 4);
  exported[0].value = 999; // mutate the copy
  exported[0].elementIds.push("zzz");
  assert.strictEqual(m.getLockedValue("a", "b"), 3.0, "store untouched by copy mutation");
  assert.strictEqual(m.getAllConstraints()[0].elementIds.length, 2, "store ids untouched");
});

t("clear + import round-trips ids and values exactly", () => {
  const exported = m.exportConstraints();
  m.clearConstraints();
  assert.strictEqual(m.getAllConstraints().length, 0);
  const n = m.importConstraints(exported);
  assert.strictEqual(n, 4, "all four imported");
  const restored = m.getAllConstraints();
  assert.deepStrictEqual(restored.map((c) => c.id), exported.map((c) => c.id), "ids preserved");
  assert.strictEqual(m.isLocked("a", "b"), true, "isLocked works after restore");
  assert.strictEqual(m.getLockedValue("a", "b"), 3.0, "locked value restored");
  assert.strictEqual(m.getLockedValue("b", "c"), 2.5);
  assert.strictEqual(m.getAllConstraints()[2].dimensionLabel, "spacing", "equality label restored");
  const par = restored[3];
  assert.strictEqual(par.type, "parallel");
  assert.ok(par.active, "imported constraints are active");
});

t("malformed entries are rejected with an honest count", () => {
  m.clearConstraints();
  const n = m.importConstraints([
    { type: "bogus", elementIds: ["x", "y"] },                       // unknown type
    { type: "locked-dimension", elementIds: ["x"], value: 1 },       // single-element lock
    { type: "locked-dimension", elementIds: ["x", "y"] },            // missing value
    { type: "locked-dimension", elementIds: ["x", "y"], value: "abc" }, // non-numeric value
    { type: "equality", elementIds: [] },                            // no elements
    { type: "equality", elementIds: ["p", "q"], dimensionLabel: "spacing" }, // valid
    { type: "locked-dimension", elementIds: ["r", "s"], value: 4.25, active: false }, // valid + inactive
    "not-an-object",                                                 // junk row
  ]);
  assert.strictEqual(n, 2, "exactly the two valid rows imported");
  const all = m.getAllConstraints();
  assert.strictEqual(all[0].type, "equality");
  assert.strictEqual(all[1].value, 4.25);
  assert.strictEqual(all[1].active, false, "active:false survives the round-trip");
});

t("defaults fill in for missing id/createdAt, and toggle still works", () => {
  m.clearConstraints();
  const n = m.importConstraints([{ type: "perpendicular", elementIds: ["m", "n"] }]);
  assert.strictEqual(n, 1);
  const c = m.getAllConstraints()[0];
  assert.ok(typeof c.id === "string" && c.id.length > 0, "id generated");
  assert.ok(Number.isFinite(c.createdAt), "createdAt generated");
  assert.strictEqual(m.toggleConstraint(c.id), false, "toggle -> inactive");
  assert.strictEqual(m.toggleConstraint(c.id), true, "toggle -> active again");
});

t("import replaces (not merges) the store", () => {
  m.clearConstraints();
  m.lockDimension("old1", "old2", 9);
  m.importConstraints([{ type: "alignment", elementIds: ["n1", "n2"] }]);
  const all = m.getAllConstraints();
  assert.strictEqual(all.length, 1, "old lock gone");
  assert.strictEqual(all[0].type, "alignment");
});

console.log(`\nconstraint-persistence: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
