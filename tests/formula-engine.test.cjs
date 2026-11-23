/**
 * tests/formula-engine.test.cjs
 *
 * Follow-up 8 (parametric families): enhanced formula engine — integrate
 * or delete, decided by evidence. Decision: INTEGRATE.
 *
 * Evidence (comparison harness run 2026-11-21 against origin/main eabab92,
 * before the swap; harness in the follow-up-8 PR description):
 *   - All 24 distinct formulas in the live TS corpus (builtin-families.ts
 *     + sample-parametric-door.ts, realistic declarations) evaluated
 *     identically in both engines: same values, same error state, same
 *     computed set, same order. 24/24.
 *   - All 57 seed families (public/families/**, real parameters + first
 *     type's values): identical. 57/57. (Was 56/56 on the 3b2f9b5 corpus;
 *     the catalog grew by one family with one formula param on main.)
 *   - Cycles, self-reference, integer rounding, min/max clamping:
 *     identical.
 *   - Enhanced-only wins: scientific notation (1e-7), string/boolean
 *     results, sind/cosd/tand, xor, to_mm/to_cm/to_ft/to_in/to_deg,
 *     precise error messages (old engine: blanket "Formula returned no
 *     value"), dependency graph + dependentsOf(), and it runs on the
 *     sanctioned safe-expr evaluator (tests/dependency-safety.test.cjs
 *     names safe-expr as the only sanctioned evaluator; the old engine
 *     was a second, unsanctioned evaluator).
 *   - Gaps closed at integration so nothing is lost: `^` power alias
 *     added to safe-expr.ts (previously threw there), infix word
 *     operators (and/or/not/eq/ne/lt/le/gt/ge) rewritten to symbolic
 *     form outside string literals, evaluateFormula() kept with the old
 *     null-on-error contract, and logic results on numeric parameters
 *     still stored as 1/0 (only Yes/No parameters keep real booleans). `Math.*` was never usable in the old
 *     engine either (its tokenizer could not lex `.`), so nothing is
 *     lost there; every Math function is a bare builtin.
 *   - Cost: ~1.27x slower per evaluateParameters call in a 2000x loop
 *     (72 -> 92 ms / 2000 calls, ~10 us/call) — negligible; formula
 *     evaluation is not a hot path.
 *
 * This suite pins the integrated engine (now the sole content of
 * src/modules/families/formula-engine.ts; formula-engine-enhanced.ts
 * deleted): the corpus goldens below are the values the OLD engine
 * produced, so any future drift from the pre-integration behaviour
 * fails here.
 *
 * Run: `node tests/formula-engine.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "fe-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execSync(
  `npx tsc src/modules/families/formula-engine.ts src/modules/families/safe-expr.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { cwd: root, stdio: "inherit" },
);
const findJs = (name) => {
  const files = fs.readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === name)
    .map((d) => path.join(d.parentPath || d.path || out, d.name));
  return files[0];
};
const eng = require(findJs("formula-engine.js"));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.log(`  FAIL ${name}: ${e.message}`);
    fail++;
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Single-formula helper: evaluate `formula` as parameter __out with the
// given seed values (each seed becomes a declared number parameter).
function evalOne(formula, seeds = {}) {
  const decls = [
    ...Object.keys(seeds).map((n) => ({ name: n, type: "number", scope: "type", default: seeds[n] })),
    { name: "__out", type: "number", scope: "type", default: 0, formula },
  ];
  return eng.evaluateParameters(decls, { ...seeds });
}
function evalOneValue(formula, seeds = {}) {
  const r = evalOne(formula, seeds);
  assert.strictEqual(r.errors.length, 0, `expected no errors, got ${JSON.stringify(r.errors)}`);
  return r.values.__out;
}

// ── 1. Corpus goldens (TS sources, realistic declarations) ─────────────
// Seeds match the comparison harness: every declared parameter 2, except
// IsDouble 1. Golden values are what the OLD engine produced.
const TS_SOURCES = [
  "src/modules/families/builtin-families.ts",
  "src/modules/families/sample-parametric-door.ts",
];
const GOLDENS = {
  "= thickness * height": 4,
  "= height / thickness": 1,
  "= thickness * depth * height": 8,
  "= height / min(thickness, depth)": 1,
  "= (thickness * height * height * height) / 12": 1.3333333333333333,
  "= eq(LeafCount, 1)": 0,
  "= eq(LeafCount, 2)": 1,
  "= Width - 0.08": 1.92,
  "= Height - 0.08": 1.92,
  "= OpeningWidth": 2,
  "= OpeningHeight": 2,
  "= OpeningWidth / 2 - 0.01": 0.99,
  "= -HalfPanelWidth / 2 - 0.01": -1.01,
  "= HalfPanelWidth / 2 + 0.01": 1.01,
  "= 0": 0,
  "= min(PanelWidth * 0.5, 0.5)": 0.5,
  "= min(PanelHeight * 0.35, 0.8)": 0.7,
  "= PanelHeight * 0.55": 1.1,
  "= if(IsDouble, RightPanelX + HalfPanelWidth * 0.35, PanelWidth * 0.4)": 2.7,
  "= 1.0": 1,
  "= Width * Height": 4,
  "= if(IsDouble, OpeningWidth * OpeningHeight, PanelWidth * PanelHeight)": 4,
  // Slice 2 corrected the pipe formulas (they referenced an undefined
  // `diameter`; they now reference `thickness`). Seeds are 2, so
  // pi() * thickness = 2pi and pi() * (thickness/2)^2 = pi.
  "= pi() * thickness": 6.283185307179586,
  "= pi() * (thickness / 2) * (thickness / 2)": 3.141592653589793,
};
// Formulas that error identically in both engines. (Was: the pipe
// `diameter` formulas — `diameter` is not a declared parameter. Slice 2
// corrected those formulas to reference `thickness`, so they no longer
// exist in the corpus and moved to GOLDENS above; the error-message probe
// for undeclared names lives on in the "pipe diameter formulas" test
// below, using the old formulas as literals.)
const GOLDEN_ERRORS = [];
const BUILTINS = new Set([...Object.keys(eng.BUILTIN_FUNCTIONS), "Math", "true", "false"]);
function identifiersIn(formula) {
  let s = String(formula ?? "");
  if (s.startsWith("=")) s = s.slice(1);
  s = s.replace(/"[^"]*"|'[^']*'/g, " ");
  const found = new Set();
  for (const m of s.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    if (!BUILTINS.has(m[0])) found.add(m[0]);
  }
  return [...found];
}
function harvestedFormulas() {
  const map = new Map(); // formula -> file
  for (const rel of TS_SOURCES) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    for (const m of src.matchAll(/formula:\s*"((?:[^"\\]|\\.)*)"/g)) {
      if (!map.has(m[1])) map.set(m[1], rel);
    }
  }
  return map;
}
function declaredNames(rel) {
  const src = fs.readFileSync(path.join(root, rel), "utf8");
  const names = new Set();
  for (const m of src.matchAll(/name:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) names.add(m[1]);
  return names;
}

t("corpus: harvested TS formulas match the golden set (drift guard)", () => {
  const harvested = [...harvestedFormulas().keys()].sort();
  const expected = [...Object.keys(GOLDENS), ...GOLDEN_ERRORS].sort();
  assert.deepStrictEqual(harvested, expected);
});

t("corpus: every TS-source formula evaluates to its golden value", () => {
  const byFile = harvestedFormulas();
  for (const [formula, golden] of Object.entries(GOLDENS)) {
    const rel = byFile.get(formula);
    const declared = declaredNames(rel);
    const ids = identifiersIn(formula).filter((id) => declared.has(id));
    const seeds = {};
    for (const id of ids) seeds[id] = id === "IsDouble" ? 1 : 2;
    const decls = [
      ...[...declared].map((n) => ({ name: n, type: "number", scope: "type", default: seeds[n] ?? 0 })),
      { name: "__out", type: "number", scope: "type", default: 0, formula },
    ];
    const r = eng.evaluateParameters(decls, seeds);
    assert.strictEqual(r.errors.length, 0, `${formula}: ${JSON.stringify(r.errors)}`);
    assert.ok(near(r.values.__out, golden), `${formula}: got ${r.values.__out}, want ${golden}`);
    assert.ok(r.computed.has("__out"), `${formula}: __out not in computed set`);
  }
});

t("corpus: pipe diameter formulas still error — and now name the cause", () => {
  // The old pipe formulas (pre-slice-2) referenced an undefined
  // `diameter`. Slice 2 corrected them to `thickness`, so they no longer
  // exist in the corpus — but as literals they still probe the point:
  // the integrated engine must name the undeclared parameter instead of
  // the old blanket "Formula returned no value".
  for (const formula of [
    "= pi() * diameter",
    "= pi() * (diameter / 2) * (diameter / 2)",
  ]) {
    const decls = [
      { name: "thickness", type: "number", scope: "type", default: 2 },
      { name: "__out", type: "number", scope: "type", default: 0, formula },
    ];
    const r = eng.evaluateParameters(decls, { thickness: 2 });
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].parameter, "__out");
    // Old engine said only "Formula returned no value"; the integrated
    // engine must name the undeclared parameter.
    assert.match(r.errors[0].message, /diameter/);
    assert.strictEqual(r.values.__out, 0, "failed formula keeps its default");
  }
});

// ── 2. Seed JSON families ──────────────────────────────────────────────
function walkJson(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(p, acc);
    else if (e.name.endsWith(".json")) acc.push(p);
  }
  return acc;
}
t("corpus: all 57 seed families evaluate with zero formula errors", () => {
  let families = 0;
  let formulaParams = 0;
  for (const file of walkJson(path.join(root, "public/families"))) {
    let def;
    try { def = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (Array.isArray(def) || !def.parameters) continue;
    families++;
    const seeds = { ...(def.types && def.types[0] ? def.types[0].values : {}) };
    for (const p of def.parameters) if (!(p.name in seeds)) seeds[p.name] = p.default ?? 0;
    const r = eng.evaluateParameters(def.parameters, { ...seeds });
    assert.strictEqual(r.errors.length, 0, `${path.basename(file)}: ${JSON.stringify(r.errors)}`);
    for (const p of def.parameters) {
      if (!p.formula) continue;
      formulaParams++;
      assert.ok(r.computed.has(p.name), `${path.basename(file)}: ${p.name} not computed`);
      assert.ok(Number.isFinite(r.values[p.name]), `${path.basename(file)}: ${p.name} not finite`);
    }
  }
  assert.strictEqual(families, 57, `expected 57 seed families, found ${families}`);
  assert.strictEqual(formulaParams, 65, `expected 65 seed formula params, found ${formulaParams}`);
});

t("corpus: seed formula shapes with fixed seeds", () => {
  assert.ok(near(evalOneValue("= width * depth", { width: 2, depth: 3, height: 4 }), 6));
  assert.ok(near(evalOneValue("= width * depth * height", { width: 2, depth: 3, height: 4 }), 24));
  assert.ok(near(evalOneValue("= width * height", { width: 2, depth: 3, height: 4 }), 8));
});

// ── 3. Enhanced-only capabilities ─────────────────────────────────────
t("enhanced: scientific notation parses", () => {
  assert.ok(near(evalOneValue("= 1e-7 * 10"), 1e-6));
  assert.ok(near(evalOneValue("= 2.5e3"), 2500));
  assert.ok(near(evalOneValue("= 1.5E-3 + 0.001", {}), 0.0025));
});

t("enhanced: string and boolean results", () => {
  assert.strictEqual(evalOneValue('= "hello"'), "hello");
  assert.strictEqual(evalOneValue('= if(a > 1, "big", "small")', { a: 2 }), "big");
  assert.strictEqual(evalOneValue('= if(a > 1, "big", "small")', { a: 0 }), "small");
  // Numeric parameters store logic results as 1/0, as the old engine did.
  const r = evalOne('= true', {});
  assert.strictEqual(r.values.__out, 1);
  // Yes/No parameters keep real booleans (old engine stored 1/0 here too).
  const rb = eng.evaluateParameters([
    { name: "a", type: "number", scope: "type", default: 2 },
    { name: "flag", type: "boolean", scope: "type", default: false, formula: "= a > 1" },
  ], { a: 2 });
  assert.strictEqual(rb.errors.length, 0);
  assert.strictEqual(rb.values.flag, true);
});

t("enhanced: degree trig, xor, to_* converters", () => {
  assert.ok(near(evalOneValue("= sind(30)"), 0.5));
  assert.ok(near(evalOneValue("= cosd(60)"), 0.5));
  assert.ok(near(evalOneValue("= tand(45)"), 1));
  // Logic builtins return booleans; numeric parameters store them as 1/0.
  assert.strictEqual(evalOneValue("= xor(1, 0)"), 1);
  assert.strictEqual(evalOneValue("= xor(1, 1)"), 0);
  assert.ok(near(evalOneValue("= to_mm(1)"), 1000));
  assert.ok(near(evalOneValue("= to_cm(1)"), 100));
  assert.ok(near(evalOneValue("= to_ft(0.3048)"), 1));
  assert.ok(near(evalOneValue("= to_in(0.0254)"), 1));
  assert.ok(near(evalOneValue("= to_deg(3.141592653589793)"), 180));
});

t("enhanced: precise error messages name the cause", () => {
  const r = evalOne("= nosuchvar * 2", { a: 2 });
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /nosuchvar/);
  const r2 = evalOne("= nosuchfn(1)", { a: 2 });
  assert.strictEqual(r2.errors.length, 1);
  assert.match(r2.errors[0].message, /nosuchfn/);
  const r3 = evalOne("= a +", { a: 2 });
  assert.strictEqual(r3.errors.length, 1);
  const r4 = evalOne("= 1 / 0", { a: 2 });
  assert.strictEqual(r4.errors.length, 1);
  assert.match(r4.errors[0].message, /non-finite/);
});

t("enhanced: dependency graph and dependentsOf", () => {
  const decls = [
    { name: "w", type: "number", scope: "type", default: 2 },
    { name: "h", type: "number", scope: "type", default: 3 },
    { name: "area", type: "number", scope: "type", default: 0, formula: "= w * h" },
    { name: "perim", type: "number", scope: "type", default: 0, formula: "= 2 * (w + h)" },
    { name: "dbl", type: "number", scope: "type", default: 0, formula: "= area * 2" },
  ];
  const r = eng.evaluateParameters(decls, { w: 2, h: 3 });
  assert.strictEqual(r.errors.length, 0);
  assert.deepStrictEqual(r.dependencies, {
    w: [], h: [], area: ["w", "h"], perim: ["w", "h"], dbl: ["area"],
  });
  assert.deepStrictEqual([...eng.dependentsOf(decls, "w")].sort(), ["area", "dbl", "perim"]);
  assert.deepStrictEqual(eng.dependentsOf(decls, "area"), ["dbl"]);
  assert.deepStrictEqual(eng.dependentsOf(decls, "dbl"), []);
});

// ── 4. Preserved old-engine behaviour ──────────────────────────────────
t("compat: ^ power operator (incl. right associativity) and **", () => {
  assert.ok(near(evalOneValue("= x ^ 2", { x: 2 }), 4));
  assert.ok(near(evalOneValue("= x ** 2", { x: 2 }), 4));
  assert.ok(near(evalOneValue("= 2 ^ 3 ^ 2"), 512));
  assert.ok(near(evalOneValue("= 2 ** 3"), 8));
});

t("compat: infix word operators and prefix not", () => {
  assert.strictEqual(evalOneValue("= a > 1 and b > 1", { a: 2, b: 3 }), 1);
  assert.strictEqual(evalOneValue("= a > 5 or b > 1", { a: 2, b: 3 }), 1);
  assert.strictEqual(evalOneValue("= a > 5 or b > 5", { a: 2, b: 3 }), 0);
  assert.strictEqual(evalOneValue("= not (a > 5)", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= a eq 2", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= a ne 2", { a: 2 }), 0);
  assert.strictEqual(evalOneValue("= a lt 3", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= a le 2", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= a gt 1", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= a ge 2", { a: 2 }), 1);
  // Function-call forms are untouched by the rewrite and still resolve.
  // (They return booleans; numeric parameters store them as 1/0.)
  assert.strictEqual(evalOneValue("= and(a > 1, b > 1)", { a: 2, b: 3 }), 1);
  assert.strictEqual(evalOneValue("= eq(a, 2)", { a: 2 }), 1);
  assert.strictEqual(evalOneValue("= not(a > 5)", { a: 2 }), 1);
});

t("compat: word operators are not rewritten inside string literals", () => {
  assert.strictEqual(evalOneValue('= if(a > 1, "bread and butter", "plain")', { a: 2 }), "bread and butter");
  assert.strictEqual(evalOneValue('= if(a > 1, "x or y", "z")', { a: 2 }), "x or y");
});

t("compat: parameter names containing operator words are untouched", () => {
  assert.ok(near(evalOneValue("= standard * 2", { standard: 2 }), 4));
  assert.ok(near(evalOneValue("= android + 1", { android: 1 }), 2));
});

t("compat: evaluateFormula keeps the null-on-error contract", () => {
  assert.strictEqual(typeof eng.evaluateFormula, "function");
  // NumberRef exprs used by parametric-geometry resolveNumber().
  assert.strictEqual(eng.evaluateFormula("thickness / 2", { thickness: 2 }), 1);
  assert.strictEqual(eng.evaluateFormula("elevation + depth / 2", { elevation: 3, depth: 4 }), 5);
  assert.strictEqual(eng.evaluateFormula("nosuchvar * 2", { a: 2 }), null);
  assert.strictEqual(eng.evaluateFormula("a +", { a: 2 }), null);
  assert.strictEqual(eng.evaluateFormula("", { a: 2 }), null);
  assert.strictEqual(eng.evaluateFormula("   ", { a: 2 }), null);
  assert.strictEqual(eng.evaluateFormula("1 / 0", {}), null);
  assert.strictEqual(eng.evaluateFormula("= true", {}), 1);
  assert.strictEqual(eng.evaluateFormula("= false", {}), 0);
  assert.strictEqual(eng.evaluateFormula("= 2 ^ 3", {}), 8);
  assert.strictEqual(eng.evaluateFormula("= a > 1 and b > 1", { a: 2, b: 3 }), 1);
});

t("compat: cycles, self-reference, integer rounding, clamps", () => {
  const cyc = [
    { name: "a", type: "number", scope: "type", default: 0, formula: "= b + 1" },
    { name: "b", type: "number", scope: "type", default: 0, formula: "= a + 1" },
  ];
  const r = eng.evaluateParameters(cyc, {});
  assert.strictEqual(r.errors.length, 2);
  assert.ok(r.errors.every((e) => /Cycle detected/.test(e.message)));
  assert.strictEqual(r.values.a, 0);
  assert.strictEqual(r.values.b, 0);
  const self = [{ name: "a", type: "number", scope: "type", default: 5, formula: "= a + 1" }];
  const r2 = eng.evaluateParameters(self, {});
  assert.strictEqual(r2.errors.length, 1);
  assert.match(r2.errors[0].message, /Cycle detected/);
  assert.strictEqual(r2.values.a, 5);
  const clamp = [{ name: "a", type: "integer", scope: "type", default: 0, min: 0, max: 10, formula: "= 7.6" }];
  assert.strictEqual(eng.evaluateParameters(clamp, {}).values.a, 8);
  const clamp2 = [{ name: "a", type: "number", scope: "type", default: 0, min: 0, max: 10, formula: "= 99" }];
  assert.strictEqual(eng.evaluateParameters(clamp2, {}).values.a, 10);
  const clamp3 = [{ name: "a", type: "number", scope: "type", default: 0, min: 5, max: 10, formula: "= 1" }];
  assert.strictEqual(eng.evaluateParameters(clamp3, {}).values.a, 5);
});

t("compat: ternary, modulo, nested functions, units, = prefix", () => {
  assert.strictEqual(evalOneValue("= a > 1 ? 10 : 20", { a: 2 }), 10);
  assert.strictEqual(evalOneValue("= a > 5 ? 1 : a > 1 ? 2 : 3", { a: 2 }), 2);
  assert.strictEqual(evalOneValue("= 7 % 3"), 1);
  assert.ok(near(evalOneValue("= round(sqrt(2) * 100, 1)"), 141.4));
  assert.ok(near(evalOneValue("= deg(180)"), Math.PI));
  assert.ok(near(evalOneValue("= ft(10)"), 3.048));
  assert.ok(near(evalOneValue("= mm(50)"), 0.05));
  assert.ok(near(evalOneValue("Height * 2", { Height: 3 }), 6), "formula without = prefix");
  assert.strictEqual(eng.hasFormulas([{ name: "a", type: "number", scope: "type", default: 0, formula: "= 1" }]), true);
  assert.strictEqual(eng.hasFormulas([{ name: "a", type: "number", scope: "type", default: 0 }]), false);
});

t("compat: topo order follows dependencies, not declaration order", () => {
  const decls = [
    { name: "area", type: "number", scope: "type", default: 0, formula: "= w * h" },
    { name: "w", type: "number", scope: "type", default: 2 },
    { name: "h", type: "number", scope: "type", default: 3 },
  ];
  const r = eng.evaluateParameters(decls, { w: 2, h: 3 });
  assert.strictEqual(r.errors.length, 0);
  assert.strictEqual(r.values.area, 6);
  assert.ok(r.order.indexOf("w") < r.order.indexOf("area"));
  assert.ok(r.order.indexOf("h") < r.order.indexOf("area"));
});

// ── 5. Dead code stays deleted; registration ───────────────────────────
t("dead code: formula-engine-enhanced.ts does not exist and is not imported", () => {
  assert.ok(!fs.existsSync(path.join(root, "src/modules/families/formula-engine-enhanced.ts")));
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) continue;
      let src = fs.readFileSync(p, "utf8");
      // formula-engine.ts itself records the history in its header
      // comment ("formerly formula-engine-enhanced.ts"); that mention
      // is documentation, not a live reference.
      if (path.basename(p) === "formula-engine.ts") {
        src = src.replace(/\(formerly formula-engine-enhanced\.ts\)/g, "");
      }
      if (src.includes("formula-engine-enhanced")) hits.push(path.relative(root, p));
    }
  };
  walk(path.join(root, "src"));
  assert.deepStrictEqual(hits, []);
});

t("test registered in package.json and CI manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["test:formula-engine"], "node tests/formula-engine.test.cjs");
  const manifest = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert.ok(manifest.includes('"test:formula-engine"'), "CI manifest must run this suite");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
