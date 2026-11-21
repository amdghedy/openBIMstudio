import { test, expect, type Page } from '@playwright/test';

/**
 * G1a — ribbon tab reorder (Revit order).
 *
 * Proves in the real app that the permanent ribbon tabs render in Revit
 * order, that Mechanical/Electrical are gone (merged into Systems), that
 * Collaborate exists, and that the merged Systems tab and the new
 * Collaborate tab actually show their regrouped tools.
 *
 * Run: npx playwright test tests/e2e/ribbon-tab-order.spec.ts --project=chromium
 * (needs a build first: the config's webServer runs `npm run preview`.)
 */

async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

const EXPECTED_TABS = ['File', 'Architecture', 'Structure', 'Systems', 'Insert',
  'Annotate', 'Analyze', 'Massing & Site', 'Collaborate', 'View', 'Manage',
  'Coordinate', 'Clash Detective', 'Edit', 'X Dim'];

test('ribbon tabs render in Revit order (Systems merged, Collaborate present)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);

  const tabs = page.locator('button.obs-ribbon__tab');
  await expect(tabs).toHaveCount(EXPECTED_TABS.length);
  expect(await tabs.allTextContents()).toEqual(EXPECTED_TABS);

  // The merged-away tabs are gone entirely.
  await expect(page.locator('button.obs-ribbon__tab', { hasText: 'Mechanical' })).toHaveCount(0);
  await expect(page.locator('button.obs-ribbon__tab', { hasText: 'Electrical' })).toHaveCount(0);

  // Systems tab: the merged discipline groups render with their tools.
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'Systems', exact: true }).click();
  const strip = page.locator('.obs-ribbon__strip');
  await expect(strip.getByRole('button', { name: 'Duct', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Cable tray', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Pipe', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Sprinkler', exact: true })).toBeVisible();
  expect(await strip.locator('.obs-ribbon-group__label').allTextContents())
    .toEqual(['HVAC', 'Auto-Route', 'Plumbing', 'Fire', 'Electrical', 'Systems',
      'Display', 'Engineering', 'Properties']);

  // Collaborate tab: Live Sync + Worksets moved here from Manage.
  await ribbon.getByRole('button', { name: 'Collaborate', exact: true }).click();
  await expect(strip.getByRole('button', { name: 'Live Sync', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Init', exact: true })).toBeVisible();
  expect(await strip.locator('.obs-ribbon-group__label').allTextContents())
    .toEqual(['Live Sync', 'Worksets']);

  // Edit stays a permanent tab (documented G1a deviation).
  await ribbon.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(strip.getByRole('button', { name: 'Snap settings', exact: true })).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
