import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * Annotation scale (2D-30, CANNOSCALE).
 *
 * Reference model, imported from DXF: one TEXT entity "H", height 20,
 * at (0,0), plus a distant LINE (200,200)-(210,200) so the model bounds
 * are non-degenerate. The TEXT keeps its nominal stored height; the
 * paint path renders it at height × the annotation scale.
 *
 * Proved in the real app:
 *  1. CANNOSCALE with no argument reports the current scale (1:1).
 *  2. The same TEXT entity renders ~2× as tall after CANNOSCALE 2 —
 *     measured as the bright-pixel bounding-box height of its glyphs,
 *     the same way, at both scales — with no new entity created.
 *  3. The status-bar button shows the scale (1:2) and clicking it
 *     cycles to the next standard scale (1:5); the text renders ~5×
 *     its scale-1 height there.
 *  4. CANNOSCALE bogus is rejected with a message and the scale is
 *     unchanged.
 *  5. (Second test) DIMOVERRIDE composes with the scale: a dimension
 *     placed at CANNOSCALE 2, then DIMOVERRIDE ARROWSIZE 5, saves
 *     arrow ticks of length 5 × 2 × √(1 + 0.32²) ≈ 10.5 — the override
 *     survives dimStyleOf with the scale applied. If the override
 *     were lost the ticks would be 5.25 (2.5 × 2); if the scale were
 *     lost, 5.25 too (5 × 1); if both were lost, 2.63.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the screen->model
 * map is re-solved from the live canvas before measuring (A15 lesson).
 * The glyph scan uses a >150 brightness threshold so the faint grid,
 * the red X axis and the green Y axis never count as glyph pixels.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && python3 -m http.server 3134 --directory dist
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3134 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 20, 1, 'H',
  0, 'LINE', 8, '0', 10, 200, 20, 200, 11, 210, 21, 200,
  0, 'ENDSEC', 0, 'EOF',
);

// Reference model for the DIMOVERRIDE composition test: one LINE
// (0,0)-(100,0), the measured feature for a DIMLINEAR, plus a distant
// LINE (200,200)-(230,200) so the model bounds are non-degenerate —
// ZOOM E on the measured line alone fits a near-zero-height view and
// the (50,-70) placement point falls off the canvas (the A8 lesson:
// the placement must stay inside the zoomed-out view).
const refLineDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LINE', 8, '0', 10, 200, 20, 200, 11, 230, 21, 200,
  0, 'ENDSEC', 0, 'EOF',
);

/** Minimal DXF record splitter (the A11 pattern). */
function dxfRecords(text: string): { type: string; groups: Map<number, string[]> }[] {
  const lines = text.split(/\r?\n/);
  const recs: { type: string; groups: Map<number, string[]> }[] = [];
  let cur: { type: string; groups: Map<number, string[]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const val = lines[i + 1];
    if (code === 0) {
      cur = { type: val.trim(), groups: new Map() };
      recs.push(cur);
    } else if (cur) {
      const arr = cur.groups.get(code) ?? [];
      arr.push(val);
      cur.groups.set(code, arr);
    }
  }
  return recs;
}
function recNum(r: { groups: Map<number, string[]> }, code: number, nth = 0): number | undefined {
  const v = r.groups.get(code)?.[nth];
  return v === undefined ? undefined : parseFloat(v);
}

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

