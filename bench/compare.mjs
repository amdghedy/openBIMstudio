/**
 * Compare two benchmark result sets and print the before/after table.
 * Never fabricates: reads only the JSON files produced by bench-node.mjs and
 * bench/bench-browser.mjs.
 *
 * Usage: node bench/compare.mjs [--node baseline after] [--browser baseline after]
 * Default: node-baseline vs node-after, browser-baseline vs browser-after.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "bench", "results");

function load(name) {
  const p = path.join(dir, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

const [ , , nodeBefore = "baseline", nodeAfter = "after", brBefore = "baseline", brAfter = "after" ] = process.argv;

const nb = load(`node-${nodeBefore}.json`);
const na = load(`node-${nodeAfter}.json`);
const bb = load(`browser-${brBefore}.json`);
const ba = load(`browser-${brAfter}.json`);

const f = (v) => (v === undefined || v === null) ? "n/a" : (typeof v === "number" ? (Math.round(v * 100) / 100).toString() : v);
const row = (label, b, a, unit = "ms") => {
  const delta = (typeof b === "number" && typeof a === "number") ? ` (${a < b ? "-" : "+"}${Math.abs(Math.round((a - b) * 100) / 100)}${unit})` : "";
  console.log(`  ${label.padEnd(44)} ${f(b).padStart(10)} → ${f(a).padStart(10)}${delta}`);
};

console.log("\n=== Node benchmarks (median of N runs; lower is better) ===");
if (nb && na) {
  const suites = new Set([...Object.keys(nb.suites ?? {}), ...Object.keys(na.suites ?? {})]);
  for (const s of ["ifc-parse", "authored-export", "spatial-index", "props-snapshot"]) {
    if (!suites.has(s)) continue;
    console.log(`[suite] ${s}`);
    const keys = new Set([...Object.keys(nb.suites[s] ?? {}), ...Object.keys(na.suites[s] ?? {})]);
    for (const k of keys) {
      const B = nb.suites[s]?.[k] ?? {};
      const A = na.suites[s]?.[k] ?? {};
      const mKey = ["parseMs", "exportMs", "snapshotMs", "buildMs"].find((x) => B[x] || A[x]);
      const qKey = A.query2000Ms || B.query2000Ms ? "query2000Ms" : null;
      if (mKey) row(`${k} ${mKey}`, B[mKey]?.median, A[mKey]?.median);
      if (qKey) row(`${k} ${qKey}`, B[qKey]?.median, A[qKey]?.median);
    }
  }
} else {
  console.log("  (missing node result files)");
}

console.log("\n=== Browser benchmarks (software-GL harness; lower is better) ===");
if (bb && ba) {
  console.log("[suite] boot");
  row("boot canvasMs", bb.suites?.boot?.canvasMs, ba.suites?.boot?.canvasMs);
  row("boot platformMs", bb.suites?.boot?.platformMs, ba.suites?.boot?.platformMs);
  console.log("[suite] ifc-load");
  const sizes = new Set([...Object.keys(bb.suites?.["ifc-load"] ?? {}), ...Object.keys(ba.suites?.["ifc-load"] ?? {})]);
  for (const s of sizes) {
    const B = bb.suites?.["ifc-load"]?.[s] ?? {};
    const A = ba.suites?.["ifc-load"]?.[s] ?? {};
    row(`${s} loadTotalMs`, B.loadTotalMs, A.loadTotalMs);
    row(`${s} elements`, B.elements, A.elements, "");
    row(`${s} fpsIdle`, B.fpsIdle?.fps, A.fpsIdle?.fps, "");
    row(`${s} fpsOrbit`, B.fpsOrbit?.fps, A.fpsOrbit?.fps, "");
    row(`${s} raycastMs.median`, B.raycastMs?.median, A.raycastMs?.median);
    row(`${s} propertiesOpenMs`, B.propertiesOpenMs, A.propertiesOpenMs);
    row(`${s} loadRepeatMs`, B.loadRepeatMs, A.loadRepeatMs);
    const bp = (B.phases ?? []).find((p) => p.file === `${s}.ifc`);
    const ap = (A.phases ?? []).find((p) => p.file === `${s}.ifc`);
    if (bp || ap) {
      row(`${s} phase convertMs`, bp?.convertMs, ap?.convertMs);
      row(`${s} phase fragLoadMs`, bp?.fragLoadMs, ap?.fragLoadMs);
    }
    if (A.hoverPicks) console.log(`  ${s} hoverPicks (after): ${JSON.stringify(A.hoverPicks)}`);
  }
  console.log("[suite] federated-load");
  row("fed-a..d loadTotalMs", bb.suites?.["federated-load"]?.loadTotalMs, ba.suites?.["federated-load"]?.loadTotalMs);
  row("fed-a..d heapDeltaMB", bb.suites?.["federated-load"]?.heapDeltaMB, ba.suites?.["federated-load"]?.heapDeltaMB, "MB");
  row("fed-a..d fpsIdle", bb.suites?.["federated-load"]?.fpsIdle?.fps, ba.suites?.["federated-load"]?.fpsIdle?.fps, "");
  console.log("[suite] memory-after-reload");
  row("heap after reload MB", bb.suites?.["memory-after-reload"]?.heapMB, ba.suites?.["memory-after-reload"]?.heapMB, "MB");
  console.log("[suite] plan-2d");
  row("fpsPan", bb.suites?.["plan-2d"]?.fpsPan?.fps, ba.suites?.["plan-2d"]?.fpsPan?.fps, "");
  row("fpsPan p95 ms", bb.suites?.["plan-2d"]?.fpsPan?.p95, ba.suites?.["plan-2d"]?.fpsPan?.p95);
  row("pointerBurst30Ms", bb.suites?.["plan-2d"]?.pointerBurst30Ms, ba.suites?.["plan-2d"]?.pointerBurst30Ms);
} else {
  console.log("  (missing browser result files)");
}

console.log("\nEnvironment: Chromium headless --use-gl=swiftshader (software GL);");
console.log("software rasterization dominates fill-bound frame times — GPU-bound");
console.log("numbers are upper bounds, CPU-bound numbers are representative.\n");
