import { test, expect, type Page } from '@playwright/test';

/** Leave the welcome screen the way a user does (the 3D BIM Platform card); it covers the ribbon on first load. */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

// Browser smoke tests. They use the visible UI only (no test hooks), so they
// double as a check that the controls a user sees are really there.
// Run: npm i -D @playwright/test && npx playwright install chromium && npx playwright test tests/e2e/smoke.spec.ts

test('the app boots without uncaught errors and draws a 3D canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});

test('2D plan: command line starts a tool and Esc cancels everything', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  const line = page.locator('#obs-plan-cmdline input');
  await expect(line).toBeVisible();

  // A bare letter on the plan opens the command line and keeps typing in it.
  await page.mouse.move(600, 400);
  await page.keyboard.type('wa');
  await expect(line).toHaveValue('wa');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Place wall', { exact: false }).first()).toBeVisible();

  // Esc ends the tool and leaves the plan open.
  await page.keyboard.press('Escape');
  await expect(page.getByText('Select', { exact: false }).first()).toBeVisible();
  await expect(line).toBeVisible();
});

test('2D plan: unknown command is reported, not ignored', async ({ page }) => {
  await page.goto('/');
  await enterPlatform(page);
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  const line = page.locator('#obs-plan-cmdline input');
  await line.focus();
  await line.fill('nonsense');
  await line.press('Enter');
  await expect(page.getByText('Unknown command', { exact: false })).toBeVisible();
});
