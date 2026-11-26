import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * AutoCAD 2D parity A8 (viewports + plot) and A19 (DWG write).
 *
 * Reference model, imported from DXF: one LINE (0,0)-(100,0) and one
 * bulged LWPOLYLINE (0,0)-(100,0) with bulge 1.0 (a semicircle). The
 * DIMENSION is placed in the UI with DIMLINEAR, so it is a real
 * dimRecord (an imported DIMENSION arrives as plain geometry — the
 * viewer has no import-time DIMENSION -> record conversion).
 *
 * Proved in the real app:
 *  1. DIMLINEAR (0,0)-(100,0), placement (50,-70) below the arc —
 *     history reports "Dimension: 100.00"; QSAVE writes a real
 *     (dimType 0) and the LWPOLYLINE keeps bulge 42 = 1.0 (the A5
 *     writer proof in the live UI).
 *  2. MVIEW on Layout1: two corners (30,30)-(267,180) in sheet
 *     coordinates, scale 1:50 — history reports the viewport creation.
 *  3. Double-click inside the viewport activates it (status bar
 *     "Viewport #2 active" — #1 is the layout's default full-sheet
 *     viewport, the MVIEW one is #2 and topmost); double-click
 *     outside leaves it.
 *  4. VPORT: scale 1:100, clip (40,40)-(250,170) in sheet coordinates,
 *     locked — re-opening the dialog shows the stored values.
 *  5. PAGESETUP: a named setup "A3-1:50" (A3, landscape, 1:50,
 *     extents — the colon in the name is legal) is saved and applied
 *     to Layout1; the plot dialog offers it and applies its scale.
 *  6. PLOT of Layout1 through that setup renders a PNG with content
 *     (the popup's title names Layout1).
 *  7. DWG round-trip: DWGSAVE writes both sheets (history notes that
 *     sheet names are not kept in DWG — the converter's block-name
 *     model); re-importing the .dwg shows both layout tabs; the
 *     merged model lands in Model space (LINE=16, LWPOLYLINE=2,
 *     TEXT=2 — live plus re-imported) while Layout1 stays empty
 *     (A9: the import no longer bakes the model into the paper
 *     layout on screen); QSAVE of the re-imported drawing still
 *     carries both LAYOUT objects with their names, the bulge 1.0,
 *     and a real DIMENSION record — the UI import reads the
 *     converter's DXF intermediate (not its document_json model),
 *     so names and the DIMENSION survive the UI loop even though the
 *     raw converter model drops them (the node A19 suite proves the
 *     raw-model loss; the UI loop proves the intermediate path) —
 *     and the saved DXF now carries the merged model once (16
 *     LINEs, 2 TEXTs), not tripled as the pre-A9 code wrote it.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the screen->world
 * map is re-solved from the live canvas before each absolute pick
 * (A15 lesson). Tolerances follow the A7/A11 convention (2 decimals).
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3119 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3119 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 100, 20, 0,
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
function recStr(r: { groups: Map<number, string[]> }, code: number, nth = 0): string | undefined {
  return r.groups.get(code)?.[nth];
}

/** Count non-white pixels in a plot PNG data URL. */
async function countDarkPixels(page: Page, src: string): Promise<number> {
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('plot img failed to load')); img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) dark++;
    }
    return dark;
  }, src);
}

