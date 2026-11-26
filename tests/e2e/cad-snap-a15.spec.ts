import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Snap divergence (AutoCAD parity A15).
 *
 * Three snapper changes, proved in the real app against one reference
 * drawing (five LINEs):
 *   A (0,0)-(1000,0) · B (300,-400)-(300,600) · D (308,2)-(316,9)
 *   C (700,200)-(800,200) · E (760,210)-(760,300)
 * C and E do not meet: E's downward extension crosses C at (760,200),
 * which is ON C but NOT on E — the apparent-intersection point.
 *
 *  1. Nearest-in-aperture: the snapper used to pick by fixed priority
 *     tier (endpoint/midpoint/centre first, intersection later) no
 *     matter the distance. At (302,3) the intersection (300,0) is 3.61
 *     away and the endpoint (308,2) is 6.08 away — the old code read
 *     (308,2); the fix reads (300,0). A LINE from there to (300,60)
 *     reports length 60.00 mm.
 *  2. Apparent intersection: the mode was accepted but could never
 *     fire. At (756,200) the apparent point (760,200) is 4.0 away and
 *     C's midpoint (750,200) is 6.0 away — the old code read (750,200);
 *     the fix reads (760,200). A LINE from there to (810,200) reports
 *     length 50.00 mm (the old first point would give 60.00 mm).
 *  3. G14 overrides in the CAD viewer: typing SE while LINE is active
 *     arms a one-shot Endpoint override; a click near A's midpoint
 *     (500,3) then lands raw instead of snapping to (500,0), and the
 *     LINE to (500,30) reports 27.00 mm (the unsuppressed pick would
 *     give 30.00 mm). Right-click during LINE offers the same five
 *     overrides as a menu; picking Center arms it. The OSNAPSET
 *     dialog's Defaults button used to refresh ALL_SNAPS (identical
 *     to All); it now restores the 7 defaults and leaves the other 7
 *     unchecked.
 *
 * Screen↔world calibration: after ZOOM E the view is an unknown affine
 * map, so the spec reads the status-bar coordinate readout at two mouse
 * positions per axis and solves the map instead of guessing pixels
 * (same approach as cad-grid-snap.spec.ts). The aperture is 14 px, so
 * it is ~37 world units at this zoom (the CAD canvas is ~380 px tall
 * in the 1280×720 viewport); the spec asserts it lands in 11–45, the
 * range the click geometry was designed for. POLAR is switched off so
 * the second clicks are not angle-constrained.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already on :3000, so a
 * run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3117 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3117 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const fiveLines = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1000, 21, 0,
  0, 'LINE', 8, '0', 10, 300, 20, -400, 11, 300, 21, 600,
  0, 'LINE', 8, '0', 10, 308, 20, 2, 11, 316, 21, 9,
  0, 'LINE', 8, '0', 10, 700, 20, 200, 11, 800, 21, 200,
  0, 'LINE', 8, '0', 10, 760, 20, 210, 11, 760, 21, 300,
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

