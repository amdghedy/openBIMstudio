import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Regression for user console output: "[cad] ribbon control missing: [data-r=importfile] / [data-a=bg] / [data-a=du] / [data-a=polar-angle]".
test('2D drawing editor: every ribbon control the wiring code looks up exists in the DOM', async ({ page }) => {
  test.setTimeout(120000);
  const warnings: string[] = [];
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const present = await page.evaluate(() => {
    const q = (s: string) => !!document.querySelector(s);
    return {
      importfile: q('[data-r=importfile]'), svgfile: q('[data-r=svgfile]'),
      bg: q('select[data-a=bg]'), du: q('select[data-a=du]'), polar: q('select[data-a=polar-angle]'),
      groups: document.querySelectorAll('.cadrg').length,
      tabs: [...new Set([...document.querySelectorAll('.cadrg')].map((g) => (g as HTMLElement).dataset.cadtab))],
    };
  });
  console.log('RIBBON-PROBE', JSON.stringify(present), JSON.stringify(warnings.filter((w) => /ribbon control missing|\[cad\]/.test(w))));
  const missing = warnings.filter((w) => /ribbon control missing/.test(w));
  expect(missing, 'ribbon controls missing: ' + missing.join(' | ')).toEqual([]);
  expect(present.importfile && present.bg && present.du && present.polar).toBe(true);
});
