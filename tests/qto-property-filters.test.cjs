/**
 * tests/qto-property-filters.test.cjs
 *
 * Unit tests for per-property QTO rule filters (5D rules v3):
 *   - parsePropertyFilterTokens / propertyClauseToString (editor text format)
 *   - normalizeQtoRuleInput validation of property clauses
 *   - rowMatches via evaluateQtoRules: equals / contains / exists semantics,
 *     case-insensitivity, AND-composition, rows without properties
 *   - flattenElementProperties / flattenPsets (row property shaping)
 *
 * Run: `node tests/qto-property-filters.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}\n    ${e.message}`); fail++; }
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-qto-prop-"));
execSync(
  `npx tsc src/modules/cost/qto-rules.ts --outDir ${out} --module commonjs --target es2020 ` +
  `--skipLibCheck --strict --ignoreDeprecations 5.0`,
  { cwd: path.resolve(__dirname, ".."), stdio: "pipe" },
);
globalThis.localStorage = {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); },
  clear() { this._s.clear(); },
};
const m = require(path.join(out, "cost", "qto-rules.js"));
const { evaluateQtoRules, normalizeQtoRuleInput } = m;

function row(overrides = {}) {
  return {
    key: "authored:w1",
    source: "authored",
    label: "Wall 001",
    detail: "wall (authored, exact)",
    count: 1,
    length: 10,
    area: 30,
    volume: 6,
    ...overrides,
  };
}

/* ── Editor text format ─────────────────────────────────────────────── */
t("parse: 'FireRating = 2 hr; IsExternal = true; Mark ~ D; LoadBearing' → 4 clauses", () => {
  const c = m.parsePropertyFilterTokens("FireRating = 2 hr; IsExternal = true; Mark ~ D; LoadBearing");
  assert.strictEqual(c.length, 4, JSON.stringify(c));
  assert.deepStrictEqual(c[0], { name: "FireRating", equals: "2 hr" });
  assert.deepStrictEqual(c[1], { name: "IsExternal", equals: "true" });
  assert.deepStrictEqual(c[2], { name: "Mark", contains: "D" });
  assert.deepStrictEqual(c[3], { name: "LoadBearing", exists: true });
});
t("parse: empty value after '=' degrades to exists", () => {
  const c = m.parsePropertyFilterTokens("FireRating = ; Mark ~ ");
  assert.strictEqual(c.length, 2);
  assert.ok(c[0].exists === true && c[0].equals === undefined, JSON.stringify(c[0]));
  assert.ok(c[1].exists === true && c[1].contains === undefined, JSON.stringify(c[1]));
});
t("parse: empty / whitespace-only input → no clauses", () => {
  assert.deepStrictEqual(m.parsePropertyFilterTokens(undefined), []);
  assert.deepStrictEqual(m.parsePropertyFilterTokens(""), []);
  assert.deepStrictEqual(m.parsePropertyFilterTokens("  ;  ; "), []);
});
t("parse: '= value' with no name keeps an empty name for the validator", () => {
  const c = m.parsePropertyFilterTokens(" = 2 hr");
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].name, "");
  assert.strictEqual(c[0].equals, "2 hr");
});
t("parse: name with '=' inside a contains value routes to equals (first marker wins)", () => {
  // First '=' before '~' → equals clause with the rest as value.
  const c = m.parsePropertyFilterTokens("Mark = D~1");
  assert.deepStrictEqual(c, [{ name: "Mark", equals: "D~1" }]);
});
t("toString round-trips every clause shape", () => {
  const clauses = m.parsePropertyFilterTokens("FireRating = 2 hr; Mark ~ D; LoadBearing");
  const text = clauses.map(m.propertyClauseToString).join("; ");
  assert.deepStrictEqual(m.parsePropertyFilterTokens(text), clauses);
});

/* ── Validation ─────────────────────────────────────────────────────── */
t("normalize: property-only rule passes the at-least-one-filter gate", () => {
  const r = normalizeQtoRuleInput({
    name: "Fire-rated render", formula: "Area", unit: "m2",
    propertyFilters: "FireRating = 2 hr",
  });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.rule.filter.properties.length, 1);
  assert.deepStrictEqual(r.rule.filter.properties[0], { name: "FireRating", equals: "2 hr" });
});
t("normalize: empty clause name is rejected with a reason", () => {
  const r = normalizeQtoRuleInput({
    name: "Bad", formula: "Area", unit: "m2", propertyFilters: " = 2 hr",
  });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /property filter/.test(e)), r.errors.join(" | "));
});
t("normalize: filterless rule without properties is still rejected", () => {
  const r = normalizeQtoRuleInput({ name: "No filter", formula: "Area", unit: "m2" });
  assert.ok(!r.ok);
  assert.ok(r.errors.some((e) => /at least one filter/.test(e)));
});

/* ── Matching semantics ─────────────────────────────────────────────── */
function runWith(rules, rows) {
  const run = evaluateQtoRules(rows, rules);
  return run.results;
}

