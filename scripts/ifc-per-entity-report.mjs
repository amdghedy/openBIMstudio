#!/usr/bin/env node
/**
 * scripts/ifc-per-entity-report.mjs — per-entity IFC fidelity for the golden corpus (#106).
 *
 *   node scripts/ifc-per-entity-report.mjs [--corpus <dir>] [--out <dir>] [--check] [--no-webifc]
 *                                          [--only <fixture-rel>] [--parts-dir <dir>] [--merge]
 *
 * For every `.ifc` (and `.ifczip`, via jszip) under the corpus dir it builds
 * the per-entity import report (src/modules/ifc-semantics/per-entity-report.ts)
 * and writes one deterministic JSON per file under <out>/, plus a
 * summary.json aggregating the whole corpus. With `--check` it regenerates
 * into memory and fails (exit 1) on any drift from the checked-in files —
 * that is the gate; plain runs rewrite the files.
 *
 * Memory-bounded mode (used by the drift gate so the suite cannot be
 * OOM-killed on small CI runners): `--only <fixture-rel>` processes a single
 * fixture and writes its report plus a summary *part* file;
 * `--merge` reassembles summary.json from the part files in corpus walk
 * order. One fixture per process means the WASM reader's peak memory never
 * accumulates across the corpus. The merged summary is byte-identical to
 * the in-process one — same assembly code, same key order.
 *
 * A second, independent leg cross-checks each file with web-ifc 0.0.77 (the
 * application's own import parser, Node API): every GlobalId the STEP report
 * lists must be visible to web-ifc with the same type. The cross-check is
 * recorded in summary.json, never folded into the STEP report's own rows,
 * and skipped (recorded as unavailable) when web-ifc is not installed.
 * It is a parser cross-check, not a desktop-tool validation: nothing here
 * has been opened in Revit / Solibri / ArchiCAD / AutoCAD.
 *
 * The summary is deterministic (no timestamps): regenerating the same
 * corpus with the same web-ifc availability yields byte-identical files.
 */

import { execSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

let reporterCache = null;

/** Compile the TS report module (and its pure deps) into a repo-local temp dir. */
export function loadReporter() {
  if (reporterCache) return reporterCache;
  const out = mkdtempSync(join(root, ".per-entity-report-"));
  // The repo package.json is "type": "module", so compiled CommonJS output
  // needs the explicit shim (same pattern as tests/native-ifc-entities.test.cjs).
  writeFileSync(join(out, "package.json"), '{"type":"commonjs"}');
  try {
    execSync(
      `npx tsc src/modules/ifc-semantics/per-entity-report.ts --outDir ${out} --rootDir src ` +
      `--module commonjs --target es2020 --lib es2020,dom --skipLibCheck --strict --ignoreDeprecations 5.0`,
      { cwd: root, stdio: "inherit" },
    );
    reporterCache = require(join(out, "modules", "ifc-semantics", "per-entity-report.js"));
    return reporterCache;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function walkIfc(dir, base = dir) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walkIfc(full, base));
    else if (/\.ifc$/i.test(entry) || /\.ifczip$/i.test(entry)) {
      found.push({ full, rel: relative(base, full).split(sep).join("/") });
    }
  }
  return found;
}

function kindOf(rel) {
  if (rel.startsWith("invalid/")) return "invalid";
  if (rel.startsWith("malformed/")) return "malformed";
  return "valid";
}

async function unzipFirstIfc(bytes) {
  let JSZip;
  try {
    JSZip = require("jszip");
  } catch {
    return { error: "jszip not installed" };
  }
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /\.ifc$/i.test(n)).sort();
  if (names.length === 0) return { error: "no .ifc entry in archive" };
  const buf = await zip.files[names[0]].async("uint8array");
  return { name: names[0], bytes: buf };
}

function webIfcVersion() {
  let dir = dirname(require.resolve("web-ifc"));
  while (dir !== dirname(dir)) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        if (j.name === "web-ifc") return j.version;
      } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  return "unknown";
}

