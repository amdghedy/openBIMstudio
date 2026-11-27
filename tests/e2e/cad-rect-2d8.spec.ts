import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Rectangle variants (2D-8).
 *
 * Proved in the real app, one rectangle per variant, all in one drawing:
 *  1. Plain RECT + two picks → one LWPOLYLINE, 4 vertices, no options.
 *  2. RECT F 5 → filleted: 8 vertices, four group-42 bulges ≈ 0.41421.
 *  3. RECT C 6 4 → chamfered: 8 vertices, no bulges.
 *  4. RECT F 0 W 2 → wide: group 43 = 2, square corners again.
 *  5. RECT W 0 E 5 T 3 → elevated + thick: groups 38 = 5, 39 = 3.
 *  6. RECT E 0 T 0 A 1000 50 → area mode: the second pick fixes only
 *     the direction; the saved rectangle is 50 × 20 (area 1000).
 *  7. QSAVE writes all six as LWPOLYLINEs with exactly those groups,
 *     and re-importing the saved DXF doubles the census to 12.
 *
 * The option settings persist across RECT invocations (AutoCAD
 * behaviour), so each variant clears the settings it does not want
 * (F 0 / W 0 / E 0 / T 0) — which also proves the zero value clears.
 * Calibration runs with OSNAP/POLAR/OTRACK/grid-snap off (A15/A16
 * lessons), and the picks are fractions of the canvas — the default
 * view only spans ~200×100 world units, so absolute world picks would
 * land outside the canvas (on the ribbon).
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && python3 -m http.server 3138 --directory dist
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3138 and which starts no webServer.
 */

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

async function calibrate(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<Affine> {
  const midY = box.y + box.height / 2;
  const midX = box.x + box.width / 2;
  await page.mouse.move(box.x + box.width * 0.25, midY);
  await page.waitForTimeout(250);
  const w1 = await readCoords(page);
  await page.mouse.move(box.x + box.width * 0.75, midY);
  await page.waitForTimeout(250);
  const w2 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.25);
  await page.waitForTimeout(250);
  const w3 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.75);
  await page.waitForTimeout(250);
  const w4 = await readCoords(page);
  const px1 = box.x + box.width * 0.25, px2 = box.x + box.width * 0.75;
  const py1 = box.y + box.height * 0.25, py2 = box.y + box.height * 0.75;
  const sx = (w2.x - w1.x) / (px2 - px1);
  const sy = (w4.y - w3.y) / (py2 - py1);
  return { sx, ox: w1.x - sx * px1, sy, oy: w3.y - sy * py1 };
}

