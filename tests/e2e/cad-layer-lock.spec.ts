import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Layer lock enforcement (AutoCAD parity A3).
 *
 * The lock toggle existed in the Layer Manager and LAYLCK/LAYUNLCK pick
 * tools existed, but nothing enforced the lock: locked-layer entities
 * stayed pickable, selectable and editable. AutoCAD behaviour is that
 * locked layers are visible but not selectable or editable, and no grips
 * appear on their entities.
 *
 * Proves in the real app, with one LINE on a locked layer ("Locked") and
 * one LINE on layer "0":
 *  1. Locking the layer (Layer Manager toggle) leaves the drawing intact
 *     — CENSUS still reports both lines (locked layers stay rendered).
 *  2. Clicking the locked line selects nothing (no "selected" in the
 *     status bar, no "object(s) selected" in the command history).
 *  3. A window dragged over both lines selects only the unlocked one
 *     ("Window selected 1 object(s)").
 *  4. ERASE with that selection leaves the locked line in the drawing
 *     (CENSUS LINE=1) — the edit path refuses locked input.
 *  5. LAYUNLCK can still pick the locked line (layer-state tools must
 *     pick locked entities, or nothing could ever unlock them), and after
 *     unlocking the same click selects it again.
 *
 * Grips are covered by the same gate: grips are painted and hit-tested
 * only for the selection, and the selection can never contain a locked
 * entity (node test layer-lock-enforcement.test.cjs pins gripAt and the
 * grip paint loop); with no selection there is nothing to grip.
 *
 * Screen↔world calibration: after ZOOM E the view is an unknown affine
 * map, so the spec reads the status-bar coordinate readout at two mouse
 * positions per axis and solves the map instead of guessing pixels.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3115 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3115 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const twoLines = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, 'Locked', 10, 0, 20, 0, 11, 10, 21, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 10, 11, 10, 21, 10,
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

test('2D editor: locked-layer entities are visible but not selectable or editable', async ({ page }) => {
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
  // Selection count from the command history: setSel logs "N object(s)
  // selected" synchronously. (The status-bar span only refreshes on a full
  // updateStatus, which a bare selection change does not trigger, so it can
  // lag one step behind — do not read the count from it.)
  const selectedLogCount = (h: string) => (h.match(/object\(s\) selected/g) ?? []).length;
  const selectedCount = async () => page.evaluate(() => {
    const bar = document.querySelector('[data-r=status]');
    if (!bar) return -1;
    const m = /(\d+) selected/.exec(bar.textContent ?? '');
    return m ? Number(m[1]) : 0;
  });

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'two.dxf', mimeType: 'text/plain', buffer: Buffer.from(twoLines) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=2/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const lockedMid = toScreen(5, 0);
  const freeMid = toScreen(5, 10);

  // 1. Lock "Locked" in the Layer Manager; the drawing is untouched.
  await run('LA');
  const row = page.locator('tr[data-row-l="Locked"]');
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('[data-act="toggle-lock"]').click();
  await expect(row.locator('[data-act="toggle-lock"]')).toContainText('🔒', { timeout: 10000 });
  await page.locator('[data-r=lyr-close]').click();
  await expect(row).toHaveCount(0, { timeout: 10000 });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=2/.test(await hist()); }, { timeout: 15000 }).toBe(true);

  // 2. Clicking the locked line selects nothing.
  const histBeforeClick = await hist();
  await page.mouse.click(lockedMid.x, lockedMid.y);
  await page.waitForTimeout(500);
  expect(await selectedCount(), 'locked line click selected something').toBe(0);
  expect(await hist(), 'locked line click logged a selection').toBe(histBeforeClick);

  // 3. A window over both lines selects only the unlocked one.
  // The world corners sit outside the fitted view, so clamp the drag into
  // the canvas (inset 5 px): the rect still covers the whole drawing,
  // which ZOOM E fitted with a margin.
  const clampPt = (p: { x: number; y: number }) => ({
    x: Math.min(Math.max(p.x, box.x + 5), box.x + box.width - 5),
    y: Math.min(Math.max(p.y, box.y + 5), box.y + box.height - 5),
  });
  const winA = clampPt(toScreen(-2, 12));
  const winB = clampPt(toScreen(12, -2));
  await page.mouse.move(winA.x, winA.y);
  await page.mouse.down();
  await page.mouse.move(winB.x, winB.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(hist, { timeout: 10000 }).toContain('Window selected 1 object(s) (fully inside)');
  await expect.poll(async () => selectedLogCount(await hist()), { timeout: 10000 }).toBe(1);

  // 4. ERASE with that selection leaves the locked line in the drawing.
  await run('ERASE');
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);

  // 5. LAYUNLCK can still pick the locked line, and afterwards it selects again.
  await run('LAYUNLCK');
  await page.mouse.click(lockedMid.x, lockedMid.y);
  await expect.poll(hist, { timeout: 10000 }).toContain('LAYUNLCK: layer "Locked" is now unlocked.');
  const logsBeforeFinalClick = selectedLogCount(await hist());
  await page.mouse.click(lockedMid.x, lockedMid.y);
  await expect.poll(async () => selectedLogCount(await hist()), { timeout: 10000 }).toBe(logsBeforeFinalClick + 1);
  // Sanity: the surviving line is the formerly locked one, still on its layer.
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);

  expect(errors, errors.join('\n')).toEqual([]);
});
