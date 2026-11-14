/**
 * Quick diagnostic probe (not a benchmark): load phase split using the
 * app-side import phase record (ctx.features.importer.lastImportPhases).
 * Run: node bench/probe-load.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "bench", "fixtures");
const PORT = 4176;
const BASE = `http://127.0.0.1:${PORT}`;

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
const waitRegistered = async (prevCount, wantMore, timeoutMs) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.evaluate(() => window.__obsPerf.modelIds().length);
    if (n >= prevCount + wantMore) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("registration timeout");
};

async function importFilesInPage(files) {
  await page.evaluate(async (files64) => {
    const objs = files64.map((b, i) => {
      const bin = atob(b);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      return new File([bytes], `probe-${i}.ifc`);
    });
    await window.__obsPerf.importFiles(objs);
  }, files);
}

// large
{
  const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
  const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  const t0 = Date.now();
  await importFilesInPage([b64("large.ifc")]);
  await waitRegistered(prev, 1, 180000);
  const wall = Date.now() - t0;
  const heapAfter = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  const phases = await page.evaluate(() => window.__obsPerf.importPhases());
  console.log("large:", JSON.stringify({ wall, heapDeltaMB: Math.round((heapAfter - heapBefore) * 10) / 10, phases }));
}

await page.reload({ waitUntil: "domcontentloaded" });
await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
try {
  await page.locator("#obs-hero-3d").click({ timeout: 15000 });
  await page.locator(".obs-home.is-open").waitFor({ state: "detached", timeout: 15000 });
} catch { /* */ }
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}

// federation: 4 files in one import call
{
  const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
  const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  const t0 = Date.now();
  await importFilesInPage([b64("fed-a.ifc"), b64("fed-b.ifc"), b64("fed-c.ifc"), b64("fed-d.ifc")]);
  await waitRegistered(prev, 4, 300000);
  const wall = Date.now() - t0;
  const heapAfter = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
  const phases = await page.evaluate(() => window.__obsPerf.importPhases());
  console.log("fed-a..d:", JSON.stringify({ wall, heapDeltaMB: Math.round((heapAfter - heapBefore) * 10) / 10, phases }));
}

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
