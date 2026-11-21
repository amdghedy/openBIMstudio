// Prints everything the page says while booting (console, page errors, failed requests, WebGL availability).
// Usage: node scripts/browser-boot-probe.mjs <chromium|firefox|webkit>   (needs the preview server on :3000)
import { chromium, firefox, webkit } from "@playwright/test";
const name = process.argv[2] || "firefox";
const type = { chromium, firefox, webkit }[name];
const launchOptions = name === "firefox" ? { firefoxUserPrefs: { 'webgl.disabled': false, 'webgl.force-enabled': true, 'webgl.enable-webgl2': true, 'webgl.forbid-software': false, 'webgl.out-of-process': false, 'webgl.disable-fail-if-major-performance-caveat': true, 'gfx.webrender.software': true, 'gfx.webrender.all': false, 'layers.acceleration.disabled': true, 'gfx.canvas.accelerated': false } } : {};
const browser = await type.launch(launchOptions);
const page = await browser.newPage();
page.on("console", (m) => console.log(`[console.${m.type()}]`, m.text().slice(0, 400)));
page.on("pageerror", (e) => console.log("[pageerror]", String(e.stack || e.message).slice(0, 800)));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url().slice(0, 200), r.failure()?.errorText));
page.on("response", (r) => { if (r.status() >= 400) console.log("[http", r.status() + "]", r.url().slice(0, 200)); });
await page.goto("http://127.0.0.1:3000/", { waitUntil: "load", timeout: 60000 }).catch((e) => console.log("[goto]", e.message));
await page.waitForTimeout(15000);
console.log("[probe] canvases:", await page.locator("canvas").count(), " ribbon:", await page.locator(".obs-ribbon").count());
console.log("[probe] webgl:", JSON.stringify(await page.evaluate(() => { const c = document.createElement("canvas"); const g = c.getContext("webgl2") || c.getContext("webgl"); return g ? { ok: true, renderer: g.getParameter(g.RENDERER) } : { ok: false }; })));
console.log("[probe] body text:", (await page.evaluate(() => document.body.innerText)).slice(0, 300).replace(/\s+/g, " "));
await browser.close();
