import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * 2D-24 — viewer-math INSERT bbox / pick / snap see dynamic-block geometry.
 *
 * The canvas already draws a dynamic block through resolvedDynOf (its
 * parameters evaluated), but bbox, pick distance and snap points used
 * plain resolvedOf — the definition as stored. For a parameter that
 * moves geometry a long way, the bbox was too small, snap points sat
 * where the geometry used to be, and picks near the moved geometry
 * missed. viewer-math now resolves INSERTs through an installed
 * resolver, and the viewer installs resolvedDynOf there.
 *
 * Fixture (the A9 dynblock one): block DYNDOOR (base 0,0) with LINE
 * (0,0)-(100,0), LINE (0,0)-(0,50) and a closed LWPOLYLINE, placed
 * twice (at 0,0 and at 200,0); a linear parameter Width, base 100.
 *
 * Proved in the real app:
 *  1. With Width set to 150 on the first instance (panel input), the
 *     moved LINE ends at (150,0) — drawn already, as before.
 *  2. Snap: with OSNAP on, hovering near (149,1) snaps the coords
 *     readout to (150,0) — the moved endpoint. On the stale resolver
 *     the nearest endpoint is (100,0), 49 units away, so nothing snaps
 *     and the readout stays near (149,1).
 *  3. Pick: after deselecting, clicking exactly on the moved segment at
 *     (148,0) — 48 units past the base LINE's end — selects the
 *     instance (the dynamic panel shows Width 150). On the stale
 *     resolver the click misses: the indexed bbox and the pick distance
 *     both come from the base geometry.
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

test('2D-24 dynamic block: snap and pick follow the parameter-moved geometry', async ({ page }) => {
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
  const widthInput = () => page.locator('[data-dyn-param="width"]');
  const widthValue = async () => parseFloat(await widthInput().inputValue());

  // OSNAP off for calibration (A16 lesson); POLAR/OTRACK off for free-point picks.
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);

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

  // 2. Author the linear parameter Width (base 100), then set it to 150
  //    on the first instance via the Properties panel.
  await run('DYNPARAM DYNDOOR LINEAR Width 0 0 0 100 0 1');
  await expect.poll(async () => /DYNPARAM: linear "Width" on "DYNDOOR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await clickWorld(50, 0);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(100, 0);
  await widthInput().fill('150');
  await page.keyboard.press('Tab');
  await expect.poll(async () => /Dynamic block "DYNDOOR": Width = 150/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(150, 0);

  // 3. Snap: with OSNAP on, hovering near (149,1) snaps to the moved
  //    endpoint (150,0). The stale resolver only knows (100,0) — 49 units
  //    away — so the readout would stay near (149,1).
  await setToggle('[data-s=snap]', true);
  {
    const s = screenOf(149, 1);
    await page.mouse.move(s.x, s.y);
    await page.waitForTimeout(300);
    const snapped = await readCoords(page);
    expect(snapped.x, `expected the snap to land on x=150, got ${snapped.x}`).toBeCloseTo(150, 0);
    expect(snapped.y, `expected the snap to land on y=0, got ${snapped.y}`).toBeCloseTo(0, 0);
  }
  await setToggle('[data-s=snap]', false);

  // 4. Pick: deselect, then click exactly on the moved segment at (148,0)
  //    — 48 units past the base LINE's end. The instance must select.
  await page.keyboard.press('Escape');
  await expect(widthInput()).toBeHidden({ timeout: 10000 });
  await clickWorld(148, 0);
  await expect(widthInput()).toBeVisible({ timeout: 10000 });
  await expect.poll(widthValue, { timeout: 10000 }).toBeCloseTo(150, 0);

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