test('2D-30 annotation scale: the same text renders at the right size at two scales', async ({ page }, testInfo) => {
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
  const osnapBtn = page.locator('[data-s=snap]');
  const setOsnap = async (on: boolean) => {
    const active = await osnapBtn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await osnapBtn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const annoBtn = page.locator('[data-s=anno]').first();

  await setOsnap(false);

  // 1. Import the reference model: TEXT "H", height 20, at (0,0).
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(lastCensus, { timeout: 15000 }).toMatch(/TEXT=1/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // The status bar shows the scale from the start; CANNOSCALE with no
  // argument reports it.
  await expect(annoBtn).toHaveText('1:1');
  await run('CANNOSCALE');
  await expect.poll(async () => /CANNOSCALE: annotation scale 1:1 \(factor 1\)/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 2. Measure the glyph height: the bright-pixel bounding box of the
  //    "H" in a box around its model position, converted through the
  //    live calibration map. The baseline sits at model (0,0); the glyphs
  //    rise above it by ~cap height, so the scan box extends mostly up.
  const box = await canvasBox();
  const map = await calibrate(page, box);
  const measureGlyphHeight = async (scaleFactor: number): Promise<number> => {
    // Park the mouse far from the text so the crosshair never crosses it.
    await page.mouse.move(box.x + 6, box.y + 6);
    await page.waitForTimeout(400);
    const baseX = (0 - map.ox) / map.sx;
    const baseY = (0 - map.oy) / map.sy;
    const unitPx = 1 / Math.abs(map.sx); // screen px per model unit
    const halfW = Math.ceil(20 * unitPx * scaleFactor * 1.2);
    // The scan box must grow with the scale: at 5× the glyph rises ~5×
    // as far above its baseline, and a scale-1 box would clip it.
    const top = Math.floor(baseY - 20 * unitPx * scaleFactor * 1.3);
    const bottom = Math.ceil(baseY + 20 * unitPx * scaleFactor * 0.3);
    return page.evaluate(([cx, topY, botY, hw]) => {
      const cv = document.querySelector('[data-r=cv]') as HTMLCanvasElement;
      const rect = cv.getBoundingClientRect();
      const dpr = cv.width / rect.width;
      const ctx = cv.getContext('2d')!;
      const x0 = Math.max(0, Math.round((cx - hw - rect.left) * dpr));
      const x1 = Math.min(cv.width, Math.round((cx + hw - rect.left) * dpr));
      const y0 = Math.max(0, Math.round((topY - rect.top) * dpr));
      const y1 = Math.min(cv.height, Math.round((botY - rect.top) * dpr));
      const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let minY = Infinity, maxY = -Infinity, found = 0;
      const w = x1 - x0;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (img[i] > 150 && img[i + 1] > 150 && img[i + 2] > 150) {
            found++;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return found === 0 ? 0 : (maxY - minY + 1) / dpr;
    }, [baseX, top, bottom, halfW]);
  };

  const h1 = await measureGlyphHeight(1);
  expect(h1, `no glyph pixels found at scale 1`).toBeGreaterThan(5);

  // 3. CANNOSCALE 2: the SAME text renders twice as tall.
  await run('CANNOSCALE 2');
  await expect.poll(async () => /CANNOSCALE: annotation scale 1:2 \(factor 2\)/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(annoBtn).toHaveText('1:2');
  await page.waitForTimeout(400);
  const h2 = await measureGlyphHeight(2);
  const ratio2 = h2 / h1;
  expect(ratio2, `glyph height at scale 2 should be ~2× scale 1 (h1=${h1.toFixed(1)}, h2=${h2.toFixed(1)})`).toBeGreaterThan(1.7);
  expect(ratio2, `glyph height at scale 2 should be ~2× scale 1 (h1=${h1.toFixed(1)}, h2=${h2.toFixed(1)})`).toBeLessThan(2.3);

  // 4. The status-bar button cycles to the next standard scale (1:5);
  //    the text renders ~5× its scale-1 height there.
  await annoBtn.click();
  await expect.poll(async () => /CANNOSCALE: annotation scale 1:5 \(factor 5\)/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(annoBtn).toHaveText('1:5');
  await page.waitForTimeout(400);
  const h5 = await measureGlyphHeight(5);
  const ratio5 = h5 / h1;
  expect(ratio5, `glyph height at scale 5 should be ~5× scale 1 (h1=${h1.toFixed(1)}, h5=${h5.toFixed(1)})`).toBeGreaterThan(4.2);
  expect(ratio5, `glyph height at scale 5 should be ~5× scale 1 (h1=${h1.toFixed(1)}, h5=${h5.toFixed(1)})`).toBeLessThan(5.8);

  // 5. A bad value is rejected and the scale is unchanged.
  await run('CANNOSCALE bogus');
  await expect.poll(async () => /CANNOSCALE: enter a positive scale/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(annoBtn).toHaveText('1:5');
  const hStill5 = await measureGlyphHeight(5);
  expect(Math.abs(hStill5 - h5) / h5, `glyph height changed after a rejected CANNOSCALE`).toBeLessThan(0.1);

  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});

test('2D-30 + DIMOVERRIDE: an override survives dimStyleOf at a non-1:1 annotation scale', async ({ page }, testInfo) => {
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
  const osnapBtn = page.locator('[data-s=snap]');
  const setOsnap = async (on: boolean) => {
    const active = await osnapBtn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await osnapBtn.click();
  };
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const annoBtn = page.locator('[data-s=anno]').first();

  await setOsnap(false);

  // 1. Import the reference model: LINE (0,0)-(100,0) plus a distant
  //    LINE so the bounds are non-degenerate.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refLineDxf) });
  await expect.poll(lastCensus, { timeout: 15000 }).toMatch(/LINE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. CANNOSCALE 2 BEFORE the dimension is placed: arrowheads are
  //    baked at creation (dimStyleOf), so the scale must already be live.
  await run('CANNOSCALE 2');
  await expect.poll(async () => /CANNOSCALE: annotation scale 1:2 \(factor 2\)/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(annoBtn).toHaveText('1:2');

  // 3. DIMLINEAR (0,0)-(100,0), placement (50,-70) — the A8 pattern:
  //    OSNAP on for the feature picks (exact endpoints), off for the
  //    free placement point. ZOOM E fits tight, so zoom out before the
  //    tool starts and re-solve the map then.
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const clickWorld = async (wx: number, wy: number) => {
    const s = { x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy };
    await page.mouse.click(s.x, s.y);
  };
  const recalibrate = async () => {
    box = await canvasBox();
    map = await calibrate(page, box);
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  await recalibrate();
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setOsnap(true);
  await run('DIMLINEAR');
  await clickWorld(0, 0);
  await clickWorld(100, 0);
  await setOsnap(false);
  await clickWorld(50, -70);
  await expect.poll(async () => /DIMLINEAR: 100\.00 mm/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 4. Select the dimension by clicking its dim line, then override its
  //    arrow size. DIMOVERRIDE rebuilds through dimStyleOf, so the
  //    override (5) must compose with the live scale (2) into arrowSize 10.
  //    DIMLINEAR repeats until Escape, so exit the tool first — otherwise
  //    the click is swallowed as the next dimension's first pick and
  //    nothing is selected. Click a quarter along the dim line (25,-70),
  //    clear of the text at (50,-68).
  await page.keyboard.press('Escape');
  await clickWorld(25, -70);
  await run('DIMOVERRIDE ARROWSIZE 5');
  await expect.poll(async () => /DIMOVERRIDE: ARROWSIZE = 5 applied to 1 dimension/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 5. QSAVE: the dimension's drawn geometry lives in its anonymous *D<n>
  //    block; the four arrow ticks are LINEs of length
  //    arrow × √(1 + 0.32²) = 10 × 1.05 ≈ 10.5. If the override were lost
  //    the ticks would be 5.25 (2.5 × 2); if the scale were lost, 5.25 too
  //    (5 × 1); if both were lost, 2.63.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  const savedPath = testInfo.outputPath('saved-2d30-dimoverride.dxf');
  await d.saveAs(savedPath);
  const recs = dxfRecords(fs.readFileSync(savedPath, 'utf8'));
  const lineLen = (r: { groups: Map<number, string[]> }) =>
    Math.hypot(recNum(r, 11)! - recNum(r, 10)!, recNum(r, 21)! - recNum(r, 20)!);
  const lineLens = recs.filter((r) => r.type === 'LINE').map(lineLen);
  const expectedTick = 10 * Math.hypot(1, 0.32);
  const ticks = lineLens.filter((l) => Math.abs(l - expectedTick) < 0.2);
  expect(ticks.length, `expected 4 arrow ticks ≈${expectedTick.toFixed(2)} long, got ${ticks.length}; LINE lengths: ${lineLens.map((l) => l.toFixed(2)).join(', ')}`).toBe(4);

  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});
