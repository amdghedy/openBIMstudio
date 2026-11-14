/**
 * OpenBIMStudio — Node-side performance benchmarks (real, reproducible).
 *
 * Measures production code paths that are DOM-free:
 *   1. ifc-parse        — web-ifc (node WASM, same 0.0.77 as the app) parse
 *                         + geometry stream of each fixture
 *   2. authored-export  — production IFC writer serialization per size
 *   3. spatial-index    — snapping AabbOctree / PlanQuadtree build + queries
 *   4. props-snapshot   — PropertiesPanelService.getSnapshot at scale
 *
 * Every number in the published report comes from running this script.
 * Usage:
 *   node bench/bench-node.mjs [--label baseline|after] [--repeats N]
 * Output: bench/results/node-<label>.json
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const label = (() => {
  const i = process.argv.indexOf("--label");
  return i > 0 ? process.argv[i + 1] : "baseline";
})();
const repeats = (() => {
  const i = process.argv.indexOf("--repeats");
  return i > 0 ? Math.max(1, Number(process.argv[i + 1])) : 3;
})();

const resultsDir = path.join(root, "bench", "results");
mkdirSync(resultsDir, { recursive: true });

const fixtureDir = path.join(root, "bench", "fixtures");
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));

// ── stats helpers ────────────────────────────────────────────────────────
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    max: s[s.length - 1],
    mean: sum / s.length,
  };
}
function rssMB() { return process.memoryUsage().rss / 1024 / 1024; }
function heapMB() { return process.memoryUsage().heapUsed / 1024 / 1024; }

const bench = { label, startedAt: new Date().toISOString(), node: process.version, suites: {} };

console.log(`[bench-node] label=${label} repeats=${repeats} node=${process.version}`);

// ═════════════════════════════════════════════════════════════════════════
// Suite 1: web-ifc parse of fixtures (production parser, node WASM build)
// ═════════════════════════════════════════════════════════════════════════
{
  console.log("[suite] ifc-parse (web-ifc 0.0.77 node WASM)");
  const webifcFactory = require(path.join(root, "public/web-ifc/web-ifc-api-node.js"));
  let ifcApi = null;
  try {
    ifcApi = new webifcFactory.IfcAPI();
    ifcApi.SetWasmPath(path.join(root, "public/web-ifc/"), true);
    await ifcApi.Init();
  } catch (e) {
    console.warn("[suite] ifc-parse skipped:", e.message);
  }

  if (ifcApi) {
    const suite = {};
    for (const [key, meta] of Object.entries(manifest.fixtures)) {
      if (key === "large-reference") continue;
      const bytes = readFileSync(path.join(fixtureDir, `${key}.ifc`));
      const samples = [];
      let modelId = null;
      let elementCount = 0;
      let propsCount = 0;
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        modelId = ifcApi.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
        // Full geometry load like the real conversion pipeline does —
        // touch every placed geometry once and sum raw geometry bytes
        // (vertex+index) without materializing bogus copies.
        let geoBytes = 0;
        const flat = ifcApi.LoadAllGeometry(modelId);
        for (let i = 0; i < flat.size(); i++) {
          const mesh = flat.get(i);
          for (let gI = 0; gI < mesh.geometries.size(); gI++) {
            const placed = mesh.geometries.get(gI);
            const geom = ifcApi.GetGeometry(modelId, placed.geometryExpressID);
            geoBytes += geom.GetVertexDataSize() + geom.GetIndexDataSize();
          }
        }
        propsCount = ifcApi.GetAllLines(modelId).size();
        const t1 = performance.now();
        samples.push(t1 - t0);
        elementCount = geoBytes;
        ifcApi.CloseModel(modelId);
      }
      suite[key] = {
        bytes: meta.bytes,
        lines: propsCount,
        geometryBytes: elementCount,
        parseMs: stats(samples),
      };
      console.log(`  ${key}: ${stats(samples).median.toFixed(1)} ms median (${repeats} runs, ${(elementCount / 1024 / 1024).toFixed(1)} MB geometry bytes, ${propsCount} lines)`);
    }
    bench.suites["ifc-parse"] = suite;
    try { ifcApi.Close(); } catch { /* */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Suite 2: production IFC writer (authored-ifc exportAuthoredToIfc)
