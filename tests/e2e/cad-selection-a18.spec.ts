import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * QSELECT dialog, FILTER property criteria + named filters, and previous
 * selection (AutoCAD parity A18).
 *
 * Reference drawing, imported from DXF:
 *   LINE A (0,0)-(200,0), layer 0 · LINE B (0,50)-(100,50), layer 0 ·
 *   LINE C (0,200)-(200,200), layer WALLS · CIRCLE (300,0) r=50 ·
 *   TEXT "NOTE A" (400,0) height 10 · closed LWPOLYLINE square
 *   (500,0)-(600,0)-(600,100)-(500,100).
 *
 * Proved in the real app:
 *  1. QSELECT dialog, include: LINE + length > 150 → A and C (2).
 *  2. QSELECT dialog, exclude: CIRCLE + radius = 50 → everything but the
 *     circle (5).
 *  3. QSELECT dialog, include then append: LINE + length = 100 → B alone
 *     (1); then CIRCLE + radius = 50 appended → B + circle (2).
 *  4. FILTER dialog, property criterion: length > 150 hides B (clicking
 *     it selects nothing — SELECTSIMILAR reports no source objects) while
 *     A still picks; FILTER CLEAR restores B.
 *  5. FILTER dialog, named filter: radius > 40 saved as "Big round" and
 *     applied from the dialog's own list, then again from the command
 *     line (FILTER Big round) — B stays unpickable in both cases; the
 *     filter deletes cleanly afterwards.
 *  5b. FILTER dialog, OR group (2D-15): root operator OR with
 *      layer = WALLS and type = CIRCLE → only C and the circle stay
 *      pickable (B is neither); FILTER CLEAR restores everything.
 *  6. Previous selection: select A, then C, clear, PREVIOUS restores C;
 *     the context-menu "Select Previous" restores it again; the P option
 *     at a MOVE "Select objects:" prompt restores it a third time and
 *     Enter accepts the set ("1 found").
 *
 * Calibration runs with OSNAP off (A16 lesson) and the map is re-solved
 * from the live canvas box right before each step's first click (A15
 * lesson). ORTHO/POLAR/OTRACK stay off so the picks land where the
 * calibration says they land.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npm run build && (cd dist && python3 -m http.server 3119 --bind 127.0.0.1)
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3119 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 200, 21, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 50, 11, 100, 21, 50,
  0, 'LINE', 8, 'WALLS', 10, 0, 20, 200, 11, 200, 21, 200,
  0, 'CIRCLE', 8, '0', 10, 300, 20, 0, 40, 50,
  0, 'TEXT', 8, '0', 10, 400, 20, 0, 40, 10, 1, 'NOTE A',
  0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 500, 20, 0, 10, 600, 20, 0, 10, 600, 20, 100, 10, 500, 20, 100,
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

