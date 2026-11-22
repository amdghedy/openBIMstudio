/**
 * tests/dimensional-analysis.test.cjs
 *
 * PE-01 — dimensional analysis for family formulas
 * (ENGINE_UPGRADE_PLAN.md §3 PE-01; audit R2).
 *
 * Before this change units were decoration: a parameter's type/unit was
 * never checked during evaluation, mm/ft were plain numeric scalings, and
 * `Length + Area` evaluated silently to a wrong number. Now dimensions
 * are carried through the formula AST (src/modules/families/
 * formula-dimensions.ts) and ill-typed formulas are rejected with a named
 * DimensionError through the existing per-parameter error path.
 *
 * What this suite pins:
 *   1. Rejections: Length + Area / Length - Area (dimension-mismatch),
 *      round(Length) / floor / log / exp / mm(Length) (non-dimensionless-
 *      argument), to_mm(Area) and a length declared with unit "m2"
 *      (unit-confusion) — each with its named code, the parameter keeping
 *      its default, and the other parameters still evaluating.
 *   2. SI conversion: mm + m, ft + m, mm2 + m2, cm3 + m3 convert before
 *      arithmetic; stored values come back in SI. Angles are the
 *      exception and stay in their declared unit (degrees): the live
 *      corpus consumes them as degrees and converts explicitly
 *      ("rotation * pi() / 180"), so converting them would double-convert.
 *   3. Function-dimension rules: sin/cos/tan take dimensionless radians
 *      only (an angle argument is rejected and directed to sind()/deg(),
 *      because sin(degrees) would be a silent wrong number);
 *      sind/cosd/tand take an angle or a dimensionless value (degrees);
 *      asin/atan take dimensionless in and return an angle (radians —
 *      to_deg() is the bridge to a degree-stored target), sqrt (halves),
 *      pow (dimensionless exponent, scales), min/max/if/comparisons (same
 *      dimension), string `+` stays concatenation ("W-" + width).
 *   4. Target-dimension checks: a dimensional target must match the
 *      inferred result; a `number` target accepts any dimension (the
 *      corpus declares section inertia, L^4, as number).
 *   5. Corpus invariance: every valid formula in the live corpus still
 *      evaluates to its previous value — all 11 built-in families, all
 *      57 seed families (65 formula params), the sample parametric door
 *      (incl. the fixed "m-" unit typo), and the 24 TS-source golden
 *      formulas re-declared with their real types.
 *   6. The typed evaluateFormula overload + checkFormulaDimensions, and
 *      the untyped one-off path staying untyped (legacy behaviour).
 *   7. The rules this change deliberately does NOT enforce, because the
 *      live suites require them: a dimensional parameter with no unit is
 *      read as SI; a seed-only name has unknown dimension; a bare literal
 *      is polymorphic (`Width - 0.08` reads 0.08 as metres).
 *
 * Run: `node tests/dimensional-analysis.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "da-"));
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execSync(
  `npx tsc src/modules/families/formula-engine.ts src/modules/families/formula-dimensions.ts src/modules/families/safe-expr.ts src/modules/families/builtin-families.ts src/modules/families/sample-parametric-door.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { cwd: root, stdio: "inherit" },
);
const findJs = (name) => {
  const files = fs.readdirSync(out, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name === name)
    .map((d) => path.join(d.parentPath || d.path || out, d.name));
  return files[0];
};
const eng = require(findJs("formula-engine.js"));
const dims = require(findJs("formula-dimensions.js"));
const builtin = require(findJs("builtin-families.js"));
const doorMod = require(findJs("sample-parametric-door.js"));

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

const L = (name, extra = {}) => ({ name, type: "length", scope: "type", default: 0, editable: true, unit: "m", ...extra });
const A = (name, extra = {}) => ({ name, type: "area", scope: "type", default: 0, editable: true, unit: "m2", ...extra });
const V = (name, extra = {}) => ({ name, type: "volume", scope: "type", default: 0, editable: true, unit: "m3", ...extra });
const N = (name, extra = {}) => ({ name, type: "number", scope: "type", default: 0, editable: true, ...extra });
const ANG = (name, extra = {}) => ({ name, type: "angle", scope: "type", default: 0, editable: true, unit: "deg", ...extra });
const B = (name, extra = {}) => ({ name, type: "boolean", scope: "type", default: false, editable: true, ...extra });
const INT = (name, extra = {}) => ({ name, type: "integer", scope: "type", default: 0, editable: true, ...extra });

function evalOne(formula, decls, seeds = {}) {
  return eng.evaluateParameters(decls, seeds);
}
function dimErrorFor(formula, decls, seeds = {}) {
  const outName = "__out";
  const r = evalOne(formula, [...decls, N(outName, { formula })], seeds);
  return r.errors.find((e) => e.parameter === outName) ?? null;
}

// ── 1. Rejections with named errors ──────────────────────────────────────

t("reject: Length + Area is a dimension-mismatch, keeps default, others still evaluate", () => {
  const r = eng.evaluateParameters([
    L("width", { default: 2 }),
    A("area", { default: 3 }),
    L("sum", { default: 7, formula: "= width + area" }),
    L("ok", { default: 0, formula: "= width * 2" }),
  ], {});
  assert.strictEqual(r.errors.length, 1, JSON.stringify(r.errors));
  assert.strictEqual(r.errors[0].parameter, "sum");
  assert.match(r.errors[0].message, /DimensionError \[dimension-mismatch\]/);
  assert.match(r.errors[0].message, /length and area/);
  assert.strictEqual(r.values.sum, 7, "failed formula keeps its default");
  assert.ok(near(r.values.ok, 4), "unrelated formula still evaluates");
  assert.ok(r.computed.has("ok"));
  assert.ok(!r.computed.has("sum"), "rejected formula is not marked computed");
});

t("reject: Length - Area, Area + Volume, Length + Length^2 all mismatch", () => {
  for (const formula of ["= width - area", "= area + vol", "= width + width * width"]) {
    const e = dimErrorFor(formula, [L("width", { default: 2 }), A("area", { default: 3 }), V("vol", { default: 4 })]);
    assert.ok(e, `${formula} must error`);
    assert.match(e.message, /DimensionError \[dimension-mismatch\]/, formula);
  }
});

t("reject: round/floor/ceil/log/exp of a length are non-dimensionless-argument", () => {
  for (const formula of ["= round(width)", "= floor(width)", "= ceil(width)", "= log(width)", "= exp(width)", "= log10(width)"]) {
    const e = dimErrorFor(formula, [L("width", { default: 2 })]);
    assert.ok(e, `${formula} must error`);
    assert.match(e.message, /DimensionError \[non-dimensionless-argument\]/, formula);
  }
  // The same functions on dimensionless values still work.
  const r = eng.evaluateParameters([
    N("x", { default: 2.5 }),
    N("a", { default: 0, formula: "= round(x)" }),
    N("b", { default: 0, formula: "= floor(x)" }),
    N("c", { default: 0, formula: "= log(10)" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.values.a, 3);
  assert.strictEqual(r.values.b, 2);
  assert.ok(near(r.values.c, Math.log(10)));
});

t("reject: unit-confusion — to_mm(area), mm(length), length declared with unit m2", () => {
  const e1 = dimErrorFor("= to_mm(area)", [A("area", { default: 3 })]);
  assert.ok(e1);
  assert.match(e1.message, /DimensionError \[unit-confusion\]/);
  assert.match(e1.message, /to_mm\(\) expects a length/);
  const e2 = dimErrorFor("= mm(width)", [L("width", { default: 2 })]);
  assert.ok(e2);
  assert.match(e2.message, /DimensionError \[non-dimensionless-argument\]/);
  // A length declared with a unit that is not a length unit: any formula
  // touching it is rejected, and so is a formula it targets.
  const r = eng.evaluateParameters([
    L("bad", { default: 2, unit: "m2" }),
    L("usesBad", { default: 0, formula: "= bad * 2" }),
    L("badTarget", { default: 0, unit: "m2", formula: "= 2" }),
    L("fine", { default: 0, formula: "= 2" }),
  ], {});
  assert.strictEqual(r.errors.length, 2, JSON.stringify(r.errors));
  assert.ok(r.errors.every((e) => /DimensionError \[unit-confusion\]/.test(e.message)));
  assert.deepStrictEqual(r.errors.map((e) => e.parameter).sort(), ["badTarget", "usesBad"]);
  assert.strictEqual(r.values.fine, 2, "unrelated formula still evaluates");
});

t("reject: undeclared name in a dimensional context is an error, not a silent default", () => {
  const r = eng.evaluateParameters([
    L("width", { default: 2 }),
    L("sum", { default: 0, formula: "= width + ghost" }),
  ], {});
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /Unknown name "ghost"/);
  assert.strictEqual(r.values.sum, 0);
});

// ── 2. SI conversion ─────────────────────────────────────────────────────

t("convert: mm + m converts to SI before arithmetic; stored values are SI", () => {
  const r = eng.evaluateParameters([
    L("wMm", { default: 900, unit: "mm" }),
    L("hM", { default: 1.1, unit: "m" }),
    L("sum", { default: 0, formula: "= wMm + hM" }),
    L("diff", { default: 0, formula: "= wMm - hM" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.wMm, 0.9), `wMm stored SI, got ${r.values.wMm}`);
  assert.ok(near(r.values.sum, 2.0), `900mm + 1.1m = 2.0m, got ${r.values.sum}`);
  assert.ok(near(r.values.diff, -0.2), `900mm - 1.1m = -0.2m, got ${r.values.diff}`);
});

t("convert: ft, mm2 and cm3 convert to SI; angles stay in declared units (degrees)", () => {
  const r = eng.evaluateParameters([
    L("wFt", { default: 10, unit: "ft" }),
    L("hM", { default: 1, unit: "m" }),
    L("sumFt", { default: 0, formula: "= wFt + hM" }),
    A("aMm2", { default: 1000000, unit: "mm2" }),
    A("aM2", { default: 2, unit: "m2" }),
    A("sumA", { default: 0, formula: "= aMm2 + aM2" }),
    V("vCm3", { default: 1000000, unit: "cm3" }),
    V("vM3", { default: 2, unit: "m3" }),
    V("sumV", { default: 0, formula: "= vCm3 + vM3" }),
    // Angles are NOT converted: the corpus stores them in degrees and
    // converts explicitly at the point of use ("rotation * pi() / 180").
    ANG("aDeg", { default: 180, unit: "deg" }),
    ANG("aZero", { default: 0, unit: "rad" }),
    ANG("sumAng", { default: 0, formula: "= aDeg + aZero" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.sumFt, 4.048), `10ft + 1m, got ${r.values.sumFt}`);
  assert.ok(near(r.values.sumA, 3), `1e6mm2 + 2m2, got ${r.values.sumA}`);
  assert.ok(near(r.values.sumV, 3), `1e6cm3 + 2m3, got ${r.values.sumV}`);
  assert.ok(near(r.values.sumAng, 180), `180deg + 0 stays 180 (degrees), got ${r.values.sumAng}`);
  assert.ok(near(r.values.aDeg, 180), "angle stored in its declared unit, not radians");
});

t("convert: type values in declared units convert; min/max clamp in declared-unit space", () => {
  // Type value 900 (mm) + 1.1 (m), seeded as a type value.
  const r = eng.evaluateParameters([
    L("wMm", { default: 0, unit: "mm" }),
    L("hM", { default: 1.1, unit: "m" }),
    L("sum", { default: 0, formula: "= wMm + hM" }),
  ], { wMm: 900 });
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.sum, 2.0));
  // Clamp: 2 m = 2000 mm exceeds max 1500 mm -> stored 1.5 (SI).
  const r2 = eng.evaluateParameters([
    L("x", { default: 0, unit: "mm", min: 500, max: 1500, formula: "= 2" }),
    L("y", { default: 0, unit: "mm", min: 500, max: 1500, formula: "= 0.1" }),
  ], {});
  assert.strictEqual(r2.errors.length, 0, JSON.stringify(r2.errors));
  assert.ok(near(r2.values.x, 1.5), `clamped to max 1500mm, got ${r2.values.x}`);
  assert.ok(near(r2.values.y, 0.5), `clamped to min 500mm, got ${r2.values.y}`);
});

t("convert: toDeclaredUnits round-trips SI back to declared units", () => {
  const decls = [L("w", { default: 900, unit: "mm" }), L("h", { default: 1, unit: "m" })];
  const back = eng.toDeclaredUnits({ w: 0.9, h: 1, extra: 5 }, decls);
  assert.ok(near(back.w, 900));
  assert.ok(near(back.h, 1));
  assert.strictEqual(back.extra, 5, "seed-only names pass through");
});

// ── 3. Function-dimension rules ──────────────────────────────────────────

t("functions: sin/cos/tan take dimensionless radians; sind takes degrees; sin(angle) is rejected", () => {
  const ok = eng.evaluateParameters([
    ANG("a", { default: 90, unit: "deg" }),
    N("x", { default: 0.5 }),
    N("s1", { default: 0, formula: "= sind(a)" }),
    N("s2", { default: 0, formula: "= sin(0.5)" }),
    N("s3", { default: 0, formula: "= sind(30)" }),
    N("s4", { default: 0, formula: "= cosd(60)" }),
  ], {});
  assert.strictEqual(ok.errors.length, 0, JSON.stringify(ok.errors));
  assert.ok(near(ok.values.s1, 1), "sind(90deg) = 1");
  assert.ok(near(ok.values.s2, Math.sin(0.5)));
  assert.ok(near(ok.values.s3, 0.5));
  assert.ok(near(ok.values.s4, 0.5));
  // Limitation, pinned: sin(deg(a)) is rejected. deg() returns an
  // angle-typed (radian-valued) result and sin() takes dimensionless
  // radians; the dimension alone cannot distinguish a radian-valued
  // angle from a degree-stored one, so the safe rule rejects and sind()
  // is the bridge for degree-stored angles.
  const eSinDeg = dimErrorFor("= sin(deg(a))", [ANG("a", { default: 90, unit: "deg" })]);
  assert.ok(eSinDeg);
  assert.match(eSinDeg.message, /DimensionError \[non-dimensionless-argument\]/);
  // sin/cos/tan on an angle-typed (degree-stored) value would compute
  // sin(degrees) — a silent wrong number — so it is rejected and the
  // message directs to sind() / deg().
  for (const formula of ["= sin(a)", "= cos(a)", "= tan(a)"]) {
    const e = dimErrorFor(formula, [ANG("a", { default: 90, unit: "deg" })]);
    assert.ok(e, formula);
    assert.match(e.message, /DimensionError \[non-dimensionless-argument\]/, formula);
    assert.match(e.message, /sind\(\)|deg\(\)/, formula);
  }
  // sind() on a length is still a plain dimension mismatch.
  const eSind = dimErrorFor("= sind(width)", [L("width", { default: 2 })]);
  assert.ok(eSind);
  assert.match(eSind.message, /DimensionError \[dimension-mismatch\]/);
  // asin/atan: dimensionless in, angle out (value in radians);
  // to_deg() is the bridge to a degree-stored target.
  const e = dimErrorFor("= asin(width)", [L("width", { default: 2 })]);
  assert.match(e.message, /DimensionError \[non-dimensionless-argument\]/);
  const r = eng.evaluateParameters([
    N("u", { default: 0.5 }),
    ANG("ang", { default: 0, formula: "= asin(u)" }),
    N("degOut", { default: 0, formula: "= to_deg(asin(u))" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.ang, Math.asin(0.5)), "asin value is in radians");
  assert.ok(near(r.values.degOut, 30), "to_deg(asin(0.5)) = 30 degrees");
  // deg() accepts an angle-typed value (both are numbers of degrees);
  // rad() does not (it would misread degrees as radians).
  const eDeg = dimErrorFor("= rad(a)", [ANG("a", { default: 90, unit: "deg" })]);
  assert.ok(eDeg);
  assert.match(eDeg.message, /DimensionError \[non-dimensionless-argument\]/);
  const eDeg2 = dimErrorFor("= deg(width)", [L("width", { default: 2 })]);
  assert.ok(eDeg2);
  assert.match(eDeg2.message, /DimensionError \[dimension-mismatch\]/);
});

t("functions: sqrt halves, pow scales by a dimensionless exponent", () => {
  const r = eng.evaluateParameters([
    L("width", { default: 2 }),
    L("depth", { default: 3 }),
    A("area", { default: 6 }),
    L("diag", { default: 0, formula: "= sqrt(width ^ 2 + depth ^ 2)" }),
    L("root", { default: 0, formula: "= sqrt(area)" }),
    A("sq", { default: 0, formula: "= width ^ 2" }),
    A("sq2", { default: 0, formula: "= pow(width, 2)" }),
    N("vol4", { default: 0, formula: "= width ^ 4" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.diag, Math.sqrt(13)));
  assert.ok(near(r.values.root, Math.sqrt(6)));
  assert.ok(near(r.values.sq, 4));
  assert.ok(near(r.values.sq2, 4));
  assert.ok(near(r.values.vol4, 16), "L^4 into a number target is the legacy escape");
  // sqrt(length) is L^0.5: it cannot target a length (a number target
  // would accept it via the legacy escape, so pin it with a length target).
  const rSqrt = eng.evaluateParameters([
    L("width", { default: 2 }),
    L("root", { default: 0, formula: "= sqrt(width)" }),
  ], {});
  assert.strictEqual(rSqrt.errors.length, 1, JSON.stringify(rSqrt.errors));
  assert.match(rSqrt.errors[0].message, /DimensionError \[dimension-mismatch\]/);
  // A dimensional exponent is rejected.
  const e2 = dimErrorFor("= width ^ depth", [L("width", { default: 2 }), L("depth", { default: 3 })]);
  assert.ok(e2);
  assert.match(e2.message, /DimensionError \[non-dimensionless-argument\]/);
});

t("functions: min/max/if/comparisons require the same dimension; literals unify", () => {
  const r = eng.evaluateParameters([
    L("w", { default: 2 }),
    L("h", { default: 3 }),
    L("m1", { default: 0, formula: "= min(w, h)" }),
    L("m2", { default: 0, formula: "= min(w * 0.5, 0.5)" }),
    L("m3", { default: 0, formula: "= max(w, 5)" }),
    B("flag", { default: true }),
    L("picked", { default: 0, formula: "= if(flag, w, h)" }),
    N("cmp", { default: 0, formula: "= w > h" }),
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.values.m1, 2);
  assert.strictEqual(r.values.m2, 0.5);
  assert.strictEqual(r.values.m3, 5);
  assert.strictEqual(r.values.picked, 2);
  assert.strictEqual(r.values.cmp, 0);
  const e1 = dimErrorFor("= min(w, a)", [L("w", { default: 2 }), A("a", { default: 3 })]);
  assert.match(e1.message, /DimensionError \[dimension-mismatch\]/);
  const e2 = dimErrorFor("= w > a", [L("w", { default: 2 }), A("a", { default: 3 })]);
  assert.match(e2.message, /DimensionError \[dimension-mismatch\]/);
  const e3 = dimErrorFor("= if(flag, w, a)", [L("w", { default: 2 }), A("a", { default: 3 }), B("flag", { default: true })]);
  assert.match(e3.message, /DimensionError \[dimension-mismatch\]/);
});

t("functions: string + stays concatenation; text in arithmetic is a mismatch", () => {
  const r = eng.evaluateParameters([
    L("width", { default: 2 }),
    { name: "label", type: "text", scope: "type", default: "", editable: true, formula: '"W-" + width' },
  ], {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.strictEqual(r.values.label, "W-2");
  const e = dimErrorFor('= "W-" - width', [L("width", { default: 2 })]);
  assert.ok(e);
  assert.match(e.message, /DimensionError \[dimension-mismatch\]/);
});

// ── 4. Target-dimension checks ───────────────────────────────────────────

t("target: a dimensional target must match the inferred result dimension", () => {
  const e1 = dimErrorFor("= width * height", [L("width", { default: 2 }), L("height", { default: 3 })], {});
  // __out is number-typed here, so this passes (legacy escape); check the
  // real target mismatch with an area-typed __out instead.
  assert.strictEqual(e1, null, "number target accepts an area result");
  const r = eng.evaluateParameters([
    L("width", { default: 2 }),
    L("height", { default: 3 }),
    A("bad", { default: 0, formula: "= width + height" }),
    L("bad2", { default: 0, formula: "= width * height" }),
  ], {});
  assert.strictEqual(r.errors.length, 2, JSON.stringify(r.errors));
  assert.ok(r.errors.every((e) => /DimensionError \[dimension-mismatch\]/.test(e.message)));
  assert.match(r.errors.find((e) => e.parameter === "bad").message, /area/);
  assert.match(r.errors.find((e) => e.parameter === "bad2").message, /length/);
});

// ── 5. Deliberate non-enforcement, pinned ───────────────────────────────

t("pinned: unit-less dimensional parameter reads as SI; seed-only name is unknown; literal is polymorphic", () => {
  const r = eng.evaluateParameters([
    { name: "width", type: "length", scope: "type", default: 2, editable: true },
    L("height", { default: 3 }),
    L("sum", { default: 0, formula: "= width + height" }),
    L("lit", { default: 0, formula: "= width - 0.08" }),
    N("a", { default: 0, formula: "= seeded + 1" }),
  ], { seeded: 41 });
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.sum, 5));
  assert.ok(near(r.values.lit, 1.92));
  assert.strictEqual(r.values.a, 42);
});

// ── 6. Corpus invariance ─────────────────────────────────────────────────

t("corpus: all 11 built-in families evaluate with zero formula errors", () => {
  const families = builtin.createBuiltInFamilies();
  assert.strictEqual(families.length, 11);
  for (const f of families) {
    const res = eng.evaluateParameters(f.parameters, {});
    assert.strictEqual(res.errors.length, 0, `${f.name}: ${JSON.stringify(res.errors)}`);
  }
  const pipe = families.find((f) => f.id.startsWith("builtin-pipe-"));
  const pipeRes = eng.evaluateParameters(pipe.parameters, { ...pipe.types.find((x) => x.name === "DN 100").values });
  assert.strictEqual(pipeRes.errors.length, 0, JSON.stringify(pipeRes.errors));
  assert.ok(near(pipeRes.values.circumference, Math.PI * 0.1));
  assert.ok(near(pipeRes.values.crossSectionArea, Math.PI * 0.05 * 0.05));
  const wall = families.find((f) => f.name === "Basic Wall");
  const wallRes = eng.evaluateParameters(wall.parameters, { thickness: 0.3 });
  assert.strictEqual(wallRes.errors.length, 0, JSON.stringify(wallRes.errors));
  assert.ok(near(wallRes.values.areaPerMeter, 0.9), `wall areaPerMeter, got ${wallRes.values.areaPerMeter}`);
  const beam = families.find((f) => f.name === "Basic Beam");
  const beamRes = eng.evaluateParameters(beam.parameters, {});
  assert.strictEqual(beamRes.errors.length, 0, JSON.stringify(beamRes.errors));
  // Section inertia is L^4 declared as number: still evaluates, unchanged.
  assert.ok(near(beamRes.values.sectionInertia, (0.25 * 0.5 * 0.5 * 0.5) / 12));
});

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

t("corpus: sample parametric door evaluates cleanly with real types (incl. fixed m2 units)", () => {
  const fam = doorMod.createParametricDoorFamily();
  // The two reporting params used to carry the corrupt unit "m-".
  for (const name of ["Report_Area", "Report_LeafArea"]) {
    const p = fam.parameters.find((x) => x.name === name);
    assert.strictEqual(p.unit, "m2", `${name} unit`);
  }
  for (const type of fam.types) {
    const r = eng.evaluateParameters(fam.parameters, { ...type.values });
    assert.strictEqual(r.errors.length, 0, `${type.name}: ${JSON.stringify(r.errors)}`);
  }
  const single = eng.evaluateParameters(fam.parameters, { Width: 0.9, Height: 2.1, LeafCount: 1 });
  assert.strictEqual(single.errors.length, 0, JSON.stringify(single.errors));
  assert.ok(near(single.values.OpeningWidth, 0.82));
  assert.ok(near(single.values.HalfPanelWidth, 0.4));
  assert.ok(near(single.values.Report_Area, 1.89));
  assert.ok(near(single.values.Report_LeafArea, 0.82 * 2.02));
  const dbl = eng.evaluateParameters(fam.parameters, { Width: 1.8, Height: 2.1, LeafCount: 2 });
  assert.strictEqual(dbl.errors.length, 0, JSON.stringify(dbl.errors));
  assert.ok(near(dbl.values.Report_LeafArea, 1.72 * 2.02));
});

t("corpus: TS-source golden formulas evaluate identically under their real types", () => {
  // Same golden values as tests/formula-engine.test.cjs, but every
  // parameter declared with its real type/unit instead of "number".
  const decls = [
    L("thickness", { default: 2 }),
    L("height", { default: 2 }),
    L("depth", { default: 2 }),
    A("areaPerMeter", { default: 0, formula: "= thickness * height" }),
    N("slenderness", { default: 0, formula: "= height / thickness" }),
    V("concreteVolume", { default: 0, formula: "= thickness * depth * height" }),
    N("slenderness2", { default: 0, formula: "= height / min(thickness, depth)" }),
    N("sectionInertia", { default: 0, formula: "= (thickness * height * height * height) / 12" }),
    INT("LeafCount", { default: 2 }),
    B("IsDouble", { default: false, formula: "= eq(LeafCount, 2)" }),
    L("Width", { default: 2 }),
    L("Height", { default: 2 }),
    L("OpeningWidth", { default: 0, formula: "= Width - 0.08" }),
    L("OpeningHeight", { default: 0, formula: "= Height - 0.08" }),
    L("HalfPanelWidth", { default: 0, formula: "= OpeningWidth / 2 - 0.01" }),
    L("LeftPanelX", { default: 0, formula: "= -HalfPanelWidth / 2 - 0.01" }),
    L("RightPanelX", { default: 0, formula: "= HalfPanelWidth / 2 + 0.01" }),
    L("PanelWidth", { default: 0, formula: "= OpeningWidth" }),
    L("PanelHeight", { default: 0, formula: "= OpeningHeight" }),
    L("VisionWidth", { default: 0, formula: "= min(PanelWidth * 0.5, 0.5)" }),
    L("VisionHeight", { default: 0, formula: "= min(PanelHeight * 0.35, 0.8)" }),
    L("VisionZ", { default: 0, formula: "= PanelHeight * 0.55" }),
    L("HandleX", { default: 0, formula: "= if(IsDouble, RightPanelX + HalfPanelWidth * 0.35, PanelWidth * 0.4)" }),
    A("Report_Area", { default: 0, formula: "= Width * Height" }),
    A("Report_LeafArea", { default: 0, formula: "= if(IsDouble, OpeningWidth * OpeningHeight, PanelWidth * PanelHeight)" }),
    L("circumference", { default: 0, formula: "= pi() * thickness" }),
    A("crossSectionArea", { default: 0, formula: "= pi() * (thickness / 2) * (thickness / 2)" }),
  ];
  const r = eng.evaluateParameters(decls, {});
  assert.strictEqual(r.errors.length, 0, JSON.stringify(r.errors));
  assert.ok(near(r.values.areaPerMeter, 4));
  assert.ok(near(r.values.slenderness, 1));
  assert.ok(near(r.values.concreteVolume, 8));
  assert.ok(near(r.values.slenderness2, 1));
  assert.ok(near(r.values.sectionInertia, 1.3333333333333333));
  assert.strictEqual(r.values.IsDouble, 1, "eq() stores 1/0 on a boolean target, as before");
  assert.ok(near(r.values.OpeningWidth, 1.92));
  assert.ok(near(r.values.OpeningHeight, 1.92));
  assert.ok(near(r.values.HalfPanelWidth, 0.95));
  assert.ok(near(r.values.LeftPanelX, -0.485));
  assert.ok(near(r.values.RightPanelX, 0.485));
  assert.ok(near(r.values.VisionWidth, 0.5));
  assert.ok(near(r.values.VisionHeight, 0.672), "min(1.92 * 0.35, 0.8) — PanelHeight here is computed (1.92), not the seed 2 of the old golden harness");
  assert.ok(near(r.values.VisionZ, 1.056), "1.92 * 0.55 — same computed-vs-seed note");
  assert.ok(near(r.values.HandleX, 0.8175), "0.485 + 0.95 * 0.35 — same note");
  assert.ok(near(r.values.Report_Area, 4));
  assert.ok(near(r.values.Report_LeafArea, 3.6864), "1.92 * 1.92 — same note");
  assert.ok(near(r.values.circumference, 6.283185307179586));
  assert.ok(near(r.values.crossSectionArea, 3.141592653589793));
});

// ── 7. Typed one-off evaluation + static check ───────────────────────────

t("typed evaluateFormula: ill-typed returns null with declarations, evaluates untyped without them", () => {
  const decls = [L("width", { default: 2 }), L("height", { default: 3 }), A("area", { default: 6 })];
  assert.strictEqual(eng.evaluateFormula("width + height", { width: 2, height: 3 }, decls), 5);
  assert.strictEqual(eng.evaluateFormula("width + area", { width: 2, area: 6 }, decls), null);
  assert.strictEqual(eng.evaluateFormula("round(width)", { width: 2 }, decls), null);
  assert.strictEqual(eng.evaluateFormula("width * height", { width: 2, height: 3 }, decls), 6);
  // Without declarations the one-off path is untyped, exactly as before.
  assert.strictEqual(eng.evaluateFormula("width + area", { width: 2, area: 6 }), 8);
  assert.strictEqual(eng.evaluateFormula("round(width)", { width: 2.5 }), 3);
});

t("checkFormulaDimensions: infers dimensions and returns the named DimensionError", () => {
  const decls = [L("width", { default: 2 }), L("height", { default: 3 }), A("area", { default: 6 })];
  const ok = eng.checkFormulaDimensions("= width * height", decls);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.dimension, { kind: "dim", dim: { L: 2, M: 0, A: 0 } });
  const bad = eng.checkFormulaDimensions("= width + area", decls);
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.error instanceof dims.DimensionError, `expected DimensionError, got ${bad.error}`);
  assert.strictEqual(bad.error.code, "dimension-mismatch");
  const roundBad = eng.checkFormulaDimensions("= round(width)", decls);
  assert.strictEqual(roundBad.error.code, "non-dimensionless-argument");
  assert.ok(eng.checkFormulaDimensions("= width * 2", decls).ok);
});

// ── 8. Registration ──────────────────────────────────────────────────────

t("test registered in package.json and CI manifest", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts["test:dimensional-analysis"], "node tests/dimensional-analysis.test.cjs");
  const manifest = fs.readFileSync(path.join(root, "scripts/ci-unit-tests.mjs"), "utf8");
  assert.ok(manifest.includes('"test:dimensional-analysis"'), "CI manifest must run this suite");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
