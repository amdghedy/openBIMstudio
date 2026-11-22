/**
 * tests/formula-scientific-notation.test.cjs
 *
 * Follow-up 2 of the parametric-families programme: the formula tokenizer
 * in src/modules/families/formula-engine.ts only read [0-9.] numbers, so
 * scientific notation (1e-7) could not parse and the formula failed
 * (evaluateFormula returned null). The fix teaches the tokenizer the
 * exponent form (mantissa, optional e/E, optional sign, digits) and stops
 * identifiersIn() from mistaking the exponent marker for a parameter
 * named "e".
 *
 * Coverage:
 *   - 1e-7, 2.5e3, capital E, explicit + sign, negative exponents
 *   - leading-dot mantissas (.5e2), trailing-dot mantissas (1.e3), 1e0, 0e0
 *   - overflow (1e309) stays non-finite and is rejected, as before
 *   - interaction with identifiers/units: height * 1e-3, mm(1e3), the
 *     builtin e() function, and a variable genuinely named "e"
 *   - exponent sign vs the subtraction operator (5 - 2e-3)
 *   - malformed exponents (1e, 1e+, 1e-, 2.5e) are rejected, not silently
 *     mis-parsed
 *   - evaluateParameters end to end, including the topo-sort case where a
 *     parameter named "e" must NOT become a dependency of "= 1e-7"
 *   - plain numbers still parse (regression guard)
 *
 * Run: `node tests/formula-scientific-notation.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const nassert = require("node:assert");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function near(a, b, tol = 1e-12) {
  if (typeof a !== "number" || typeof b !== "number" || !(Math.abs(a - b) <= tol)) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-formula-sci-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(tmpOut, "node_modules"), "junction");
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/families/formula-engine.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const fe = require(path.join(tmpOut, "modules/families/formula-engine.js"));

// ── 1. Bare scientific-notation literals ────────────────────────────────────
t("1e-7 parses to 1e-7 (the reported failure)", () => {
  near(fe.evaluateFormula("1e-7", {}), 1e-7);
});

t("2.5e3 parses to 2500", () => {
  near(fe.evaluateFormula("2.5e3", {}), 2500);
});

t("capital E works: 1E3 and 1E-7", () => {
  near(fe.evaluateFormula("1E3", {}), 1000);
  near(fe.evaluateFormula("1E-7", {}), 1e-7);
});

t("explicit plus sign works: 1e+7", () => {
  near(fe.evaluateFormula("1e+7", {}), 1e7);
});

t("negative exponents: 2e-3 is 0.002, 5e-1 is 0.5", () => {
  near(fe.evaluateFormula("2e-3", {}), 0.002);
  near(fe.evaluateFormula("5e-1", {}), 0.5);
});

t("leading-dot mantissa: .5e2 is 50", () => {
  near(fe.evaluateFormula(".5e2", {}), 50);
});

t("trailing-dot mantissa: 1.e3 is 1000", () => {
  near(fe.evaluateFormula("1.e3", {}), 1000);
});

t("zero exponents: 1e0 is 1, 0e0 is 0, 3.14e0 is 3.14", () => {
  near(fe.evaluateFormula("1e0", {}), 1);
  near(fe.evaluateFormula("0e0", {}), 0);
  near(fe.evaluateFormula("3.14e0", {}), 3.14);
});

t("overflow stays rejected: 1e309 is null (non-finite, as before)", () => {
  nassert.strictEqual(fe.evaluateFormula("1e309", {}), null);
  near(fe.evaluateFormula("1e308", {}), 1e308, 1e292);
});

// ── 2. Scientific notation inside expressions ──────────────────────────────
t("identifier interaction: height * 1e-3 converts mm to m", () => {
  near(fe.evaluateFormula("height * 1e-3", { height: 3000 }), 3);
});

t("two sci literals: 1e-7 * 1e7 is 1", () => {
  near(fe.evaluateFormula("1e-7 * 1e7", {}), 1, 1e-9);
});

t("addition: 1e-7 + 2e-7 is 3e-7", () => {
  near(fe.evaluateFormula("1e-7 + 2e-7", {}), 3e-7);
});

t("unit helper takes a sci literal: mm(1e3) is 1", () => {
  near(fe.evaluateFormula("mm(1e3)", {}), 1);
});

t("sci literal in a conditional: if(1e-7 > 0, 1, 0) is 1", () => {
  near(fe.evaluateFormula("if(1e-7 > 0, 1, 0)", {}), 1);
});

t("exponent sign is not subtraction: 5 - 2e-3 is 4.998", () => {
  near(fe.evaluateFormula("5 - 2e-3", {}), 4.998);
});

t("parenthesised: (1e-7 + 1) * 2 is ~2", () => {
  near(fe.evaluateFormula("(1e-7 + 1) * 2", {}), 2.0000002, 1e-9);
});

// ── 3. The letter "e" must still work as an identifier ─────────────────────
t("builtin e() still returns Euler's number", () => {
  near(fe.evaluateFormula("e()", {}), Math.E);
});

t("a variable genuinely named e still resolves: e * 2 with e=5 is 10", () => {
  near(fe.evaluateFormula("e * 2", { e: 5 }), 10);
});

t("sci literal and variable e coexist: 1e2 + e with e=5 is 105", () => {
  near(fe.evaluateFormula("1e2 + e", { e: 5 }), 105);
});

// ── 4. Malformed exponents are rejected, not silently mis-parsed ───────────
t("malformed exponents return null: 1e, 1e+, 1e-, 2.5e", () => {
  for (const bad of ["1e", "1e+", "1e-", "2.5e", "1E+", "3e-"]) {
    nassert.strictEqual(fe.evaluateFormula(bad, {}), null, bad);
  }
});

t("malformed mantissa still rejected: 1..2 is null", () => {
  nassert.strictEqual(fe.evaluateFormula("1..2", {}), null);
});

// ── 5. Plain numbers still parse (regression guard) ────────────────────────
t("plain numbers unchanged: 2 + 3, 2.5 * 4, .5, 1000", () => {
  near(fe.evaluateFormula("2 + 3", {}), 5);
  near(fe.evaluateFormula("2.5 * 4", {}), 10);
  near(fe.evaluateFormula(".5", {}), 0.5);
  near(fe.evaluateFormula("1000", {}), 1000);
});

// ── 6. evaluateParameters end to end ───────────────────────────────────────
function param(name, extra = {}) {
  return { name, type: "number", scope: "type", default: 0, editable: true, ...extra };
}

t("evaluateParameters resolves '= 1e-7 * width' with no errors", () => {
  const out = fe.evaluateParameters(
    [param("width", { default: 3000 }), param("tol", { formula: "= 1e-7 * width" })],
    {},
  );
  nassert.deepStrictEqual(out.errors, []);
  near(out.values.tol, 3e-4);
  assert(out.computed.has("tol"), "tol should be marked computed");
});

t("evaluateParameters resolves '= 2.5e3' as a plain sci literal", () => {
  const out = fe.evaluateParameters([param("scale", { formula: "= 2.5e3" })], {});
  nassert.deepStrictEqual(out.errors, []);
  near(out.values.scale, 2500);
});

t("no spurious dependency: '= 1e-7' does not depend on a parameter named e", () => {
  // Before the identifiersIn fix, the "e" in "1e-7" registered as a
  // dependency on parameter "e". Both declaration orders must resolve
  // tiny to 1e-7 regardless of e's value, with no cycle errors.
  for (const decls of [
    [param("e", { default: 5 }), param("tiny", { formula: "= 1e-7" })],
    [param("tiny", { formula: "= 1e-7" }), param("e", { default: 5 })],
  ]) {
    const out5 = fe.evaluateParameters(decls, {});
    const out99 = fe.evaluateParameters(decls, { e: 99 });
    nassert.deepStrictEqual(out5.errors, []);
    nassert.deepStrictEqual(out99.errors, []);
    near(out5.values.tiny, 1e-7);
    near(out99.values.tiny, 1e-7);
    near(out99.values.e, 99);
  }
});

// ── 7. CI registration drift guard ──────────────────────────────────────────
t("test is registered in package.json and ci-unit-tests.mjs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(
    pkg.scripts["test:formula-scientific-notation"] === "node tests/formula-scientific-notation.test.cjs",
    "package.json must define test:formula-scientific-notation",
  );
  const ciList = fs.readFileSync(path.join(root, "scripts", "ci-unit-tests.mjs"), "utf8");
  assert(ciList.includes('"test:formula-scientific-notation"'), "ci-unit-tests.mjs must run test:formula-scientific-notation");
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\nformula-scientific-notation: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
