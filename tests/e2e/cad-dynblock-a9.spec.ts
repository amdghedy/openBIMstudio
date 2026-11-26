import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * AutoCAD 2D parity A9 — dynamic-block parameters (authored in the editor).
 *
 * Reference model, imported from DXF with native blocks on: block
 * "DYNDOOR" (base 0,0) holding two LINEs (indices 0, 1) and one closed
 * LWPOLYLINE panel (index 2), placed twice (at 0,0 and at 200,0).
 *
 * Proved in the real app:
 *  1. DYNPARAM authors a linear parameter (Width, base 100, moving the
 *     two LINEs), a flip parameter (Mirror, axis Y) and a visibility
 *     parameter (State: Open / Closed); DYNPARAM LIST reports all three.
 *  2. The linear grip drags: dragging the orange diamond at (100,0) to
 *     (150,0) moves the two LINEs (canvas pixels appear at (150,0)),
 *     the history logs "Width = 150", and the Properties panel shows
 *     150; Ctrl+Z restores 100; the panel input sets 150 again.
 *  3. The flip grip toggles on click: the Mirror checkbox follows, and
 *     LINE1 mirrors about y=0 (pixels appear at (50,-25), vanish on
 *     the second click).
 *  4. The lookup drives the linear parameter: DYNPARAM LOOKUP Size
 *     Small/Large sets Width 50/150; the panel and the canvas agree
 *     (the lookup owns its target while active).
 *  5. The visibility state hides real geometry: in a BEDIT session
 *     DYNVIS Closed hides the panel (its pixels vanish from the session
 *     canvas); after BCLOSE both instances hide it, and DYNBLOCK DYNDOOR
 *     Open brings it back on both.
 *
 * Geometry is proved with canvas pixels (the draw path evaluates the
 * parameters; picking/bbox use the plain resolver — recorded follow-up),
 * counting pixels that differ from the patch background in a 21x21 patch
 * around a point on an edge. The grid is off so no grid line pollutes a
 * patch; the mouse is parked in a canvas corner before each read so no
 * cursor marker lands in a patch.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the screen->world
 * map is re-solved from the live canvas before each absolute pick
 * (A15 lesson). Tolerances follow the A7/A11 convention (2 decimals;
 * the grip drag is asserted within 0.5 of the target).
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3119 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3119 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1, 0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS', 0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, 'DYNDOOR', 70, 0, 10, 0, 20, 0, 30, 0, 3, 'DYNDOOR',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 0, 21, 50, 31, 0,
  0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, 60, 20, 10, 10, 90, 20, 10, 10, 90, 20, 40, 10, 60, 20, 40,
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'INSERT', 8, '0', 2, 'DYNDOOR', 10, 0, 20, 0, 30, 0,
  0, 'INSERT', 8, '0', 2, 'DYNDOOR', 10, 200, 20, 0, 30, 0,
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