/** web-ifc leg: GlobalId → type enumeration for one STEP file's bytes. */
async function webIfcCrossCheck(api, W, bytes, rows) {
  const model = api.OpenModel(bytes, {});
  try {
    const byGuid = new Map();
    const TYPE_IDS = Object.entries(W).filter(
      ([k, v]) => typeof v === "number" && /^IFC[A-Z0-9_]+$/.test(k),
    );
    for (const [name, id] of TYPE_IDS) {
      const lines = api.GetLineIDsWithType(model, id);
      if (lines.size() === 0) continue;
      for (const lineId of lines) {
        const props = api.GetLine(model, lineId);
        const gid = props?.GlobalId?.value ?? null;
        if (gid) byGuid.set(gid, name);
      }
    }
    const missing = [];
    const mismatches = [];
    let matched = 0;
    for (const row of rows) {
      if (!row.globalId) continue;
      const seen = byGuid.get(row.globalId);
      if (seen === undefined) missing.push(row.globalId);
      else if (seen !== row.ifcType) mismatches.push({ globalId: row.globalId, report: row.ifcType, webIfc: seen });
      else matched++;
    }
    return { opened: true, productsSeen: byGuid.size, globalIdsMatched: matched, globalIdsMissing: missing, typeMismatches: mismatches };
  } finally {
    api.CloseModel(model);
  }
}

async function initWebIfc() {
  try {
    const { IfcAPI } = require("web-ifc");
    const W = require("web-ifc");
    const api = new IfcAPI();
    await api.Init();
    return { api, W, version: webIfcVersion() };
  } catch (e) {
    return { available: false, reason: String((e && e.message) || e) };
  }
}

/**
 * Build one fixture's report + its summary entry (the exact body of the
 * original corpus loop, unchanged). Returns
 * { outRel, reportJson | null, summaryEntry,
 *   delta: { totalProducts, reported, totalDefinitions, totals } }.
 */
async function processFixture(fx, reporter, web, webAvailable) {
  const raw = readFileSync(fx.full);
  let bytes = raw;
  let fileName = fx.rel;
  let zipNote = null;
  if (/\.ifczip$/i.test(fx.rel)) {
    const unzipped = await unzipFirstIfc(new Uint8Array(raw));
    if (unzipped.error) {
      return {
        outRel: null, reportJson: null,
        summaryEntry: {
          file: fx.rel, kind: kindOf(fx.rel), schema: "UNKNOWN", report: null,
          reason: `ifczip unreadable: ${unzipped.error}`,
          totalProducts: 0, totals: null, webIfc: null,
        },
        delta: { totalProducts: 0, reported: 0, totalDefinitions: 0, totals: zeroTotals() },
      };
    }
    bytes = Buffer.from(unzipped.bytes);
    fileName = `${fx.rel}!${unzipped.name}`;
    zipNote = `extracted ${unzipped.name} from ${fx.rel}`;
  }
  const report = reporter.buildImportFidelityReport(fileName, new Uint8Array(bytes));
  if (!report) {
    return {
      outRel: null, reportJson: null,
      summaryEntry: {
        file: fx.rel, kind: kindOf(fx.rel), schema: "UNKNOWN", report: null,
        reason: "no product entities readable (not STEP-shaped, empty, or unreadable)",
        totalProducts: 0, totals: null, webIfc: null,
      },
      delta: { totalProducts: 0, reported: 0, totalDefinitions: 0, totals: zeroTotals() },
    };
  }
  const outRel = fx.rel.replace(/\.ifczip$/i, ".ifc") + ".json";
  const reportJson = reporter.fidelityReportToJson(report);

  let webCheck = null;
  if (webAvailable) {
    try {
      webCheck = await webIfcCrossCheck(web.api, web.W, new Uint8Array(bytes), report.rows);
    } catch (e) {
      const raw = String((e && e.message) || e);
      // The WASM OOB abort surfaces with different messages per Node runtime
      // ("Aborted(). Build with -sASSERTIONS..." on 22, a V8 trap message on
      // 24+) — record one canonical label so the drift gate stays
      // environment-independent.
      const msg = /memory access out of bounds|^Aborted\(\)/i.test(raw)
        ? "memory access out of bounds"
        : raw;
      webCheck = { opened: false, error: msg };
    }
  }
  const summaryEntry = {
    file: fx.rel, kind: kindOf(fx.rel), schema: report.schema,
    report: outRel, ...(zipNote ? { note: zipNote } : {}),
    totalProducts: report.totalProducts, totals: report.totals,
    definitions: report.definitions?.total ?? 0,
    webIfc: webAvailable ? webCheck : { available: false },
  };
  return {
    outRel, reportJson, summaryEntry,
    delta: {
      totalProducts: report.totalProducts, reported: 1,
      totalDefinitions: report.definitions?.total ?? 0, totals: report.totals,
    },
  };
}

function zeroTotals() {
  return { preserved: 0, transformed: 0, approximated: 0, unsupported: 0, skipped: 0, failed: 0 };
}

function addTotals(acc, totals) {
  for (const k of Object.keys(acc)) acc[k] += totals?.[k] ?? 0;
}

