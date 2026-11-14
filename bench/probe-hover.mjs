/**
 * Build-agnostic hover-cost probe: works on the pre-optimization build AND
 * the optimized build (no dependency on new perf helpers).
 *
 * Measures main-thread wall time for 60 button-held pointer moves across the
 * 3D canvas (orbiting) + 30 free moves, after loading small.ifc via the real
 * UI import path. On the old build every held move triggers a hover GPU
 * pick; on the new build (hover gate) it must not.
 *
 * Run: node bench/probe-hover.mjs [--label NAME]
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

const label = (() => {
  const i = process.argv.indexOf("--label");
  return i > 0 ? process.argv[i + 1] : "probe";
})();

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
} catch { /* maybe entered */ }

// Import small.ifc through the real UI: click "Any file" → filechooser
const [chooser] = await Promise.all([
  page.waitForEvent("filechooser", { timeout: 30000 }),
  page.locator(".obs-ribbon").getByRole("button", { name: "File", exact: true }).click({ timeout: 15000 }).then(() => page.locator(".obs-ribbon").getByRole("button", { name: "Any file", exact: false }).first().click({ timeout: 15000 })),
]);
await chooser.setFiles(path.join(fixtureDir, "small.ifc"));

// Wait for the import queue to report done (both builds render "done · N elements")
const t0 = Date.now();
while (Date.now() - t0 < 120000) {
  const done = await page.evaluate(() => /done · \d+ elements/.test(document.body.innerText));
  if (done) break;
  await new Promise((r) => setTimeout(r, 300));
}
await page.waitForTimeout(1500); // fitAll settle

// Measure: 60 held-button moves + 30 free moves on the 3D canvas
const res = await page.evaluate(async () => {
  const canvas = document.querySelector("canvas");
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const move = (buttons, dx, dy) => canvas.dispatchEvent(new PointerEvent("pointermove", {
    clientX: cx + dx, clientY: cy + dy, bubbles: true, pointerId: 1, isPrimary: true, buttons,
  }));
  const heldStart = performance.now();
  for (let i = 0; i < 60; i++) {
    move(1, Math.sin(i / 6) * 80, Math.cos(i / 6) * 40);
    await new Promise((r) => setTimeout(r, 4));
  }
  const heldMs = performance.now() - heldStart;
  const freeStart = performance.now();
  for (let i = 0; i < 30; i++) {
    move(0, Math.sin(i / 3) * 60, Math.cos(i / 3) * 30);
    await new Promise((r) => setTimeout(r, 30));
  }
  const freeMs = performance.now() - freeStart;
  return { heldMs: Math.round(heldMs), freeMs: Math.round(freeMs) };
});

console.log(`${label}: 60 held-button moves=${res.heldMs} ms, 30 free moves=${res.freeMs} ms`);

await browser.close();
try { process.kill(-srv.pid); } catch { /* */ }
process.exit(0);
