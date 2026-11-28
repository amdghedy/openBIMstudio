import { chromium } from 'playwright';
const browser = await chromium.launch();

async function boot(page, w, h, locale) {
  await page.addInitScript((loc) => { if (loc) localStorage.setItem('obs.locale', loc); }, locale);
  await page.setViewportSize({ width: w, height: h });
  await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(6000);
}

// 1) 1280px ribbon clipping
let page = await browser.newPage();
await boot(page, 1280, 800, 'en');
const ribbon = await page.evaluate(() => {
  const out = [];
  const els = document.querySelectorAll('*');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.top < 120 && r.height > 8 && el.children.length === 0 && el.textContent?.trim()) {
      const clippedRight = r.right > 1280;
      const hidden = r.width === 0 || getComputedStyle(el).visibility === 'hidden' || r.right < 0;
      if (clippedRight || hidden) out.push({ tag: el.tagName, cls: String(el.className).slice(0,60), text: el.textContent.trim().slice(0,40), right: Math.round(r.right), clippedRight, hidden });
    }
  }
  // horizontal overflow of likely tab containers
  const conts = [];
  for (const sel of ['.ribbon-tabs', '.tabs', '[class*="tab"]', 'header', 'nav']) {
    document.querySelectorAll(sel).forEach(el => {
      if (el.scrollWidth > el.clientWidth + 4) conts.push({ sel, cls: String(el.className).slice(0,60), scrollW: el.scrollWidth, clientW: el.clientWidth, overflowX: getComputedStyle(el).overflowX });
    });
  }
  return { clipped: out.slice(0, 30), overflowingContainers: conts.slice(0, 15) };
});
console.log('== 1280 ribbon ==');
console.log(JSON.stringify(ribbon, null, 1).slice(0, 4000));
await page.screenshot({ path: '/tmp/probe-1280.png' });
await page.close();

// 2) 390px mobile
page = await browser.newPage();
await boot(page, 390, 844, 'en');
const mobile = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const cr = canvas?.getBoundingClientRect();
  const panels = [];
  document.querySelectorAll('div,aside,section').forEach(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 200 && r.height > 200 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.zIndex > 10) {
      panels.push({ cls: String(el.className).slice(0,70), id: el.id, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), z: cs.zIndex });
    }
  });
  return { canvas: cr ? { w: Math.round(cr.width), h: Math.round(cr.height) } : null, overlays: panels.slice(0, 20) };
});
console.log('== 390 mobile ==');
console.log(JSON.stringify(mobile, null, 1).slice(0, 3000));
await page.screenshot({ path: '/tmp/probe-390.png' });
await page.close();

// 3) Arabic untranslated visible text
page = await browser.newPage();
await boot(page, 1280, 800, 'ar');
await page.waitForTimeout(3000);
const ar = await page.evaluate(() => {
  const counts = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t || t.length < 2 || t.length > 60) continue;
    if (!/^[A-Za-z][A-Za-z0-9 &+\-/().:']+$/.test(t)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).visibility === 'hidden') continue;
    if (['SCRIPT','STYLE'].includes(el.tagName)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a,b) => b[1]-a[1]).slice(0, 80);
});
console.log('== AR untranslated visible ==');
console.log(JSON.stringify(ar, null, 0).slice(0, 5000));
await page.screenshot({ path: '/tmp/probe-ar.png' });
await page.close();
await browser.close();
