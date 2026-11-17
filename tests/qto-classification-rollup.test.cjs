/**
 * tests/qto-classification-rollup.test.cjs
 *
 * Unit tests for the QTO roll-up by ELEMENT classification code
 * (5D rules: rules without an explicit classification decompose their
 * quantity over the matched rows' assigned industry codes).
 *
 * Run: `node tests/qto-classification-rollup.test.cjs`
 */

const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-qto-cls-"));
execSync(
  `npx tsc src/modules/cost/qto-rules.ts --outDir ${out} --module commonjs --target es2020 ` +
  `--skipLibCheck --strict --ignoreDeprecations 5.0`,
  { cwd: path.resolve(__dirname, ".."), stdio: "inherit" },
);
const compiled = path.join(out, "cost", "qto-rules.js");
assert.ok(fs.existsSync(compiled), "expected compiled module at cost/qto-rules.js");
const m = require(compiled);
const { evaluateQtoRules, normalizeQtoRuleInput, rollupByElementClassification } = m;

globalThis.localStorage = {
  _s: new Map(),
  getItem(k) { return this._s.has(k) ? this._s.get(k) : null; },
  setItem(k, v) { this._s.set(k, String(v)); },
  removeItem(k) { this._s.delete(k); },
  clear() { this._s.clear(); },
};

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

t("rule without classification decomposes over element codes", () => {
  const rule = normalizeQtoRuleInput({
    name: "Paint", formula: "Area", unit: "m2", matchTokens: "wall",
  }).rule;
  const run = evaluateQtoRules([
    row({ key: "authored:a", classification: "Uniclass 2015 EF: EF_30_10", area: 40 }),
    row({ key: "authored:b", label: "Wall 002", classification: "Uniclass 2015 EF: EF_30_20", area: 60 }),
  ], [rule]);
  assert.strictEqual(run.results[0].quantity, 100, `qty=${run.results[0].quantity}`);
  const by = run.byElementClassification;
  assert.strictEqual(by.length, 2, JSON.stringify(by));
  const ef30 = by.find((c) => c.code.includes("EF_30_10"));
  const ef40 = by.find((c) => c.code.includes("EF_30_20"));
  assert.ok(ef30 && ef30.quantity === 40, `EF_30_10=${ef30?.quantity}`);
  assert.ok(ef40 && ef40.quantity === 60, `EF_30_20=${ef40?.quantity}`);
  assert.deepStrictEqual(ef30.ruleIds, [rule.id]);
  assert.strictEqual(ef30.unit, "m2");
});

t("rule WITH explicit classification does NOT contribute to byElementClassification", () => {
  const rule = normalizeQtoRuleInput({
    name: "Paint", formula: "Area", unit: "m2", matchTokens: "wall",
    classification: "09 90 00 Painting",
  }).rule;
  const run = evaluateQtoRules([
    row({ classification: "Uniclass 2015 EF: EF_30_10" }),
  ], [rule]);
  assert.strictEqual(run.byElementClassification.length, 0, "rule-owned classification must stay in byClassification");
  assert.ok(run.byClassification.some((c) => c.classification === "09 90 00 Painting"));
  assert.strictEqual(run.results[0].byElementClassification, undefined);
});

t("rows without an assignment are excluded from the element roll-up", () => {
  const rule = normalizeQtoRuleInput({
    name: "Paint", formula: "Area", unit: "m2", matchTokens: "wall",
  }).rule;
  const run = evaluateQtoRules([
    row({ key: "authored:a", area: 40 }),
    row({ key: "authored:b", label: "Wall 002", classification: "S: EF_30_10", area: 60 }),
  ], [rule]);
  const by = run.byElementClassification;
  assert.strictEqual(by.length, 1, JSON.stringify(by));
  assert.strictEqual(by[0].quantity, 60, `only coded rows: ${by[0]?.quantity}`);
});

t("waste factor scales the per-code buckets (they sum to rule quantity)", () => {
  const rule = normalizeQtoRuleInput({
    name: "Paint", formula: "Area", unit: "m2", matchTokens: "wall", wasteFactorPct: "5",
  }).rule;
  const run = evaluateQtoRules([
    row({ key: "authored:a", classification: "S: A", area: 40 }),
    row({ key: "authored:b", label: "Wall 002", classification: "S: B", area: 60 }),
  ], [rule]);
  const sum = run.byElementClassification.reduce((s, c) => s + c.quantity, 0);
  assert.ok(Math.abs(sum - 105) < 1e-9, `sum=${sum} expected 105`);
  assert.ok(Math.abs(run.results[0].quantity - 105) < 1e-9);
});

t("same code across rules accumulates into one bucket with both rule ids", () => {
  const r1 = normalizeQtoRuleInput({
    name: "Paint area", formula: "Area", unit: "m2", matchTokens: "wall",
  }).rule;
  const r2 = normalizeQtoRuleInput({
    name: "Paint length", formula: "Length", unit: "m", matchTokens: "wall",
  }).rule;
  const run = evaluateQtoRules([
    row({ key: "authored:a", classification: "S: EF_30_10", area: 40, length: 10 }),
    row({ key: "authored:b", label: "Wall 002", classification: "S: EF_30_10", area: 60, length: 12 }),
  ], [r1, r2]);
  const m2 = run.byElementClassification.find((c) => c.unit === "m2");
  const mm = run.byElementClassification.find((c) => c.unit === "m");
  assert.ok(m2 && Math.abs(m2.quantity - 100) < 1e-9, `m2=${m2?.quantity}`);
  assert.ok(mm && Math.abs(mm.quantity - 22) < 1e-9, `m=${mm?.quantity}`);
  assert.ok(m2.ruleIds.includes(r1.id));
  assert.ok(mm.ruleIds.includes(r2.id));
});

t("rollupByElementClassification export is stable when called directly", () => {
  const empty = rollupByElementClassification([]);
  assert.deepStrictEqual(empty, []);
});

t("result decomposition present on the rule result (panel + CSV source)", () => {
  const rule = normalizeQtoRuleInput({
    name: "Paint", formula: "Area", unit: "m2", matchTokens: "wall",
  }).rule;
  const run = evaluateQtoRules([
    row({ key: "authored:a", classification: "S: A", area: 40 }),
    row({ key: "authored:b", label: "Wall 002", classification: "S: B", area: 60 }),
  ], [rule]);
  const dec = run.results[0].byElementClassification;
  assert.ok(Array.isArray(dec) && dec.length === 2, JSON.stringify(dec));
  assert.ok(Math.abs(dec[0].quantity - 60) < 1e-9, "sorted desc by quantity");
});

if (fail) process.exit(1);
console.log(`=== qto-classification-rollup tests complete: ${pass} passed, ${fail} failed ===`);
