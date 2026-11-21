import { test, expect, type Page } from '@playwright/test';

/**
 * Revit 2D environment audit gap G11 — Project Browser ordering and grouping.
 *
 * Proves in the real app that the Project Browser renders in Revit's order
 * (Views, Sheets, Schedules/Quantities, Families, Groups, Models & Links,
 * 4D Phases), that the Views node subgroups by kind (Floor Plans /
 * Elevations / Sections / 3D Views — no empty Ceiling Plans group), that
 * Families lists family types (Basic Wall → Generic 200 mm), and that the
 * filter textbox narrows the tree by name as you type.
 *
 * Run against a preview server on a distinct port (the repo config reuses
 * any server already on :3000, so a sibling worktree's build could be
 * tested by mistake — see the port rule in the task brief):
 *   npx vite build
 *   npx vite preview --port 3111 --strictPort --host 127.0.0.1
 *   npx playwright test --config=playwright.g11.config.ts --project=chromium
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function openProjectBrowser(page: Page): Promise<void> {
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(page.locator('.obs-project-browser')).toBeVisible({ timeout: 15000 });
}

/** Labels of the depth-0 (root) rows, in DOM order. */
async function rootLabels(page: Page): Promise<string[]> {
  return page.locator('.obs-project-browser .pb-body .pb-row').evaluateAll((rows) =>
    rows
      .filter((r) => (r as HTMLElement).style.paddingLeft === '8px')
      .map((r) => r.querySelector('.pb-label')?.textContent?.trim() ?? ''));
}

/** Click the chevron of the row whose label is exactly `label`. */
async function toggleRow(page: Page, label: string): Promise<void> {
  const row = page.locator('.obs-project-browser .pb-row', {
    has: page.locator('.pb-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('.pb-chev').click();
}

async function expectLabelVisible(page: Page, label: string): Promise<void> {
  await expect(
    page.locator('.obs-project-browser .pb-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  ).toBeVisible({ timeout: 15000 });
}

async function expectLabelHidden(page: Page, label: string): Promise<void> {
  await expect(
    page.locator('.obs-project-browser .pb-label', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  ).toHaveCount(0, { timeout: 15000 });
}

test('G11: Project Browser renders in Revit root order with Views subgrouped by kind', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  // The filter textbox itself proves this is the G11 build (base has none).
  await expect(page.locator('.pb-filter-input')).toBeVisible({ timeout: 15000 });

  expect(await rootLabels(page)).toEqual([
    'Views (all)',
    'Sheets (all)',
    'Schedules/Quantities (all)',
    'Families',
    'Groups',
    'Models & Links',
    '4D Phases',
  ]);

  // Views subgroups expand: Floor Plans / Elevations / Sections / 3D Views.
  // (Views itself starts expanded; Floor Plans and 3D Views start expanded.)
  for (const group of ['Floor Plans', 'Elevations', 'Sections', '3D Views']) {
    await expectLabelVisible(page, group);
  }
  // No empty group for a view kind with no stored views.
  await expectLabelHidden(page, 'Ceiling Plans');

  // Stored views sit inside their kind subgroup.
  await expectLabelVisible(page, 'Level 0 Plan');
  await expectLabelVisible(page, 'Level 1 Plan');
  await toggleRow(page, 'Elevations');
  await expectLabelVisible(page, 'North Elevation');
  await toggleRow(page, 'Sections');
  await expectLabelVisible(page, 'Section A-A');

  // Families lists family types, not just materials.
  await toggleRow(page, 'Families');
  await expectLabelVisible(page, 'Basic Wall');
  await toggleRow(page, 'Basic Wall');
  await expectLabelVisible(page, 'Generic 200 mm');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G11: filter textbox narrows the tree by name as you type', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  // Expand the branches the post-filter assertions need (they stay expanded
  // when the filter is cleared).
  await toggleRow(page, 'Elevations');
  await toggleRow(page, 'Families');

  await page.locator('.pb-filter-input').fill('Level 1');
  await expectLabelVisible(page, 'Level 1 Plan');
  await expectLabelHidden(page, 'Level 0 Plan');
  await expectLabelHidden(page, 'North Elevation');
  await expectLabelHidden(page, 'Basic Wall');

  // Clearing the filter restores the full tree.
  await page.locator('.pb-filter-input').fill('');
  await expectLabelVisible(page, 'North Elevation');
  await expectLabelVisible(page, 'Basic Wall');
  await expectLabelVisible(page, 'Level 0 Plan');

  // Toolbar and header still work alongside the filter.
  await expect(page.locator('.pb-toolbar [data-act="new-view"]')).toBeVisible();
  await expect(page.locator('.pb-toolbar [data-act="new-sheet"]')).toBeVisible();
  await expect(page.locator('.pb-toolbar [data-act="expand"]')).toBeVisible();
  await expect(page.locator('.pb-header [data-act="refresh"]')).toBeVisible();
  await expect(page.locator('.pb-header [data-act="close"]')).toBeVisible();

  expect(errors, errors.join('\n')).toEqual([]);
});
