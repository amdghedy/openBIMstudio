import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// #90: every rejected file must leave the open drawing exactly as it was. Exercised on the 2D editor's
// "Import DWG / DXF" boundary (readCadFile -> file-guard / parser), the one boundary reachable without a
// large fixture. The IFC, BCF, PDF, IDS and archive boundaries are covered by static ordering tests only.
const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const validDxf = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 10, 0, 'CIRCLE', 8, '0', 10, 5, 20, 5, 40, 2, 0, 'ENDSEC', 0, 'EOF');
const rejected: Array<[string, string, Buffer]> = [
  ['wrong-signature.dwg', 'application/octet-stream', Buffer.from('this is not a DWG file at all, just text'.repeat(20))],
  ['binary-noise.dxf', 'application/octet-stream', Buffer.from(Array.from({ length: 4096 }, (_v, i) => (i * 131 + 7) & 0xff))],
  ['truncated.dxf', 'text/plain', Buffer.from(D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20))],
  ['no-geometry.dxf', 'text/plain', Buffer.from(D(0, 'SECTION', 2, 'ENTITIES', 0, 'ENDSEC', 0, 'EOF'))],
  ['non-finite.dxf', 'text/plain', Buffer.from(D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 'NaN', 20, 'Infinity', 11, 'NaN', 21, 'NaN', 0, 'ENDSEC', 0, 'EOF'))],
  ['empty.dxf', 'text/plain', Buffer.alloc(0)],
];

test('2D editor: rejected imports leave the drawing unchanged and import keeps working', async ({ page }) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  // Entity count straight from the editor's own CENSUS command (no test-only globals).
  const count = async (): Promise<number> => {
    await page.locator('[data-r=cmd]').first().fill('CENSUS');
    await page.locator('[data-r=cmd]').first().press('Enter');
    const text = await page.locator('[data-r=cmdhist]').first().innerText();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    if (/\(empty\)/.test(last)) return 0;
    return [...last.matchAll(/=(\d+)/g)].reduce((n, m) => n + Number(m[1]), 0);
  };
  await expect.poll(async () => (await page.locator('[data-r=cmd]').count()) > 0, { timeout: 15000 }).toBe(true);
  const input = page.locator('[data-r=importfile]').first();
  const before0 = await count();
  await input.setInputFiles({ name: 'ok.dxf', mimeType: 'text/plain', buffer: Buffer.from(validDxf) });
  await expect.poll(count, { timeout: 15000 }).toBe(before0 + 2);
  const baseline = await count();

  for (const [name, mimeType, buffer] of rejected) {
    await input.setInputFiles({ name, mimeType, buffer });
    await page.waitForTimeout(700); // let the async reader settle (accepted files would add entities within this time)
    expect(await count(), `${name} changed the drawing`).toBe(baseline);
  }

  await input.setInputFiles({ name: 'ok2.dxf', mimeType: 'text/plain', buffer: Buffer.from(validDxf) });
  await expect.poll(count, { timeout: 15000 }).toBe(baseline + 2);
});
