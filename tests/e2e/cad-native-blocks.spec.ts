import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Phase 1: BLOCK creates a native definition and replaces the selection with ONE reference; EXPLODE gives
// the geometry back; UNDO / REDO move the whole transaction (entities + block table) together.
const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const dxf = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 10, 0, 'CIRCLE', 8, '0', 10, 5, 20, 5, 40, 2, 0, 'ENDSEC', 0, 'EOF');

test('2D editor: native BLOCK / EXPLODE / UNDO / REDO', async ({ page }) => {
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
  await expect.poll(async () => (await page.locator('[data-r=cmd]').count()) > 0, { timeout: 15000 }).toBe(true);
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const text = await page.locator('[data-r=cmdhist]').first().innerText();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    return Object.fromEntries([...last.matchAll(/([A-Z]+)=(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  };
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'two.dxf', mimeType: 'text/plain', buffer: Buffer.from(dxf) });
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 15000 }).toBe(1);

  await run('SELECTALL');
  await run('BLOCK');
  const name = page.locator('.obs-form-modal input[type=text]').first();
  await expect(name).toBeVisible({ timeout: 10000 });
  await name.fill('DOOR');
  await name.press('Enter');
  await expect.poll(async () => (await census()).INSERT ?? 0, { timeout: 10000 }).toBe(1);
  expect((await census()).LINE ?? 0).toBe(0);

  await run('EXPLODE');
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 10000 }).toBe(1);
  expect((await census()).CIRCLE ?? 0).toBe(1);
  expect((await census()).INSERT ?? 0).toBe(0);

  await run('UNDO');
  await expect.poll(async () => (await census()).INSERT ?? 0, { timeout: 10000 }).toBe(1);
  await run('UNDO');
  await expect.poll(async () => (await census()).LINE ?? 0, { timeout: 10000 }).toBe(1);
  expect((await census()).INSERT ?? 0).toBe(0);
  await run('REDO');
  await expect.poll(async () => (await census()).INSERT ?? 0, { timeout: 10000 }).toBe(1);
  expect(errors, 'page errors: ' + errors.join(' | ')).toEqual([]);
});
