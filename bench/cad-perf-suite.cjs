/* Phase 5: repeatable CAD performance suite. Usage: node --max-old-space-size=8192 bench/cad-perf-suite.cjs [sizes=10000,100000,1000000] [--json out.json]
 * Seeded (mulberry32) so runs are comparable. Reports p50/p95 per operation, heap delta, and one-shot timings. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cadperf-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/cad-viewer/viewer-math.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const M = require(find(out, "viewer-math.js")), { writeDxf } = require(find(out, "dxf-writer.js")), { parseDxf } = require(find(out, "dxf-reader.js"));
const sizesArg = process.argv.find((a) => /^\d+(,\d+)*$/.test(a));
const sizes = (sizesArg ?? "10000,100000,1000000").split(",").map(Number);
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const rng = (s) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const W = 10000;
function gen(n) {
  const r = rng(12345), ents = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = r(), x = r() * W, y = r() * W, layer = "L" + (i % 20);
    ents[i] = k < 0.6 ? { type: "LINE", layer, start: { x, y }, end: { x: x + r() * 40 - 20, y: y + r() * 40 - 20 } }
      : k < 0.8 ? { type: "CIRCLE", layer, center: { x, y }, radius: 1 + r() * 15 }
      : k < 0.9 ? { type: "ARC", layer, center: { x, y }, radius: 1 + r() * 15, startAngle: 0, endAngle: 90 + r() * 200 }
      : { type: "LWPOLYLINE", layer, closed: false, points: [{ x, y }, { x: x + 10, y: y + 5 }, { x: x + 20, y: y - 5 }, { x: x + 30, y }] };
  }
  return ents;
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const now = () => Number(process.hrtime.bigint()) / 1e6;
function sample(reps, fn) { const t = []; for (let i = 0; i < reps; i++) { const s = now(); fn(i); t.push(now() - s); } return { n: reps, p50: +pct(t, 0.5).toFixed(3), p95: +pct(t, 0.95).toFixed(3), max: +Math.max(...t).toFixed(3) }; }
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed / 1048576; };
const results = [];
for (const n of sizes) {
  const r = rng(99), row = { entities: n, ops: {} };
  const h0 = heap();
  let s = now(); const ents = gen(n); row.generateMs = +(now() - s).toFixed(1);
  s = now(); let b = null; for (const e of ents) b = M.unionBBox(b, M.entityBBox(e)); row.bboxPassMs = +(now() - s).toFixed(1);
  s = now(); const idx = M.buildIndex(ents, b); row.indexBuildMs = +(now() - s).toFixed(1);
  row.heapMB = +(heap() - h0).toFixed(0);
  const q = (w) => { const x = r() * (W - w), y = r() * (W - w); return { minX: x, minY: y, maxX: x + w, maxY: y + w }; };
  row.ops.windowSelect_1pctArea = sample(200, () => M.queryIndexBox(idx, ents, q(W * 0.1)));
  row.ops.windowSelect_0_01pctArea = sample(500, () => M.queryIndexBox(idx, ents, q(W * 0.01)));
  row.ops.pick = sample(2000, () => M.pickEntity(idx, ents, r() * W, r() * W, 8));
  row.ops.snap = sample(2000, () => M.snapOrRaw(idx, ents, r() * W, r() * W, 8, ["endpoint", "midpoint", "center", "nearest"]));
  // Incremental index maintenance proxy: rebuild cost after a single edit is the current behaviour (full rebuild).
  row.ops.rebuildIndexAfterEdit = sample(n >= 1e6 ? 1 : 3, () => M.buildIndex(ents, b));
  // Draw one more entity: incremental append vs the previous full rebuild.
  { const base = ents.length; const spare = ents.slice(); row.ops.addOneEntity_append = sample(50, () => { spare.push({ type: "LINE", layer: "L0", start: { x: 100, y: 100 }, end: { x: 120, y: 110 } }); if (!M.indexAppend(idx, spare, spare.length - 1)) spare.pop(); }); spare.length = base; idx.boxes.length = base; }
  // Undo-stack memory proxy: shallow snapshot of the entity array per step.
  const hs = heap(); const stack = []; for (let i = 0; i < 20; i++) stack.push(ents.slice()); row.undoSnapshots20MB = +(heap() - hs).toFixed(0); stack.length = 0;
  if (n <= 200000) {
    const doc = { layers: Array.from({ length: 20 }, (_, i) => ({ name: "L" + i, color: 7 })), entities: ents };
    s = now(); const text = writeDxf(doc); row.writeDxfMs = +(now() - s).toFixed(0); row.dxfMB = +(text.length / 1048576).toFixed(1);
    s = now(); const back = parseDxf(text); row.parseDxfMs = +(now() - s).toFixed(0); row.roundTripEntities = back.entities.length;
  } else row.note = "DXF write/parse skipped at this size (string size/heap); run with a larger heap to include it.";
  results.push(row);
  console.log(JSON.stringify(row));
}
const header = `| entities | bbox pass | index build | heap MB | window 1% area p50/p95 | window 0.01% area p50/p95 | pick p50/p95 | snap p50/p95 | write DXF | parse DXF |\n|---|---|---|---|---|---|---|---|---|---|`;
const f = (o) => `${o.p50}/${o.p95} ms`;
console.log("\n" + header);
for (const r of results) console.log(`| ${r.entities} | ${r.bboxPassMs} ms | ${r.indexBuildMs} ms | ${r.heapMB} | ${f(r.ops.windowSelect_1pctArea)} | ${f(r.ops.windowSelect_0_01pctArea)} | ${f(r.ops.pick)} | ${f(r.ops.snap)} | ${r.writeDxfMs ?? "—"} ms | ${r.parseDxfMs ?? "—"} ms |`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ node: process.version, cpus: os.cpus()[0]?.model, results }, null, 2));
