/**
 * Federated-import cost decomposition under bench conditions.
 *
 * Replicates the bench-browser.mjs federation sequence (small → medium →
 * large loaded first, then fed-a..d in ONE import call) and dumps the
 * production import-phase log so the wall-clock gap — importPhases total vs
 * measured wall — can be attributed precisely (queue UI, autofit loop,
 * camera settle, per-task fixed costs).
 *
 * Diagnostic probe, not a benchmark. Run: node bench/probe-fed.mjs
 * Optionally: node bench/probe-fed.mjs --pause-renderer  (measures the same
 * sequence with the 3D loop paused during the fed import only)
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "bench", "fixtures");
const PORT = 4177;
const BASE = `http://127.0.0.1:${PORT}`;
const pauseRenderer = process.argv.includes("--pause-renderer");

const srv = spawn("npx", ["vite", "preview", "--port", String(PORT), "--host", "127.0.0.1", "--strictPort"], {
  cwd: root, stdio: "ignore", detached: true, shell: true,
});
await new Promise((r) => setTimeout(r, 3500));

const browser = await chromium.launch({
  args: ["--use-gl=swiftshader", "--enable-precise-memory-info", "--js-flags=--expose-gc", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
try {
  await page.locator("#obs-hero-3d").click({ timeout: 15000 });
  await page.locator(".obs-home.is-open").waitFor({ state: "detached", timeout: 15000 });
} catch { /* maybe already entered */ }
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}

const b64 = (f) => readFileSync(path.join(fixtureDir, f)).toString("base64");

async function importInPage(files64, names) {
  await page.evaluate(async ({ files, names }) => {
    const objs = files.map((b, i) => {
      const bin = atob(b);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      return new File([bytes], names[i], { type: "application/ifc" });
    });
    await window.__obsPerf.importFiles(objs);
  }, { files: files64, names });
}

const waitRegistered = async (prevCount, wantMore, timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.evaluate(() => window.__obsPerf.modelIds().length);
    if (n >= prevCount + wantMore) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("registration timeout");
};

// ── Warm-up sequence, identical to bench-browser.mjs ──
for (const [name, timeout] of [["small.ifc", 120000], ["medium.ifc", 120000], ["large.ifc", 180000]]) {
  const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
  const t0 = Date.now();
  await importInPage([b64(name)], [name]);
  const regMs = await waitRegistered(prev, 1, timeout);
  console.log(`warmup ${name}: registered ${regMs} ms (wall ${Date.now() - t0} ms)`);
}

// ── Federated import under bench conditions ──
{
  const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
  const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  const rendererWasEnabled = await page.evaluate(() => window.__obsPerf.isRendererEnabled());

  // Optionally pause the 3D loop for the fed import only (diagnostic arm).
  if (pauseRenderer) {
    await page.evaluate(() => window.__obsPerf.setRendererEnabled(false));
  }

  const t0 = Date.now();
  await importInPage([b64("fed-a.ifc"), b64("fed-b.ifc"), b64("fed-c.ifc"), b64("fed-d.ifc")],
    ["fed-a.ifc", "fed-b.ifc", "fed-c.ifc", "fed-d.ifc"]);
  const regMs = await waitRegistered(prev, 4, 300000);
  const wall = Date.now() - t0;

  if (pauseRenderer) {
    await page.evaluate(() => window.__obsPerf.setRendererEnabled(true));
  }

  // Let the 4th phase record land (geom-count check runs after registration).
  await page.waitForTimeout(1500);
  const heapAfter = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  // Lifecycle safety: after the queue settles the render loop MUST be back on
  // (pauseRenderLoop guard restored) — a stuck-disabled renderer is a bug.
  await page.waitForTimeout(3000);
  const rendererEnabledAfterSettle = await page.evaluate(() => window.__obsPerf.isRendererEnabled());
  const phases = await page.evaluate(() => window.__obsPerf.importPhases().filter((p) => p.file.startsWith("fed-")));
  const sumConvert = phases.reduce((a, p) => a + p.convertMs, 0);
  const sumLoad = phases.reduce((a, p) => a + p.fragLoadMs, 0);
  const sumTotal = phases.reduce((a, p) => a + p.totalMs, 0);
  console.log("fed RESULT", JSON.stringify({
    mode: pauseRenderer ? "renderer-paused" : "renderer-live",
    rendererWasEnabled,
    rendererEnabledAfterSettle,
    wall, regMs,
    heapDeltaMB: Math.round((heapAfter - heapBefore) * 10) / 10,
    filesLogged: phases.length,
    sumConvertMs: Math.round(sumConvert),
    sumFragLoadMs: Math.round(sumLoad),
    sumTaskTotalMs: Math.round(sumTotal),
    unaccountedMs: Math.round(wall - sumTotal),
    perFile: phases.map((p) => ({ f: p.file, c: Math.round(p.convertMs), l: Math.round(p.fragLoadMs), t: Math.round(p.totalMs) })),
  }));
}

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