test('A9 dynamic blocks: grip drag, flip toggle, lookup drive, visibility state', async ({ page }) => {
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
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const banner = page.locator('[data-r=bedit]').first();

  // OSNAP off for calibration (A16 lesson); POLAR/OTRACK off for
  // free-point picks; GRID off so no grid line pollutes a pixel patch.
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setToggle('[data-s=grid]', false);

  // Native blocks on, so the imported INSERTs stay references.
  await run('NATIVEBLOCKS ON');
  await expect.poll(async () => /NATIVEBLOCKS: ON/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 1. Import the reference model: two references to DYNDOOR.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'dyndoor.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/INSERT=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  let box = await canvasBox();
  let map = await calibrate(page, box);
  const screenOf = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const clickWorld = async (wx: number, wy: number) => {
    const s = screenOf(wx, wy);
    await page.mouse.click(s.x, s.y);
  };
  /** Pixels in a 21x21 patch around a world point that differ from the patch background. */
  const strokePixels = async (wx: number, wy: number): Promise<number> => {
    const s = screenOf(wx, wy);
    // Park the mouse in a canvas corner so no cursor marker lands in the patch.
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.waitForTimeout(200);
    return page.evaluate(({ cx, cy, half, bx, by }) => {
      const cv = document.querySelector<HTMLCanvasElement>('[data-r=cv]');
      if (!cv) return -1;
      const ctx = cv.getContext('2d');
      if (!ctx) return -1;
      // getImageData takes canvas-local coordinates, not page coordinates.
      const dpr = window.devicePixelRatio || 1;
      const x = Math.max(0, Math.round((cx - bx - half) * dpr));
      const y = Math.max(0, Math.round((cy - by - half) * dpr));
      const w = Math.round(half * 2 * dpr);
      const h = Math.round(half * 2 * dpr);
      const data = ctx.getImageData(x, y, w, h).data;
      const counts = new Map<string, number>();
      for (let i = 0; i + 3 < data.length; i += 4) {
        const k = `${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      let bg = '';
      let best = -1;
      for (const [k, n] of counts) if (n > best) { best = n; bg = k; }
      const [br, bgc, bb] = bg.split(',').map(Number);
      let drawn = 0;
      for (let i = 0; i + 3 < data.length; i += 4) {
        if (Math.abs(data[i] - br) > 12 || Math.abs(data[i + 1] - bgc) > 12 || Math.abs(data[i + 2] - bb) > 12) drawn++;
      }
      return drawn;
    }, { cx: s.x, cy: s.y, half: 10, bx: box.x, by: box.y });
  };
  const widthInput = () => page.locator('[data-dyn-param="width"]');
  const widthValue = async () => parseFloat(await widthInput().inputValue());

  // 2. Author the parameters: linear Width (the two LINEs), flip Mirror,
  //    visibility State (Open / Closed).
  await run('DYNPARAM DYNDOOR LINEAR Width 0 0 0 100 0 1');
  await expect.poll(async () => /DYNPARAM: linear "Width" on "DYNDOOR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('DYNPARAM DYNDOOR FLIP Mirror 0 0 Y');
  await expect.poll(async () => /DYNPARAM: flip "Mirror" on "DYNDOOR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('DYNPARAM DYNDOOR VISIBILITY State Open Closed');
  await expect.poll(async () => /DYNPARAM: visibility "State" on "DYNDOOR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('DYNPARAM DYNDOOR LIST');
  await expect.poll(async () => /linear\s+Width/.test(await hist()) && /flip\s+Mirror/.test(await hist()) && /visibility\s+State/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 3. Select the first instance (click the LINE at (50,0)): the panel shows Width 100.
  await clickWorld(50, 0);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(100, 0);
  await expect(page.locator('[data-dyn-param="mirror"]')).not.toBeChecked();
  await expect(page.locator('[data-dyn-param="state"]')).toHaveValue('Open');

  // 4. Baseline: nothing drawn at (150,0) yet.
  expect(await strokePixels(150, 0), 'baseline: the LINE ends at (100,0)').toBe(0);

  // 5. Drag the linear grip (100,0) -> (150,0): the LINEs move, the panel and the log follow.
  {
    const start = screenOf(100, 0);
    const end = screenOf(150, 0);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 12 });
    await page.mouse.up();
  }
  await expect.poll(async () => /Dynamic block "DYNDOOR": Width = 1[45][0-9]/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(150, 0);
  expect(await strokePixels(150, 0), 'after the drag the LINE ends at (150,0)').toBeGreaterThanOrEqual(5);

  // 6. Ctrl+Z restores 100 (the drag committed one modify undo action).
  await page.keyboard.press('Control+z');
  await clickWorld(50, 0);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(100, 0);

  // 7. The panel input sets 150 again.
  await widthInput().fill('150');
  await page.keyboard.press('Tab');
  await expect.poll(async () => /Dynamic block "DYNDOOR": Width = 150/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(150, 0);
  expect(await strokePixels(150, 0), 'panel-set Width 150 draws the LINE to (150,0)').toBeGreaterThanOrEqual(5);

  // 8. Flip grip: click toggles Mirror on (the LINEs mirror about y=0),
  //    click again toggles off. The flip grip sits at (0,12) in block
  //    space, but the linear parameter (Width 150, base 100) moves it +50
  //    along X, so it is at (50,12) here. The mirrored LINE1 is proved at
  //    (50,-25); mirroring about x=0 would push the geometry off-screen,
  //    so the flip is about the horizontal axis.
  await clickWorld(50, 12);
  await expect.poll(async () => page.locator('[data-dyn-param="mirror"]').isChecked(), { timeout: 10000 }).toBe(true);
  expect(await strokePixels(50, -25), 'flipped: LINE1 now spans (50,0)-(50,-50)').toBeGreaterThanOrEqual(5);
  await clickWorld(50, 12);
  await expect.poll(async () => page.locator('[data-dyn-param="mirror"]').isChecked(), { timeout: 10000 }).toBe(false);
  expect(await strokePixels(50, -25), 'unflipped: nothing at (50,-25) again').toBe(0);

  // 9. Lookup: Small drives Width 50, Large drives 150 (panel and canvas agree).
  await run('DYNPARAM DYNDOOR LOOKUP Size Small Width=50');
  await expect.poll(async () => /DYNPARAM: lookup "Size" on "DYNDOOR" — row "Small" added/.test(await hist()), { timeout: 10000 }).toBe(true);
  await run('DYNPARAM DYNDOOR LOOKUP Size Large Width=150');
  await expect.poll(async () => /DYNPARAM: lookup "Size" on "DYNDOOR" — row "Large" added/.test(await hist()), { timeout: 10000 }).toBe(true);
  // The lookup defaults to its first row ("Small"), so Width is 50 now.
  // Probe (100,0): only instance 1's LINE crosses it (at Width 150 it
  // spans (50,0)-(150,0); instance 2's LINE is at (150,0)-(250,0) now,
  // since the lookup default drives it too).
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(50, 0);
  expect(await strokePixels(100, 0), 'lookup Small: instance 1 LINE ends at (50,0)').toBe(0);
  await page.locator('[data-dyn-param="size"]').selectOption('Large');
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(150, 0);
  expect(await strokePixels(100, 0), 'lookup Large: instance 1 LINE spans (50,0)-(150,0) again').toBeGreaterThanOrEqual(5);
  await page.locator('[data-dyn-param="size"]').selectOption('Small');
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(50, 0);
  expect(await strokePixels(100, 0), 'lookup Small again: instance 1 LINE is back at (50,0)').toBe(0);

  // 10. Visibility: in a BEDIT session, DYNVIS Closed hides the panel.
  await run('BEDIT DYNDOOR');
  await expect.poll(async () => /BEDIT: editing "DYNDOOR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeVisible();
  box = await canvasBox();
  map = await calibrate(page, box);
  expect(await strokePixels(75, 10), 'session baseline: the panel bottom edge is drawn').toBeGreaterThanOrEqual(5);
  await clickWorld(75, 10);
  await run('DYNVIS Closed');
  await expect.poll(async () => /DYNVIS: hid 1 object\(s\) in state "Closed"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await clickWorld(50, 45);
  expect(await strokePixels(75, 10), 'session: the panel is hidden in state Closed').toBe(0);
  await run('BCLOSE');
  await expect.poll(async () => /BCLOSE: block "DYNDOOR" redefined \(3 object\(s\), base 0, 0\) — 2 reference\(s\) updated/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeHidden();

  // 11. On the model the Closed state hides the panel on BOTH instances.
  await run('ZOOM E');
  await page.waitForTimeout(600);
  box = await canvasBox();
  map = await calibrate(page, box);
  expect(await strokePixels(75, 10), 'model: instance 1 panel hidden in Closed').toBe(0);
  expect(await strokePixels(275, 10), 'model: instance 2 panel hidden in Closed').toBe(0);

  // 12. DYNBLOCK DYNDOOR Open brings the panel back on both.
  await run('DYNBLOCK DYNDOOR Open');
  await expect.poll(async () => /DYNBLOCK: "DYNDOOR" → "Open" \(visibility parameter\)/.test(await hist()), { timeout: 10000 }).toBe(true);
  expect(await strokePixels(75, 10), 'model: instance 1 panel back in Open').toBeGreaterThanOrEqual(5);
  expect(await strokePixels(275, 10), 'model: instance 2 panel back in Open').toBeGreaterThanOrEqual(5);

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
