/**
 * OpenBIMStudio — browser-level performance benchmarks (real, reproducible).
 *
 * Drives the BUILT app (dist/, served by `vite preview`) through the real
 * production pipelines and measures:
 *
 *   boot            — navigation → 3D canvas + ribbon interactive
 *   ifc-load S/M/L  — real importFiles() → web-ifc → fragments → scene
 *   federated-load  — 4 IFC files in one import
 *   fps-idle        — requestAnimationFrame cadence, model loaded
 *   fps-orbit       — camera orbit interaction, model loaded
 *   selection       — production raycast (OBC.Raycasters.castRay) latency
 *   properties      — properties palette open latency
 *   memory          — JS heap checkpoints + load/dispose leak cycles
 *   plan-2d         — 2D plan interaction frame cadence
 *
 * Every number in the published report comes from running this script.
 * Usage:
 *   node bench/bench-browser.mjs [--label baseline] [--sizes small,medium,large]
 *        [--skip-plan] [--repeats N]
 * Output: bench/results/browser-<label>.json
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = path.join(root, "bench", "results");
mkdirSync(resultsDir, { recursive: true });

const label = arg("--label") ?? "baseline";
const sizes = (arg("--sizes") ?? "small,medium,large").split(",").filter(Boolean);
const skipPlan = process.argv.includes("--skip-plan");
const repeats = Math.max(1, Number(arg("--repeats") ?? 1));
const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const fixtureDir = path.join(root, "bench", "fixtures");
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));

// ── server ───────────────────────────────────────────────────────────────
async function startPreview() {
  // Reuse a server if one is already up (keeps CI/dev flexible)
  try {
    const res = await fetch(`${BASE}/`);
    if (res.ok) { console.log("[bench] reusing preview server on", PORT); return null; }
  } catch { /* not running */ }
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], {
    cwd: root, stdio: "ignore", detached: true, shell: true,
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) { console.log("[bench] preview server up on", PORT); return child; }
    } catch { /* retry */ }
  }
  throw new Error("vite preview failed to start");
}

// ── helpers ──────────────────────────────────────────────────────────────
const b64 = (f) => readFileSync(path.join(fixtureDir, f)).toString("base64");

async function enterPlatform(page) {
  // The welcome screen is dismissed persistently — only click through when
  // it is actually open (first visit of a fresh context).
  const homeOpen = await page.locator(".obs-home.is-open").count();
  if (homeOpen > 0) {
    await page.locator("#obs-hero-3d").click({ timeout: 30000 });
    await page.locator(".obs-home.is-open").waitFor({ state: "detached", timeout: 20000 });
  }
}

async function importIfcB64(page, b64str, name) {
  return page.evaluate(async ({ b64, name }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: "application/ifc" });
    const t0 = performance.now();
    await window.__obsPerf.importFiles([file]);
    const t1 = performance.now();
    return { ms: t1 - t0 };
  }, { b64: b64str, name });
}

async function waitForModel(page, prevIds, timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ids = await page.evaluate(() => window.__obsPerf.modelIds());
    if (ids.length > prevIds.length) return { ids, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`model did not register within ${timeoutMs} ms`);
}

