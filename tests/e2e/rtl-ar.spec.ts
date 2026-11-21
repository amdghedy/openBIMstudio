// Live-browser RTL proof for #141 (hardening item 16). Boots the real app
// in Arabic at 1280px and checks the named views from #141 — modeling
// viewport + ribbon, properties, schedules (table), project browser —
// asserting dir=rtl, no horizontal overflow, and the intentional icon
// mirroring (undo/redo swap, chevron mirror) by computed style, not by
// reading the stylesheet. Screenshots land in test-results/rtl-ar-*.
// Run: npx playwright test tests/e2e/rtl-ar.spec.ts --project=chromium
import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

test.use({ viewport: { width: 1280, height: 800 } });

const FLIP = 'matrix(-1, 0, 0, 1, 0, 0)';

async function bootAr(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as any).__rtlErrors = errors;
  await page.addInitScript(() => { try { localStorage.setItem('obs.locale', 'ar'); } catch { /* */ } });
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
}

function assertNoErrors(page: Page): void {
  const errors = (page as any).__rtlErrors as string[];
  expect(errors, errors.join('\n')).toEqual([]);
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Computed transform of the first element matching `sel`, or null when absent. */
async function computedTransform(page: Page, sel: string): Promise<string | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement | null;
    return el ? getComputedStyle(el).transform : null;
  }, sel);
}

test('ar boots RTL: dir, Arabic font stack, no overflow, ribbon + viewport', async ({ page }) => {
  await bootAr(page);
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('ar');
  expect(await page.evaluate(() => document.body.getAttribute('data-dir'))).toBe('rtl');
  const fontUi = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-ui'));
  expect(fontUi, '--font-ui should use the Arabic stack').toContain('Noto Naskh Arabic');
  expect(await overflowPx(page), 'horizontal overflow in px').toBeLessThanOrEqual(1);

  // Ribbon spans the viewport; the 3D canvas is drawn.
  const ribbon = await page.locator('.obs-ribbon').boundingBox();
  expect(ribbon, 'ribbon present').not.toBeNull();
  expect(Math.round(ribbon!.width), `ribbon width ${ribbon!.width}`).toBeGreaterThanOrEqual(1270);
  expect(await page.locator('canvas').first().isVisible()).toBe(true);
  await page.screenshot({ path: 'test-results/rtl-ar-1-viewport.png' });
  assertNoErrors(page);
});

test('CAD editor undo/redo pair swaps under RTL (LTR control, then live switch to ar)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  // Default-locale boot (item 16): dir/lang/data-dir are set even in en —
  // setLocale's early return used to skip them, leaving the attributes unset.
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('ltr');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  expect(await page.evaluate(() => document.body.getAttribute('data-dir'))).toBe('ltr');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });

  // The CAD editor (Drawing Editor) is opened through the command palette;
  // palette matching uses the registered English labels, so it works in any locale.
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('#obs-cad-shell')).toBeVisible({ timeout: 30000 });
  const undoSel = '.cadrb[data-a="undo"] .cadrb__icon';
  const redoSel = '.cadrb[data-a="redo"] .cadrb__icon';
  await expect(page.locator('.cadrb[data-a="undo"]')).toBeVisible({ timeout: 10000 });

  // LTR control: the redo icon reuses the undo SVG via .cadrb--flip.
  expect(await computedTransform(page, undoSel), 'LTR undo icon').toBe('none');
  expect(await computedTransform(page, redoSel), 'LTR redo icon').toBe(FLIP);
  expect(await computedTransform(page, '.cad-qat [data-qat="undo"] svg'), 'LTR Quick Access undo').toBe('none');
  expect(await computedTransform(page, '.cad-qat [data-qat="redo"] .qat-flip'), 'LTR Quick Access redo').toBe(FLIP);

  // Live switch to Arabic: the pair must swap, and the layout must not overflow.
  await page.evaluate(() => (window as any).__OBS_CTX__.features.i18n.setLocale('ar'));
  await expect.poll(() => page.evaluate(() => document.documentElement.dir), { timeout: 10000 }).toBe('rtl');
  await page.waitForTimeout(500); // let the DOM re-translation pass settle
  expect(await computedTransform(page, undoSel), 'RTL undo icon').toBe(FLIP);
  expect(await computedTransform(page, redoSel), 'RTL redo icon').toBe('none');
  expect(await computedTransform(page, '.cad-qat [data-qat="undo"] svg'), 'RTL Quick Access undo').toBe(FLIP);
  expect(await computedTransform(page, '.cad-qat [data-qat="redo"] .qat-flip'), 'RTL Quick Access redo').toBe('none');
  expect(await overflowPx(page), 'horizontal overflow in px after the switch').toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/rtl-ar-2-cad-editor.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('ar: properties palette + project browser mirror, chevron flips', async ({ page }) => {
  await bootAr(page);
  await page.evaluate(() => {
    (window as any).__OBS_CTX__.features.propertyPalette.open();
    (window as any).__OBS_CTX__.features.projectBrowser.open();
  });
  const palette = page.locator('#obs-property-palette');
  await expect(palette).toBeVisible({ timeout: 10000 });
  const browser = page.locator('.obs-project-browser');
  await expect(browser).toBeVisible({ timeout: 10000 });

  // Both panels sit inside the 1280px viewport (no panel pushed off-screen).
  for (const [name, loc] of [['properties', palette], ['project browser', browser]] as const) {
    const box = (await loc.boundingBox())!;
    expect(box.x, `${name} x`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `${name} right edge`).toBeLessThanOrEqual(1281);
  }
  expect(await overflowPx(page), 'horizontal overflow in px with both panels open').toBeLessThanOrEqual(1);

  // The tree has expandable groups even with an empty model; their
  // chevrons mirror under RTL (▶ becomes ◀ via scaleX(-1)).
  const chev = await page.locator('.obs-project-browser .pb-chev').first();
  await expect(chev).toBeVisible();
  expect(await computedTransform(page, '.obs-project-browser .pb-chev'), 'project-browser chevron').toBe(FLIP);
  await page.waitForTimeout(500); // let the panels settle before the evidence shot
  await page.screenshot({ path: 'test-results/rtl-ar-3-panels.png' });
  assertNoErrors(page);
});

test('ar: schedules table renders with no overflow', async ({ page }) => {
  await bootAr(page);
  await page.evaluate(() => (window as any).__OBS_CTX__.features.schedules.toggle());
  const overlay = page.locator('.obs-schedules-overlay');
  await expect(overlay).toBeVisible({ timeout: 10000 });
  await expect(overlay.locator('table').first()).toBeVisible({ timeout: 10000 });
  const box = (await overlay.boundingBox())!;
  expect(box.x, 'schedules x').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'schedules right edge').toBeLessThanOrEqual(1281);
  expect(await overflowPx(page), 'horizontal overflow in px with schedules open').toBeLessThanOrEqual(1);
  await page.waitForTimeout(500); // let the panel settle before the evidence shot
  await page.screenshot({ path: 'test-results/rtl-ar-4-schedules.png' });
  assertNoErrors(page);
});
