import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * Polyline width / Close / bulge preservation (AutoCAD parity A7).
 *
 * Reference drawing, imported from DXF:
 *   LWPOLYLINE (0,0)-(200,0), bulge -1 (semicircle, crown (100,100)),
 *   constant width 5 (group 43) · LINE (-50,-50)-(650,450) (a frame that
 *   makes ZOOM E cover every draw below with margin).
 *
 * Proved in the real app:
 *  1. PLINEWID: `PLINEWID 3` reports "PLINEWID = 3"; a polyline drawn
 *     afterwards (300,0)-(400,0)-(400,100) carries that width — the
 *     saved DXF has group 43 = 7 after step 5 changed it, and the
 *     history reports "Polyline: 200.00".
 *  2. In-tool Arc: `PLINE`, (0,300), `A`, mid (100,400), end (200,300)
 *     — the history reports "Polyline: 314.16" (arc-aware: the chord
 *     alone would be 200.00), and the saved DXF carries group 42 = -1
 *     on that polyline (a semicircle, not two straight segments).
 *  3. In-tool Close: `PLINE`, (500,0)-(600,0)-(600,100), `C` — the
 *     history reports "Polyline: 341.42 (closed)" and the saved DXF has
 *     group 70 bit 1 set on that polyline. (Before A7, C fell through
 *     to the CIRCLE command and Close existed only afterwards via
 *     PEDIT C / CLOSEPL.)
 *  4. In-tool Width: `PLINE`, (500,300), `W`, 5, 2 — the history
 *     reports "PLINE: next segment width 5 → 2."; the drawn segment
 *     (500,300)-(600,300) saves with group 40 = 5 and group 41 = 2
 *     (a taper, not a constant width).
 *  5. Properties Width: clicking the PLINEWID polyline shows a Width
 *     row reading 3; setting it to 7 commits (undoable) — the saved
 *     DXF has group 43 = 7 on that polyline.
 *  6. Round trip: the imported bulged polyline saves with group 42 =
 *     -1 and group 43 = 5 (before A7 the reader tessellated the bulge
 *     away and the writer emitted no group 42 at all). QSAVE, reload,
 *     re-import: CENSUS identical (LINE=1, LWPOLYLINE=5).
 *
 * Calibration runs with OSNAP off (A16 lesson): the coords readout shows
 * the snapped cursor while OSNAP is on, which contaminates the map. The
 * map is re-solved from the live canvas box right before each polyline's
 * first click (A15 lesson: a ~5 px canvas shrink shifts Y only).
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already on :3000, so a
 * run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3118 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3118 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 43, 5, 10, 0, 20, 0, 42, -1, 10, 200, 20, 0,
  0, 'LINE', 8, '0', 10, -50, 20, -50, 11, 650, 21, 450,
  0, 'ENDSEC', 0, 'EOF',
);

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

/** Solve screen→world from two mouse samples per axis (OSNAP off). */
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
  expect(Math.abs(w2.x - w1.x), 'calibration: no world-X change across the canvas').toBeGreaterThan(0.1);
  expect(Math.abs(w4.y - w3.y), 'calibration: no world-Y change across the canvas').toBeGreaterThan(0.1);
  const sx = (w2.x - w1.x) / (px2 - px1);
  const sy = (w4.y - w3.y) / (py2 - py1);
  return { sx, ox: w1.x - sx * px1, sy, oy: w3.y - sy * py1 };
}

/** Minimal DXF record reader for the saved-file assertions. */
function dxfRecords(text: string): Array<{ type: string; pairs: Array<[string, string]> }> {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const recs: Array<{ type: string; pairs: Array<[string, string]> }> = [];
  let cur: { type: string; pairs: Array<[string, string]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1];
    if (code === '0') { cur = { type: value.trim(), pairs: [] }; recs.push(cur); }
    else if (cur) cur.pairs.push([code, value]);
  }
  return recs;
}
const recVal = (rec: { pairs: Array<[string, string]> }, code: string | number, n = 0): string | undefined =>
  rec.pairs.filter(([c]) => c === String(code)).map(([, v]) => v)[n];
