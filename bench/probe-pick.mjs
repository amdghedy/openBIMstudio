/**
 * Quick diagnostic probe (not a benchmark): renders stats + pick split on
 * the large fixture. Run: node bench/probe-pick.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "bench", "fixtures");
const PORT = 4175;
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
// welcome screen (fresh context) — enter
try {
  await page.locator("#obs-hero-3d").click({ timeout: 15000 });
  await page.locator(".obs-home.is-open").waitFor({ state: "detached", timeout: 15000 });
} catch { /* maybe already entered */ }
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}

// load large
const b64 = readFileSync(path.join(fixtureDir, "large.ifc")).toString("base64");
const prev = await page.evaluate(() => window.__obsPerf.modelIds());
await page.evaluate(async ({ b64 }) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  await window.__obsPerf.importFiles([new File([bytes], "large.ifc")]);
}, { b64 });
let t0 = Date.now();
while (Date.now() - t0 < 120000) {
  const ids = await page.evaluate(() => window.__obsPerf.modelIds());
  if (ids.length > prev.length) break;
  await new Promise((r) => setTimeout(r, 250));
}
await page.waitForTimeout(1500);

const stats = await page.evaluate(() => window.__obsPerf.renderStats());
console.log("renderStats:", JSON.stringify(stats, null, 2));

for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.6]]) {
  const split = await page.evaluate(async ([fx, fy]) => {
    const canvas = document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    return await window.__obsPerf.pickSplit(rect.width * fx, rect.height * fy);
  }, [fx, fy]);
  console.log(`pickSplit @${fx},${fy}:`, JSON.stringify(split));
}

// frame timing with stats
const ft = await page.evaluate(() => window.__obsPerf.frameTimes(1500));
console.log("frameTimes:", JSON.stringify(ft));

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
