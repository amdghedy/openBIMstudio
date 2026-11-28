import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 390, height: 844 });
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForSelector('#obs-hero-3d', { timeout: 60000 });
await page.click('#obs-hero-3d');
await page.waitForTimeout(8000);
// open a few panels: try View menu or known toggles. First list fixed/absolute wide containers that can appear.
const before = await page.evaluate(() => document.querySelectorAll('[class*="panel"], [class*="dock"], [id*="panel"]').length);
// try opening the left project browser via keyboard or button: find buttons with 'Models' text
const res = await page.evaluate(async () => {
  const out = { opened: [] };
  const clickByText = (txt) => {
    const els = [...document.querySelectorAll('button, [role="button"], span, div')];
    const el = els.find(e => e.textContent?.trim() === txt && e.children.length <= 3);
    if (el) { el.click(); return true; } return false;
  };
  clickByText('Models');
  await new Promise(r => setTimeout(r, 1200));
  const panels = [];
  document.querySelectorAll('div,aside,section').forEach(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 150 && r.height > 200 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.zIndex >= 40 && cs.pointerEvents !== 'none' && r.bottom > 0 && r.right > 0) {
      panels.push({ cls: String(el.className).slice(0,70), id: el.id.slice(0,40), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top), z: cs.zIndex });
    }
  });
  out.panels = panels;
  return out;
});
console.log(JSON.stringify(res, null, 1).slice(0, 3000));
await page.screenshot({ path: '/tmp/probe-390-panel.png' });
await browser.close();
