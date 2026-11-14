/**
 * Reload-lifecycle diagnostic: after a full bench-like session (5 models
 * incl. a 4-file federation), reload and read the heap — then reload AGAIN.
 * A first-reload reading that drops substantially on the second reload is
 * transient post-boot settling, not retained memory.
 * Run: node bench/probe-reload.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = path.join(root, "bench", "fixtures");
const PORT = 4178;
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

const b64 = (f) => readFileSync(path.join(fixtureDir, f)).toString("base64");

// Session: small + medium + large + fed×4 (bench federation sequence).
for (const name of ["small.ifc", "medium.ifc", "large.ifc"]) {
  await page.evaluate(async (b) => {
    const bin = atob(b);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    await window.__obsPerf.importFiles([new File([bytes], "s-" + Math.random().toString(36).slice(2, 7) + ".ifc")]);
  }, b64(name));
  // wait for registration
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    const n = await page.evaluate(() => window.__obsPerf.modelIds().length);
    const target = name === "small.ifc" ? 1 : name === "medium.ifc" ? 2 : 3;
    if (n >= target) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}
{
  const prev = await page.evaluate(() => window.__obsPerf.modelIds().length);
  await page.evaluate(async (bs) => {
    const objs = bs.map((b, i) => {
      const bin = atob(b);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      return new File([bytes], `fed-${i}.ifc`);
    });
    await window.__obsPerf.importFiles(objs);
  }, ["fed-a", "fed-b", "fed-c", "fed-d"].map((k) => b64(`${k}.ifc`)));
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const n = await page.evaluate(() => window.__obsPerf.modelIds().length);
    if (n >= prev + 4) break;
    await new Promise((r) => setTimeout(r, 250));
  }
}
await page.waitForTimeout(4000);
const heapSession = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
console.log("session heap (7 models):", heapSession, "MB");

// Reload #1 — the bench's lifecycle checkpoint.
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}
await page.waitForTimeout(3000);
const h1 = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
console.log("after reload #1 (+3 s, gc):", h1, "MB");

// Reload #2 — same procedure once more.
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60000 });
while (!(await page.evaluate(() => !!window.__obsPerf?.modelIds))) {
  await new Promise((r) => setTimeout(r, 250));
}
await page.waitForTimeout(3000);
const h2 = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
console.log("after reload #2 (+3 s, gc):", h2, "MB");

// Idle settle without reload — does the heap drain further over time?
await page.waitForTimeout(8000);
const h3 = await page.evaluate(() => { window.__obsPerf.gc(); return window.__obsPerf.heapMB(); });
console.log("after 8 s idle (gc):", h3, "MB");

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