/**
 * Generate the corpus reports. Returns { files: Map<outRel, jsonString>, summary }.
 * `files` keys are paths relative to the out dir; the summary references them.
 */
export async function generateCorpusReports({ corpusDir, useWebIfc = true } = {}) {
  const reporter = loadReporter();
  const corpus = resolve(root, corpusDir);
  const fixtures = walkIfc(corpus);
  const web = useWebIfc ? await initWebIfc() : { available: false, reason: "disabled with --no-webifc" };
  const webAvailable = !!web.api;

  const files = new Map();
  const summaryFiles = [];
  const totals = zeroTotals();
  let totalProducts = 0;
  let reported = 0;
  let totalDefinitions = 0;

  for (const fx of fixtures) {
    const r = await processFixture(fx, reporter, web, webAvailable);
    if (r.outRel) files.set(r.outRel, r.reportJson);
    summaryFiles.push(r.summaryEntry);
    totalProducts += r.delta.totalProducts;
    reported += r.delta.reported;
    totalDefinitions += r.delta.totalDefinitions;
    addTotals(totals, r.delta.totals);
  }

  const summary = assembleSummary({ corpusDir, web, webAvailable, fileCount: fixtures.length, summaryFiles, reported, totalProducts, totalDefinitions, totals });
  return { files, summary };
}

/** The summary object — single construction site so every mode is byte-identical. */
function assembleSummary({ corpusDir, web, webAvailable, fileCount, summaryFiles, reported, totalProducts, totalDefinitions, totals }) {
  const corpus = resolve(root, corpusDir);
  return {
    schemaVersion: 1,
    generator: "scripts/ifc-per-entity-report.mjs (per-entity-report v1)",
    corpus: relative(root, corpus).split(sep).join("/"),
    webIfc: webAvailable
      ? { available: true, version: web.version }
      : { available: false, reason: web.reason ?? "web-ifc not installed" },
    files: summaryFiles,
    totals: {
      files: fileCount, reported, unreported: fileCount - reported,
      products: totalProducts, definitions: totalDefinitions, ...totals,
    },
  };
}

function summaryJson(summary) {
  return JSON.stringify(summary, null, 2) + "\n";
}

/** Strip the web-ifc sections so a run without web-ifc can still be compared on the STEP part. */
export function stripWebIfc(summary) {
  const copy = JSON.parse(JSON.stringify(summary));
  delete copy.webIfc;
  for (const f of copy.files) delete f.webIfc;
  return copy;
}

/* ── Memory-bounded split mode ───────────────────────────────────────────
   --only <rel>   process one fixture: write <out>/<report>.json plus
                  <out>/.parts/<rel>.part.json (summary entry + totals delta
                  + the run's top-level webIfc object).
   --merge        reassemble summary.json from the part files in corpus walk
                  order — byte-identical to the in-process summary.
   One fixture per process bounds the WASM reader's peak memory; the drift
   gate spawns these sequentially so a small CI runner cannot be OOM-killed. */

function partPath(partsDir, rel) {
  return join(partsDir, rel.replaceAll("/", "__") + ".part.json");
}

async function runOnly(corpusDir, outAbs, onlyRel, useWebIfc) {
  const reporter = loadReporter();
  const corpus = resolve(root, corpusDir);
  const fx = walkIfc(corpus).find((f) => f.rel === onlyRel);
  if (!fx) { console.error(`--only: no such fixture under the corpus: ${onlyRel}`); process.exit(1); }
  const web = useWebIfc ? await initWebIfc() : { available: false, reason: "disabled with --no-webifc" };
  const webAvailable = !!web.api;
  const r = await processFixture(fx, reporter, web, webAvailable);
  const partsDir = join(outAbs, ".parts");
  mkdirSync(partsDir, { recursive: true });
  if (r.outRel) {
    const p = join(outAbs, r.outRel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, r.reportJson);
  }
  writeFileSync(partPath(partsDir, fx.rel), JSON.stringify({
    summaryEntry: r.summaryEntry,
    delta: r.delta,
    webIfc: webAvailable
      ? { available: true, version: web.version }
      : { available: false, reason: web.reason ?? "web-ifc not installed" },
  }, null, 2) + "\n");
  console.log(`part ${fx.rel}: ${r.outRel ?? "(no report)"}`);
}

