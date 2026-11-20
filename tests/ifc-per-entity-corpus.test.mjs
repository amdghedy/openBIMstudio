/**
 * tests/ifc-per-entity-corpus.test.mjs
 *
 * Drift gate for the checked-in per-entity corpus reports (#106):
 * regenerates every report under tests/fixtures/ifc-corpus/per-entity-reports/
 * from the fixtures with scripts/ifc-per-entity-report.mjs and fails on any
 * difference — byte-for-byte for the per-file reports, and for summary.json
 * (in full when web-ifc is available in this run, on the STEP-derived part
 * only when it is not: a missing web-ifc install must not fail the gate).
 *
 * Also pins the meaning of the checked-in example: generated-small.ifc has
 * 9 products, all preserved, with the scope caveat attached.
 *
 * Run: `node tests/ifc-per-entity-corpus.test.mjs`
 */

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCorpusReports, stripWebIfc } from "../scripts/ifc-per-entity-report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tests", "fixtures", "ifc-corpus", "per-entity-reports");

const { files, summary } = await generateCorpusReports({
  corpusDir: "tests/fixtures/ifc-corpus",
  useWebIfc: true,
});

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("  PASS " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + ": " + e.message); }
};

check("checked-in per-file reports regenerate byte-identically", () => {
  assert.ok(files.size > 0, "no reports generated");
  for (const [rel, json] of files) {
    const p = join(outDir, rel);
    assert.ok(existsSync(p), `missing checked-in report: ${rel}`);
    assert.strictEqual(readFileSync(p, "utf8"), json, `drift in checked-in report: ${rel}`);
  }
});

check("checked-in summary.json matches regeneration", () => {
  const p = join(outDir, "summary.json");
  assert.ok(existsSync(p), "missing checked-in report: summary.json");
  const checked = JSON.parse(readFileSync(p, "utf8"));
  const fresh = JSON.parse(JSON.stringify(summary));
  if (summary.webIfc.available) {
    assert.deepStrictEqual(checked, fresh, "summary.json drifted");
  } else {
    console.log("    (web-ifc unavailable in this run — comparing the STEP-derived part only)");
    assert.deepStrictEqual(stripWebIfc(checked), stripWebIfc(fresh), "summary.json drifted (STEP part)");
  }
});

check("summary totals equal the sum of the per-file totals", () => {
  const sum = { preserved: 0, transformed: 0, approximated: 0, unsupported: 0, skipped: 0, failed: 0, products: 0 };
  for (const f of summary.files) {
    if (!f.totals) continue;
    sum.products += f.totalProducts;
    for (const k of ["preserved", "transformed", "approximated", "unsupported", "skipped", "failed"]) {
      sum[k] += f.totals[k];
    }
  }
  assert.strictEqual(summary.totals.products, sum.products);
  for (const k of ["preserved", "transformed", "approximated", "unsupported", "skipped", "failed"]) {
    assert.strictEqual(summary.totals[k], sum[k], `summary total ${k} mismatch`);
  }
  assert.strictEqual(summary.totals.files, summary.files.length);
});

check("example generated-small.ifc.json: 9 products, all preserved, scope attached", () => {
  const p = join(outDir, "generated-small.ifc.json");
  assert.ok(existsSync(p), "missing checked-in example: generated-small.ifc.json");
  const example = JSON.parse(readFileSync(p, "utf8"));
  assert.strictEqual(example.kind, "import");
  assert.strictEqual(example.fileName, "generated-small.ifc");
  assert.strictEqual(example.schema, "IFC4");
  assert.strictEqual(example.totalProducts, 9);
  assert.strictEqual(example.totals.preserved, 9);
  assert.strictEqual(example.totals.lostPct, 0);
  assert.strictEqual(example.rows.length, 9);
  assert.ok(/Not a per-entity web-ifc FRAG-conversion claim/.test(example.scope));
});

if (failures) process.exit(1);
console.log("=== ifc-per-entity-corpus tests complete: 4 passed, 0 failed ===");
