import { chromium } from 'playwright';
const browser = await chromium.launch();
// A) boot bytes (cold)
let page = await browser.newPage();
const reqs = [];
page.on('requestfinished', async r => {
  try { const res = await r.response(); const b = await res.body().catch(() => null); reqs.push({ url: r.url().replace('http://localhost:4173',''), bytes: b ? b.length : 0 }); } catch {}
});
const t0 = Date.now();
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => document.querySelector('#obs-hero-3d'), null, { timeout: 60000 }).catch(()=>{});
await page.waitForTimeout(8000);
const total = reqs.reduce((a,r)=>a+r.bytes,0);
console.log('boot: requests=' + reqs.length, 'bytes=' + total, 'ms=' + (Date.now()-t0));
console.log('ifc-vendor fetched at boot:', reqs.some(r => r.url.includes('ifc-vendor')));
for (const r of reqs.sort((a,b)=>b.bytes-a.bytes).slice(0,8)) console.log(' ', r.bytes, r.url.slice(0,90));
await page.close();
// B) Arabic workspace untranslated
page = await browser.newPage();
await page.addInitScript(() => localStorage.setItem('obs.locale', 'ar'));
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
await page.waitForSelector('#obs-hero-3d', { timeout: 60000 });
await page.waitForTimeout(2500);
const homeAr = await page.evaluate(() => {
  const counts = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t || t.length < 3 || t.length > 70) continue;
    if (!/^[A-Za-z][A-Za-z0-9 &+\-/().:']+$/.test(t)) continue;
    const el = n.parentElement; if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (['SCRIPT','STYLE'].includes(el.tagName)) continue;
    counts.add(t);
  }
  return [...counts];
});
console.log('AR home untranslated:', JSON.stringify(homeAr.slice(0,60)));
await page.click('#obs-hero-3d');
await page.waitForTimeout(8000);
const wsAr = await page.evaluate(() => {
  const counts = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.trim();
    if (!t || t.length < 3 || t.length > 70) continue;
    if (!/^[A-Za-z][A-Za-z0-9 &+\-/().:']+$/.test(t)) continue;
    const el = n.parentElement; if (!el) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
    if (['SCRIPT','STYLE'].includes(el.tagName)) continue;
    counts.add(t);
  }
  return [...counts];
});
console.log('AR workspace untranslated:', JSON.stringify(wsAr.slice(0,80)));
await page.screenshot({ path: '/tmp/verify-ar.png' });
await page.close();
await browser.close();
