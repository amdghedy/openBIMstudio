// Status-bar selection count (2D-32) — browser proof.
//
// The count used to render only inside updateStatus()'s full innerHTML
// rebuild, so it went stale after every selection change until some
// other path re-rendered the bar (pointer moves take the coords-only
// early return and never touch it). The fix refreshes only the count
// span ([data-s=selcount]) on every selection change.
//
// Proves in the real app, through the real UI only:
//  1. The count is empty with nothing selected.
//  2. SELECTALL (a command that mutates `sel` directly, no setSel, no
//     showProps) updates the count to "2 selected" with no pointer
//     move afterwards — on the unfixed tree it stays empty.
//  3. CLRSEL clears the count back to empty.
//
// Run against this branch's own build on its own port (never :3000):
//   npx vite build
//   python3 -m http.server 3123 --directory dist
//   npx playwright test --config=playwright.2d32selcount.config.ts --project=chromium
import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 200, 21, 0,
  0, 'LINE', 8, '0', 10, 100, 20, -100, 11, 100, 21, 100,
  0, 'ENDSEC', 0, 'EOF',
);

test('status bar selection count refreshes on selection change (2D-32)', async ({ page }: { page: Page }) => {
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
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const text = await hist();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    const out: Record<string, number> = {};
    for (const m of last.matchAll(/([A-Z0-9]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
  };
  const selCount = page.locator('[data-s=selcount]').first();

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'ref.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(async () => { const c = await census(); return c.LINE === 2; }, { timeout: 15000 }).toBe(true);

  // 1. Nothing selected: the count span is present and empty. (An empty
  // inline span has zero size, so Playwright reports it hidden — assert
  // presence + text, not visibility.)
  await expect(selCount).toHaveCount(1, { timeout: 30000 });
  await expect(selCount).toHaveText('');

  // 2. SELECTALL updates the count with no pointer move afterwards.
  await run('SELECTALL');
  await expect.poll(hist, { timeout: 10000 }).toContain('SELECTALL: 2 object(s).');
  await expect(selCount).toHaveText('2 selected', { timeout: 10000 });

  // 3. CLRSEL clears the count back to empty.
  await run('CLRSEL');
  await expect.poll(hist, { timeout: 10000 }).toContain('CLRSEL: selection cleared.');
  await expect(selCount).toHaveText('', { timeout: 10000 });

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
