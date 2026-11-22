import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Phase 2: XATTACH keeps the reference OUT of the host drawing database (CENSUS must not change),
// XSTATUS reports it, XDETACHN removes it again.
const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const host = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 10, 0, 'ENDSEC', 0, 'EOF');
const ref = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 5, 21, 0, 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 5, 0, 'ENDSEC', 0, 'EOF');

test('2D editor: native XREF stays separate from the host drawing', async ({ page }) => {
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
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const last = (await hist()).split('\n').filter((l) => /CENSUS: /.test(l)).pop() ?? '';
    return Object.fromEntries([...last.matchAll(/([A-Z]+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  };
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'host.dxf', mimeType: 'text/plain', buffer: Buffer.from(host) });
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 15000 }).toBe(1);

  const chooser = page.waitForEvent('filechooser');
  await run('XATTACH');
  await (await chooser).setFiles({ name: 'site.dxf', mimeType: 'text/plain', buffer: Buffer.from(ref) });
  await expect.poll(async () => await hist(), { timeout: 15000 }).toContain('XATTACH: "site" loaded');
  expect((await census()).LINE ?? 0).toBe(1); // host database untouched

  await run('XSTATUS');
  await expect.poll(async () => await hist(), { timeout: 5000 }).toMatch(/XSTATUS: site \[attach\] LOADED · 2 entities/);

  await run('XDETACHN site');
  await expect.poll(async () => await hist(), { timeout: 5000 }).toContain('XDETACHN: removed 1 reference(s).');
  await run('XSTATUS');
  await expect.poll(async () => await hist(), { timeout: 5000 }).toContain('no native external references');
  expect(errors, 'page errors: ' + errors.join(' | ')).toEqual([]);
});
