import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Layer manager completion (AutoCAD parity A16).
 *
 * Reference drawing: four horizontal LINEs on four layers with distinct
 * ACI colours, imported from a DXF that carries a real LAYER table:
 *   "0" (7) · Walls (1 red) · Doors (3 green) · Hidden (2 yellow)
 *
 * Proved in the real app:
 *  1. Rename in the manager: double-click the Walls name, rename to
 *     Walls-New — the row is renamed and the entities move with it
 *     (CENSUS still LINE=4).
 *  2. Make-current: click the Status cell (Doors) and the sidebar name
 *     (Walls-New) — the ✔ follows the current layer.
 *  3. Plot toggle is honoured at plot time: with Doors set not to plot,
 *     the Plot PNG has zero green-core pixels and plenty of red-core
 *     pixels; toggling it back on brings the green pixels back. (The
 *     old code had no click handler on the Plot cell at all, and the
 *     plot path rendered every layer regardless.)
 *  4. Transparency edit: the Hidden cell takes 50%.
 *  5. Delete in the manager: Hidden (with an object) asks first, then
 *     deletes layer + object (CENSUS LINE=3). Deleting layer "0" and
 *     the current layer is refused.
 *  6. Properties palette: the single-selection Layer row is a control —
 *     moving the Doors line to Walls-New shows LAYERSTATS Walls-New=2,
 *     and UNDO restores Walls-New=1.
 *  7. Layer states capture the full property set and persist: save a
 *     state, turn Doors off, restore the state (Doors back on), reload
 *     the page, re-import the same file — LAYERSTATE still lists it.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3117 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3117 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const layersDxf = D(
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'LAYER', 70, 4,
  0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'Continuous',
  0, 'LAYER', 2, 'Walls', 70, 0, 62, 1, 6, 'Continuous',
  0, 'LAYER', 2, 'Doors', 70, 0, 62, 3, 6, 'Continuous',
  0, 'LAYER', 2, 'Hidden', 70, 0, 62, 2, 6, 'Continuous',
  0, 'ENDTAB',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LINE', 8, 'Walls', 10, 0, 20, 10, 11, 100, 21, 10,
  0, 'LINE', 8, 'Doors', 10, 0, 20, 20, 11, 100, 21, 20,
  0, 'LINE', 8, 'Hidden', 10, 0, 20, 30, 11, 100, 21, 30,
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

/** Count pure-colour core pixels (antialiased edges blend toward white, so they never match). */
async function countPlotPixels(page: Page, src: string): Promise<{ green: number; red: number }> {
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('plot img failed to load')); img.src = dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!;
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let green = 0, red = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (g > 150 && r < 100 && b < 100) green++;
      if (r > 150 && g < 100 && b < 100) red++;
    }
    return { green, red };
  }, src);
}