test('2D editor: QSELECT dialog, FILTER criteria and named filters, previous selection', async ({ page }) => {
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
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const text = await hist();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    const out: Record<string, number> = {};
    for (const m of last.matchAll(/([A-Z0-9]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
  };
  const setToggle = async (name: string, on: boolean) => {
    const btn = page.locator(`[data-s=${name}]`);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'ref.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(async () => { const c = await census(); return c.LINE === 3 && c.CIRCLE === 1 && c.TEXT === 1 && c.LWPOLYLINE === 1; }, { timeout: 15000 }).toBe(true);

  // Calibrate with OSNAP off, then keep OSNAP/ORTHO/POLAR/OTRACK off.
  await setToggle('snap', false);
  await setToggle('ortho', false);
  await setToggle('polar', false);
  await setToggle('otrack', false);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  let map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const recalibrate = async () => {
    const live = (await page.locator('[data-r=cv]').first().boundingBox())!;
    map = await calibrate(page, live);
  };
  const clickWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };
  const qselect = async (type: string, prop: string, op: string, value: string, mode?: string) => {
    await run('QSELECT');
    await expect(page.locator('[data-r=qs-type]')).toBeVisible({ timeout: 10000 });
    await page.locator('[data-r=qs-type]').selectOption(type);
    await page.locator('[data-r=qs-prop]').selectOption(prop);
    await page.locator('[data-r=qs-op]').selectOption(op);
    await page.locator('[data-r=qs-value]').fill(value);
    if (mode) await page.locator(`input[name=qs-mode][value=${mode}]`).check();
    await page.locator('[data-r=qs-apply]').click();
  };

  // 1. QSELECT dialog, include: LINE + length > 150 → A and C.
  await qselect('LINE', 'length', '>', '150');
  await expect.poll(hist, { timeout: 10000 }).toContain('QSELECT LINE length > 150 (include): 2 object(s) selected.');

  // 2. QSELECT dialog, exclude: ALL + text contains NOTE → everything
  //    but the text object (5). Exclude removes the matches from the
  //    whole drawing when no type scopes the operation.
  await qselect('ALL', 'text', 'contains', 'NOTE', 'exclude');
  await expect.poll(hist, { timeout: 10000 }).toContain('QSELECT text contains NOTE (exclude): 5 object(s) selected.');

  // 3. QSELECT dialog, include then append: LINE + length = 100 → B alone,
  //    then CIRCLE + radius = 50 appended → B + circle.
  await qselect('LINE', 'length', '=', '100');
  await expect.poll(hist, { timeout: 10000 }).toContain('QSELECT LINE length = 100 (include): 1 object(s) selected.');
  await qselect('CIRCLE', 'radius', '=', '50', 'append');
  await expect.poll(hist, { timeout: 10000 }).toContain('QSELECT CIRCLE radius = 50 (append): 2 object(s) selected.');

  // 4. FILTER dialog, property criterion: length > 150. B stops being
  //    pickable (SELECTSIMILAR reports no source objects after clicking
  //    it) while A still picks; FILTER CLEAR restores B.
  await run('FILTER');
  await expect(page.locator('[data-r=filter-picker-prop]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=filter-picker-prop]').selectOption('length');
  await page.locator('[data-r=filter-picker-op]').selectOption('>');
  await page.locator('[data-r=filter-picker-value]').fill('150');
  await page.locator('[data-r=filter-add-criterion]').click();
  await expect(page.locator('[data-r=filter-tree]')).toContainText('Length > 150');
  await page.locator('[data-r=filter-apply]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: selection filter active');
  await recalibrate();
  await clickWorld(50, 50); // B — filtered out
  await run('SELECTSIMILAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('SELECTSIMILAR: select one or more source objects first.');
  await recalibrate();
  await clickWorld(150, 0); // A — still selectable
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');
  await run('FILTER CLEAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: selection filter cleared');
  await recalibrate();
  await clickWorld(50, 50); // B is back
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');

  // 5. FILTER dialog, named filter: radius > 40 saved as "Big round",
  //    applied from the dialog's own list, then from the command line;
  //    B stays unpickable in both cases; the filter deletes cleanly.
  await run('FILTER');
  await expect(page.locator('[data-r=filter-picker-prop]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=filter-picker-prop]').selectOption('radius');
  await page.locator('[data-r=filter-picker-op]').selectOption('>');
  await page.locator('[data-r=filter-picker-value]').fill('40');
  await page.locator('[data-r=filter-add-criterion]').click();
  await expect(page.locator('[data-r=filter-tree]')).toContainText('Radius > 40');
  await page.locator('[data-r=filter-name]').fill('Big round');
  await page.locator('[data-r=filter-save]').click();
  await expect(page.locator('[data-r=filter-named]')).toContainText('Big round');
  await page.locator('[data-filter-apply-name="Big round"]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: applied named filter "Big round"');
  await recalibrate();
  await clickWorld(50, 50); // B — filtered out by the named filter
  await run('SELECTSIMILAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('SELECTSIMILAR: select one or more source objects first.');
  await run('FILTER CLEAR');
  await run('FILTER Big round');
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: applied named filter "Big round"');
  await recalibrate();
  await clickWorld(50, 50); // B — still filtered out
  await run('SELECTSIMILAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('SELECTSIMILAR: select one or more source objects first.');
  await run('FILTER CLEAR');
  await run('FILTER');
  await expect(page.locator('[data-filter-delete-name="Big round"]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-filter-delete-name="Big round"]').click();
  await expect(page.locator('[data-r=filter-named]')).toContainText('No saved filters yet.');
  await page.locator('[data-r=filter-apply]').click();

  // 5b. FILTER dialog, OR group (2D-15): root operator OR with
  //     layer = WALLS and type = CIRCLE → only C and the circle stay
  //     pickable (B is neither); FILTER CLEAR restores everything.
  await run('FILTER');
  await expect(page.locator('[data-r=filter-picker-prop]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=filter-group-op]').selectOption('OR');
  await page.locator('[data-r=filter-picker-prop]').selectOption('layer');
  await page.locator('[data-r=filter-picker-op]').selectOption('=');
  await page.locator('[data-r=filter-picker-value]').fill('WALLS');
  await page.locator('[data-r=filter-add-criterion]').click();
  await page.locator('[data-r=filter-picker-prop]').selectOption('type');
  await page.locator('[data-r=filter-picker-op]').selectOption('=');
  await page.locator('[data-r=filter-picker-value]').fill('CIRCLE');
  await page.locator('[data-r=filter-add-criterion]').click();
  await expect(page.locator('[data-r=filter-tree]')).toContainText('Layer = WALLS');
  await expect(page.locator('[data-r=filter-tree]')).toContainText('Object Type = CIRCLE');
  await page.locator('[data-r=filter-apply]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: selection filter active');
  await recalibrate();
  await clickWorld(50, 50); // B — neither WALLS nor CIRCLE
  await run('SELECTSIMILAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('SELECTSIMILAR: select one or more source objects first.');
  await recalibrate();
  await clickWorld(150, 200); // C — WALLS branch
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');
  await recalibrate();
  await clickWorld(350, 0); // circle circumference — CIRCLE branch
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');
  await run('FILTER CLEAR');
  await expect.poll(hist, { timeout: 10000 }).toContain('FILTER: selection filter cleared');

  // 6. Previous selection: select A, then C, clear, PREVIOUS restores C;
  //    the context menu restores it again; P at a MOVE prompt restores it
  //    a third time and Enter accepts the set.
  await recalibrate();
  await clickWorld(150, 0); // A
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');
  await clickWorld(100, 200); // C
  await expect.poll(hist, { timeout: 10000 }).toContain('1 object(s) selected');
  await clickWorld(650, 150); // empty space — clears the selection
  await run('PREVIOUS');
  await expect.poll(hist, { timeout: 10000 }).toContain('PREVIOUS: restored 1 object(s) from the previous selection.');
  await clickWorld(650, 150); // clear again
  {
    const s = toScreen(650, 150);
    await page.mouse.click(s.x, s.y, { button: 'right' });
    await page.getByRole('button', { name: 'Select Previous' }).click();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('PREVIOUS: restored 1 object(s) from the previous selection.');
  await clickWorld(650, 150); // clear again
  await run('MOVE');
  await expect.poll(hist, { timeout: 10000 }).toContain('Select objects:');
  await run('P');
  await expect.poll(hist, { timeout: 10000 }).toContain('PREVIOUS: restored 1 object(s) from the previous selection.');
  await focusCanvas();
  await page.keyboard.press('Enter');
  await expect.poll(hist, { timeout: 10000 }).toContain('1 found');
  await page.keyboard.press('Escape');

  // 7. Live counts unchanged (selection work only — no geometry edited).
  const live = await census();
  expect(live.LINE).toBe(3);
  expect(live.CIRCLE).toBe(1);
  expect(live.TEXT).toBe(1);
  expect(live.LWPOLYLINE).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