/** CSP-safe polling replacement for page.waitForFunction (eval-based). */
async function waitForCond(page, fn, timeoutMs = 30000, intervalMs = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await page.evaluate(fn)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

const perfReady = () => !!window.__obsPerf?.modelIds;
const propsPaletteOpen = () => {
  const el = document.getElementById("obs-property-palette");
  return !!el && el.offsetParent !== null;
};

const bench = { label, startedAt: new Date().toISOString(), sizes, suites: {} };
let server = null;

try {
  server = await startPreview();

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--enable-precise-memory-info",
      "--js-flags=--expose-gc",
      "--disable-dev-shm-usage",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e?.message ?? e)));

  // ═════════════════════════════════════════════════════════════════════
  // Boot
  // ═════════════════════════════════════════════════════════════════════
  {
    console.log("[suite] boot");
    const bootSamples = [];
    for (let r = 0; r < Math.max(2, repeats); r++) {
      const t0 = Date.now();
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
      await page.locator(".obs-ribbon").waitFor({ state: "visible", timeout: 30000 });
      await page.locator("#obs-hero-3d").waitFor({ state: "visible", timeout: 30000 });
      const tCanvas = Date.now() - t0;
      await enterPlatform(page);
      // perf engine registered?
      await waitForCond(page, perfReady, 30000);
      bootSamples.push({ canvasMs: tCanvas, platformMs: Date.now() - t0 });
      console.log(`  run ${r + 1}: canvas+ribbon ${tCanvas} ms, platform+perf ready ${bootSamples[bootSamples.length - 1].platformMs} ms`);
      if (r === 0) {
        bench.suites.heapAfterBootMB = await page.evaluate(() => window.__obsPerf.heapMB());
        bench.suites.bvhInstalled = await page.evaluate(() => window.__obsPerf.isBVHInstalled());
        bench.suites.bootErrors = errors.splice(0).length;
      }
      if (r < Math.max(2, repeats) - 1) await page.reload({ waitUntil: "domcontentloaded" });
    }
    const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    bench.suites.boot = {
      runs: bootSamples.length,
      canvasMs: med(bootSamples.map((s) => s.canvasMs)),
      platformMs: med(bootSamples.map((s) => s.platformMs)),
    };
  }

  await enterPlatform(page);

  // ═════════════════════════════════════════════════════════════════════
  // IFC load S/M/L + fps + selection + memory
  // ═════════════════════════════════════════════════════════════════════
  const loadSuite = {};
  for (const size of sizes) {
    console.log(`[suite] ifc-load ${size} (${manifest.fixtures[size].elements} elements, ${(manifest.fixtures[size].bytes / 1024).toFixed(0)} KB)`);
    const entry = { fixtureBytes: manifest.fixtures[size].bytes, fixtureElements: manifest.fixtures[size].elements };

    const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
    const prevIds = await page.evaluate(() => window.__obsPerf.modelIds());
    const t0 = Date.now();
    const importRes = await importIfcB64(page, b64(`${size}.ifc`), `${size}.ifc`);
    const { ids } = await waitForModel(page, prevIds);
    const tRegistered = Date.now() - t0;
    const info = await page.evaluate(async (id) => await window.__obsPerf.modelInfo(id), ids[ids.length - 1]);
    // Wait until fitAll camera settle (2 rAF) — user-visible load completes here
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const loadTotal = Date.now() - t0;
    const heapAfter = await page.evaluate(() => window.__obsPerf.heapMB());

    entry.importCallMs = importRes.ms;       // importFiles promise resolve time
    entry.registerMs = tRegistered;          // → fragments.list entry visible
    entry.loadTotalMs = loadTotal;           // wall clock to interactive
    entry.elements = info?.elements ?? -1;
    entry.heapBeforeMB = heapBefore;
    entry.heapAfterMB = heapAfter;
    entry.heapDeltaMB = Math.round((heapAfter - heapBefore) * 10) / 10;
    entry.sceneMeshes = await page.evaluate(() => window.__obsPerf.sceneMeshes());

    // fps idle (2s) then orbit (2s) — dispatch real pointer drags on canvas
    await page.waitForTimeout(800); // settle after fitAll
    entry.fpsIdle = await page.evaluate(() => window.__obsPerf.frameTimes(2000));

    const canvas = page.locator("canvas").first();
    const box = await canvas.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    // Orbit: press-drag-move-move...-up loop for ~2.5s
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const orbitStart = Date.now();
    let step = 0;
    while (Date.now() - orbitStart < 2500) {
      const dx = Math.sin(step / 8) * 40, dy = Math.cos(step / 8) * 18;
      await page.mouse.move(cx + dx, cy + dy, { steps: 2 });
      step++;
      await new Promise((r) => setTimeout(r, 16));
    }
    await page.mouse.up();
    const fpsDuring = await page.evaluate(() => window.__obsPerf.frameTimes(400));
    // Sample the LAST 2s of orbiting via a fresh orbit while frameTimes runs
    entry.fpsOrbit = await page.evaluate(async (dur) => {
      const p = window.__obsPerf.frameTimes(dur);
      const canvas = document.querySelector("canvas");
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      function fire(cx0, cy0) {
        canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + cx0, clientY: rect.top + cy0, bubbles: true, pointerId: 1, isPrimary: true, buttons: 1 }));
      }
      let s = 0;
      const end = performance.now() + dur;
      fire(cx, cy);
      canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: rect.left + cx, clientY: rect.top + cy, bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
      while (performance.now() < end) {
        fire(cx + Math.sin(s / 6) * 60, cy + Math.cos(s / 6) * 25);
        s++;
        await new Promise((r) => setTimeout(r, 16));
      }
      canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: rect.left + cx, clientY: rect.top + cy, bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
      return await p;
    }, 2000);

    // Selection latency: raycast at a few viewport points (center + quarters)
    const rays = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35]]) {
      const r = await page.evaluate(async ([fx, fy]) => {
        const canvas = document.querySelector("canvas");
        const rect = canvas.getBoundingClientRect();
        return await window.__obsPerf.castRayAt(rect.width * fx, rect.height * fy);
      }, [fx, fy]);
      rays.push(r.ms);
    }
    entry.raycastMs = { n: rays.length, median: [...rays].sort((a, b) => a - b)[Math.floor(rays.length / 2)], min: Math.min(...rays), max: Math.max(...rays) };

    // Diagnostic: same raycasts AFTER manually building BVH boundsTrees on
    // every scene mesh (simulates what accelerateAllMeshes would do if it
    // ran post-load). Justifies (or rejects) the BVH integration fix.
    await page.evaluate(() => window.__obsPerf.accelerateAllMeshes());
    const raysBvh = [];
    for (const [fx, fy] of [[0.5, 0.5], [0.35, 0.5], [0.65, 0.5], [0.5, 0.35]]) {
      const r = await page.evaluate(async ([fx, fy]) => {
        const canvas = document.querySelector("canvas");
        const rect = canvas.getBoundingClientRect();
        return await window.__obsPerf.castRayAt(rect.width * fx, rect.height * fy);
      }, [fx, fy]);
      raysBvh.push(r.ms);
    }
    entry.raycastAfterBvhMs = { n: raysBvh.length, median: [...raysBvh].sort((a, b) => a - b)[Math.floor(raysBvh.length / 2)], min: Math.min(...raysBvh), max: Math.max(...raysBvh) };

    // Properties palette open latency (production service path)
    const propsMs = await measureProps(page);
    entry.propertiesOpenMs = propsMs;

    // Diagnostic: fixed vs per-element import cost — import the SAME file
    // again in this page and compare (worker/wasm already warm).
    const prevIds2 = await page.evaluate(() => window.__obsPerf.modelIds());
    const t0r = Date.now();
    await importIfcB64(page, b64(`${size}.ifc`), `${size}-repeat.ifc`);
    await waitForModel(page, prevIds2);
    entry.loadRepeatMs = Date.now() - t0r;
    const heapRepeat = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
    entry.heapAfterRepeatMB = heapRepeat;
    // Production phase split (src/features/importer.ts): conversion vs
    // fragments scene load, per file.
    const phases = await page.evaluate(() => window.__obsPerf.importPhases());
    entry.phases = phases.filter((p) => p.file === `${size}.ifc` || p.file === `${size}-repeat.ifc`).slice(-2);
    console.log(`  repeat-load=${entry.loadRepeatMs} ms, heapAfterRepeat=${heapRepeat} MB`);

    // Hover pick cost: count production FastModelPickers.getFullPick calls
    // for 60 button-held moves (orbiting) + 10 free moves. The hover gate
    // (core/hover-gate.ts) must suppress picks during the held phase.
    entry.hoverPicks = await page.evaluate(async () => await window.__obsPerf.countHoverPicks());

    loadSuite[size] = entry;
    console.log(`  load=${entry.loadTotalMs} ms  elements=${entry.elements}  heapΔ=${entry.heapDeltaMB} MB  fpsIdle=${entry.fpsIdle.fps}  fpsOrbit=${entry.fpsOrbit.fps}  raycast=${entry.raycastMs.median}→${entry.raycastAfterBvhMs.median} ms (with BVH)  props=${entry.propertiesOpenMs} ms`);
  }
  bench.suites["ifc-load"] = loadSuite;

  // ═════════════════════════════════════════════════════════════════════
  // Federated load (4 models) + memory lifecycle (dispose cycles)
  // ═════════════════════════════════════════════════════════════════════
  {
    console.log("[suite] federated-load (fed-a..d)");
    const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
    const prevIds = await page.evaluate(() => window.__obsPerf.modelIds());
    const t0 = Date.now();
    await page.evaluate(async (files) => {
      const objs = files.map((b) => {
        const bin = atob(b.b);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], b.n, { type: "application/ifc" });
      });
      await window.__obsPerf.importFiles(objs);
    }, ["fed-a", "fed-b", "fed-c", "fed-d"].map((k) => ({ b: b64(`${k}.ifc`), n: `${k}.ifc` })));
    const { ids } = await waitForModel(page, prevIds, 240000);
    // federation registers one model per file sequentially; wait until +4
    let wait = Date.now();
    while (Date.now() - wait < 180000) {
      const now = await page.evaluate(() => window.__obsPerf.modelIds());
      if (now.length >= prevIds.length + 4) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const loadTotal = Date.now() - t0;
    const heapAfter = await page.evaluate(() => window.__obsPerf.heapMB());
    const fps = await page.evaluate(() => window.__obsPerf.frameTimes(2000));
    bench.suites["federated-load"] = {
      files: 4,
      loadTotalMs: loadTotal,
      heapBeforeMB: heapBefore,
      heapAfterMB: heapAfter,
      heapDeltaMB: Math.round((heapAfter - heapBefore) * 10) / 10,
      fpsIdle: fps,
      totalModels: ids.length,
    };
    console.log(`  4 files: ${loadTotal} ms, heapΔ=${bench.suites["federated-load"].heapDeltaMB} MB, fpsIdle=${fps.fps}`);

    // Memory lifecycle: dispose everything (remove models via UI API if
    // available; otherwise reload) and measure heap recovery.
    // Use page.reload() as the app's real unload path, then re-boot.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
    await waitForCond(page, perfReady, 30000);
    const heapReboot = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
    bench.suites["memory-after-reload"] = { heapMB: heapReboot, heapReclaimedVsFederatedMB: Math.round((heapAfter - heapReboot) * 10) / 10 };
    console.log(`  after reload: ${heapReboot} MB (reclaimed ${bench.suites["memory-after-reload"].heapReclaimedVsFederatedMB} MB vs federated)`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // 2D plan interaction (Plan view via ribbon: View → Plan — SVG surface)
  // ═════════════════════════════════════════════════════════════════════
  if (!skipPlan) {
    console.log("[suite] plan-2d");
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator(".obs-ribbon").waitFor({ state: "visible", timeout: 30000 });
      await enterPlatform(page);
      await waitForCond(page, perfReady, 30000);
      const ribbon = page.locator(".obs-ribbon");
      await ribbon.getByRole("button", { name: "View", exact: true }).click();
      await ribbon.getByRole("button", { name: "Plan", exact: true }).click();
      const line = page.locator("#obs-plan-cmdline input");
      await line.waitFor({ state: "visible", timeout: 20000 });

      // Draw a grid of walls via the command line (real production draw path)
      await page.mouse.move(600, 400);
      await page.keyboard.type("wa");
      await page.keyboard.press("Enter");
      await page.getByText("Place wall", { exact: false }).first().waitFor({ timeout: 10000 });
      const drawn = [];
      for (let i = 0; i < 40; i++) {
        const x0 = 120 + (i % 8) * 55;
        const y0 = 140 + Math.floor(i / 8) * 55;
        await page.mouse.click(x0, y0);
        await page.mouse.click(x0 + 50, y0);
        drawn.push(i);
      }
      await page.keyboard.press("Escape");

      // The app itself now pauses the 3D renderer while the plan overlay is
      // open (plan-view-panel.ts setPlanRenderer3d) — the 2D numbers below
      // are measured in that real production state.
      const rendererPaused = await page.evaluate(() => window.__obsPerf.isRendererEnabled() === false);
      const fpsPan = await page.evaluate(async (dur) => {
        const surface = document.querySelector(".obs-plan-overlay svg") ?? document.querySelector(".obs-plan-overlay");
        if (!surface) throw new Error("plan surface not found");
        const rect = surface.getBoundingClientRect();
        const p = window.__obsPerf.frameTimes(dur);
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        surface.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: 1 }));
        let s = 0;
        const end = performance.now() + dur;
        while (performance.now() < end) {
          surface.dispatchEvent(new PointerEvent("pointermove", { clientX: cx + Math.sin(s / 5) * 120, clientY: cy + Math.cos(s / 5) * 80, bubbles: true, pointerId: 1, isPrimary: true, buttons: 1 }));
          s++;
          await new Promise((r) => setTimeout(r, 16));
        }
        surface.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, bubbles: true, pointerId: 1, isPrimary: true, button: 0 }));
        return await p;
      }, 2000);

      // Pointer-move burst: snap recompute sits on this path
      const snapMs = await page.evaluate(async () => {
        const surface = document.querySelector(".obs-plan-overlay svg") ?? document.querySelector(".obs-plan-overlay");
        const rect = surface.getBoundingClientRect();
        const t0 = performance.now();
        for (let i = 0; i < 30; i++) {
          surface.dispatchEvent(new PointerEvent("pointermove", { clientX: rect.left + 300 + (i % 10) * 20, clientY: rect.top + 300 + (i % 7) * 20, bubbles: true, pointerId: 1, isPrimary: true }));
          await new Promise((r) => setTimeout(r, 0));
        }
        await new Promise((r) => requestAnimationFrame(r));
        return performance.now() - t0;
      });

      bench.suites["plan-2d"] = { wallsDrawn: drawn.length, renderer3dPaused: rendererPaused, fpsPan, pointerBurst30Ms: Math.round(snapMs * 10) / 10 };
      console.log(`  walls=${drawn.length} (3D paused=${rendererPaused})  fpsPan=${fpsPan.fps} (p95=${fpsPan.p95} ms)  pointerBurst30=${bench.suites["plan-2d"].pointerBurst30Ms} ms`);
    } catch (e) {
      bench.suites["plan-2d"] = { skipped: true, reason: String(e?.message ?? e).slice(0, 200) };
      console.warn("  plan-2d skipped:", e?.message ?? e);
    }
  }

  bench.pageErrors = errors;
  bench.finishedAt = new Date().toISOString();

  const outFile = path.join(resultsDir, `browser-${label}.json`);
  writeFileSync(outFile, JSON.stringify(bench, null, 2), "utf8");
  console.log(`[bench-browser] wrote ${outFile}`);
  if (errors.length) console.warn(`[bench-browser] ⚠ ${errors.length} page errors recorded`);
} finally {
  if (server) { try { process.kill(-server.pid); } catch { /* */ } }
}

async function measureProps(page) {
  const wasOpen = await page.evaluate(() => window.__obsPerf.isPropertyPaletteVisible());
  const t0 = Date.now();
  await page.evaluate(async () => await window.__obsPerf.openPropertyPalette());
  if (wasOpen) {
    await page.evaluate(() => window.__obsPerf.openPropertyPalette());
  }
  await waitForCond(page, () => window.__obsPerf.isPropertyPaletteVisible(), 15000, 50);
  return Date.now() - t0;
}
