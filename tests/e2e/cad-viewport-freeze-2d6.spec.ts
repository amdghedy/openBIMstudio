import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Per-viewport freeze (2D-6).
 *
 * Reference model, imported from DXF: one LINE on layer WALLS
 * (0,0)-(1000,0) and one LINE on layer DOORS (0,1000)-(1000,1000).
 * Model bounds are x 0..1000, y 0..1000, centre (500,500). The lines
 * are 1000 model units long so that at 1:50 each spans ~18 screen px
 * inside its viewport — long enough to sample reliably.
 *
 * Proved in the real app:
 *  1. Layout1 gets two MVIEW viewports side by side at 1:50, both
 *     showing the same model window (viewCentre (50,500)).
 *  2. VPORT freezes layer WALLS in the left viewport only; re-opening
 *     the dialog shows the stored value.
 *  3. Pixel proof on the live canvas: the WALLS line is absent in the
 *     left viewport and present in the right one, while the DOORS line
 *     is present in both — the freeze hides one layer through one
 *     viewport and nothing else.
 *  4. QSAVE writes the freeze as VIEWPORT group 331 (exactly one 331
 *     in the saved DXF — the frozen viewport's WALLS handle).
 *
 * Calibration runs with OSNAP off (A16 lesson) and the screen->sheet
 * map is re-solved from the live canvas before each absolute pick
 * (A15 lesson). The default full-sheet viewport paints the two lines
 * at sheet y≈9.5/200.5 — outside the MVIEW rects (30..180) — so it
 * cannot contaminate the pixel samples.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && python3 -m http.server 3133 --directory dist
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3133 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, 'WALLS', 10, 0, 20, 0, 11, 1000, 21, 0,
  0, 'LINE', 8, 'DOORS', 10, 0, 20, 1000, 11, 1000, 21, 1000,
  0, 'ENDSEC', 0, 'EOF',
);

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
  await page.waitForTimeout(150);
  const w1 = await readCoords(page);
  await page.mouse.move(box.x + box.width * 0.75, midY);
  await page.waitForTimeout(150);
  const w2 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.25);
  await page.waitForTimeout(150);
  const w3 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.75);
  await page.waitForTimeout(150);
  const w4 = await readCoords(page);
  const px1 = box.x + box.width * 0.25, px2 = box.x + box.width * 0.75;
  const py1 = box.y + box.height * 0.25, py2 = box.y + box.height * 0.75;
  const sx = (w2.x - w1.x) / (px2 - px1);
  const sy = (w4.y - w3.y) / (py2 - py1);
  return { sx, ox: w1.x - sx * px1, sy, oy: w3.y - sy * py1 };
}

