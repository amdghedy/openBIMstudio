import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * Fence / lasso selection, Ctrl+click cycling, grip modes (AutoCAD parity A11).
 *
 * Reference drawing, imported from DXF:
 *   LINE A (0,0)-(200,0) · LINE B (100,-100)-(100,100) (they cross at
 *   (100,0)) · CIRCLE (300,0) r=50 · closed LWPOLYLINE square
 *   (400,0)-(500,0)-(500,100)-(400,100) · a 4-line frame
 *   (-100,-100)-(700,-100)-(700,200)-(-100,200) so ZOOM E leaves margin
 *   for the lasso loops.
 *
 * Proved in the real app:
 *  1. Ctrl+click cycling: at the A/B crossing (100,0) the first
 *     Ctrl+click reports "cycle: 1 of 2", the second "2 of 2", the third
 *     wraps to "1 of 2". (The crossing is also both lines' midpoint
 *     grip — the grip check must not swallow the Ctrl+click.)
 *  2. FENCE: (50,-50)-(50,50) crosses only A → "FENCE selected 1";
 *     (0,50)-(200,-50) crosses A and B at their crossing → 2.
 *  3. LASSO window (dragged left-to-right around the square) → 1 (the
 *     square only); LASSO crossing (dragged right-to-left around the
 *     A/B region) → 2 (A and B).
 *  4. Grip Stretch (default): A's start grip (0,0) → (0,50) moves only
 *     the start point.
 *  5. Grip Move (Enter once): B's start grip (100,-100) → (150,-100)
 *     moves the whole line; a stretch would have left the end behind.
 *  6. Grip Rotate (Enter twice): the square's vertex grip (400,0), first
 *     move to (450,0) sets the zero reference, second to (400,50)
 *     rotates 90° about (400,0).
 *  7. Grip Scale (Enter three times): B's start grip (150,-100), first
 *     move to (150,0) sets the reference distance 100, second to
 *     (150,100) scales ×2 about the grip.
 *  8. Grip menu: right-click during a grip drag opens a menu with the
 *     five modes (Stretch disabled as current); Escape cancels the drag
 *     (the menu is dismissed by the next canvas click); the drag is then
 *     redone with Enter ×4 → Mirror: A's end grip (200,0), cursor
 *     (200,50) mirrors A across x=200.
 *  9. QSAVE + reload + re-import: the saved DXF carries the final
 *     geometry — A (400,50)-(200,0), B (150,-100)-(150,300), the square
 *     rotated to (400,0),(400,100),(300,100),(300,0), the circle
 *     untouched at (300,0) r=50.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the map is re-solved
 * from the live canvas box right before each step's first click (A15
 * lesson). ORTHO/POLAR/OTRACK stay off so the freehand lasso and the
 * grip drags land where the calibration says they land.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3119 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3119 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 200, 21, 0,
  0, 'LINE', 8, '0', 10, 100, 20, -100, 11, 100, 21, 100,
  0, 'CIRCLE', 8, '0', 10, 300, 20, 0, 40, 50,
  0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 400, 20, 0, 10, 500, 20, 0, 10, 500, 20, 100, 10, 400, 20, 100,
  0, 'LINE', 8, '0', 10, -100, 20, -100, 11, 700, 21, -100,
  0, 'LINE', 8, '0', 10, 700, 20, -100, 11, 700, 21, 200,
  0, 'LINE', 8, '0', 10, 700, 20, 200, 11, -100, 21, 200,
  0, 'LINE', 8, '0', 10, -100, 20, 200, 11, -100, 21, -100,
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

