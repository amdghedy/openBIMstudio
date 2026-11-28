import { chromium } from 'playwright';
const browser = await chromium.launch();
async function enter(w, h) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: w, height: h });
  await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('#obs-hero-3d', { timeout: 60000 });
  await page.click('#obs-hero-3d');
  await page.waitForTimeout(8000);
  return page;
}
// 1280: all tabs reachable?
let page = await enter(1280, 800);
const r1280 = await page.evaluate(() => {
  const names = ['Output', 'Clash Detective', 'Edit', 'X Dim', 'View'];
  const found = [];
  for (const el of document.querySelectorAll('.obs-ribbon__tab, button, [role="tab"]')) {
    const t = el.textContent?.trim();
    if (names.includes(t)) {
      const r = el.getBoundingClientRect();
      found.push({ t, right: Math.round(r.right), visible: r.right <= innerWidth && r.left >= 0 && r.width > 0 });
    }
  }
  return found;
});
console.log('1280 tabs:', JSON.stringify(r1280));
await page.screenshot({ path: '/tmp/verify-1280.png' });
await page.close();
// 390: panel sheet + viewcube hidden
page = await enter(390, 844);
await page.evaluate(() => {
  const els = [...document.querySelectorAll('button, [role="button"], span, div')];
  els.find(e => e.textContent?.trim() === 'Models' && e.children.length <= 3)?.click();
});
await page.waitForTimeout(1200);
const r390 = await page.evaluate(() => {
  const out = { panel: null, viewcube: null, canvasVisibleBelow: null };
  document.querySelectorAll('div').forEach(el => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if ((cs.position === 'absolute' || cs.position === 'fixed') && +cs.zIndex >= 9000 && r.width > 150 && r.height > 150 && cs.visibility !== 'hidden') {
      out.panel = { w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top), bottom: Math.round(r.bottom) };
    }
  });
  const vc = document.getElementById('obs-viewcube');
  out.viewcube = vc ? getComputedStyle(vc).display : 'missing';
  out.vh = innerHeight;
  return out;
});
console.log('390:', JSON.stringify(r390));
await page.screenshot({ path: '/tmp/verify-390.png' });
await page.close();
await browser.close();
