/**
 * Perf budget gate — makes scripts/budget.json enforceable.
 *
 * Budgets (scripts/budget.json):
 *   import.maxSeconds / import.maxPeakMB  — large-fixture load wall time & heap
 *   bundle.maxMainJsKB                    — main bundle size
 *   e2eSmoke.maxSeconds                   — smoke e2e budget (CI measure)
 *
 * Reads ONLY measured JSON produced by bench/bench-browser.mjs and
 * bench/bench-node.mjs (never fabricates). Exit 1 on any breach.
 *
 * Usage:
 *   node bench/check-budgets.mjs [--require bundle,import,node] [--results browser-after] [--node-results node-after]
 *
 * FAIL-CLOSED: a check named by --require (default: bundle) that cannot be evaluated — missing dist/, missing or
 * malformed results JSON, missing large-fixture entry, non-finite metric — is a FAILURE, never a skip.
 * Checks not required are reported as SKIPPED (visibly) when their input is absent, but still fail on a breach.
 * OBS_BENCH_ROOT overrides the repository root (used by tests).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OBS_BENCH_ROOT ? path.resolve(process.env.OBS_BENCH_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt; };
const required = new Set(arg("--require", "bundle").split(",").map((x) => x.trim()).filter(Boolean));
const brName = arg("--results", "browser-after");
const ndName = arg("--node-results", "node-after");

let failed = 0;
const fail = (msg) => { console.error("  BUDGET FAIL:", msg); failed++; };
const ok = (msg) => console.log("  budget ok:", msg);
/** Missing input: failure when the check is required, otherwise a visible skip. */
const missing = (check, msg) => { if (required.has(check)) fail(`${check}: ${msg} (required)`); else console.warn(`  SKIPPED ${check}: ${msg}`); };
const finite = (v) => typeof v === "number" && Number.isFinite(v);

let budget;
try { budget = JSON.parse(readFileSync(path.join(root, "scripts", "budget.json"), "utf8")); }
catch (e) { console.error("  BUDGET FAIL: scripts/budget.json unreadable or malformed:", e.message); process.exit(1); }
const resultsDir = path.join(root, "bench", "results");

function readJson(file) {
  try { return { value: JSON.parse(readFileSync(file, "utf8")) }; }
  catch (e) { return { error: e.code === "ENOENT" ? "file missing" : "malformed JSON: " + e.message }; }
}

// ── bundle ───────────────────────────────────────────────────────────────
{
  const assetsDir = path.join(root, "dist", "assets");
  if (!existsSync(assetsDir)) missing("bundle", "dist/assets missing — run the production build first");
  else {
    const budgetKB = budget.bundle?.maxMainJsKB ?? 2500;
    const files = readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
    if (!files.length) missing("bundle", "no index-*.js main chunk found in dist/assets");
    else {
      let worst = 0;
      for (const f of files) worst = Math.max(worst, readFileSync(path.join(assetsDir, f)).length / 1024);
      if (worst <= budgetKB) ok(`main bundle ${Math.round(worst)} KB ≤ ${budgetKB} KB`);
      else fail(`main bundle ${Math.round(worst)} KB > ${budgetKB} KB`);
    }
  }
}

// ── import (large fixture, browser measurement) ──────────────────────────
{
  const r = readJson(path.join(resultsDir, `${brName}.json`));
  if (r.error) missing("import", `${brName}.json ${r.error}`);
  else {
    const large = r.value.suites?.["ifc-load"]?.large;
    if (!large) missing("import", "no large entry in suites.ifc-load");
    else if (!finite(large.loadTotalMs) || large.loadTotalMs <= 0) fail(`import: loadTotalMs invalid (${large.loadTotalMs})`);
    else {
      const maxS = budget.import?.maxSeconds ?? 60;
      if (large.loadTotalMs / 1000 <= maxS) ok(`large load ${(large.loadTotalMs / 1000).toFixed(1)} s ≤ ${maxS} s`);
      else fail(`large load ${(large.loadTotalMs / 1000).toFixed(1)} s > ${maxS} s`);
      const maxMB = budget.import?.maxPeakMB ?? 1500;
      if (!finite(large.heapAfterMB)) missing("import", "heapAfterMB missing or non-finite");
      else if (large.heapAfterMB <= maxMB) ok(`large heap ${large.heapAfterMB} MB ≤ ${maxMB} MB`);
      else fail(`large heap ${large.heapAfterMB} MB > ${maxMB} MB`);
    }
  }
}

// ── node: parse the large fixture under the import budget (CPU upper bound) ──
{
  const r = readJson(path.join(resultsDir, `${ndName}.json`));
  if (r.error) missing("node", `${ndName}.json ${r.error}`);
  else {
    const med = r.value.suites?.["ifc-parse"]?.large?.parseMs?.median;
    if (med === undefined) missing("node", "no suites.ifc-parse.large.parseMs.median");
    else if (!finite(med) || med <= 0) fail(`node: parse median invalid (${med})`);
    else {
      const maxS = budget.import?.maxSeconds ?? 60;
      if (med / 1000 <= maxS) ok(`node parse large ${(med / 1000).toFixed(2)} s ≤ ${maxS} s`);
      else fail(`node parse large ${(med / 1000).toFixed(2)} s > ${maxS} s`);
    }
  }
}

if (failed) {
  console.error(`=== Perf budget: ${failed} failure(s) ===`);
  process.exit(1);
}
console.log("=== Perf budget: all evaluated checks passed ===");
