import { chromium } from 'playwright';
const browser = await chromium.launch();
async function enter(w, h, locale, shot) {
  const page = await browser.newPage();
  await page.addInitScript((loc) => { if (loc) localStorage.setItem('obs.locale', loc); }, locale);
  await page.setViewportSize({ width: w, height: h });
  await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
  await page.waitForSelector('#obs-hero-3d', { timeout: 60000 });
  await page.click('#obs-hero-3d');
  await page.waitForTimeout(9000);
  return page;
}
// 1280 ribbon
let page = await enter(1280, 800, 'en');
const ribbon = await page.evaluate(() => {
  const res = { vw: innerWidth, tabs: [], clippedTabs: [], overflowConts: [] };
  // find the tab strip: look for elements whose text matches known tab names
  const names = ['Output', 'Clash Detective', 'Edit', 'X Dim', 'Home', 'Insert'];
  const all = [...document.querySelectorAll('button, [role="tab"], a, span, div')];
  for (const el of all) {
    const t = el.textContent?.trim();
    if (names.includes(t) && el.children.length <= 2) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.top < 200) res.tabs.push({ t, left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width) });
    }
  }
  const dedup = new Set();
  res.tabs = res.tabs.filter(x => { const k = x.t + x.left; if (dedup.has(k)) return false; dedup.add(k); return true; });
  res.clippedTabs = res.tabs.filter(x => x.right > innerWidth - 1);
  // containers with horizontal clipping in top 200px
  const seen = new Set();
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.top < 200 && r.height > 10 && el.scrollWidth > el.clientWidth + 4 && r.width > 200) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
        const k = el.className + '|' + el.tagName;
        if (!seen.has(k)) { seen.add(k); res.overflowConts.push({ tag: el.tagName, cls: String(el.className).slice(0,80), scrollW: el.scrollWidth, clientW: el.clientWidth, ovx: cs.overflowX }); }
      }
    }
  });
  return res;
});
console.log('==1280 ribbon=='); console.log(JSON.stringify(ribbon, null, 1).slice(0, 5000));
await page.screenshot({ path: '/tmp/probe2-1280.png' });
await page.close();
// 390 mobile workspace
page = await enter(390, 844, 'en');
const mob = await page.evaluate(() => {
  const panels = [];
  document.querySelectorAll('div,aside,section').forEach(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 150 && r.height > 150 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.zIndex >= 40 && r.bottom > 0 && r.right > 0) {
      panels.push({ cls: String(el.className).slice(0,60), id: el.id.slice(0,40), w: Math.round(r.width), h: Math.round(r.height), l: Math.round(r.left), t: Math.round(r.top), z: cs.zIndex, pe: cs.pointerEvents });
    }
  });
  return panels.slice(0, 25);
});
console.log('==390 workspace=='); console.log(JSON.stringify(mob, null, 1).slice(0, 4000));
await page.screenshot({ path: '/tmp/probe2-390.png' });
await page.close();
await browser.close();