test('2D-8 rectangle variants: chamfer, fillet, width, elevation/thickness, area', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 60000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  const waitHist = async (re: RegExp) => {
    await expect.poll(async () => re.test(await hist()), { timeout: 15000 }).toBe(true);
  };
  const lastCensus = async () => {
    await run('CENSUS');
    const lines = (await hist()).split('\n').filter((l) => l.includes('CENSUS:'));
    return lines[lines.length - 1] ?? '';
  };
  const expectCensus = async (re: RegExp) => {
    await expect.poll(lastCensus, { timeout: 15000 }).toMatch(re);
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel).first();
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };

  // OSNAP/POLAR/OTRACK/grid-snap off for the free-point picks (A15/A16
  // lessons).
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setToggle('[data-s=gridsnap]', false);

  const box = await canvasBox();
  const map = await calibrate(page, box);
  void map;
  const frac = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const pickRect = async (fx0: number, fy0: number, fx1: number, fy1: number) => {
    const a = frac(fx0, fy0), b = frac(fx1, fy1);
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
  };

  // 1. Plain rectangle — the pre-2D-8 path, unchanged.
  await run('RECTANG');
  await pickRect(0.08, 0.15, 0.28, 0.30);
  await waitHist(/Rectangle added: .*×/);
  await expectCensus(/LWPOLYLINE=1/);

  // 2. Fillet: F arms the prompt, 5 sets the radius.
  await run('RECTANG');
  await run('F');
  await run('5');
  await waitHist(/RECT: fillet radius = 5/);
  await pickRect(0.36, 0.15, 0.56, 0.30);
  await waitHist(/Rectangle added: .*\(fillet r=5/);
  await expectCensus(/LWPOLYLINE=2/);

  // 3. Chamfer: inline "C 6 4" sets both distances and clears the fillet.
  await run('RECTANG');
  await run('C 6 4');
  await waitHist(/RECT: chamfer distances = 6/);
  await pickRect(0.64, 0.15, 0.84, 0.30);
  await waitHist(/Rectangle added: .*\(chamfer 6/);
  await expectCensus(/LWPOLYLINE=3/);

  // 4. Width: F 0 clears the fillet first, then W 2.
  await run('RECTANG');
  await run('F 0');
  await waitHist(/RECT: fillet radius = 0/);
  await run('W');
  await run('2');
  await waitHist(/RECT: line width = 2/);
  await pickRect(0.08, 0.45, 0.28, 0.60);
  await waitHist(/Rectangle added: .*\(width 2/);
  await expectCensus(/LWPOLYLINE=4/);

  // 5. Elevation + thickness: W 0 clears the width first.
  await run('RECTANG');
  await run('W 0');
  await waitHist(/RECT: line width = 0/);
  await run('E');
  await run('5');
  await waitHist(/RECT: elevation = 5/);
  await run('T');
  await run('3');
  await waitHist(/RECT: thickness = 3/);
  await pickRect(0.36, 0.45, 0.56, 0.60);
  await waitHist(/Rectangle added: .*\(elevation 5/);
  await expectCensus(/LWPOLYLINE=5/);

  // 6. Area: E 0 / T 0 clear the elevation and thickness, then A 1000
  //    and a length of 50 — the second pick fixes only the direction
  //    (due east), so the rectangle is 50 long and 1000/50 = 20 wide.
  await run('RECTANG');
  await run('E 0');
  await waitHist(/RECT: elevation = 0/);
  await run('T 0');
  await waitHist(/RECT: thickness = 0/);
  await run('A');
  await run('1000');
  await waitHist(/Enter length of rectangle or \[Width\]:/);
  await run('50');
  await waitHist(/RECT: rectangle area = 1000/);
  const a6 = frac(0.64, 0.55), b6 = frac(0.84, 0.55);
  await page.mouse.click(a6.x, a6.y);
  await page.mouse.click(b6.x, b6.y);
  await waitHist(/Rectangle added: .*\(area 1000/);
  await expectCensus(/LWPOLYLINE=6/);

  // 7. QSAVE: every variant is written as a LWPOLYLINE with exactly the
  //    groups its variant needs, in drawing order.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  const savedPath = testInfo.outputPath('saved-2d8.dxf');
  await d.saveAs(savedPath);
  const text = (await import('node:fs')).readFileSync(savedPath, 'utf8');
  const lines = text.split(/\r?\n/);
  const recs: { type: string; groups: Map<string, string[]> }[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), val = lines[i + 1];
    if (code === '0') recs.push({ type: val, groups: new Map() });
    const cur = recs[recs.length - 1];
    if (cur) {
      const arr = cur.groups.get(code) ?? [];
      arr.push(val);
      cur.groups.set(code, arr);
    }
  }
  const pls = recs.filter((r) => r.type === 'LWPOLYLINE');
  expect(pls, `expected exactly 6 LWPOLYLINE records, got ${pls.length}`).toHaveLength(6);
  const verts = (r: { groups: Map<string, string[]> }) => {
    const xs = (r.groups.get('10') ?? []).map(Number);
    const ys = (r.groups.get('20') ?? []).map(Number);
    return xs.map((x, i) => ({ x, y: ys[i] }));
  };
  const has = (r: { groups: Map<string, string[]> }, code: string) => r.groups.has(code);
  const num = (r: { groups: Map<string, string[]> }, code: string) => Number(r.groups.get(code)?.[0]);

  expect(verts(pls[0]), 'plain: 4 vertices').toHaveLength(4);
  expect(has(pls[0], '42'), 'plain: no bulges').toBe(false);
  expect(has(pls[0], '43'), 'plain: no width').toBe(false);
  expect(has(pls[0], '38'), 'plain: no elevation').toBe(false);
  expect(has(pls[0], '39'), 'plain: no thickness').toBe(false);

  expect(verts(pls[1]), 'fillet: 8 vertices').toHaveLength(8);
  const bulges = (pls[1].groups.get('42') ?? []).map(Number);
  expect(bulges, 'fillet: four bulges').toHaveLength(4);
  for (const b of bulges) expect(Math.abs(b - Math.tan(Math.PI / 8)), `bulge ${b} ≈ tan(22.5°)`).toBeLessThan(0.001);
  expect(has(pls[1], '43'), 'fillet: no width').toBe(false);

  expect(verts(pls[2]), 'chamfer: 8 vertices').toHaveLength(8);
  expect(has(pls[2], '42'), 'chamfer: no bulges').toBe(false);

  expect(verts(pls[3]), 'width: 4 vertices').toHaveLength(4);
  expect(num(pls[3], '43'), 'width: group 43 = 2').toBe(2);
  expect(has(pls[3], '42'), 'width: no bulges (fillet cleared)').toBe(false);

  expect(verts(pls[4]), 'elev/thick: 4 vertices').toHaveLength(4);
  expect(num(pls[4], '38'), 'elevation: group 38 = 5').toBe(5);
  expect(num(pls[4], '39'), 'thickness: group 39 = 3').toBe(3);
  expect(has(pls[4], '43'), 'elev/thick: no width').toBe(false);

  const v6 = verts(pls[5]);
  expect(v6, 'area: 4 vertices').toHaveLength(4);
  const xs6 = v6.map((p) => p.x), ys6 = v6.map((p) => p.y);
  const w6 = Math.max(...xs6) - Math.min(...xs6), h6 = Math.max(...ys6) - Math.min(...ys6);
  expect(Math.abs(w6 - 50), `area: width ${w6} ≈ 50`).toBeLessThan(0.5);
  expect(Math.abs(h6 - 20), `area: height ${h6} ≈ 20`).toBeLessThan(0.5);
  let a6area = 0;
  for (let i = 0; i < 4; i++) { const p = v6[i], q = v6[(i + 1) % 4]; a6area += p.x * q.y - q.x * p.y; }
  expect(Math.abs(Math.abs(a6area) / 2 - 1000), `area: |area| ${Math.abs(a6area) / 2} ≈ 1000`).toBeLessThan(1);
  expect(has(pls[5], '38'), 'area: no elevation').toBe(false);
  expect(has(pls[5], '39'), 'area: no thickness').toBe(false);

  // 8. Re-import the saved DXF: the six rectangles come back as six
  //    more LWPOLYLINEs.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'saved-2d8.dxf', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expectCensus(/LWPOLYLINE=12/);

  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});