test('2D-6 per-viewport freeze: one layer hidden in one viewport only', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  const lastCensus = async () => {
    await run('CENSUS');
    const lines = (await hist()).split('\n').filter((l) => l.includes('CENSUS:'));
    return lines[lines.length - 1] ?? '';
  };
  const expectCensus = async (re: RegExp) => {
    await expect.poll(lastCensus, { timeout: 15000 }).toMatch(re);
  };
  const spaceBtn = page.locator('[data-s=space]').first();
  const tabs = page.locator('[data-r=tabs]').first();
  const newLayoutBtn = tabs.locator('button[data-new-layout]');
  const osnapBtn = page.locator('[data-s=snap]');
  const setOsnap = async (on: boolean) => {
    const active = await osnapBtn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await osnapBtn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;

  // OSNAP off for calibration (A16 lesson). POLAR tracking is on by
  // default and snaps a free-point pick to the nearest polar ray from the
  // last point — the MVIEW second corner would land on the 90° ray from
  // the first corner instead of the clicked point — so POLAR and OTRACK
  // are off for the free-point picks, as in the A8 spec.
  await setOsnap(false);
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);

  // 1. Import the reference model: WALLS line at y=0, DOORS line at y=1000.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/LINE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. Layout1 + two MVIEW viewports at 1:50, side by side.
  await newLayoutBtn.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await expect(tabs.locator('button[data-li="0"]')).toHaveText('Layout1');
  await run('ZOOM E');
  await page.waitForTimeout(600);
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const clickSheet = async (wx: number, wy: number) => {
    await page.mouse.click((wx - map.ox) / map.sx, (wy - map.oy) / map.sy);
  };
  const recalibrate = async () => {
    box = await canvasBox();
    map = await calibrate(page, box);
  };
  const mview = async (x1: number, y1: number, x2: number, y2: number) => {
    await run('MVIEW');
    await expect.poll(async () => /specify the first corner/.test(await hist()), { timeout: 10000 }).toBe(true);
    await clickSheet(x1, y1);
    await clickSheet(x2, y2);
    const mvScale = page.locator('[data-r=mv-scale]');
    await expect(mvScale).toBeVisible({ timeout: 10000 });
    await mvScale.selectOption('0.02');
    await page.locator('[data-r=mv-create]').click();
    await expect.poll(async () => /MVIEW: viewport created on "Layout1" at 1:50/.test(await hist()), { timeout: 15000 }).toBe(true);
  };
  await mview(30, 30, 140, 180);
  await page.keyboard.press('Escape');
  await recalibrate();
  await mview(160, 30, 270, 180);
  await page.keyboard.press('Escape');
  await recalibrate();

  // 3. VPORT: freeze WALLS in the left viewport (index 1; index 0 is the
  //    layout's default full-sheet viewport). Re-opening shows it stored.
  await run('VPORT');
  const frozenInput = page.locator('[data-r=vp-frozen-1]');
  await expect(frozenInput).toBeVisible({ timeout: 10000 });
  await frozenInput.fill('WALLS');
  await page.locator('[data-r=vp-apply]').click();
  await expect.poll(async () => /VPORT: 3 viewport\(s\) updated on "Layout1"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('VPORT');
  await expect(page.locator('[data-r=vp-frozen-1]')).toHaveValue('WALLS');
  await expect(page.locator('[data-r=vp-frozen-2]')).toHaveValue('');
  await page.locator('[data-r=vp-cancel]').click();
  await page.waitForTimeout(400);

  // The canvas draws full-width crosshair lines through the mouse, and
  // calibration leaves the mouse at 75% height — right across the sample
  // points. Park it in the canvas corner, far from both viewports, and
  // let the crosshair redraw there before sampling.
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.waitForTimeout(400);

  // 4. Pixel proof. Both viewports show the same model window at 1:50
  //    (viewCentre (50,500)): the WALLS line lands at sheet y = 95 and
  //    the DOORS line at sheet y = 115, centred on each viewport's
  //    sheet centre x (85 left, 215 right).
  const sheetToScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const brightInBox = async (cx: number, cy: number): Promise<number> => {
    return page.evaluate(([px, py]) => {
      const cv = document.querySelector('[data-r=cv]') as HTMLCanvasElement;
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      const ctx = cv.getContext('2d')!;
      // (px, py) are page coordinates; getImageData wants canvas pixels,
      // so the canvas origin must be subtracted first.
      const w = Math.round(20 * dpr), h = Math.round(8 * dpr);
      const d = ctx.getImageData(Math.round((px - rect.left - 10) * dpr), Math.round((py - rect.top - 4) * dpr), w, h).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 100 && d[i + 1] > 100 && d[i + 2] > 100) bright++;
      }
      return bright;
    }, [cx, cy]);
  };
  const leftWalls = await brightInBox(sheetToScreen(85, 95).x, sheetToScreen(85, 95).y);
  const leftDoors = await brightInBox(sheetToScreen(85, 115).x, sheetToScreen(85, 115).y);
  const rightWalls = await brightInBox(sheetToScreen(215, 95).x, sheetToScreen(215, 95).y);
  const rightDoors = await brightInBox(sheetToScreen(215, 115).x, sheetToScreen(215, 115).y);
  expect(leftWalls, `WALLS line must be hidden in the frozen (left) viewport, got ${leftWalls} bright px`).toBe(0);
  expect(leftDoors, `DOORS line must still show in the left viewport, got ${leftDoors} bright px`).toBeGreaterThanOrEqual(3);
  expect(rightWalls, `WALLS line must still show in the right viewport, got ${rightWalls} bright px`).toBeGreaterThanOrEqual(3);
  expect(rightDoors, `DOORS line must still show in the right viewport, got ${rightDoors} bright px`).toBeGreaterThanOrEqual(3);

  // 5. QSAVE: the freeze is written as VIEWPORT group 331 — exactly one
  //    331 inside a VIEWPORT record, pointing at the WALLS layer handle.
  //    (The LAYOUT object carries its own 331s naming its viewports —
  //    those are not freeze data and are not counted.)
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    const savedPath = testInfo.outputPath('saved-2d6.dxf');
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
    const wallsHandle = recs.find((r) => r.type === 'LAYER' && r.groups.get('2')?.[0] === 'WALLS')?.groups.get('5')?.[0];
    expect(wallsHandle, 'no WALLS layer record in the saved DXF').toBeTruthy();
    const frozen331 = recs.filter((r) => r.type === 'VIEWPORT').flatMap((r) => r.groups.get('331') ?? []);
    expect(frozen331, `expected exactly one group 331 inside VIEWPORT records, got ${JSON.stringify(frozen331)}`).toEqual([wallsHandle]);
  }

  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});
