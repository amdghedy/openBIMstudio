/**
 * 5D QTO rules engine unit tests — pure module from
 * src/modules/cost/qto-rules.ts (house pattern: compile with tsc, require).
 *
 * Locks the semantics that make this a real rules engine and not a
 * re-skin of the takeoff:
 *   • rules FILTER rows, DERIVE quantities via the safe formula compiler
 *     (the same AST evaluator schedules use — no eval), apply WASTE factors
 *   • a broken rule lands in run.errors and never aborts the batch
 *   • pricing resolves through the rate book by cost CODE with a strict
 *     unit match — mismatch is an error, not silently-wrong money
 *   • classification roll-up groups work items like a real estimate
 *   • every BUILT-IN rule must compile — a shipped rule that doesn't even
 *     parse would silently empty the whole rules tab
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

// Node has no localStorage — qto-rules persists custom rules there.
globalThis.localStorage = {
  _s: {},
  getItem(k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "qtorules-"));
execSync(
  `npx tsc src/modules/cost/qto-rules.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const compiled = path.join(out, "cost", "qto-rules.js");
assert.ok(fs.existsSync(compiled), "expected compiled module at cost/qto-rules.js — got: " +
  JSON.stringify(fs.readdirSync(out, { recursive: true })));
const m = require(compiled);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const approx = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ~${b}, got ${a}`);

// ── fixtures ─────────────────────────────────────────────────────────────
const row = (label, detail, q = {}, source = "authored") => ({
  key: `${source}:${label}`,
  source,
  label,
  detail,
  count: q.c ?? 1,
  length: q.l ?? 0,
  area: q.a ?? 0,
  volume: q.v ?? 0,
});

const ROWS = [
  row("Wall 001", "exact", { l: 10, a: 51, v: 12.75 }),
  row("Slab 001", "exact", { l: 0, a: 40, v: 8 }),
  row("Door 001", "unit (0.9 × 2.1 m)", { c: 1 }),
  row("Window 001", "unit (1.2 × 1.2 m)", { c: 1 }),
];

const RATES = {
  "C-CONC": { code: "C-CONC", name: "Ready-mix concrete C30", unit: "m3", rate: 120 },
  "C-REBAR": { code: "C-REBAR", name: "Rebar B500", unit: "kg", rate: 2 },
  "C-DOOR": { code: "C-DOOR", name: "Interior door", unit: "pcs", rate: 350 },
  "C-WINDOW": { code: "C-WINDOW", name: "Window", unit: "pcs", rate: 300 },
};

const byId = (run, id) => run.results.find((r) => r.ruleId === id);

// ── built-in library integrity ───────────────────────────────────────────
t("every built-in rule compiles and has a known unit", () => {
  assert.ok(m.BUILT_IN_QTO_RULES.length >= 10, "rule library shrank");
  for (const r of m.BUILT_IN_QTO_RULES) {
    const v = m.evaluateQtoRules([], [r]); // evaluation compiles the formula
    assert.strictEqual(v.errors.length, 0, `${r.id}: ${v.errors[0]?.error}`);
    assert.ok(["m", "m2", "m3", "pcs", "kg"].includes(r.unit), `${r.id} unit ${r.unit}`);
    assert.ok(r.classification, `${r.id} missing classification`);
  }
});

// ── filtering ────────────────────────────────────────────────────────────
t("wall rules match only wall rows", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES);
  const conc = byId(run, "qto-wall-concrete");
  assert.strictEqual(conc.matchedRows, 1);
  assert.strictEqual(conc.lines[0].rowKey, "authored:Wall 001");
  const doors = byId(run, "qto-door-count");
  assert.strictEqual(doors.matchedRows, 1);
  const wins = byId(run, "qto-window-count");
  assert.strictEqual(wins.matchedRows, 1);
});

t("matchAny and sources filters work", () => {
  const rule = { id: "x", name: "X", filter: { matchAny: ["door", "window"] }, formula: "Count", unit: "pcs" };
  assert.strictEqual(m.evaluateQtoRules(ROWS, [rule]).results[0].matchedRows, 2);
  const authoredOnly = { id: "y", name: "Y", filter: { sources: ["authored"], matchAll: ["wall"] }, formula: "Length", unit: "m" };
  assert.strictEqual(m.evaluateQtoRules(ROWS, [authoredOnly]).results[0].matchedRows, 1);
  const ifcOnly = { id: "z", name: "Z", filter: { sources: ["ifc"], matchAll: ["wall"] }, formula: "Length", unit: "m" };
  assert.strictEqual(m.evaluateQtoRules(ROWS, [ifcOnly]).results[0].matchedRows, 0);
});

t("excludeAny drops rows whose label contains an exclusion", () => {
  const rows = [...ROWS, row("Door-Window combo", "unit")];
  const run = m.evaluateQtoRules(rows, m.BUILT_IN_QTO_RULES);
  assert.strictEqual(byId(run, "qto-door-count").matchedRows, 1); // combo excluded
});

// ── derivation ───────────────────────────────────────────────────────────
t("net quantity is the formula over the takeoff", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES);
  approx(byId(run, "qto-wall-concrete").netQuantity, 12.75);
  approx(byId(run, "qto-wall-formwork").netQuantity, 51);
  approx(byId(run, "qto-wall-length").netQuantity, 10);
  approx(byId(run, "qto-slab-concrete").netQuantity, 8);
  approx(byId(run, "qto-door-count").netQuantity, 1);
});

t("waste factor multiplies net quantity", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES);
  approx(byId(run, "qto-wall-paint").netQuantity, 51);
  approx(byId(run, "qto-wall-paint").quantity, 51 * 1.05);
  approx(byId(run, "qto-slab-finish").quantity, 40 * 1.08);
  approx(byId(run, "qto-wall-rebar").netQuantity, 12.75 * 100);
  approx(byId(run, "qto-wall-rebar").quantity, 12.75 * 100 * 1.03);
  assert.strictEqual(byId(run, "qto-wall-concrete").wasteFactorPct, 0);
});

t("formulas can combine variables", () => {
  const rule = { id: "mix", name: "M", filter: { matchAll: ["wall"] }, formula: "Volume * 2 + Length / 2", unit: "m3" };
  const run = m.evaluateQtoRules(ROWS, [rule]);
  approx(run.results[0].netQuantity, 12.75 * 2 + 10 / 2);
});

// ── batch resilience ─────────────────────────────────────────────────────
t("an invalid formula becomes an error, not a crash — batch survives", () => {
  const rules = [
    { id: "bad", name: "Bad", filter: { matchAll: ["wall"] }, formula: "Volume * [unclosed", unit: "m3" },
    { id: "good", name: "Good", filter: { matchAll: ["wall"] }, formula: "Volume", unit: "m3" },
  ];
  const run = m.evaluateQtoRules(ROWS, rules);
  assert.strictEqual(run.results.length, 1);
  assert.strictEqual(run.results[0].ruleId, "good");
  assert.strictEqual(run.errors.length, 1);
  assert.strictEqual(run.errors[0].ruleId, "bad");
  assert.ok(run.errors[0].error.includes("invalid formula"));
});

t("empty formula is an error", () => {
  const run = m.evaluateQtoRules(ROWS, [{ id: "e", name: "E", filter: {}, formula: "  ", unit: "m3" }]);
  assert.strictEqual(run.results.length, 0);
  assert.strictEqual(run.errors.length, 1);
  assert.strictEqual(run.errors[0].error, "empty formula");
});

t("unknown columns evaluate to 0 without throwing", () => {
  const rule = { id: "u", name: "U", filter: { matchAll: ["wall"] }, formula: "Height * Width", unit: "m2" };
  const run = m.evaluateQtoRules(ROWS, [rule]);
  assert.strictEqual(run.errors.length, 0);
  approx(run.results[0].netQuantity, 0);
});

// ── pricing ──────────────────────────────────────────────────────────────
t("pricing resolves by cost code with strict unit match", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES, { rates: RATES });
  const conc = byId(run, "qto-wall-concrete");
  assert.ok(conc.cost, "wall concrete should be priced");
  assert.strictEqual(conc.cost.code, "C-CONC");
  approx(conc.cost.rate, 120);
  approx(conc.cost.total, 12.75 * 120);
  const rebar = byId(run, "qto-wall-rebar");
  approx(rebar.cost.total, 12.75 * 100 * 1.03 * 2);
  const wins = byId(run, "qto-window-count");
  assert.ok(wins.cost, "cost resolves even at zero quantity");
  approx(wins.cost.total, 1 * 300);
  const formwork = byId(run, "qto-wall-formwork");
  assert.strictEqual(formwork.cost, undefined, "rule without costCode stays unpriced");
});

t("unit mismatch between rule and rate is an error, not wrong money", () => {
  const rates = { "C-CONC": { code: "C-CONC", name: "X", unit: "m2", rate: 9 } };
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES, { rates });
  assert.ok(run.errors.some((e) => e.ruleId === "qto-wall-concrete" && e.error.includes("unit mismatch")));
  const conc = byId(run, "qto-wall-concrete");
  assert.strictEqual(conc.cost, undefined, "no cost attached on mismatch");
});

t("unknown cost code yields quantity without cost", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES, { rates: {} });
  assert.strictEqual(byId(run, "qto-wall-concrete").cost, undefined);
  assert.strictEqual(run.errors.length, 0);
  approx(byId(run, "qto-wall-concrete").quantity, 12.75);
});

t("costTotal sums only priced rules", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES, { rates: RATES });
  const expected =
    12.75 * 120 +            // wall concrete
    8 * 120 +                // slab concrete
    12.75 * 100 * 1.03 * 2 + // rebar
    1 * 350 +                // door
    1 * 300;                 // window
  approx(run.costTotal, expected, 1e-6);
});

// ── roll-ups ─────────────────────────────────────────────────────────────
t("byUnit totals per unit", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES);
  approx(run.byUnit.m3, 12.75 + 8);
  approx(run.byUnit.m2, 51 + 51 * 1.05 + 40 * 1.08);
  approx(run.byUnit.pcs, 2); // door + window
  approx(run.byUnit.kg, 12.75 * 100 * 1.03);
  approx(run.byUnit.m, 10);
});

t("byClassification groups concrete work under one code", () => {
  const run = m.evaluateQtoRules(ROWS, m.BUILT_IN_QTO_RULES);
  const concrete = run.byClassification.filter((c) => c.classification === "03 30 00 Cast-in-place concrete");
  assert.strictEqual(concrete.length, 1, "one group per (classification, unit)");
  assert.strictEqual(concrete[0].unit, "m3");
  approx(concrete[0].quantity, 12.75 + 8);
  assert.ok(concrete[0].ruleIds.includes("qto-wall-concrete"));
  assert.ok(concrete[0].ruleIds.includes("qto-slab-concrete"));
  // Zero-quantity rules (no beams/columns/footings in fixture) still list.
  assert.ok(concrete[0].ruleIds.includes("qto-beam-concrete"));
});

// ── custom rules ─────────────────────────────────────────────────────────
t("setCustomQtoRules rejects invalid rules with reasons", () => {
  const { rejected } = m.setCustomQtoRules([
    { id: "ok1", name: "OK", filter: { matchAll: ["wall"] }, formula: "Length * 2", unit: "m" },
    { id: "bad1", name: "Bad formula", filter: {}, formula: "Length +", unit: "m" },
    { id: "bad2", filter: {}, formula: "Area", unit: "m2" },
    { id: "ok1", name: "Duplicate", filter: {}, formula: "Area", unit: "m2" },
    { id: "bad3", name: "Bad unit", filter: {}, formula: "Area", unit: "m9" },
  ]);
  assert.strictEqual(rejected.length, 4);
  assert.ok(rejected.some((r) => r.reason.includes("invalid formula")));
  assert.ok(rejected.some((r) => r.reason.includes("missing id or name")));
  assert.ok(rejected.some((r) => r.reason.includes("duplicate id")));
  assert.ok(rejected.some((r) => r.reason.includes("unknown unit")));
});

t("custom rules persist and join the active set after built-ins", () => {
  globalThis.localStorage.removeItem("obs.qto.customRules");
  m.setCustomQtoRules([
    { id: "custom-1", name: "Skirting", description: "Wall length × 0.1", filter: { matchAll: ["wall"] }, formula: "Length * 0.1", unit: "m" },
  ]);
  const active = m.getActiveQtoRules();
  assert.strictEqual(active[0].id, "qto-wall-concrete", "built-ins come first");
  const custom = active.find((r) => r.id === "custom-1");
  assert.ok(custom, "custom rule active");
  const run = m.evaluateQtoRules(ROWS, [custom]);
  approx(run.results[0].netQuantity, 10 * 0.1);
  globalThis.localStorage.removeItem("obs.qto.customRules");
});

// ── IFC rows ─────────────────────────────────────────────────────────────
t("IFC category rows match by category name", () => {
  const ifcRows = [row("IfcWallStandardCase", "geometry (bbox)", { l: 20, a: 120, v: 24 }, "ifc")];
  const run = m.evaluateQtoRules(ifcRows, m.BUILT_IN_QTO_RULES);
  approx(byId(run, "qto-wall-concrete").netQuantity, 24);
  assert.strictEqual(byId(run, "qto-wall-concrete").matchedRows, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
