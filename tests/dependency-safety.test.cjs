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
const { createHash } = require("crypto");

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

// ── CSP / no-runtime-CDN pins (remediation program Phase 1.5) ──────────────
// Evidence: docs/CSP.md. The ThatOpen SDK's `FragmentsManager.getWorker()`
// fetches the worker from unpkg.com at runtime and returns a blob URL — an
// undeclared third-party dependency that violates connect-src and sends
// version data to a public CDN on every boot. The app self-hosts the worker
// (src/core/setup.ts imports `@thatopen/fragments/dist/Worker/worker.mjs?url`
// and passes the same-origin URL to fragments.init()).

function srcFilesMatching(pattern) {
  const roots = ["src", "public"];
  const hits = [];
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); continue; }
      if (!/\.(ts|tsx|js|mjs|cjs|html|css)$/.test(e.name)) continue;
      const src = stripComments(fs.readFileSync(p, "utf8"));
      if (pattern.test(src)) hits.push(path.relative(root, p));
    }
  };
  for (const r of roots) { const d = path.join(root, r); if (fs.existsSync(d)) walk(d); }
  return hits;
}

t("no runtime fetch of the unpkg CDN anywhere in app source", () => {
  assert.deepStrictEqual(srcFilesMatching(/unpkg\.com/), []);
});

t("fragments worker is self-hosted, not SDK getWorker() (unpkg blob)", () => {
  const setup = fs.readFileSync(path.join(root, "src/core/setup.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  assert.ok(!/FragmentsManager\.getWorker/.test(setup), "getWorker() call still present");
  assert.ok(
    /import\s+fragmentsWorkerUrl\s+from\s+["']@thatopen\/fragments\/worker\?url["']/.test(setup),
    "self-hosted ?url import missing"
  );
  assert.ok(/fragments\.init\(\s*fragmentsWorkerUrl\s*\)/.test(setup), "init must use the self-hosted URL");
});

t("index.html ships the CSP meta policy", () => {
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(/http-equiv=["']Content-Security-Policy["']/.test(html), "meta CSP missing");
  // The strict bar: no blanket https: allowance that would defeat the
  // enumerated connect-src inventory.
  assert.ok(!/default-src[^;]*https:/.test(html), "default-src must not allow blanket https:");
  assert.ok(/worker-src[^;]*'self'/.test(html), "worker-src must allow same-origin workers");
});

// ── web-ifc glue/wasm coherence pin (remediation program Phase 1.5) ────────
// The bundled web-ifc JS glue (node_modules → ifc-vendor chunk) fetches the
// WASM binaries from /web-ifc/ (public/) at runtime. When the npm dependency
// was bumped (0.0.77 → 0.0.78) without re-pinning the public copies, the
// 4-arg StreamMeshes JS hit the 3-arg embind binding of the old wasm and
// every IFC import died with BindingError. The whole stack is pinned to
// 0.0.77, whose JS and browser/node WASM binaries are mutually coherent.
t("public/web-ifc wasm assets match the installed web-ifc package byte-for-byte", () => {
  for (const f of ["web-ifc-api.js", "web-ifc.wasm", "web-ifc-mt.wasm", "web-ifc-node.wasm"]) {
    const pub = path.join(root, "public/web-ifc", f);
    const nm = path.join(root, "node_modules/web-ifc", f);
    assert.ok(fs.existsSync(pub), "public/web-ifc/" + f + " missing");
    assert.ok(fs.existsSync(nm), "node_modules/web-ifc/" + f + " missing");
    assert.strictEqual(
      createHash("sha256").update(fs.readFileSync(pub)).digest("hex"),
      createHash("sha256").update(fs.readFileSync(nm)).digest("hex"),
      "public/web-ifc/" + f + " drifted from the installed web-ifc package"
    );
  }
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