test('2D editor: nearest-in-aperture snap, apparent intersection, G14 overrides, OSNAP Defaults', async ({ page }) => {
  test.setTimeout(240000);
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
  // OSNAP is a bare toggle (no ON/OFF argument), so drive it to a wanted
  // state and prove the toggle landed by watching for the fresh log line:
  // the history only appends, so a marker appearing after the snapshot
  // proves this toggle produced it. Calibrations must run with OSNAP OFF:
  // the coords readout shows the *snapped* cursor while it is on, which
  // contaminates the screen→world map (2D-5; the A16 lesson).
  const setOsnap = async (want: "ON" | "OFF") => {
    const before = await hist();
    await run("OSNAP");
    await expect.poll(async () => {
      const added = (await hist()).slice(before.length);
      return added.includes(`OSNAP: <${want}>`);
    }, { timeout: 10000 }).toBe(true);
  };
  // F-keys and bare letters are swallowed while a text field has focus,
  // so focus the canvas (tabindex=0, so .focus() works with no click
  // and no side effect) before typing override keys.
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'five.dxf', mimeType: 'text/plain', buffer: Buffer.from(fiveLines) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=5/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  // `map` is re-solved before step 3 (see there): the canvas can resize
  // between this calibration and the raw pick, which shifts the map in Y.
  // Calibrate with OSNAP OFF (2D-5): the coords readout shows the snapped
  // cursor while it is on, which contaminates the map.
  await setOsnap("OFF");
  let map = await calibrate(page, box);
  await setOsnap("ON");
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  // The aperture is 14 px; the click geometry below was designed for
  // 11–45 world units. Outside that range the test cannot tell the old
  // code from the new one, so fail loudly instead of passing vaguely.
  // (The upper bound also keeps the calibration points — the closest
  // is 50 world units from any entity — outside the snap aperture.)
  const aperture = 14 * map.sx;
  expect(aperture, `aperture ${aperture.toFixed(1)} world units is outside the designed 11–45 range`).toBeGreaterThan(11);
  expect(aperture, `aperture ${aperture.toFixed(1)} world units is outside the designed 11–45 range`).toBeLessThan(45);
  await run('POLAR OFF');
  await expect.poll(hist, { timeout: 10000 }).toContain('POLAR');

  // 1. Nearest-in-aperture: (302,3) reads the intersection (300,0),
  // not the higher-tier endpoint (308,2) the old code returned.
  await run('LINE');
  await page.mouse.move(toScreen(302, 3).x, toScreen(302, 3).y);
  await page.waitForTimeout(200);
  const nearest = await readCoords(page);
  expect(nearest.x).toBeCloseTo(300, 0);
  expect(nearest.y).toBeCloseTo(0, 0);
  await page.mouse.click(toScreen(302, 3).x, toScreen(302, 3).y);
  await page.mouse.click(toScreen(300, 60).x, toScreen(300, 60).y);
  await expect.poll(hist, { timeout: 10000 }).toContain('Line added: length = 60.00 mm');
  await focusCanvas();
  await page.keyboard.press('Escape');

  // 2. Apparent intersection: (756,200) reads (760,200) — the crossing
  // of E's extension with C — not C's midpoint (750,200).
  await run('LINE');
  await page.mouse.move(toScreen(756, 200).x, toScreen(756, 200).y);
  await page.waitForTimeout(200);
  const apparent = await readCoords(page);
  expect(apparent.x).toBeCloseTo(760, 0);
  expect(apparent.y).toBeCloseTo(200, 0);
  await page.mouse.click(toScreen(756, 200).x, toScreen(756, 200).y);
  await page.mouse.click(toScreen(810, 200).x, toScreen(810, 200).y);
  // (760,200)-(810,200): 50.00 mm. The old first point (750,200)
  // would give 60.00 mm.
  await expect.poll(hist, { timeout: 10000 }).toContain('Line added: length = 50.00 mm');
  await focusCanvas();
  await page.keyboard.press('Escape');

  // 3. One-shot override by keys: SE arms Endpoint; a click near A's
  // midpoint (500,3) then lands raw instead of snapping to (500,0).
  await run('LINE');
  await focusCanvas();
  await page.keyboard.type('se');
  await expect.poll(hist, { timeout: 10000 }).toContain('Snap override: Endpoint');
  // Re-solve the screen→world map from the live canvas box right before
  // the raw pick. The canvas can resize between the initial calibration
  // and here (a few px of layout settling); the view keeps its centre
  // and scale but updates view.h, so screenToWorld shifts in Y only and
  // the frozen map puts the raw pick ~7 world units low — the CI failure
  // (raw y −3.83 instead of 3, raw x exact). The snap-based steps above
  // are immune (the snap point is exact); only this raw pick needs a
  // current map. The re-solve hovers are far from any endpoint (239+
  // world units, aperture ~40), so the armed SE override cannot snap
  // them, and hovering never consumes the one-shot override.
  const box3 = (await page.locator('[data-r=cv]').first().boundingBox())!;
  // Same OSNAP-off rule as the first calibration — safe mid-tool: the
  // OSNAP command only flips the master switch (no tool change), so the
  // LINE tool stays active and the armed SE override survives it.
  await setOsnap("OFF");
  map = await calibrate(page, box3);
  await setOsnap("ON");
  await page.mouse.move(toScreen(500, 3).x, toScreen(500, 3).y);
  await page.waitForTimeout(200);
  const raw = await readCoords(page);
  expect(Math.abs(raw.x - 500), `expected raw x≈500, got ${raw.x}`).toBeLessThan(1);
  expect(raw.y, `expected raw y≈3 (not the snapped 0), got ${raw.y}`).toBeGreaterThan(2);
  expect(raw.y, `expected raw y≈3, got ${raw.y}`).toBeLessThan(4);
  await page.mouse.click(toScreen(500, 3).x, toScreen(500, 3).y);
  await page.mouse.click(toScreen(500, 30).x, toScreen(500, 30).y);
  // (500,3)-(500,30): 27.00 mm. The unsuppressed pick (500,0)-(500,30)
  // would give 30.00 mm.
  await expect.poll(hist, { timeout: 10000 }).toContain('Line added: length = 27.00 mm');
  await focusCanvas();
  await page.keyboard.press('Escape');

  // 4. One-shot override by right-click menu: Center arms from the menu.
  await run('LINE');
  await focusCanvas();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  const menu = page.locator('.obs-cad-context-menu');
  await expect(menu).toBeVisible({ timeout: 5000 });
  await expect(menu).toContainText('SNAP OVERRIDES');
  await page.locator('[data-snap-override="center"]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('Snap override: Center');
  await focusCanvas();
  await page.keyboard.press('Escape');

  // 5. A buffered "s" followed by a digit must not lose the "s" — or
  // replay it over the digit. Typing "s5" opens the dynamic command
  // with "s5" (openDynamicCommand overwrites the input on every call,
  // so a stale timer would clobber the digit).
  await run('LINE');
  await focusCanvas();
  await page.keyboard.type('s5');
  const dynInput = page.locator('input[aria-label="Drawing command or numeric input"]');
  await expect(dynInput).toHaveValue('s5');
  await page.keyboard.press('Escape');

  // 6. OSNAPSET Defaults: All then Defaults leaves exactly the 7
  // defaults checked — Defaults used to be identical to All.
  await run('OSNAPSET');
  await expect(page.locator('[data-r=snap-all]')).toBeVisible({ timeout: 10000 });
  await page.locator('[data-r=snap-all]').click();
  await page.locator('[data-r=snap-default]').click();
  for (const mode of ['endpoint', 'midpoint', 'center', 'intersection', 'perpendicular', 'extension', 'nearest']) {
    await expect(page.locator(`[data-snap-mode="${mode}"]`)).toBeChecked();
  }
  for (const mode of ['quadrant', 'tangent', 'parallel', 'node', 'insertion', 'apparent', 'geometric-center']) {
    await expect(page.locator(`[data-snap-mode="${mode}"]`)).not.toBeChecked();
  }
  await page.locator('[data-r=snap-close]').click();

  expect(errors, errors.join('\n')).toEqual([]);
});
