/* Code-referenced calculation checks — ASHRAE (US) duct friction
 * (code-reference-checks.ts, production pressure.ts).
 *
 * Proves: the production Darcy–Weisbach / Colebrook–White duct calc
 * reproduces published ASHRAE Handbook—Fundamentals Ch. 21, Fig. 12
 * friction-chart values at three points (two chart points within the
 * ±10% chart band, one fully hand-worked example within ±2%), the
 * Colebrook solver matches an independent hand iteration to <1%, and
 * every check is labelled with its jurisdiction and reference — exactly
 * one jurisdiction, no compliance claim.
 *
 * Run: `node tests/mep-code-reference-checks.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mcr-"));
execSync(`npx tsc src/modules/mep/code-reference-checks.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "code-reference-checks.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const checks = m.runCodeReferenceChecks();
const byId = Object.fromEntries(checks.map((c) => [c.id, c]));

t("all ASHRAE duct-friction checks pass within their stated bands", () => {
  assert.strictEqual(checks.length, 3);
  for (const c of checks) {
    assert.ok(c.passed, `${c.id}: deviation ${c.deviationPct.toFixed(2)}% exceeds ±${c.tolerancePct}%`);
    console.log(`    ${c.id}: deviation ${c.deviationPct.toFixed(2)}% (band ±${c.tolerancePct}%)`);
  }
});

t("1000 CFM in 13.7-in duct reproduces the chart (0.10 in. w.g./100 ft, 983 fpm)", () => {
  const c = byId["ashrae-duct-friction-1"];
  assert.ok(Math.abs(c.deviationPct) <= 10, "deviation " + c.deviationPct);
  assert.ok(Math.abs(c.computed.frictionRateInWgPer100Ft - 0.1) < 0.01, "rate " + c.computed.frictionRateInWgPer100Ft);
  // Secondary cross-check: the velocity must match the published 983 fpm
  // (confirms the unit conversions, not just the friction factor).
  assert.ok(Math.abs(c.computed.velocityFpm - 983) / 983 <= 0.02, "velocity " + c.computed.velocityFpm + " fpm");
});

t("678 CFM in 12-in duct reproduces the chart (0.10 in. w.g./100 ft, 863 fpm)", () => {
  const c = byId["ashrae-duct-friction-2"];
  assert.ok(Math.abs(c.deviationPct) <= 10, "deviation " + c.deviationPct);
  assert.ok(Math.abs(c.computed.velocityFpm - 863) / 863 <= 0.02, "velocity " + c.computed.velocityFpm + " fpm");
});

t("hand-worked 0.5 m3/s in 300 mm duct matches to <2% (and the solver to <1%)", () => {
  const c = byId["ashrae-duct-friction-3"];
  assert.ok(Math.abs(c.deviationPct) <= 2, "deviation " + c.deviationPct);
  assert.ok(Math.abs(c.computed.totalDropPa - 37.0) / 37.0 <= 0.02, "20 m drop " + c.computed.totalDropPa + " Pa vs 37.0 Pa");
  // Independent hand iteration of Colebrook–White at Re 140,932,
  // ε/D = 0.0003 gives f = 0.01853; the production solver must agree
  // to <1% — this validates the SOLVER, not just the chart.
  assert.ok(Math.abs(c.computed.frictionFactor - 0.01853) / 0.01853 <= 0.01,
    "friction factor " + c.computed.frictionFactor + " vs hand-computed 0.01853");
});

t("exactly one jurisdiction, every check labelled with its reference", () => {
  const jurisdictions = [...new Set(checks.map((c) => c.jurisdiction))];
  assert.deepStrictEqual(jurisdictions, ["ASHRAE (US)"]);
  for (const c of checks) {
    assert.ok(c.reference.includes("ASHRAE Handbook"), c.id + ": reference");
    assert.ok(c.reference.includes("Chapter 21"), c.id + ": chapter");
    assert.ok(c.description.length > 20, c.id + ": description");
    assert.strictEqual(typeof c.deviationPct, "number");
    assert.ok(Number.isFinite(c.deviationPct), c.id + ": finite deviation");
  }
});

t("no check claims code compliance", () => {
  for (const c of checks) {
    const text = (c.reference + " " + c.description).toLowerCase();
    assert.ok(!/is code-compliant|compliant with|certified|approved for permit|meets the code/.test(text), c.id);
  }
});

console.log(`\nmep-code-reference-checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
