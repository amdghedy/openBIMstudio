import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * 2D-27 — sheets-panel click-through: clicking a CAD layout row in the
 * Sheets panel opens the Drawing Editor on that layout.
 *
 * Reference model, imported from DXF: an L of two LINEs (0,0)-(100,0)
 * and (0,0)-(0,50). Two paper layouts are created in-app (Layout1,
 * Layout2) via the "+" tab button, exactly as the A20 batch spec does.
 *
 * Proved in the real app:
 *  1. After the viewer is closed, the Sheets panel lists both CAD
 *     layouts as rows (the A20 read-only bridge).
 *  2. Clicking the Layout2 row re-opens the Drawing Editor with the
 *     Layout2 tab active (the tab button carries the "on" class) and
 *     the Model tab inactive — the viewer tabs survive the viewer
 *     closing, so no re-open or re-import is needed.
 *  3. Clicking the Layout1 row then switches back to Layout1.
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
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 0, 21, 50, 31, 0,
  0, 'ENDSEC', 0, 'EOF',
);

test('2D-27 sheets-panel click-through: a CAD layout row opens the viewer on that layout', async ({ page }) => {
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
  const tabs = page.locator('[data-r=tabs]').first();

  // 1. Import the reference model and create two paper layouts.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(lastCensus, { timeout: 15000 }).toMatch(/LINE=2/);
  const newLayoutBtn = tabs.locator('button[data-new-layout]');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="0"]')).toHaveText('Layout1');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="1"]')).toHaveText('Layout2');

  // 2. Close the viewer (tabs survive — the shell is only hidden).
  const dirtyVisible = await page.locator('.cadtab__dirty').first().isVisible().catch(() => false);
  await page.locator('.cadtab__x').first().click();
  if (dirtyVisible) {
    await page.getByRole('button', { name: 'Confirm' }).click({ timeout: 10000 });
  }
  await expect(page.locator('#obs-cad-shell')).toBeHidden({ timeout: 15000 });

  // 3. Sheets panel: both CAD layouts appear as rows.
  await page.locator('button.obs-ribbon__tab[data-tab="file"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Sheets', exact: true }).first().click();
  await page.waitForTimeout(700);
  const cadRows = page.locator('.obs-sheets__row--cad');
  await expect(cadRows).toHaveCount(2, { timeout: 15000 });
  await expect(cadRows.nth(0)).toContainText('Layout1');
  await expect(cadRows.nth(1)).toContainText('Layout2');

  // 4. Click the Layout2 row: the viewer re-opens on Layout2.
  await cadRows.nth(1).click();
  await expect(page.locator('#obs-cad-shell')).toBeVisible({ timeout: 15000 });
  await expect(tabs.locator('button[data-li="1"]')).toHaveClass(/on/, { timeout: 15000 });
  await expect(tabs.locator('button[data-li="-1"]')).not.toHaveClass(/on/);

  // 5. Back to the panel, click Layout1: the viewer switches to it
  //    (re-mounting the registry doc a second time).
  const dirty2 = await page.locator('.cadtab__dirty').first().isVisible().catch(() => false);
  await page.locator('.cadtab__x').first().click();
  if (dirty2) {
    await page.getByRole('button', { name: 'Confirm' }).click({ timeout: 10000 });
  }
  await expect(page.locator('#obs-cad-shell')).toBeHidden({ timeout: 15000 });
  await page.locator('button.obs-ribbon__tab[data-tab="file"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Sheets', exact: true }).first().click();
  await page.waitForTimeout(700);
  await expect(page.locator('.obs-sheets__row--cad')).toHaveCount(2, { timeout: 15000 });
  await page.locator('.obs-sheets__row--cad').nth(0).click();
  await expect(page.locator('#obs-cad-shell')).toBeVisible({ timeout: 15000 });
  await expect(tabs.locator('button[data-li="0"]')).toHaveClass(/on/, { timeout: 15000 });
  await expect(tabs.locator('button[data-li="1"]')).not.toHaveClass(/on/);

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
