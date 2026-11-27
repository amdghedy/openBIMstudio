import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Editable TABLE (2D-7).
 *
 * Proved in the real app:
 *  1. TABLE 2 3 + two picks creates ONE TABLE entity (CENSUS TABLE=1,
 *     no LINE/TEXT), not the loose grid the tool used to emit.
 *  2. Double-clicking a cell opens the cell editor; typing "Edited"
 *     updates cell 1,2 (history: "TABLEEDIT: cell 1,2 updated.").
 *  3. QSAVE writes a real ACAD_TABLE (groups 91=2 rows, 92=3 cols,
 *     141 row heights, 142 column widths, group 1 cell texts including
 *     "Edited") and no LINE records in ENTITIES.
 *  4. Re-importing the saved DXF reads back as a TABLE (CENSUS
 *     TABLE=2), and pixel proof on the live canvas shows the grid line
 *     drawn while the cell interior stays empty.
 *
 * Calibration runs with OSNAP/POLAR/OTRACK/grid-snap off and the grid
 * display off (A15/A16 lessons), and the screen->world map is re-solved
 * from the live canvas after every view change. The table's corners are
 * picked as fractions of the canvas and its geometry is derived from the
 * calibrated map — the default view only spans ~200×100 world units, so
 * absolute world picks would land outside the canvas (on the ribbon).
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && python3 -m http.server 3137 --directory dist
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3137 and which starts no webServer.
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