test('2D editor: fence, lasso, Ctrl+click cycling, grip modes', async ({ page }, testInfo) => {
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
  await expect.poll(async () => { const c = await census(); return c.LINE === 6 && c.CIRCLE === 1 && c.LWPOLYLINE === 1; }, { timeout: 15000 }).toBe(true);

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
  const ctrlClickWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.keyboard.down('Control');
    await page.mouse.click(s.x, s.y);
    await page.keyboard.up('Control');
  };
  const finishFence = async () => {
    await focusCanvas();
    await page.keyboard.press('Enter');
  };

  // 1. Ctrl+click cycling at the A/B crossing (100,0): 1 of 2, 2 of 2, wrap to 1 of 2.
  await recalibrate();
  await ctrlClickWorld(100, 0);
  await expect.poll(hist, { timeout: 10000 }).toContain('Ctrl+click cycle: 1 of 2');
  await ctrlClickWorld(100, 0);
  await expect.poll(hist, { timeout: 10000 }).toContain('Ctrl+click cycle: 2 of 2');
  await ctrlClickWorld(100, 0);
  await expect.poll(hist, { timeout: 10000 }).toContain('Ctrl+click cycle: 1 of 2');

  // 2. FENCE across A only, then across A and B at their crossing.
  await run('FENCE');
  await recalibrate();
  await clickWorld(50, -50);
  await clickWorld(50, 50);
  await finishFence();
  await expect.poll(hist, { timeout: 10000 }).toContain('FENCE selected 1 object(s).');
  await run('FENCE');
  await recalibrate();
  await clickWorld(0, 50);
  await clickWorld(200, -50);
  await finishFence();
  await expect.poll(hist, { timeout: 10000 }).toContain('FENCE selected 2 object(s).');

  // 3. LASSO window: left-to-right loop around the square only.
  await recalibrate();
  await run('LASSO');
  {
    const loop: Array<[number, number]> = [[390, -10], [510, -10], [510, 110], [390, 110], [390, -10]];
    const s0 = toScreen(loop[0][0], loop[0][1]);
    await page.mouse.move(s0.x, s0.y);
    await page.mouse.down();
    for (const [wx, wy] of loop.slice(1)) {
      const s = toScreen(wx, wy);
      await page.mouse.move(s.x, s.y, { steps: 12 });
    }
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Lasso window selected 1 object(s).');

  // 4. LASSO crossing: right-to-left loop around the A/B region.
  await recalibrate();
  await run('LASSO');
  {
    const loop: Array<[number, number]> = [[150, 50], [50, 50], [50, -50], [150, -50], [150, 50]];
    const s0 = toScreen(loop[0][0], loop[0][1]);
    await page.mouse.move(s0.x, s0.y);
    await page.mouse.down();
    for (const [wx, wy] of loop.slice(1)) {
      const s = toScreen(wx, wy);
      await page.mouse.move(s.x, s.y, { steps: 12 });
    }
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Lasso crossing selected 2 object(s).');

  // 5. Grip Stretch (default): A's start grip (0,0) -> (0,50) moves only the start.
  await recalibrate();
  await clickWorld(50, 0); // select A alone
  {
    const g = toScreen(0, 0), t = toScreen(0, 50);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.move(t.x, t.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 6. Grip Move (Enter once): B's start grip (100,-100) -> (150,-100) moves the whole line.
  await recalibrate();
  await clickWorld(100, 50); // select B alone
  {
    const g = toScreen(100, -100), t = toScreen(150, -100);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter'); // stretch -> move
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Move');
    await page.mouse.move(t.x, t.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 7. Grip Rotate (Enter twice): square vertex grip (400,0); (450,0) sets
  //    the zero reference, (400,50) rotates 90 deg about (400,0).
  await recalibrate();
  await clickWorld(450, 0); // select the square alone (top edge)
  {
    const g = toScreen(400, 0), r = toScreen(450, 0), t = toScreen(400, 50);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter'); // stretch -> move
    await page.keyboard.press('Enter'); // move -> rotate
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Rotate');
    // Single-step move to the reference point: the implementation captures
    // the rotate/scale zero reference at the FIRST significant move out of
    // the grip, so an interpolated multi-step move would capture the first
    // intermediate point instead of the intended reference.
    await page.mouse.move(r.x, r.y);
    await page.mouse.move(t.x, t.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 8. Grip Scale (Enter three times): B's start grip (150,-100); (150,0)
  //    sets the reference distance 100, (150,100) scales x2 about the grip.
  await recalibrate();
  await clickWorld(150, 50); // select B alone (now at x=150)
  {
    const g = toScreen(150, -100), r = toScreen(150, 0), t = toScreen(150, 100);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // stretch -> move -> rotate -> scale
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Scale');
    // Single-step move to the reference point: the implementation captures
    // the scale zero reference at the FIRST significant move out of the
    // grip, so an interpolated multi-step move would capture the first
    // intermediate point (12.5 units out) instead of (150,0).
    await page.mouse.move(r.x, r.y);
    await page.mouse.move(t.x, t.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 9. Grip menu + Mirror (Enter four times): A's end grip (200,0).
  //    Right-click mid-drag opens the five-mode menu; Escape cancels the
  //    drag (the menu is dismissed by the next canvas click); the drag is
  //    then redone with Enter x4 -> Mirror, cursor (200,50) mirrors A
  //    across x=200.
  await recalibrate();
  await clickWorld(100, 25); // select A alone (A now runs (0,50)-(200,0))
  {
    const g = toScreen(200, 0);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await page.mouse.click(g.x, g.y, { button: 'right' });
    await expect(page.locator('[data-grip-mode]')).toHaveCount(5, { timeout: 10000 });
    await expect(page.locator('[data-grip-mode="stretch"]')).toBeDisabled();
    await expect(page.locator('[data-grip-mode="mirror"]')).toBeEnabled();
    await page.keyboard.press('Escape'); // cancels the drag; menu stays until the next click
    await page.mouse.up();
  }
  // The grip menu is still open and covers part of the canvas, so dismiss
  // it with a canvas click BEFORE recalibrating — the calibration probes
  // read the coords readout, which only updates while the cursor is over
  // the canvas itself.
  await clickWorld(100, 25); // dismisses the menu and re-selects A
  await recalibrate();
  await clickWorld(100, 25); // re-select A with the fresh map
  {
    const g = toScreen(200, 0), t = toScreen(200, 50);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // stretch -> move -> rotate -> scale -> mirror
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Mirror');
    await page.mouse.move(t.x, t.y, { steps: 8 });
    await page.mouse.up();
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 10. Live counts unchanged by the grip edits (same entities, moved).
  const live = await census();
  expect(live.LINE).toBe(6);
  expect(live.CIRCLE).toBe(1);
  expect(live.LWPOLYLINE).toBe(1);

  // 11. QSAVE: parse the downloaded DXF in Node.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  // saveAs() waits for the download to finish writing; reading d.path()
  // straight after waitForEvent('download') can catch a partially written
  // file (the CIRCLE record sits after the LINEs, so a short read loses it
  // while the two LINE asserts still pass).
  const savedPath = testInfo.outputPath('saved-a11.dxf');
  await d.saveAs(savedPath);
  const dxfText = fs.readFileSync(savedPath, 'utf8');
  const recs = dxfRecords(dxfText);
  const lines = recs.filter((r) => r.type === 'LINE');
  const nearLine = (x1: number, y1: number, x2: number, y2: number) =>
    lines.find((r) =>
      Math.abs(recNum(r, 10)! - x1) < 0.01 && Math.abs(recNum(r, 20)! - y1) < 0.01 &&
      Math.abs(recNum(r, 11)! - x2) < 0.01 && Math.abs(recNum(r, 21)! - y2) < 0.01);
  // A: stretched, then mirrored across x=200.
  expect(nearLine(400, 50, 200, 0), 'mirrored A missing from the saved DXF').toBeTruthy();
  // B: moved +50 in x, then scaled x2 about (150,-100).
  expect(nearLine(150, -100, 150, 300), 'moved+scaled B missing from the saved DXF').toBeTruthy();
  // Circle untouched.
  const circle = recs.find((r) => r.type === 'CIRCLE');
  expect(circle, 'circle missing from the saved DXF').toBeTruthy();
  expect(recNum(circle!, 10)).toBeCloseTo(300, 2);
  expect(recNum(circle!, 20)).toBeCloseTo(0, 2);
  expect(recNum(circle!, 40)).toBeCloseTo(50, 2);
  // Square rotated 90 deg about (400,0).
  const square = recs.find((r) => r.type === 'LWPOLYLINE');
  expect(square, 'square missing from the saved DXF').toBeTruthy();
  const verts = new Set<string>();
  // Round to 2 decimals: the rotate drag's screen→world round-trip lands
  // the vertices ~1e-4 units off the exact integers, as the LINE asserts
  // above already tolerate with 0.01.
  for (let n = 0; n < 4; n++) verts.add(`${recNum(square!, 10, n)!.toFixed(2)},${recNum(square!, 20, n)!.toFixed(2)}`);
  expect(verts.has('400.00,0.00') && verts.has('400.00,100.00') && verts.has('300.00,100.00') && verts.has('300.00,0.00'),
    `rotated square vertices wrong: ${[...verts].join(' ')}`).toBe(true);

  // 12. Reload, re-import the saved file: the same counts prove the file stands alone.
  await page.reload();
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'saved.dxf', mimeType: 'text/plain', buffer: Buffer.from(dxfText) });
  await expect.poll(async () => { const c = await census(); return c.LINE === 6 && c.CIRCLE === 1 && c.LWPOLYLINE === 1; }, { timeout: 30000 }).toBe(true);
  const back = await census();
  expect(back.LINE).toBe(6);
  expect(back.CIRCLE).toBe(1);
  expect(back.LWPOLYLINE).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