test('2D editor: layer manager — rename, delete, plot, transparency, make-current, properties layer, states', async ({ page }) => {
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
  const census = async () => {
    await run('CENSUS');
    const text = await hist();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    return Object.fromEntries([...last.matchAll(/([A-Z]+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'layers.dxf', mimeType: 'text/plain', buffer: Buffer.from(layersDxf) });
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 15000 }).toBe(4);

  const openManager = async () => {
    await run('LA');
    await expect(page.locator('tr[data-row-l="Walls"], tr[data-row-l="Walls-New"]').first()).toBeVisible({ timeout: 10000 });
  };
  const row = (name: string) => page.locator(`tr[data-row-l="${name}"]`);

  // 1. Rename Walls -> Walls-New in the manager (double-click the name).
  await openManager();
  await expect(row('Walls')).toBeVisible();
  await row('Walls').locator('[data-act=rename]').dblclick();
  const renameInput = page.locator('.obs-form-modal input[type=text]').first();
  await expect(renameInput).toBeVisible({ timeout: 10000 });
  await renameInput.fill('Walls-New');
  await renameInput.press('Enter');
  await expect(row('Walls-New')).toBeVisible({ timeout: 10000 });
  await expect(row('Walls')).toHaveCount(0);
  expect((await census()).LINE).toBe(4);

  // 2. Make-current: Status cell click (Doors), then sidebar name click (Walls-New).
  await row('Doors').locator('[data-act=make-current]').click();
  await expect(row('Doors').locator('[data-act=make-current]')).toContainText('✔');
  await page.keyboard.press('Escape');
  await page.locator('[data-zl="Walls-New"]').click();
  await openManager();
  await expect(row('Walls-New').locator('[data-act=make-current]')).toContainText('✔');
  await expect(row('Doors').locator('[data-act=make-current]')).not.toContainText('✔');

  // 3. Plot toggle is honoured at plot time (pixel proof on the Plot PNG).
  const plotOnce = async (): Promise<{ green: number; red: number }> => {
    await run('PLOT');
    await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
    await page.locator('[data-p=area]').selectOption('extents');
    await page.locator('[data-p=mono]').selectOption('0');
    const popupPromise = page.waitForEvent('popup');
    await page.locator('[data-p=go]').click();
    const popup = await popupPromise;
    await popup.locator('img').waitFor({ timeout: 30000 });
    const src = (await popup.locator('img').getAttribute('src'))!;
    expect(src.startsWith('data:image/png'), 'plot popup has no PNG').toBe(true);
    const counts = await countPlotPixels(page, src);
    await popup.close();
    return counts;
  };
  await row('Doors').locator('[data-act=toggle-plot]').click();
  await expect(row('Doors').locator('[data-act=toggle-plot]')).toContainText('🚫');
  await page.keyboard.press('Escape');
  let px = await plotOnce();
  expect(px.green, `Doors set not to plot, but the Plot PNG has ${px.green} green-core pixels`).toBe(0);
  expect(px.red, `Walls-New should still plot (red-core pixels), got ${px.red}`).toBeGreaterThan(100);
  await openManager();
  await row('Doors').locator('[data-act=toggle-plot]').click();
  await expect(row('Doors').locator('[data-act=toggle-plot]')).toContainText('🖨️');
  await page.keyboard.press('Escape');
  px = await plotOnce();
  expect(px.green, `Doors plots again, but the Plot PNG has only ${px.green} green-core pixels`).toBeGreaterThan(100);
  expect(px.red, `Walls-New should still plot, got ${px.red}`).toBeGreaterThan(100);

  // 4. Transparency edit in the manager.
  await openManager();
  await row('Hidden').locator('[data-act=edit-transparency]').click();
  const transpInput = page.locator('.obs-form-modal input[type=number]').first();
  await expect(transpInput).toBeVisible({ timeout: 10000 });
  await transpInput.fill('50');
  await transpInput.press('Enter');
  await expect(row('Hidden').locator('[data-act=edit-transparency]')).toContainText('50%', { timeout: 10000 });

  // 5. Delete Hidden (has an object: asks first), then the guards.
  await row('Hidden').locator('[data-act=delete]').click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(row('Hidden')).toHaveCount(0, { timeout: 10000 });
  expect((await census()).LINE).toBe(3);
  await row('0').locator('[data-act=delete]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('cannot delete');
  await expect(row('0')).toHaveCount(1);
  await row('Walls-New').locator('[data-act=delete]').click();
  await expect.poll(hist, { timeout: 10000 }).toContain('is current');
  await expect(row('Walls-New')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // 6. Properties palette: move the Doors line to Walls-New, then undo.
  // The coords readout shows the SNAPPED cursor while OSNAP is on, so
  // calibration must run with OSNAP off — otherwise a calibration point
  // near a line reads the snapped value, the map goes stale by ~15 px,
  // and the click lands outside the 8 px pick aperture (the product is
  // correct; the spec was aiming at a snapped ghost).
  const osnapBtn = page.locator('[data-s=snap]');
  if (await osnapBtn.evaluate((el) => el.classList.contains('active'))) await osnapBtn.click();
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const clickPt = toScreen(50, 20);
  await page.mouse.move(clickPt.x, clickPt.y);
  await page.waitForTimeout(300);
  const at = await readCoords(page);
  expect(Math.abs(at.x - 50) < 0.5 && Math.abs(at.y - 20) < 0.5, `calibration off: cursor reads ${at.x}, ${at.y} at the Doors line`).toBe(true);
  await page.mouse.click(clickPt.x, clickPt.y);
  const layerSelect = page.locator('[data-props-layer]');
  await expect(layerSelect).toBeVisible({ timeout: 10000 });
  await expect(layerSelect).toHaveValue('Doors');
  await layerSelect.selectOption('Walls-New');
  await expect.poll(async () => { await run('LAYERSTATS'); return hist(); }, { timeout: 10000 }).toContain('Walls-New=2');
  await run('UNDO');
  await expect.poll(async () => { await run('LAYERSTATS'); return hist(); }, { timeout: 10000 }).toContain('Walls-New=1');

  // 7. Layer states: full snapshot + restore + persistence across reload.
  await run('LAYERSTATE S A16test');
  await expect.poll(hist, { timeout: 10000 }).toContain('LAYERSTATE: saved "A16test"');
  await openManager();
  await row('Doors').locator('[data-act=toggle-on]').click();
  await expect(row('Doors').locator('[data-act=toggle-on]')).toContainText('💡❌', { timeout: 10000 });
  await page.keyboard.press('Escape');
  await run('LAYERSTATE R A16test');
  await expect.poll(hist, { timeout: 10000 }).toContain('LAYERSTATE: restored "A16test"');
  await openManager();
  await expect(row('Doors').locator('[data-act=toggle-on]')).toContainText('💡');
  await expect(row('Doors').locator('[data-act=toggle-on]')).not.toContainText('💡❌');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'layers.dxf', mimeType: 'text/plain', buffer: Buffer.from(layersDxf) });
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 15000 }).toBe(4);
  await run('LAYERSTATE');
  await expect.poll(hist, { timeout: 10000 }).toContain('A16test');

  expect(errors, 'page errors: ' + errors.join(' | ')).toEqual([]);
});
