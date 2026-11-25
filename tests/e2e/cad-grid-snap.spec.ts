import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Real grid snap (AutoCAD parity A4).
 *
 * F9 / SNAP / SNAPMODE used to toggle the same `snapOn` master as
 * OSNAP (F3), so F9 was a second OSNAP switch; the live point pipeline
 * had no grid step and SNAPUNIT stored a value nobody read. The fix
 * separates the masters — `gridSnapOn` vs `snapOn` — and quantizes the
 * input point to the SNAPUNIT spacing (measured from the drawing origin)
 * whenever grid snap is on and no object snap won the point.
 *
 * Proves in the real app, with one reference LINE (0,0)-(100,0):
 *  1. With grid snap OFF (the default), the status-bar coordinate
 *     readout at a mouse position follows the raw cursor (13,4).
 *  2. `SNAPUNIT 10` + F9 turns the status-bar SNAP indicator on while
 *     the OSNAP indicator stays on — the two masters are independent.
 *  3. The same mouse position now reads exactly (10,0): the grid step.
 *  4. `SNAPUNIT 5` moves the same mouse position to (15,5): the
 *     SNAPUNIT value actually takes effect in the browser.
 *  5. A LINE drawn with grid snap on lands on grid multiples: the
 *     command history reports length 28.28 for the (10,0)-(30,20) line
 *     picked at (13,4) and (27,18) (the unsnapped picks would be 19.80).
 *  6. F9 again turns SNAP off without touching OSNAP, and the readout
 *     follows the raw cursor again; the SNAP command toggles it back on.
 *
 * Screen↔world calibration: after ZOOM E the view is an unknown affine
 * map, so the spec reads the status-bar coordinate readout at two mouse
 * positions per axis and solves the map instead of guessing pixels
 * (same approach as cad-layer-lock.spec.ts). The reference line sits at
 * y=0, so the (13,4) probe is ~30 px from it at the fitted scale —
 * outside the 14 px OSNAP aperture, so no object snap can win the
 * point; POLAR is switched off for the LINE draw so the second point
 * is quantized purely by the grid.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3116 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3116 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const oneLine = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'ENDSEC', 0, 'EOF',
);

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

/** Solve screen→world from two mouse samples per axis. */
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

test('2D editor: F9 grid snap quantizes points to the SNAPUNIT spacing, independent of OSNAP', async ({ page }) => {
  test.setTimeout(180000);
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
  const snapBtn = page.locator('[data-s=gridsnap]').first();
  const osnapBtn = page.locator('[data-s=snap]').first();
  // F9 is a window-level hotkey but is swallowed while a text field has
  // focus, so every F9 press is preceded by moving focus to the canvas
  // (tabindex=0, so .focus() works with no click and no side effect).
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(oneLine) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const probe = toScreen(13, 4);

  // 1. Grid snap OFF (default): the readout follows the raw cursor.
  await expect(snapBtn).not.toHaveClass(/active/);
  await expect(osnapBtn).toHaveClass(/active/);
  await page.mouse.move(probe.x, probe.y);
  await page.waitForTimeout(200);
  const raw = await readCoords(page);
  // Loose bounds: the screen→world calibration carries up to ~0.5 units
  // of error at this zoom, but 13±1 still rules out every grid multiple.
  expect(raw.x).toBeGreaterThan(12);
  expect(raw.x).toBeLessThan(14);
  expect(raw.y).toBeGreaterThan(3);
  expect(raw.y).toBeLessThan(5);

  // 2. SNAPUNIT 10 + F9: SNAP indicator on, OSNAP indicator untouched.
  await run('SNAPUNIT 10');
  await expect.poll(hist, { timeout: 10000 }).toContain('SNAPUNIT = 10');
  await focusCanvas();
  await page.keyboard.press('F9');
  await expect(snapBtn).toHaveClass(/active/);
  await expect(osnapBtn).toHaveClass(/active/);

  // 3. The same mouse position now reads exactly on the 10-grid.
  await page.mouse.move(probe.x, probe.y);
  await page.waitForTimeout(200);
  const snapped10 = await readCoords(page);
  expect(snapped10.x).toBeCloseTo(10, 1);
  expect(snapped10.y).toBeCloseTo(0, 1);

  // 4. SNAPUNIT 5 moves the same mouse position to the 5-grid.
  await run('SNAPUNIT 5');
  await expect.poll(hist, { timeout: 10000 }).toContain('SNAPUNIT = 5');
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.waitForTimeout(150);
  await page.mouse.move(probe.x, probe.y);
  await page.waitForTimeout(200);
  const snapped5 = await readCoords(page);
  expect(snapped5.x).toBeCloseTo(15, 1);
  expect(snapped5.y).toBeCloseTo(5, 1);

  // 5. A LINE drawn with grid snap on lands on grid multiples.
  await run('SNAPUNIT 10');
  await expect.poll(hist, { timeout: 10000 }).toContain('SNAPUNIT = 10');
  await run('POLAR OFF');
  await expect.poll(hist, { timeout: 10000 }).toContain('POLAR');
  await run('LINE');
  await page.mouse.click(probe.x, probe.y);
  const second = toScreen(27, 18);
  await page.mouse.click(second.x, second.y);
  // (10,0)-(30,20): length sqrt(800) = 28.28, with the unit suffix.
  // (The unsnapped picks (13,4)-(27,18) would be 19.80, so the length
  // proves both endpoints landed on grid multiples.)
  await expect.poll(hist, { timeout: 10000 }).toContain('Line added: length = 28.28 mm');
  // No CENSUS count here on purpose: addDraftEntity pushes to both
  // `ents` and `modelEnts`, which are the same array in model space, so
  // every drafted entity counts twice in CENSUS (LINE=3 after one draw).
  // That double-add is pre-existing and unrelated to grid snap, so this
  // spec does not enshrine its count.

  // 6. F9 again: SNAP off, OSNAP still on, readout follows the raw cursor.
  await focusCanvas();
  await page.keyboard.press('F9');
  await expect(snapBtn).not.toHaveClass(/active/);
  await expect(osnapBtn).toHaveClass(/active/);
  await page.mouse.move(probe.x, probe.y);
  await page.waitForTimeout(200);
  const rawAgain = await readCoords(page);
  expect(rawAgain.x).toBeGreaterThan(12);
  expect(rawAgain.x).toBeLessThan(14);
  expect(rawAgain.y).toBeGreaterThan(3);
  expect(rawAgain.y).toBeLessThan(5);

  // The SNAP command toggles the same master as F9.
  await run('SNAP');
  await expect(snapBtn).toHaveClass(/active/);
  await expect(osnapBtn).toHaveClass(/active/);

  expect(errors, errors.join('\n')).toEqual([]);
});
