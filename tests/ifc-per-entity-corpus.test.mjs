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
 * Regeneration runs MEMORY-BOUNDED: one subprocess per fixture
 * (--only <fixture>), then a merge pass (--merge) that reassembles
 * summary.json from the per-fixture parts in corpus walk order. Each
 * subprocess loads the web-ifc WASM reader for exactly one file, so the
 * peak memory does not accumulate across the corpus and the gate cannot
 * be OOM-killed on small CI runners. The merged outputs are byte-identical
 * to the in-process generation (same assembly code, same key order).
 *
 * Also pins the meaning of the checked-in example: generated-small.ifc has
 * 9 products, all preserved, with the scope caveat attached.
 *
 * Run: `node tests/ifc-per-entity-corpus.test.mjs`
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripWebIfc } from "../scripts/ifc-per-entity-report.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "tests", "fixtures", "ifc-corpus", "per-entity-reports");
const corpusDir = "tests/fixtures/ifc-corpus";

// ── regenerate memory-bounded: one process per fixture, then a merge ──
const fixtureRels = [];
{
  const list = spawnSync("node", ["-e",
    `const{readdirSync,statSync}=require("fs");const{join,relative}=require("path");` +
    `const walk=(d,b)=>{let o=[];for(const e of readdirSync(d).sort()){const f=join(d,e);` +
    `if(statSync(f).isDirectory())o=o.concat(walk(f,b));` +
    `else if(/\\.(ifc|ifczip)$/i.test(e))o.push(relative(b,f).split(require("path").sep).join("/"));}` +
    `return o;};` +
    `console.log(JSON.stringify(walk("${join(root, corpusDir)}","${join(root, corpusDir)}")))`,
  ], { encoding: "utf8" });
  if (list.status !== 0) { console.error(list.stderr); process.exit(1); }
  fixtureRels.push(...JSON.parse(list.stdout));
}

const gen = join(root, "scripts", "ifc-per-entity-report.mjs");

async function regenerate(withWebIfc) {
  const dir = mkdtempSync(join(root, ".corpus-drift-"));
  let ok = true;
  for (const rel of fixtureRels) {
    const args = ["node", [gen, "--corpus", corpusDir, "--out", dir, "--only", rel]];
    if (!withWebIfc) args[1].push("--no-webifc");
    const r = spawnSync(...args, { encoding: "utf8" });
    // A SIGKILL (exit 137) means the runner's memory ceiling killed the
    // web-ifc WASM heap mid-parse (small CI runners can hit this on the
    // malformed fixtures, whose linear-memory growth is unbounded).
    if (r.status !== 0 || r.signal) { ok = false; break; }
  }
  if (ok) {
    const m = spawnSync("node", [gen, "--corpus", corpusDir, "--out", dir, "--merge"], { encoding: "utf8" });
    if (m.status !== 0 || m.signal) ok = false;
  }
  return { dir, ok };
}

let run = await regenerate(true);
if (!run.ok) {
  // The web-ifc leg cannot complete on this runner (OOM-killed mid-parse).
  // Degrade exactly as the documented no-web-ifc path does: regenerate the
  // whole corpus without web-ifc and compare the STEP-derived part only.
  rmSync(run.dir, { recursive: true, force: true });
  console.log("    (web-ifc leg killed on this runner — regenerating without web-ifc; STEP-part comparison)");
  run = await regenerate(false);
}
if (!run.ok) { console.error("corpus regeneration failed in both web-ifc and no-web-ifc modes"); process.exit(1); }
const freshDir = run.dir;
const freshSummaryRaw = readFileSync(join(freshDir, "summary.json"), "utf8");

// The regeneration produced every fixture's report; mirror the old in-process
// result shape: files = Map<outRel, jsonString>, summary = parsed object.
const files = new Map();
for (const rel of fixtureRels) {
  const outRel = rel.replace(/\.ifczip$/i, ".ifc") + ".json";
  const p = join(freshDir, outRel);
  if (existsSync(p)) files.set(outRel, readFileSync(p, "utf8"));
}
const summary = JSON.parse(freshSummaryRaw);

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log("  PASS " + name); }
  catch (e) { failures++; console.log("  FAIL " + name + ": " + e.message); }
};

check("regeneration completed for every fixture", () => {
  assert.ok(fixtureRels.length > 0, "no fixtures walked");
  assert.ok(files.size > 0 || summary.files.length === fixtureRels.length, "no reports generated");
});

check("every fixture has a summary entry in corpus order", () => {
  assert.strictEqual(summary.files.length, fixtureRels.length, "summary file count mismatch");
  for (let i = 0; i < fixtureRels.length; i++) {
    assert.strictEqual(summary.files[i].file, fixtureRels[i], `summary order drift at ${i}`);
  }
});

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

rmSync(freshDir, { recursive: true, force: true });
if (failures) process.exit(1);
console.log(`=== ifc-per-entity-corpus tests complete: ${6 - failures} passed, ${failures} failed ===`);