const recNum = (rec: { pairs: Array<[string, string]> }, code: string | number, n = 0): number | undefined => {
  const v = recVal(rec, code, n);
  return v === undefined ? undefined : parseFloat(v);
};

test('2D editor: polyline width, in-tool Close, arc segments, bulge round trip', async ({ page }, testInfo) => {
  test.setTimeout(300000);
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
  // Measure results ("Polyline: …") render in the Measurements panel,
  // not the command history.
  const meas = async () => page.locator('[data-r=meas]').first().innerText();
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const text = await hist();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    const out: Record<string, number> = {};
    for (const m of last.matchAll(/([A-Z0-9]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
  };
  const setOsnap = async (on: boolean) => {
    const btn = page.locator('[data-s=snap]');
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  // ORTHO/POLAR/OTRACK constrain point entry from the anchor — all off,
  // so the free-point picks land where the calibration says they land.
  const setToggle = async (name: string, on: boolean) => {
    const btn = page.locator(`[data-s=${name}]`);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const setOrtho = (on: boolean) => setToggle('ortho', on);
  const setPolar = (on: boolean) => setToggle('polar', on);
  const setOtrack = (on: boolean) => setToggle('otrack', on);
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'ref.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(async () => { const c = await census(); return c.LWPOLYLINE === 1 && c.LINE === 1; }, { timeout: 15000 }).toBe(true);

  // Calibrate with OSNAP off, then keep it off for every free-point pick.
  await setOsnap(false);
  await setOrtho(false);
  await setPolar(false);
  await setOtrack(false);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  let map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  // The map goes stale if the canvas resizes after calibration (A15's
  // failure mode). Re-solve from the live canvas box right before each
  // polyline's first click.
  const recalibrate = async () => {
    const live = (await page.locator('[data-r=cv]').first().boundingBox())!;
    map = await calibrate(page, live);
  };
  const clickWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };
  // Enter on the canvas (not the command line) finishes a polyline.
  const finishPoly = async () => {
    await focusCanvas();
    await page.keyboard.press('Enter');
  };

  // 1. PLINEWID 3 + draw: (300,0)-(400,0)-(400,100), length 200.
  await run('PLINEWID 3');
  await expect.poll(hist, { timeout: 10000 }).toContain('PLINEWID = 3');
  await run('PLINE');
  await recalibrate();
  await clickWorld(300, 0);
  await clickWorld(400, 0);
  await clickWorld(400, 100);
  await finishPoly();
  await expect.poll(meas, { timeout: 15000 }).toContain('Polyline: 200.00 mm');

  // 2. In-tool Arc: (0,300) through mid (100,400) to end (200,300) —
  // a semicircle, R=100, arc-aware length π·100 = 314.16 (the chord
  // alone would be 200.00).
  await run('PLINE');
  await recalibrate();
  await clickWorld(0, 300);
  await run('A');
  await clickWorld(100, 400);
  await clickWorld(200, 300);
  await finishPoly();
  await expect.poll(meas, { timeout: 15000 }).toContain('Polyline: 314.16 mm');

  // 3. In-tool Close: (500,0)-(600,0)-(600,100), then C closes it —
  // perimeter 100 + 100 + √2·100 = 341.42, reported as closed.
  await run('PLINE');
  await recalibrate();
  await clickWorld(500, 0);
  await clickWorld(600, 0);
  await clickWorld(600, 100);
  await run('C');
  await expect.poll(meas, { timeout: 15000 }).toContain('Polyline: 341.42 mm (closed)');

  // 4. In-tool Width taper: (500,300), W, start 5, end 2, then (600,300).
  await run('PLINE');
  await recalibrate();
  await clickWorld(500, 300);
  await run('W');
  await run('5');
  await run('2');
  await expect.poll(async () => /PLINE: next segment width 5(\.\d+)?( mm)? → 2(\.\d+)?( mm)?\./.test(await hist()), { timeout: 10000 }).toBe(true);
  await clickWorld(600, 300);
  await finishPoly();
  await expect.poll(meas, { timeout: 15000 }).toContain('Polyline: 100.00 mm');

  // 5. Properties Width: click the PLINEWID polyline (its first segment
  // runs (300,0)-(400,0)) and change its width 3 → 7. Verify the cursor
  // reads the intended point before the pick (A16 pattern: a stale map
  // puts the click outside the 8 px pick aperture).
  await recalibrate();
  const pickAt = toScreen(350, 0);
  await page.mouse.move(pickAt.x, pickAt.y);
  await page.waitForTimeout(300);
  const at = await readCoords(page);
  expect(Math.abs(at.x - 350) < 0.5 && Math.abs(at.y - 0) < 0.5, `calibration off: cursor reads ${at.x}, ${at.y} at the wide polyline`).toBe(true);
  await page.mouse.click(pickAt.x, pickAt.y);
  const widthInput = page.locator('[data-props-width]');
  await expect(widthInput).toBeVisible({ timeout: 10000 });
  await expect(widthInput).toHaveValue('3');
  await widthInput.fill('7');
  await widthInput.press('Tab'); // blur fires change → commitModify
  await expect.poll(async () => widthInput.inputValue(), { timeout: 10000 }).toBe('7');

  // 6. Live counts: 1 ref LINE + 1 imported + 4 drawn LWPOLYLINEs.
  const live = await census();
  expect(live.LINE).toBe(1);
  expect(live.LWPOLYLINE).toBe(5);

  // 7. QSAVE: parse the downloaded DXF in Node.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  // saveAs() waits for the download to finish writing; reading d.path()
  // straight after waitForEvent('download') can catch a partially written
  // file (2D-14; the A11 spec already uses this pattern).
  const dxfPath = testInfo.outputPath('saved-a7.dxf');
  await d.saveAs(dxfPath);
  const dxfText = fs.readFileSync(dxfPath, 'utf8');
  const recs = dxfRecords(dxfText);
  const pls = recs.filter((r) => r.type === 'LWPOLYLINE');
  expect(pls.length).toBe(5);
  const byFirst = (x: number, y: number) =>
    pls.find((r) => Math.abs(recNum(r, 10, 0)! - x) < 0.01 && Math.abs(recNum(r, 20, 0)! - y) < 0.01);
  // Imported: bulge -1 and constant width 5 survived the round trip.
  const imported = byFirst(0, 0);
  expect(imported, 'imported bulged polyline missing from the saved DXF').toBeTruthy();
  expect(recNum(imported!, 42, 0)).toBeCloseTo(-1, 2);
  expect(recNum(imported!, 43)).toBeCloseTo(5, 2);
  // PLINEWID polyline: width 7 after the Properties change.
  const wide = byFirst(300, 0);
  expect(wide, 'PLINEWID polyline missing from the saved DXF').toBeTruthy();
  expect(recNum(wide!, 43)).toBeCloseTo(7, 2);
  // Arc polyline: a semicircle bulge (-1: clockwise from (0,300) over
  // the crown (100,400) to (200,300)), not tessellated segments.
  const arc = byFirst(0, 300);
  expect(arc, 'arc polyline missing from the saved DXF').toBeTruthy();
  expect(recNum(arc!, 42, 0)).toBeCloseTo(-1, 2);
  // Closed polyline: group 70 bit 1.
  const closed = byFirst(500, 0);
  expect(closed, 'closed polyline missing from the saved DXF').toBeTruthy();
  expect(recNum(closed!, 70)! & 1).toBe(1);
  // Taper polyline: start width 5, end width 2 on its first vertex.
  const taper = byFirst(500, 300);
  expect(taper, 'taper polyline missing from the saved DXF').toBeTruthy();
  expect(recNum(taper!, 40, 0)).toBeCloseTo(5, 2);
  expect(recNum(taper!, 41, 0)).toBeCloseTo(2, 2);

  // 8. Reload, re-import the saved file: the same counts prove the file
  //    stands alone and the bulges/widths survive as geometry.
  await page.reload();
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'saved.dxf', mimeType: 'text/plain', buffer: Buffer.from(dxfText) });
  await expect.poll(async () => { const c = await census(); return c.LWPOLYLINE === 5 && c.LINE === 1; }, { timeout: 30000 }).toBe(true);
  const back = await census();
  expect(back.LWPOLYLINE).toBe(5);
  expect(back.LINE).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
