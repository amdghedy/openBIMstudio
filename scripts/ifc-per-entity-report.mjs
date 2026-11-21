#!/usr/bin/env node
/**
 * scripts/ifc-per-entity-report.mjs — per-entity IFC fidelity for the golden corpus (#106).
 *
 *   node scripts/ifc-per-entity-report.mjs [--corpus <dir>] [--out <dir>] [--check] [--no-webifc]
 *
 * For every `.ifc` (and `.ifczip`, via jszip) under the corpus dir it builds
 * the per-entity import report (src/modules/ifc-semantics/per-entity-report.ts)
 * and writes one deterministic JSON per file under <out>/, plus a
 * summary.json aggregating the whole corpus. With `--check` it regenerates
 * into memory and fails (exit 1) on any drift from the checked-in files —
 * that is the gate; plain runs rewrite the files.
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

import { execSync } from "node:child_process";
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
  const totals = {
    preserved: 0, transformed: 0, approximated: 0,
    unsupported: 0, skipped: 0, failed: 0,
  };
  let totalProducts = 0;
  let reported = 0;
  let totalDefinitions = 0;

  for (const fx of fixtures) {
    const raw = readFileSync(fx.full);
    let bytes = raw;
    let fileName = fx.rel;
    let zipNote = null;
    if (/\.ifczip$/i.test(fx.rel)) {
      const unzipped = await unzipFirstIfc(new Uint8Array(raw));
      if (unzipped.error) {
        summaryFiles.push({
          file: fx.rel, kind: kindOf(fx.rel), schema: "UNKNOWN", report: null,
          reason: `ifczip unreadable: ${unzipped.error}`,
          totalProducts: 0, totals: null, webIfc: null,
        });
        continue;
      }
      bytes = Buffer.from(unzipped.bytes);
      fileName = `${fx.rel}!${unzipped.name}`;
      zipNote = `extracted ${unzipped.name} from ${fx.rel}`;
    }
    const report = reporter.buildImportFidelityReport(fileName, new Uint8Array(bytes));
    if (!report) {
      summaryFiles.push({
        file: fx.rel, kind: kindOf(fx.rel), schema: "UNKNOWN", report: null,
        reason: "no product entities readable (not STEP-shaped, empty, or unreadable)",
        totalProducts: 0, totals: null, webIfc: null,
      });
      continue;
    }
    reported++;
    totalProducts += report.totalProducts;
    for (const k of Object.keys(totals)) totals[k] += report.totals[k];
    totalDefinitions += report.definitions?.total ?? 0;
    const outRel = fx.rel.replace(/\.ifczip$/i, ".ifc") + ".json";
    files.set(outRel, reporter.fidelityReportToJson(report));

    let webCheck = null;
    if (webAvailable) {
      try {
        webCheck = await webIfcCrossCheck(web.api, web.W, new Uint8Array(bytes), report.rows);
      } catch (e) {
        webCheck = { opened: false, error: String((e && e.message) || e) };
      }
    }
    summaryFiles.push({
      file: fx.rel, kind: kindOf(fx.rel), schema: report.schema,
      report: outRel, ...(zipNote ? { note: zipNote } : {}),
      totalProducts: report.totalProducts, totals: report.totals,
      definitions: report.definitions?.total ?? 0,
      webIfc: webAvailable ? webCheck : { available: false },
    });
  }

  const summary = {
    schemaVersion: 1,
    generator: "scripts/ifc-per-entity-report.mjs (per-entity-report v1)",
    corpus: relative(root, corpus).split(sep).join("/"),
    webIfc: webAvailable
      ? { available: true, version: web.version }
      : { available: false, reason: web.reason ?? "web-ifc not installed" },
    files: summaryFiles,
    totals: {
      files: fixtures.length, reported, unreported: fixtures.length - reported,
      products: totalProducts, definitions: totalDefinitions, ...totals,
    },
  };
  return { files, summary };
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

async function main(argv) {
  const corpusDir = argv.includes("--corpus") ? argv[argv.indexOf("--corpus") + 1] : "tests/fixtures/ifc-corpus";
  const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : join(corpusDir, "per-entity-reports");
  const check = argv.includes("--check");
  const useWebIfc = !argv.includes("--no-webifc");
  const outAbs = resolve(root, outDir);

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