t("equals matches case-insensitively on name and value", () => {
  const rules = [normalizeQtoRuleInput({
    name: "FR2", formula: "Area", unit: "m2", propertyFilters: "firerating = 2 HR",
  }).rule];
  const hit = runWith(rules, [row({ properties: { FireRating: "2 hr" } })])[0];
  const miss = runWith(rules, [row({ properties: { FireRating: "1 hr" } })])[0];
  const noProp = runWith(rules, [row()])[0];
  assert.strictEqual(hit.quantity, 30, `hit=${hit.quantity}`);
  assert.strictEqual(miss.quantity, 0, `miss=${miss.quantity}`);
  assert.strictEqual(noProp.quantity, 0, "row without properties must not match");
});
t("contains matches substrings inside the value", () => {
  const rules = [normalizeQtoRuleInput({
    name: "MarkD", formula: "Count", unit: "pcs", propertyFilters: "Mark ~ D",
  }).rule];
  const hit = runWith(rules, [row({ properties: { Mark: "D07" } })])[0];
  const miss = runWith(rules, [row({ properties: { Mark: "W01" } })])[0];
  assert.strictEqual(hit.quantity, 1);
  assert.strictEqual(miss.quantity, 0);
});
t("bare name means exists (any value)", () => {
  const rules = [normalizeQtoRuleInput({
    name: "HasLead", formula: "Count", unit: "pcs", propertyFilters: "LeadPaint",
  }).rule];
  const hit = runWith(rules, [row({ properties: { LeadPaint: "false" } })])[0];
  const miss = runWith(rules, [row({ properties: { Other: "x" } })])[0];
  assert.strictEqual(hit.quantity, 1);
  assert.strictEqual(miss.quantity, 0);
});
t("multiple clauses AND together", () => {
  const rules = [normalizeQtoRuleInput({
    name: "ExtFR", formula: "Area", unit: "m2",
    propertyFilters: "IsExternal = true; FireRating = 2 hr",
  }).rule];
  const both = runWith(rules, [row({ properties: { IsExternal: "true", FireRating: "2 hr" } })])[0];
  const oneOnly = runWith(rules, [row({ properties: { IsExternal: "true", FireRating: "1 hr" } })])[0];
  assert.strictEqual(both.quantity, 30);
  assert.strictEqual(oneOnly.quantity, 0);
});
t("property clause composes with source and token filters", () => {
  const rules = [normalizeQtoRuleInput({
    name: "IfcExt", formula: "Volume", unit: "m3",
    sources: "ifc", matchTokens: "wall", propertyFilters: "IsExternal = true",
  }).rule];
  const hit = runWith(rules, [row({
    key: "ifc:m1:Wall", source: "ifc", label: "Wall", detail: "3 elements",
    volume: 12, properties: { IsExternal: "TRUE" },
  })])[0];
  const wrongSource = runWith(rules, [row({ properties: { IsExternal: "true" } })])[0];
  assert.strictEqual(hit.quantity, 12, `hit=${hit.quantity}`);
  assert.strictEqual(wrongSource.quantity, 0, "authored row must not match an ifc-only rule");
});
t("IFC aggregate semantics: uniform property matches, divergent property is omitted", () => {
  const rules = [normalizeQtoRuleInput({
    name: "UniformExt", formula: "Count", unit: "pcs", sources: "ifc",
    propertyFilters: "IsExternal = true",
  }).rule];
  const uniform = runWith(rules, [row({
    key: "ifc:m1:Wall", source: "ifc", count: 3, properties: { IsExternal: "true" },
  })])[0];
  const divergent = runWith(rules, [row({
    key: "ifc:m1:Wall", source: "ifc", count: 3, properties: { Colour: "white" },
  })])[0];
  assert.strictEqual(uniform.quantity, 3, `uniform=${uniform.quantity}`);
  assert.strictEqual(divergent.quantity, 0, "missing property on aggregate → no match");
});

/* ── Row property shaping ───────────────────────────────────────────── */
t("flattenElementProperties: strings/numbers/booleans stringify, null/empty skipped", () => {
  const f = m.flattenElementProperties({
    FireRating: "2 hr", Thickness: 0.2, LoadBearing: true, Note: "", Empty: null,
  });
  assert.deepStrictEqual(f, { FireRating: "2 hr", Thickness: "0.2", LoadBearing: "true" });
});
t("flattenElementProperties: objects become truncated JSON, cap at 40", () => {
  const bag = { Big: { a: "x".repeat(300) } };
  const f = m.flattenElementProperties(bag);
  assert.ok(f.Big.length <= 120, `len=${f.Big.length}`);
  const many = {};
  for (let i = 0; i < 60; i++) many["P" + i] = "v" + i;
  const capped = m.flattenElementProperties(many);
  assert.strictEqual(Object.keys(capped).length, 40, `got ${Object.keys(capped).length}`);
});
t("flattenElementProperties: non-object input → empty", () => {
  assert.deepStrictEqual(m.flattenElementProperties(null), {});
  assert.deepStrictEqual(m.flattenElementProperties(undefined), {});
  assert.deepStrictEqual(m.flattenElementProperties("nope"), {});
});
t("flattenPsets: skips Qto_* sets, flattens bare names", () => {
  const f = m.flattenPsets({
    "Qto_WallBaseQuantities": { NetVolume: 5, NetArea: 20 },
    "Pset_WallCommon": { IsExternal: true, FireRating: "2 hr" },
  });
  assert.deepStrictEqual(f, { IsExternal: "true", FireRating: "2 hr" });
});
t("flattenPsets: same bare name in two sets keeps the first occurrence", () => {
  const f = m.flattenPsets({
    "Pset_A": { Colour: "red" },
    "Pset_B": { Colour: "blue" },
  });
  assert.deepStrictEqual(f, { Colour: "red" });
});

if (fail) process.exit(1);
console.log(`=== qto-property-filters tests complete: ${pass} passed, ${fail} failed ===`);
