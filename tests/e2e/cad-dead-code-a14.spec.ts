import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * A14 dead-code removal smoke: after deleting the duplicate snap engine
 * and the snapping octree, the app must still load, the CAD viewer must
 * open, and the LIVE snap pipeline (viewer-math.ts findSnap) plus FENCE
 * selection must still work.
 *
 * Reference drawing, imported from DXF:
 *   LINE A (0,0)-(200,0) · LINE B (0,100)-(100,100) · CIRCLE (300,0) r=50.
 *
 * Proved in the real app:
 *  1. Endpoint snap: with OSNAP on, hovering directly above A's start
 *     (0,2) reads exactly (0,0) — the live findSnap endpoint. The hover
 *     point is straight above the endpoint on purpose: hovering past
 *     the end of the line would (correctly, AutoCAD-style) catch the
 *     EXTENSION snap along the line's direction instead.
 *  2. Midpoint snap: hovering just off A's middle (100,3) reads exactly
 *     (100,0).
 *  3. FENCE (50,-50)-(50,150) selects A and B (2); FENCE
 *     (150,-50)-(150,150) selects A only (1).
 *  4. Live counts unchanged (LINE=2, CIRCLE=1). No page errors.
 *
 * The hover points are chosen so the wanted snap is also the nearest
 * point on the segment (directly above the endpoint, just off the
 * midpoint), so the assertion holds whatever the kind ranking is — only
 * the coordinates are asserted.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the map is re-solved
 * from the live canvas box right before each step's first click (A15
 * lesson). ORTHO/POLAR/OTRACK stay off.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3120 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3120 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 200, 21, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 100, 11, 100, 21, 100,
  0, 'CIRCLE', 8, '0', 10, 300, 20, 0, 40, 50,
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

test('2D editor: live snap and FENCE still work after the A14 dead-code removal', async ({ page }) => {
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
  await expect.poll(async () => { const c = await census(); return c.LINE === 2 && c.CIRCLE === 1; }, { timeout: 15000 }).toBe(true);

  // Calibrate with OSNAP off, then keep ORTHO/POLAR/OTRACK off.
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
  const hoverWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.move(s.x, s.y);
    await page.waitForTimeout(200);
  };

  // 1+2. Live snap: calibrate with OSNAP off (a calibration sample
  // landing near an entity would snap and corrupt the map), then turn
  // OSNAP on and hover with no recalibration in between.
  await recalibrate();
  await setToggle('snap', true);
  await hoverWorld(0, 2);
  {
    const p = await readCoords(page);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  }
  await hoverWorld(100, 3);
  {
    const p = await readCoords(page);
    expect(p.x).toBeCloseTo(100, 6);
    expect(p.y).toBeCloseTo(0, 6);
  }
  await setToggle('snap', false);

  // 3. FENCE across both lines, then across A only. The fence x comes
  //    from the world map (X is exact — the A15 shift moves Y only);
  //    the endpoints are placed by SCREEN position, 12px inside the
  //    canvas top/bottom, so they always land on-canvas and straddle
  //    both lines. (Fixed world-y endpoints went off-canvas: B sits
  //    near the top of the ZOOM E view, so a (50,150) endpoint clicked
  //    the ribbon instead — it started ERASE.)
  const finishFence = async () => {
    await focusCanvas();
    await page.keyboard.press('Enter');
  };
  const fenceAt = async (wx: number) => {
    await recalibrate();
    const liveBox = (await page.locator('[data-r=cv]').first().boundingBox())!;
    const x = toScreen(wx, 0).x;
    await page.mouse.click(x, liveBox.y + 12);
    await page.mouse.click(x, liveBox.y + liveBox.height - 12);
  };
  await run('FENCE');
  await fenceAt(50);
  await finishFence();
  await expect.poll(hist, { timeout: 10000 }).toContain('FENCE selected 2 object(s).');
  await run('FENCE');
  await fenceAt(150);
  await finishFence();
  await expect.poll(hist, { timeout: 10000 }).toContain('FENCE selected 1 object(s).');

  // 4. Live counts unchanged (selection work only — no geometry edited).
  const live = await census();
  expect(live.LINE).toBe(2);
  expect(live.CIRCLE).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