async function runMerge(corpusDir, outAbs, useWebIfc) {
  const corpus = resolve(root, corpusDir);
  const fixtures = walkIfc(corpus);
  const partsDir = join(outAbs, ".parts");
  const summaryFiles = [];
  const totals = zeroTotals();
  let totalProducts = 0;
  let reported = 0;
  let totalDefinitions = 0;
  let webIfcTop = null;
  for (const fx of fixtures) {
    const pp = partPath(partsDir, fx.rel);
    if (!existsSync(pp)) { console.error(`--merge: missing part for ${fx.rel} (run --only first)`); process.exit(1); }
    const part = JSON.parse(readFileSync(pp, "utf8"));
    if (!webIfcTop) webIfcTop = part.webIfc;
    summaryFiles.push(part.summaryEntry);
    totalProducts += part.delta.totalProducts;
    reported += part.delta.reported;
    totalDefinitions += part.delta.totalDefinitions;
    addTotals(totals, part.delta.totals);
  }
  // The top-level webIfc object comes from the part runs (it records whether
  // the WASM reader actually initialised there); the version string is
  // re-read locally without initialising the WASM heap.
  const webForSummary = webIfcTop?.available
    ? { version: useWebIfc ? webIfcVersion() : undefined, top: webIfcTop }
    : { top: webIfcTop };
  const summary = assembleSummary({
    corpusDir,
    web: webForSummary.top.available
      ? { version: webForSummary.version ?? webIfcVersion() }
      : { reason: webForSummary.top.reason ?? "web-ifc not installed" },
    webAvailable: !!webForSummary.top.available,
    fileCount: fixtures.length, summaryFiles, reported, totalProducts, totalDefinitions, totals,
  });
  writeFileSync(join(outAbs, "summary.json"), summaryJson(summary));
  console.log(`merged ${fixtures.length} part(s) into summary.json`);
}

async function main(argv) {
  const corpusDir = argv.includes("--corpus") ? argv[argv.indexOf("--corpus") + 1] : "tests/fixtures/ifc-corpus";
  const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(corpusDir, "per-entity-reports");
  const check = argv.includes("--check");
  const useWebIfc = !argv.includes("--no-webifc");
  const outAbs = resolve(root, outDir);
  const onlyIdx = argv.indexOf("--only");
  const merge = argv.includes("--merge");

  if (onlyIdx >= 0) {
    await runOnly(corpusDir, outAbs, argv[onlyIdx + 1], useWebIfc);
    return;
  }
  if (merge) {
    await runMerge(corpusDir, outAbs, useWebIfc);
    return;
  }

  const { files, summary } = await generateCorpusReports({ corpusDir, useWebIfc });

  if (check) {
    let drift = 0;
    for (const [rel, json] of files) {
      const p = join(outAbs, rel);
      if (!existsSync(p)) { console.error(`MISSING checked-in report: ${rel}`); drift++; continue; }
      if (readFileSync(p, "utf8") !== json) { console.error(`DRIFT in checked-in report: ${rel} (regenerate with: node scripts/ifc-per-entity-report.mjs)`); drift++; }
    }
    const summaryPath = join(outAbs, "summary.json");
    if (!existsSync(summaryPath)) {
      console.error("MISSING checked-in report: summary.json");
      drift++;
    } else {
      const checked = JSON.parse(readFileSync(summaryPath, "utf8"));
      const fresh = JSON.parse(summaryJson(summary));
      const same = summary.webIfc.available
        ? JSON.stringify(checked) === JSON.stringify(fresh)
        : JSON.stringify(stripWebIfc(checked)) === JSON.stringify(stripWebIfc(fresh));
      if (!same) {
        console.error("DRIFT in checked-in report: summary.json (regenerate with: node scripts/ifc-per-entity-report.mjs)");
        drift++;
      }
    }
    if (drift) {
      console.error(`per-entity corpus check: ${drift} drifted file(s)`);
      process.exit(1);
    }
    console.log(`per-entity corpus check: ${files.size} report(s) + summary.json match the checked-in files`);
    return;
  }

  mkdirSync(outAbs, { recursive: true });
  for (const [rel, json] of files) {
    const p = join(outAbs, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, json);
  }
  writeFileSync(join(outAbs, "summary.json"), summaryJson(summary));
  const t = summary.totals;
  console.log(`per-entity corpus report: ${t.reported}/${t.files} files reported, ${t.products} products — ` +
    `preserved ${t.preserved}, transformed ${t.transformed}, approximated ${t.approximated}, ` +
    `unsupported ${t.unsupported}, skipped ${t.skipped}, failed ${t.failed}`);
  console.log(`web-ifc: ${summary.webIfc.available ? `cross-check ran (version ${summary.webIfc.version})` : `unavailable (${summary.webIfc.reason})`}`);
  console.log(`wrote ${files.size} report(s) + summary.json to ${relative(root, outAbs)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