// ═════════════════════════════════════════════════════════════════════════
{
  console.log("[suite] authored-export (production IFC writer)");
  const tmpOut = mkdtempSync(path.join(tmpdir(), "obs-bench-export-"));
  writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
  const tsc = spawnSync(
    "npx",
    ["tsc", "--rootDir", "src", "--outDir", tmpOut, "--module", "commonjs",
     "--moduleResolution", "node", "--target", "ES2022", "--skipLibCheck", "--noCheck",
     "src/modules/bim-gaps/authored-ifc.ts"],
    { cwd: root, stdio: "pipe", shell: true },
  );
  if (tsc.status !== 0) {
    console.warn("  [authored-export] tsc compile failed, suite skipped");
  }
  // Deterministic building corpus — same layout rules as gen-fixtures.mjs.
  const FLOOR_H = 3.2, WALL_H = 3.0, WALL_T = 0.2;
  function building({ name, floors, colsX, colsY, roomW = 4, roomD = 3 }) {
    const elements = [];
    const levels = [];
    let n = 0;
    const id = (k) => `${name}-${k}-${n++}`;
    for (let f = 0; f < floors; f++) {
      const z = f * FLOOR_H;
      levels.push({ id: `L${f}`, name: `Level ${f}`, elevation: z });
      for (let i = 0; i < colsX; i++) for (let j = 0; j < colsY; j++)
        elements.push({ id: id("slab"), type: "slab", name: `Slab L${f} ${i}-${j}`, levelId: `L${f}`,
          params: { polygon: [[i * roomW, j * roomD], [(i + 1) * roomW, j * roomD], [(i + 1) * roomW, (j + 1) * roomD], [i * roomW, (j + 1) * roomD]], height: 0.2, thickness: 0.2, elevation: z - 0.2 } });
      for (let i = 0; i <= colsX; i++) for (let j = 0; j < colsY; j++) {
        const x0 = i * roomW, y0 = j * roomD;
        const wid = id("wall");
        const exterior = i === 0 || i === colsX;
        elements.push({ id: wid, type: "wall", name: `Wall V${i} L${f} ${j}`, levelId: `L${f}`,
          params: { start: [x0, y0], end: [x0, y0 + roomD], height: WALL_H, thickness: WALL_T, elevation: z } });
        if (exterior && j % 2 === 0) elements.push({ id: id("win"), type: "window", hostId: wid, params: { width: 1.2, height: 1.4, thickness: WALL_T, elevation: z, offsetAlongHost: roomD / 2, sillHeight: 0.9 } });
        else if (!exterior && j % 3 === 1) elements.push({ id: id("door"), type: "door", hostId: wid, params: { width: 0.9, height: 2.1, thickness: WALL_T, elevation: z, offsetAlongHost: roomD / 2, sillHeight: 0 } });
      }
      for (let j = 0; j <= colsY; j++) for (let i = 0; i < colsX; i++) {
        const x0 = i * roomW, y0 = j * roomD;
        const wid = id("wall");
        const exterior = j === 0 || j === colsY;
        elements.push({ id: wid, type: "wall", name: `Wall H${j} L${f} ${i}`, levelId: `L${f}`,
          params: { start: [x0, y0], end: [x0 + roomW, y0], height: WALL_H, thickness: WALL_T, elevation: z } });
        if (exterior && i % 2 === 1) elements.push({ id: id("win"), type: "window", hostId: wid, params: { width: 1.4, height: 1.4, thickness: WALL_T, elevation: z, offsetAlongHost: roomW / 2, sillHeight: 0.9 } });
        else if (!exterior && i % 4 === 2) elements.push({ id: id("door"), type: "door", hostId: wid, params: { width: 0.9, height: 2.1, thickness: WALL_T, elevation: z, offsetAlongHost: roomW / 2, sillHeight: 0 } });
      }
      for (let i = 0; i <= colsX; i++) for (let j = 0; j <= colsY; j++) {
        if ((i === 0 || i === colsX) && (j === 0 || j === colsY) && f > 0) continue;
        elements.push({ id: id("col"), type: "column", name: `Column L${f} ${i}-${j}`, levelId: `L${f}`,
          params: { point: [i * roomW, j * roomD], depth: 0.35, thickness: 0.35, height: FLOOR_H, elevation: z } });
      }
      for (let i = 1; i < colsX; i++) for (let j = 0; j < colsY; j++)
        elements.push({ id: id("beam"), type: "beam", name: `Beam L${f} V${i}-${j}`, levelId: `L${f}`,
          params: { start: [i * roomW, j * roomD], end: [i * roomW, (j + 1) * roomD], height: 0.5, thickness: 0.25, elevation: z + FLOOR_H - 0.5 } });
    }
    return { elements, levels };
  }

  if (tsc.status === 0) {
    const { exportAuthoredToIfc } = require(path.join(tmpOut, "modules/bim-gaps/authored-ifc.js"));
    const suite = {};
    for (const spec of [
      ["small", building({ name: "s", floors: 1, colsX: 3, colsY: 2 })],
      ["medium", building({ name: "m", floors: 3, colsX: 5, colsY: 4 })],
      ["large", building({ name: "l", floors: 8, colsX: 8, colsY: 5 })],
    ]) {
      const [key, { elements, levels }] = spec;
      const samples = [];
      let outKB = 0;
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        const res = exportAuthoredToIfc(elements, { schema: "IFC4", levels, projectName: "bench", timestamp: "2026-01-01T00:00:00Z" });
        const t1 = performance.now();
        samples.push(t1 - t0);
        outKB = Buffer.byteLength(res.text, "utf8") / 1024;
      }
      suite[key] = { elements: elements.length, outKB, exportMs: stats(samples) };
      console.log(`  ${key}: ${stats(samples).median.toFixed(1)} ms median (${elements.length} elements → ${outKB.toFixed(0)} KB)`);
    }
    bench.suites["authored-export"] = suite;
  } else {
    console.warn("  [authored-export] tsc compile failed, suite skipped");
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Suite 3: snapping spatial index (AabbOctree + PlanQuadtree)
// ═════════════════════════════════════════════════════════════════════════
{
  console.log("[suite] spatial-index (snapping octree/quadtree)");
  const tmpOut = mkdtempSync(path.join(tmpdir(), "obs-bench-spatial-"));
  writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
  const tsc = spawnSync(
    "npx",
    ["tsc", "--rootDir", "src", "--outDir", tmpOut, "--module", "commonjs",
     "--moduleResolution", "node", "--target", "ES2022", "--skipLibCheck", "--noCheck",
     "src/modules/snapping/spatial-index.ts"],
    { cwd: root, stdio: "pipe", shell: true },
  );
  if (tsc.status === 0) {
    const S = require(path.join(tmpOut, "modules/snapping/spatial-index.js"));
    const suite = {};
    for (const nItems of [500, 2000, 8000]) {
      // Deterministic grid of wall-like AABBs over a big site
      const items = [];
      for (let i = 0; i < nItems; i++) {
        const gx = (i % 64) * 6, gy = Math.floor(i / 64) * 8;
        items.push({
          id: `e${i}`,
          aabb: { min: [gx, 0, gy], max: [gx + 6, 3, gy + 0.2] },
        });
      }
      const tree = new S.AabbOctree({ min: [-10, -10, -10], max: [420, 10, 480] });
      const buildSamples = [];
      for (let r = 0; r < repeats; r++) {
        tree.rebuild([]);
        const t0 = performance.now();
        tree.rebuild(items);
        buildSamples.push(performance.now() - t0);
      }
      // 2000 radius queries (simulates a snap pass per pointer-move burst)
      const qSamples = [];
      let hits = 0;
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        for (let q = 0; q < 2000; q++) {
          const x = ((q * 37) % 390), z = ((q * 61) % 450);
          hits += tree.queryRadius([x, 1, z], 2).length > 0 ? 1 : 0;
        }
        qSamples.push(performance.now() - t0);
      }
      suite[`${nItems}-items`] = {
        n: nItems,
        buildMs: stats(buildSamples),
        query2000Ms: stats(qSamples),
        hitRate: hits / (2000 * repeats),
      };
      console.log(`  ${nItems} items: build ${stats(buildSamples).median.toFixed(1)} ms, 2000 queries ${stats(qSamples).median.toFixed(1)} ms`);
    }
    bench.suites["spatial-index"] = suite;
  } else {
    console.warn("  [spatial-index] tsc compile failed, suite skipped");
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Suite 4: properties panel snapshot at scale
// ═════════════════════════════════════════════════════════════════════════
{
  console.log("[suite] props-snapshot (PropertiesPanelService)");
  const tmpOut = mkdtempSync(path.join(tmpdir(), "obs-bench-props-"));
  writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
  const tsc = spawnSync(
    "npx",
    ["tsc", "--rootDir", "src", "--outDir", tmpOut, "--module", "commonjs",
     "--moduleResolution", "node", "--target", "ES2022", "--skipLibCheck", "--noCheck",
     "src/modules/properties-panel/index.ts", "src/modules/properties-panel/types.ts", "src/modules/properties-panel/schema.ts"],
    { cwd: root, stdio: "pipe", shell: true },
  );
  if (tsc.status === 0) {
    const { PropertiesPanelService } = require(path.join(tmpOut, "modules/properties-panel/index.js"));
    const svc = new PropertiesPanelService();
    const suite = {};
    for (const nEls of [100, 1000, 5000]) {
      const catalog = {};
      for (let i = 0; i < nEls; i++) {
        catalog[`el${i}`] = {
          id: `el${i}`, typeName: i % 3 === 0 ? "Wall" : i % 3 === 1 ? "Door" : "Slab",
          Level: `L${i % 8}`, Volume: (i * 1.5) % 100, Area: (i * 2.7) % 200,
          Material: "Concrete", Mark: `M${i}`, Comments: "", Phase: "New",
        };
      }
      svc.setElementAccessors((id) => catalog[id] ?? null, (id) => catalog[id]?.typeName ?? "Unknown");
      const ids = Object.keys(catalog);
      const samples = [];
      let propsOut = 0;
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        const snap = svc.getSnapshot(ids);
        const t1 = performance.now();
        samples.push(t1 - t0);
        if (r === 0) propsOut = snap?.props?.length ?? 0;
      }
      suite[`${nEls}-els`] = { propsOut, snapshotMs: stats(samples) };
      console.log(`  ${nEls} elements: ${stats(samples).median.toFixed(1)} ms median`);
    }
    bench.suites["props-snapshot"] = suite;
  } else {
    console.warn("  [props-snapshot] tsc compile failed, suite skipped");
  }
}

bench.peakRssMB = Math.round(rssMB());
bench.heapMB = Math.round(heapMB());
bench.finishedAt = new Date().toISOString();

const outFile = path.join(resultsDir, `node-${label}.json`);
writeFileSync(outFile, JSON.stringify(bench, null, 2), "utf8");
console.log(`[bench-node] wrote ${outFile}`);