test('2D-7 editable TABLE: create, edit a cell, save, reload — still a table', async ({ page }, testInfo) => {
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
  // lessons), and the drafting grid display off so the pixel proof reads
  // the table's own grid, not the background grid.
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setToggle('[data-s=gridsnap]', false);
  const gridBtn = page.locator('[data-a=grid]');
  if (await gridBtn.evaluate((el) => el.classList.contains('on'))) await run('GRID');

  // 1. TABLE 2 3, two picks as fractions of the canvas. The table
  //    normalises to its top-left corner: 3 equal columns, 2 equal rows.
  //    Its geometry is derived from the calibrated map, not assumed.
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const worldAt = (px: number, py: number) => ({ x: map.ox + map.sx * px, y: map.oy + map.sy * py });
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const recalibrate = async () => {
    box = await canvasBox();
    map = await calibrate(page, box);
  };
  const pA = { x: box.x + box.width * 0.35, y: box.y + box.height * 0.4 };
  const pB = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.6 };
  const wA = worldAt(pA.x, pA.y), wB = worldAt(pB.x, pB.y);
  const left = Math.min(wA.x, wB.x), right = Math.max(wA.x, wB.x);
  const top = Math.max(wA.y, wB.y), bottom = Math.min(wA.y, wB.y);
  const colW = (right - left) / 3, rowH = (top - bottom) / 2;
  expect(colW, 'table columns must have positive width').toBeGreaterThan(1);
  expect(rowH, 'table rows must have positive height').toBeGreaterThan(1);
  await run('TABLE 2 3');
  await expect.poll(async () => /Next table: 2 rows × 3 columns/.test(await hist()), { timeout: 10000 }).toBe(true);
  await page.mouse.click(pA.x, pA.y);
  await page.mouse.click(pB.x, pB.y);
  await expect.poll(async () => /Table added: 2 rows × 3 columns/.test(await hist()), { timeout: 15000 }).toBe(true);
  await expectCensus(/TABLE=1/);
  await expect.poll(async () => !/LINE=/.test(await lastCensus()), { timeout: 15000 }).toBe(true);

  // Back to the select tool: a double-click while the table tool is still
  // active would be read as two table picks (a zero-size table).
  await page.keyboard.press('Escape');
  await expect.poll(async () => page.locator('[data-t=select]').evaluate((el) => el.classList.contains('on')), { timeout: 10000 }).toBe(true);

  // 2. Double-click cell (0,1) — centre (left + 1.5 colW, top - 0.5 rowH)
  //    — and edit it to "Edited".
  await run('ZOOM E');
  await page.waitForTimeout(600);
  await recalibrate();
  const cell = toScreen(left + 1.5 * colW, top - 0.5 * rowH);
  await page.mouse.dblclick(cell.x, cell.y);
  await expect.poll(async () => /Table cell 1,2:/.test(await hist()), { timeout: 10000 }).toBe(true);
  await cmd.fill('Edited');
  await cmd.press('Enter');
  await expect.poll(async () => /TABLEEDIT: cell 1,2 updated/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expectCensus(/TABLE=1/);

  // 3. QSAVE: a real ACAD_TABLE with the edited cell, no loose LINEs.
  //    The sizes are checked against the derived geometry (the picks are
  //    exact screen points, the map carries ~1 unit of error).
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  const savedPath = testInfo.outputPath('saved-2d7.dxf');
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
  const tables = recs.filter((r) => r.type === 'ACAD_TABLE');
  expect(tables, 'expected exactly one ACAD_TABLE record in the saved DXF').toHaveLength(1);
  const tb = tables[0];
  expect(tb.groups.get('91')?.[0], 'group 91 = 2 rows').toBe('2');
  expect(tb.groups.get('92')?.[0], 'group 92 = 3 cols').toBe('3');
  const heights = (tb.groups.get('141') ?? []).map(Number);
  const widths = (tb.groups.get('142') ?? []).map(Number);
  expect(heights, 'group 141 = two row heights').toHaveLength(2);
  expect(widths, 'group 142 = three column widths').toHaveLength(3);
  for (const h of heights) expect(Math.abs(h - rowH), `row height ${h} ≈ derived ${rowH}`).toBeLessThan(2);
  for (const w of widths) expect(Math.abs(w - colW), `column width ${w} ≈ derived ${colW}`).toBeLessThan(2);
  expect(tb.groups.get('1'), 'group 1 = cell texts row-major, edited cell included').toEqual([
    '1,1', 'Edited', '1,3', '2,1', '2,2', '2,3',
  ]);
  const entTypes = recs.filter((r) => ['LINE', 'TEXT'].includes(r.type)).map((r) => r.type);
  expect(entTypes, 'the table must not save as loose LINE/TEXT').toEqual([]);

  // 4. Re-import the saved DXF: it reads back as a TABLE, and the grid
  //    still renders. The proof scans the canvas pixels directly instead
  //    of trusting calibrated coordinates: the calibrated geometry carries
  //    ~1 unit of error, which the ZOOM E scale (~14 px/unit) magnifies
  //    past an 8 px sample box. A rendered table is 3 horizontal bands
  //    (top, middle, bottom) and 4 vertical bands (left, 2 dividers,
  //    right) of bright pixels, and the inside of a cell stays empty.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'saved-2d7.dxf', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await expectCensus(/TABLE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  // Park the mouse in the canvas corner so the crosshair lines cannot
  // contaminate the scan (its lines sit inside the excluded 30 px border).
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.waitForTimeout(400);
  const scan = await page.evaluate(() => {
    const cv = document.querySelector('[data-r=cv]') as HTMLCanvasElement;
    const rect = cv.getBoundingClientRect();
    const dpr = cv.width / rect.width;
    const ctx = cv.getContext('2d')!;
    const W = cv.width, H = cv.height;
    const img = ctx.getImageData(0, 0, W, H).data;
    const isBright = (x: number, y: number): boolean => {
      // The table draws in the layer colour — a light blue (r ≈ 56), so
      // the all-channels->100 test the 2D-6 spec used for white lines
      // would miss it. Max-channel > 150 separates it from the dark
      // background (max ≈ 60) and the faint header shading.
      const i = (y * W + x) * 4;
      return Math.max(img[i], img[i + 1], img[i + 2]) > 150;
    };
    const M = Math.round(30 * dpr);
    const rowCount: number[] = new Array(H).fill(0);
    const colCount: number[] = new Array(W).fill(0);
    for (let y = M; y < H - M; y++) {
      for (let x = M; x < W - M; x++) {
        if (isBright(x, y)) { rowCount[y]++; colCount[x]++; }
      }
    }
    const bands = (counts: number[], thresh: number): Array<{ at: number; max: number }> => {
      const out: Array<{ at: number; max: number }> = [];
      let run: number[] = [];
      const flush = () => {
        if (run.length) {
          const at = run.reduce((best, cur) => (counts[cur] > counts[best] ? cur : best), run[0]);
          out.push({ at, max: counts[at] });
          run = [];
        }
      };
      for (let i = 0; i < counts.length; i++) {
        if (counts[i] > thresh) run.push(i);
        else flush();
      }
      flush();
      return out;
    };
    // A grid line spans the table (~890 px wide, ~230 px tall after
    // ZOOM E); a row through the big cell text holds at most ~250 bright
    // px, so the threshold sits at half the strongest row/column — the
    // grid, not the labels, clears it.
    const maxRow = Math.max(...rowCount), maxCol = Math.max(...colCount);
    const hLines = maxRow > 100 ? bands(rowCount, maxRow * 0.5) : [];
    const vLines = maxCol > 100 ? bands(colCount, maxCol * 0.5) : [];
    // Interior of cell (0,2): 75% across the third column, centred on
    // the first row — right of the "1,3" label, clear of every grid line.
    let inCell = -1;
    if (hLines.length >= 2 && vLines.length >= 4) {
      const cx = Math.round(vLines[2].at + 0.75 * (vLines[3].at - vLines[2].at));
      const cy = Math.round((hLines[0].at + hLines[1].at) / 2);
      const w = Math.round(20 * dpr), h = Math.round(8 * dpr);
      inCell = 0;
      for (let y = cy - h / 2; y < cy + h / 2; y++) {
        for (let x = cx - w / 2; x < cx + w / 2; x++) {
          if (isBright(x, y)) inCell++;
        }
      }
    }
    return { hLines, vLines, inCell };
  });
  expect(scan.hLines.length, `expected 3 horizontal grid lines, got ${JSON.stringify(scan.hLines)}`).toBe(3);
  expect(scan.vLines.length, `expected 4 vertical grid lines, got ${JSON.stringify(scan.vLines)}`).toBe(4);
  expect(scan.inCell, `the cell interior must stay empty, got ${scan.inCell} bright px`).toBe(0);

  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});
