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
 *   node bench/check-budgets.mjs [--results browser-after] [--node-results node-after]
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const budget = JSON.parse(readFileSync(path.join(root, "scripts", "budget.json"), "utf8"));
const resultsDir = path.join(root, "bench", "results");

const brName = (() => {
  const i = process.argv.indexOf("--results");
  return i > 0 ? process.argv[i + 1] : "browser-after";
})();
const ndName = (() => {
  const i = process.argv.indexOf("--node-results");
  return i > 0 ? process.argv[i + 1] : "node-after";
})();

let failed = 0;
const fail = (msg) => { console.error("  BUDGET FAIL:", msg); failed++; };
const ok = (msg) => console.log("  budget ok:", msg);

// ── bundle ───────────────────────────────────────────────────────────────
{
  const assetsDir = path.join(root, "dist", "assets");
  if (!existsSync(assetsDir)) {
    console.warn("  (dist/ missing — run npm run build first; bundle budget skipped)");
  } else {
    const budgetKB = budget.bundle?.maxMainJsKB ?? 2500;
    // "main" = the largest non-vendor, non-worker entry chunk (index-*.js)
    const files = readdirSync(assetsDir).filter((f) => /^index-.*\.js$/.test(f));
    let worst = 0;
    for (const f of files) {
      const kb = readFileSync(path.join(assetsDir, f)).length / 1024;
      if (kb > worst) worst = kb;
    }
    if (worst <= budgetKB) ok(`main bundle ${Math.round(worst)} KB ≤ ${budgetKB} KB`);
    else fail(`main bundle ${Math.round(worst)} KB > ${budgetKB} KB`);
  }
}

// ── import (large fixture) ───────────────────────────────────────────────
{
  const p = path.join(resultsDir, `${brName}.json`);
  if (!existsSync(p)) {
    console.warn(`  (${brName}.json missing — run bench/bench-browser.mjs first; import budgets skipped)`);
  } else {
    const b = JSON.parse(readFileSync(p, "utf8"));
    const large = b.suites?.["ifc-load"]?.large;
    if (large) {
      const maxS = budget.import?.maxSeconds ?? 60;
      if (large.loadTotalMs / 1000 <= maxS) ok(`large load ${(large.loadTotalMs / 1000).toFixed(1)} s ≤ ${maxS} s`);
      else fail(`large load ${(large.loadTotalMs / 1000).toFixed(1)} s > ${maxS} s`);
      const maxMB = budget.import?.maxPeakMB ?? 1500;
      if (large.heapAfterMB > 0 && large.heapAfterMB <= maxMB) ok(`large heap ${large.heapAfterMB} MB ≤ ${maxMB} MB`);
      else if (large.heapAfterMB > maxMB) fail(`large heap ${large.heapAfterMB} MB > ${maxMB} MB`);
    } else {
      console.warn("  (no large entry in results; import budget skipped)");
    }
  }
}

// ── node: keep parse under the import budget too (CPU upper bound) ───────
{
  const p = path.join(resultsDir, `${ndName}.json`);
  if (existsSync(p)) {
    const n = JSON.parse(readFileSync(p, "utf8"));
    const large = n.suites?.["ifc-parse"]?.large;
    const maxS = budget.import?.maxSeconds ?? 60;
    if (large && large.parseMs) {
      if (large.parseMs.median / 1000 <= maxS) ok(`node parse large ${(large.parseMs.median / 1000).toFixed(2)} s ≤ ${maxS} s`);
      else fail(`node parse large ${(large.parseMs.median / 1000).toFixed(2)} s > ${maxS} s`);
    }
  }
}

if (failed) {
  console.error(`=== Perf budget: ${failed} breach(es) ===`);
  process.exit(1);
}
console.log("=== Perf budget: all checks passed ===");