test('A8 viewports + plot, A19 DWG round-trip', async ({ page }, testInfo) => {
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
  // POLAR tracking is on by default and snaps a placement pick to the
  // nearest polar ray from the last point (the (50,-70) pick read back
  // as (100,-86.02): the 270° ray at the pick's distance) — off for
  // the free-point picks, as is OTRACK.
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;

  // OSNAP off for calibration (A16 lesson).
  await setOsnap(false);

  // 1. Import the reference model.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/LINE=1/);
  await expectCensus(/LWPOLYLINE=1/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. DIMLINEAR (0,0)-(100,0), placement (50,-70) below the arc —
  //    OSNAP on for the feature picks (exact endpoints), off for the
  //    free placement point. The wheel zooms out BEFORE the tool
  //    starts and the map is solved then: calibrating while the tool
  //    waits for its third point reads the tool-tracked cursor
  //    (polar/placement tracking), not the free cursor, and poisons
  //    the map. ZOOM E fits tight (the arc bulges to y=-50), so the
  //    zoomed-out view is what leaves room for the placement.
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

  // 3. QSAVE: the saved DXF carries a real DIMENSION record (dimType 0)
  //    and the bulged polyline.
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    const savedPath = testInfo.outputPath('saved-a8.dxf');
    await d.saveAs(savedPath);
    const recs = dxfRecords(fs.readFileSync(savedPath, 'utf8'));
    const dim = recs.find((r) => r.type === 'DIMENSION');
    expect(dim, 'no DIMENSION record in the saved DXF').toBeTruthy();
    // Group 70 = 32: dimType 0 (linear) + the exclusive-block bit, the
    // same convention as A10's ordinate (38 = 6 + 32).
    expect(recNum(dim!, 70)).toBe(32);
    // The dimension's arrowheads are LWPOLYLINEs too — find the one that
    // carries a bulge.
    const bulged = recs.filter((r) => r.type === 'LWPOLYLINE' && recNum(r, 42) !== undefined);
    expect(bulged.length, 'no bulged LWPOLYLINE in the saved DXF').toBe(1);
    expect(recNum(bulged[0], 42)).toBeCloseTo(1, 2);
  }

  // 4. Two paper layouts via the "+" tab button.
  await newLayoutBtn.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await expect(tabs.locator('button[data-li="0"]')).toHaveText('Layout1');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="1"]')).toHaveText('Layout2');
  // Back to Layout1 for the viewport work.
  await tabs.locator('button[data-li="0"]').click();
  await expect(tabs.locator('button[data-li="0"]')).toHaveClass(/on/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 5. MVIEW: two sheet corners, scale 1:50. The sheet is A4/A3-sized
  //    (297x210 or larger), so (30,30)-(267,180) sits inside either.
  await recalibrate();
  await run('MVIEW');
  await expect.poll(async () => /specify the first corner/.test(await hist()), { timeout: 10000 }).toBe(true);
  await clickWorld(30, 30);
  await clickWorld(267, 180);
  const mvScale = page.locator('[data-r=mv-scale]');
  await expect(mvScale).toBeVisible({ timeout: 10000 });
  await mvScale.selectOption('0.02');
  await page.locator('[data-r=mv-create]').click();
  await expect.poll(async () => /MVIEW: viewport created on "Layout1" at 1:50/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 6. Double-click inside the viewport activates it; outside leaves it.
  //    Layout1 already ships a default full-sheet viewport (A13), so
  //    the MVIEW one is #2 — and it is the topmost, so the double-click
  //    activates #2.
  await page.keyboard.press('Escape');
  await recalibrate();
  await page.mouse.dblclick((148 - map.ox) / map.sx, (105 - map.oy) / map.sy);
  await expect.poll(async () => /Viewport #2 active/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(page.locator('[data-s=viewport]')).toContainText('Viewport #2 active');
  await page.mouse.dblclick((10 - map.ox) / map.sx, (10 - map.oy) / map.sy);
  await expect.poll(async () => /Left the viewport/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(page.locator('[data-s=viewport]')).toHaveCount(0);

  // 7. VPORT: scale 1:100, clip (40,40)-(250,170) sheet units, locked —
  //    on viewport #2 (index 1; index 0 is the layout's default).
  //    Re-opening the dialog shows the stored values.
  await run('VPORT');
  const vpScale = page.locator('[data-r=vp-scale-1]');
  await expect(vpScale).toBeVisible({ timeout: 10000 });
  await expect(vpScale).toHaveValue('0.02');
  await vpScale.selectOption('0.01');
  await page.locator('[data-r=vp-clip-minx-1]').fill('40');
  await page.locator('[data-r=vp-clip-miny-1]').fill('40');
  await page.locator('[data-r=vp-clip-maxx-1]').fill('250');
  await page.locator('[data-r=vp-clip-maxy-1]').fill('170');
  await page.locator('[data-r=vp-lock-1]').check();
  await page.locator('[data-r=vp-apply]').click();
  await expect.poll(async () => /VPORT: 2 viewport\(s\) updated on "Layout1"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('VPORT');
  await expect(page.locator('[data-r=vp-scale-1]')).toHaveValue('0.01');
  await expect(page.locator('[data-r=vp-lock-1]')).toBeChecked();
  await expect(page.locator('[data-r=vp-clip-minx-1]')).toHaveValue('40');
  await expect(page.locator('[data-r=vp-clip-maxx-1]')).toHaveValue('250');
  await page.locator('[data-r=vp-cancel]').click();

  // 8. PAGESETUP: named setup "A3-1:50" (colon is a legal name), saved
  //    and applied to Layout1.
  await run('PAGESETUP');
  await expect(page.locator('[data-r=ps-new]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=ps-new]').click();
  const nameInput = page.locator('.obs-form-modal input[type=text]').first();
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill('A3-1:50');
  await nameInput.press('Enter');
  await expect(page.locator('[data-r=ps-name]')).toHaveValue('A3-1:50', { timeout: 10000 });
  await page.locator('[data-r=ps-paper]').selectOption('A3');
  await page.locator('[data-r=ps-orient]').selectOption('landscape');
  await page.locator('[data-r=ps-scale]').selectOption('0.02');
  await page.locator('[data-r=ps-area]').selectOption('extents');
  await page.locator('[data-r=ps-save]').click();
  await expect.poll(async () => /PAGESETUP: saved "A3-1:50" \(A3 landscape, 1:50, extents\)/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('PAGESETUP');
  await expect(page.locator('[data-r=ps-apply-layout]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=ps-apply-layout]').click();
  await expect.poll(async () => /PAGESETUP: "A3-1:50" applied to "Layout1"/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 9. PLOT of Layout1 through the setup: the dialog offers the setup
  //    and applies its scale; the popup renders a PNG with content.
  await run('PLOT');
  await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-p=layout]').selectOption('0');
  await page.locator('[data-p=setup]').selectOption('A3-1:50');
  await expect(page.locator('[data-p=scale]')).toHaveValue('0.02');
  await page.locator('[data-p=area]').selectOption('extents');
  const popupPromise = page.waitForEvent('popup');
  await page.locator('[data-p=go]').click();
  const popup = await popupPromise;
  await expect(popup.locator('img')).toBeVisible({ timeout: 30000 });
  expect(await popup.title(), 'plot popup title should name the layout').toContain('Layout1');
  const src = (await popup.locator('img').getAttribute('src'))!;
  expect(src.startsWith('data:image/png'), 'plot popup has no PNG').toBe(true);
  const dark = await countDarkPixels(page, src);
  expect(dark, 'plot PNG has no drawn content').toBeGreaterThan(100);
  await popup.close();

  // 10. DWG round-trip: DWGSAVE writes both sheets; re-import shows
  //     both layout tabs, and the merged model lands in Model space
  //     (A9: the re-import no longer bakes the model into the paper
  //     layout that is on screen — Layout1 stays empty).
  {
    const dl = page.waitForEvent('download', { timeout: 120000 });
    await run('DWGSAVE');
    const d = await dl;
    expect(d.suggestedFilename(), 'DWG download name').toMatch(/\.dwg$/);
    const dwgPath = testInfo.outputPath('roundtrip-a8.dwg');
    await d.saveAs(dwgPath);
    await expect.poll(async () => /2 paper-space sheet\(s\) written; sheet names are not kept in DWG/.test(await hist()), { timeout: 15000 }).toBe(true);
    const dwgBytes = fs.readFileSync(dwgPath);
    expect(dwgBytes.length, 'empty DWG download').toBeGreaterThan(1000);
    await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'roundtrip-a8.dwg', mimeType: 'application/octet-stream', buffer: dwgBytes });
    await expect(tabs.locator('button[data-li="0"]')).toBeVisible({ timeout: 30000 });
    await expect(tabs.locator('button[data-li="1"]')).toBeVisible({ timeout: 30000 });
    // Layout1 is empty after the re-import: the model is no longer
    // baked into the paper layout (A9 baking fix — on the pre-A9
    // code this census read LINE=8, LWPOLYLINE=1, TEXT=1).
    await expect.poll(async () => {
      const c = await lastCensus();
      return !/LINE=|LWPOLYLINE=|TEXT=/.test(c) ? c : '';
    }, { timeout: 15000 }).toContain('CENSUS: (empty)');
    // The merged model is in Model space: the live entities plus the
    // re-imported copies (LINE 8+8, the bulged polyline twice, the
    // dimension text twice).
    await tabs.locator('button[data-li="-1"]').click();
    await expect(spaceBtn).toHaveText('MODEL');
    await expectCensus(/LINE=16/);
    await expectCensus(/LWPOLYLINE=2/);
    await expectCensus(/TEXT=2/);
  }

  // 11. QSAVE after the DWG loop: the layouts, the bulge and the
  //     DIMENSION all survive the UI loop — the UI import reads the
  //     converter's DXF intermediate (not its document_json model),
  //     so the LAYOUT names and the DIMENSION entity come back
  //     intact. Since A9 the model geometry is no longer baked into
  //     the paper layouts by the import, so the saved DXF carries the
  //     merged model once per record type (16 LINEs, 2 TEXTs,
  //     1 DIMENSION — not the 24 / 3 the pre-A9 code wrote). One
  //     observation remains a follow-up, not a blocker: the
  //     DIMENSION's defpoints come back to 7 decimals, not bit-exact.
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    const savedPath = testInfo.outputPath('saved-after-dwg-a8.dxf');
    await d.saveAs(savedPath);
    const recs = dxfRecords(fs.readFileSync(savedPath, 'utf8'));
    const layouts = recs.filter((r) => r.type === 'LAYOUT');
    // The writer emits one LAYOUT per paper sheet plus one for Model.
    // (The last group-1 is the layout name; the first is the setup name.)
    const paperNames = layouts.map((r) => {
      const names = r.groups.get(1) ?? [];
      return names[names.length - 1];
    }).filter((n) => n !== 'Model');
    expect(layouts.length, `expected 3 LAYOUT objects (Model + 2 sheets) after the DWG loop, got ${layouts.length}`).toBe(3);
    expect(paperNames, `layout names did not survive the DWG loop: ${paperNames}`).toEqual(['Layout1', 'Layout2']);
    const bulged = recs.filter((r) => r.type === 'LWPOLYLINE' && recNum(r, 42) !== undefined && Math.abs(recNum(r, 42)! - 1) < 0.01);
    expect(bulged.length, 'no LWPOLYLINE with bulge 1.0 after the DWG loop').toBeGreaterThanOrEqual(1);
    expect(recNum(bulged[0], 42)).toBeCloseTo(1, 2);
    const dimText = recs.find((r) => r.type === 'TEXT' && recStr(r, 1) === '100.00 mm');
    expect(dimText, 'dimension text "100.00 mm" missing after the DWG loop').toBeTruthy();
    const dims = recs.filter((r) => r.type === 'DIMENSION');
    expect(dims.length, `expected the DIMENSION record to survive the DWG loop, got ${dims.length}`).toBe(1);
    expect(recStr(dims[0], 1)).toBe('100.00 mm');
    expect(recNum(dims[0], 70)).toBe(32);
    // The merged model is written once, not tripled (A9 baking fix):
    // 16 LINE records and 2 TEXT records in the whole file.
    const lineCount = recs.filter((r) => r.type === 'LINE').length;
    expect(lineCount, `expected 16 LINE records after the DWG loop, got ${lineCount}`).toBe(16);
    const textCount = recs.filter((r) => r.type === 'TEXT').length;
    expect(textCount, `expected 2 TEXT records after the DWG loop, got ${textCount}`).toBe(2);
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
