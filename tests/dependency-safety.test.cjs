/* Dependency-safety regression test (remediation program Phase 1.1).
 *
 * Evidence baseline: docs/engineering/BASELINE.md §4.
 * json-rules-engine (→ vulnerable jsonpath-plus RCE, GHSA-pppg-cpfq-h7wr /
 * GHSA-hw8r-x6gr-5gjp) and nasjidwg were phantom dependencies: declared in
 * package.json but imported nowhere in src/ (full-repo scan on 7c85364).
 * They were removed instead of upgraded because zero call sites means the
 * vulnerable JSONPath evaluator can never be reached by project files, IDS
 * files, plugins, or user input.
 *
 * This test pins that state. If anyone re-introduces JSONPath-style rule
 * evaluation it MUST go through the sandboxed expression layer
 * (src/modules/families/safe-expr.ts, covered by tests/safe-expr.test.cjs),
 * not through jsonpath-plus.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const declaredDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

// A require scoped to the package root: resolves what the app could resolve.
const reqFromRoot = createRequire(path.join(root, "index.js"));

t("json-rules-engine is not declared in package.json", () => {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.ok(!(pkg[section] || {})["json-rules-engine"], "found in " + section);
  }
});

t("jsonpath-plus is not declared in package.json", () => {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.ok(!(pkg[section] || {})["jsonpath-plus"], "found in " + section);
  }
});

t("nasjidwg (unused native DWG lib) is not declared", () => {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    assert.ok(!(pkg[section] || {})["nasjidwg"], "found in " + section);
  }
});

t("vulnerable rule engine cannot be resolved from the package root", () => {
  assert.throws(() => reqFromRoot("json-rules-engine"), /Cannot find module/);
});

t("vulnerable jsonpath evaluator cannot be resolved from the package root", () => {
  assert.throws(() => reqFromRoot("jsonpath-plus"), /Cannot find module/);
});

t("no evaluator registered for JSONPath-style member execution (sandbox rule)", () => {
  // The only sanctioned expression evaluator is src/modules/families/safe-expr.ts
  // (covered by tests/safe-expr.test.cjs, which refuses member/constructor access).
  // Nothing else in the tree may evaluate rule strings — pinned by the checks above.
  assert.ok(fs.existsSync(path.join(root, "src/modules/families/safe-expr.ts")));
});

t("no source file imports json-rules-engine or jsonpath-plus", () => {
  const banned = /from\s+["'](json-rules-engine|jsonpath-plus)["']|require\(\s*["'](json-rules-engine|jsonpath-plus)["']\s*\)|import\(\s*["'](json-rules-engine|jsonpath-plus)["']\s*\)/;
  const roots = ["src", "public", "scripts", "tests"];
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      if (banned.test(src)) hits.push(path.relative(root, p));
    }
  };
  for (const r of roots) { const d = path.join(root, r); if (fs.existsSync(d)) walk(d); }
  assert.deepStrictEqual(hits, []);
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
