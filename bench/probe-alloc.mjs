/**
 * Quick diagnostic probe (not a benchmark): heap allocation sampling during
 * a single IFC import (fed-a, 247 elements) via CDP HeapProfiler.
 * Run: node bench/probe-alloc.mjs
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
} catch { /* */ }
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}

const cdp = await page.context().newCDPSession(page);
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });

const heapBefore = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
const b64 = readFileSync(path.join(fixtureDir, "fed-a.ifc")).toString("base64");
const t0 = Date.now();
await page.evaluate(async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await window.__obsPerf.importFiles([new File([bytes], "fed-a.ifc")]);
}, b64);
const tRegistered = await (async () => {
  while (Date.now() - t0 < 120000) {
    const n = await page.evaluate(() => window.__obsPerf.modelIds().length);
    if (n > prev) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timeout");
})();
await page.waitForTimeout(2500);
const heapAfter = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });

const stop = await cdp.send("HeapProfiler.stopSampling"); const result = stop.profile ?? stop.result ?? stop;
await cdp.detach();

// Build a tree: sum retained size by top function per script
const agg = new Map();
function walk(node, depth, path) {
  const name = node.callFrame.functionName || "(anonymous)";
  const url = (node.callFrame.url || "").replace(/^.*\/(src|node_modules|assets)\//, "$1/").slice(0, 60);
  const self = node.selfSize || 0;
  if (self > 0) {
    const key = `${name} @ ${url}`;
    agg.set(key, (agg.get(key) ?? 0) + self);
  }
  for (const c of node.children || []) walk(c, depth + 1, path + "/" + name);
}
walk(result.head ?? result, 0, "");
const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log(`import wall-to-registered: ${tRegistered} ms`);
console.log(`heap before: ${heapBefore} MB, after(gc): ${heapAfter} MB, delta: ${Math.round((heapAfter - heapBefore) * 10) / 10} MB`);
console.log("--- top allocation sites (self bytes) ---");
for (const [k, v] of sorted) console.log(`${(v / 1048576).toFixed(1).padStart(8)} MB  ${k}`);

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
