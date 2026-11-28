import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const reqs = [];
page.on('requestfinished', async r => {
  try {
    const res = await r.response();
    const body = await res.body().catch(() => null);
    reqs.push({ url: r.url().replace('http://localhost:4173',''), type: r.resourceType(), bytes: body ? body.length : 0, timing: r.timing() });
  } catch {}
});
const t0 = Date.now();
await page.goto('http://localhost:4173/', { waitUntil: 'load', timeout: 120000 });
const tLoad = Date.now() - t0;
// wait for app ready signal
await page.waitForFunction(() => document.querySelector('#app')?.children.length > 0, null, {timeout: 60000}).catch(()=>{});
await page.waitForTimeout(8000);
const tIdle = Date.now() - t0;
const byType = {};
for (const r of reqs) { byType[r.type] = byType[r.type] || {n:0, bytes:0}; byType[r.type].n++; byType[r.type].bytes += r.bytes; }
console.log('load event ms:', tLoad, 'after 8s settle ms:', tIdle);
console.log('total requests:', reqs.length, 'total bytes:', reqs.reduce((a,r)=>a+r.bytes,0));
console.log(JSON.stringify(byType, null, 1));
console.log('--- biggest ---');
for (const r of reqs.sort((a,b)=>b.bytes-a.bytes).slice(0,15)) console.log(r.bytes, r.type, r.url.slice(0,110));
await browser.close();
