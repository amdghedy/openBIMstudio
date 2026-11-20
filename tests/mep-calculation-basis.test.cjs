/* MEP calculation basis — every area discloses method, standard, units,
 * assumptions, limitations and validation status.
 *
 * Run: `node tests/mep-calculation-basis.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mcb-"));
execSync(`npx tsc src/modules/mep/calculation-basis.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "calculation-basis.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const AREAS = [
  "duct-pressure", "pipe-pressure", "duct-pipe-sizing", "network-audit",
  "hvac-loads", "plumbing-demand", "drainage", "fire-sprinkler",
  "electrical-voltage-drop", "electrical-demand-factors",
  "protection-coordination", "lighting", "insulation", "mep-connectivity",
];

t("every calculation area has a basis record", () => {
  for (const a of AREAS) {
    const b = m.calculationBasisFor(a);
    assert.ok(b, "missing basis for " + a);
  }
  assert.strictEqual(m.MEP_CALCULATION_BASIS.length, AREAS.length, "no undocumented areas");
});

t("every record discloses method, standard, units, assumptions, limitations, validation and source", () => {
  for (const b of m.MEP_CALCULATION_BASIS) {
    assert.ok(b.method.length > 20, b.area + ": method");
    assert.ok(b.standard.length > 3, b.area + ": standard");
    assert.ok(b.units.length > 1, b.area + ": units");
    assert.ok(Array.isArray(b.assumptions) && b.assumptions.length > 0, b.area + ": assumptions");
    assert.ok(Array.isArray(b.limitations) && b.limitations.length > 0, b.area + ": limitations");
    assert.ok(b.validationNote.length > 10, b.area + ": validationNote");
    assert.ok(b.source.startsWith("src/modules/mep/"), b.area + ": source");
  }
});

t("no area claims validation stronger than unit tests", () => {
  // Nothing in MEP has been validated against a reference implementation,
  // a code, or measured data for any jurisdiction. If that changes, this
  // test must be updated deliberately, with evidence, not by editing prose.
  assert.deepStrictEqual(m.validatedAreas(), []);
  for (const b of m.MEP_CALCULATION_BASIS) {
    assert.strictEqual(b.validation, "unit-tested-only", b.area);
  }
});

t("no record claims code compliance", () => {
  for (const b of m.MEP_CALCULATION_BASIS) {
    const text = (b.method + " " + b.limitations.join(" ") + " " + b.validationNote).toLowerCase();
    assert.ok(!/is code-compliant|compliant with|certified|approved for permit|meets the code/.test(text), b.area + " must not claim compliance");
  }
});

t("unknown areas return undefined", () => {
  assert.strictEqual(m.calculationBasisFor("teleportation"), undefined);
});

console.log(`\nmep-calculation-basis: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
