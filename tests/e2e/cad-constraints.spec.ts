import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Phase 4: a constraint applied from the Parametric tab is RECORDED (not just applied once) and the solver
// commands report on it. Also pins that the new buttons are reachable from the ribbon.
const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const one = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 4, 0, 'ENDSEC', 0, 'EOF');

test('2D editor: constraints are recorded and solvable from the ribbon', async ({ page }) => {
  test.setTimeout(150000);
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
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(one) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');

  // Nothing recorded yet: the ribbon buttons answer honestly instead of doing nothing.
  await page.locator('[data-ribtab=parametric]').first().click();
  await expect(page.locator('[data-a=gc-solve]').first()).toBeVisible();
  await page.locator('[data-a=gc-list]').first().click();
  await expect.poll(hist).toContain('GCLIST: no recorded constraints');

  // Keyboard-driven path: select the line, record HORIZONTAL + LEN 10 (a 10 x 4 diagonal must become 10 x 0).
  await run('SELECTALL');
  await run('GCADD H');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: recorded 1 horizontal');
  await run('GCADD LEN 10');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: recorded 1 length');
  // Horizontal AND vertical AND length 10 on one line cannot hold: refused and reported, not silently applied.
  await run('GCADD V');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: not recorded.');

  await page.locator('[data-a=gc-list]').first().click();
  await expect.poll(hist).toMatch(/#1 horizontal — ok/);
  await expect.poll(hist).toMatch(/#2 length = 10(\.0+)?( \w+)? — ok/);
  await page.locator('[data-a=gc-solve]').first().click();
  await expect.poll(hist).toContain('GCSOLVE:');
  await run('GCDEL 9');
  await expect.poll(hist).toContain('GCDEL: give a constraint number between 1 and 2');
  await run('GCDEL 2');
  await expect.poll(hist).toContain('GCDEL: removed #2 length; 1 constraint(s) remain');
  expect(errors, errors.join('\n')).toEqual([]);
});

// Regression: a blank drawing starts with a placeholder frame (0,0)-(100,100). ZOOM EXTENTS after adding a small
// line used to fit that frame instead of the line, so the line sat tiny off-centre and every pick said "0 found".
test('2D editor: ZOOM EXTENTS fits the first geometry of a blank drawing, so a centre click picks it', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(one) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  await run('HORIZONTAL');
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.click(cx, cy);
  await expect.poll(hist, { timeout: 10000 }).toContain('recorded as constraint #1');
});

// Phase 4c: recorded constraints are written into the saved DXF and restored (verified) when it is reopened.
test('2D editor: constraints survive save and reopen', async ({ page }) => {
  test.setTimeout(150000);
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
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(one) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('SELECTALL');
  await run('GCADD H');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: recorded 1 horizontal');

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), run('QSAVE')]);
  const { readFileSync } = await import('node:fs');
  const saved = readFileSync(await download.path());
  expect(saved.toString('utf8')).toContain('OBS_CONSTRAINT');
  await expect.poll(hist, { timeout: 10000 }).toContain('Saved 1 constraint(s) with the drawing.');

  // Reopen the saved bytes through the shell's open-file picker (a real open, not a merge): a new drawing tab
  // loads them and the relation comes back, attached to the same line.
  await page.locator('input[type=file][accept*=".bak"]').first().setInputFiles({ name: 'saved.dxf', mimeType: 'text/plain', buffer: saved });
  const vcmd = page.locator('[data-r=cmd]:visible').first();
  const vhist = async () => page.locator('[data-r=cmdhist]:visible').first().innerText();
  await expect.poll(vhist, { timeout: 20000 }).toContain('Restored 1 constraint(s) saved with this drawing');
  await vcmd.fill('GCLIST'); await vcmd.press('Enter');
  await expect.poll(vhist, { timeout: 10000 }).toMatch(/#1 horizontal — ok/);
  expect(errors, errors.join('\n')).toEqual([]);
});
