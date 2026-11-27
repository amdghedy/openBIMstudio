import { test, expect, type Page } from '@playwright/test';

/**
 * Revit 2D environment audit gap G11 — Project Browser RIGHT-CLICK menu.
 *
 * Proves in the real app that right-clicking a tree node opens a working
 * context menu, and that every listed action executes for real: rename
 * renames, duplicate duplicates, delete deletes (through the app's confirm
 * dialog), and creation actions on root nodes create.
 *
 * Run against a preview server on a distinct port (the repo config reuses
 * any server already on :3000, so a sibling worktree's build could be
 * tested by mistake — see the port rule in the task brief):
 *   npx vite build
 *   npx vite preview --port 3121 --strictPort --host 127.0.0.1
 *   npx playwright test --config=playwright.g11menu.config.ts --project=chromium
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

function exactLabel(label: string): RegExp {
  return new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** The tree row whose label is exactly `label`. */
function rowByLabel(page: Page, label: string) {
  return page.locator('.obs-project-browser .pb-row', {
    has: page.locator('.pb-label', { hasText: exactLabel(label) }),
  }).first();
}

async function expectLabelVisible(page: Page, label: string): Promise<void> {
  await expect(
    page.locator('.obs-project-browser .pb-label', { hasText: exactLabel(label) }),
  ).toBeVisible({ timeout: 15000 });
}

async function expectLabelHidden(page: Page, label: string): Promise<void> {
  await expect(
    page.locator('.obs-project-browser .pb-label', { hasText: exactLabel(label) }),
  ).toHaveCount(0, { timeout: 15000 });
}

/** Click the chevron of the row whose label is exactly `label`. */
async function toggleRow(page: Page, label: string): Promise<void> {
  const row = rowByLabel(page, label);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.locator('.pb-chev').click();
}

/** Right-click a row and wait for the browser context menu to open. */
async function rightClickRow(page: Page, label: string): Promise<void> {
  const row = rowByLabel(page, label);
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click({ button: 'right' });
  await expect(page.locator('#obs-project-browser-menu')).toBeVisible({ timeout: 15000 });
}

function menuItem(page: Page, action: string) {
  return page.locator(`#obs-project-browser-menu .pb-menu-item[data-action="${action}"]`);
}

async function expectMenuItems(page: Page, actions: string[]): Promise<void> {
  for (const a of actions) {
    await expect(menuItem(page, a)).toBeVisible({ timeout: 15000 });
  }
}

/** Fill the app promptLine modal and submit it. */
async function answerPrompt(page: Page, value: string): Promise<void> {
  const input = page.locator('.obs-form-modal input[type="text"]');
  await expect(input).toBeVisible({ timeout: 15000 });
  await input.fill(value);
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('.obs-form-modal')).toHaveCount(0, { timeout: 15000 });
}

/** Confirm the app confirmDialog. */
async function answerConfirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  // The dialog is gone once the action has run.
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0, { timeout: 15000 });
}

test('G11 menu: stored view Rename → Duplicate → Delete all execute for real', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  // Rename the seeded Level 0 Plan.
  await rightClickRow(page, 'Level 0 Plan');
  await expectMenuItems(page, ['open', 'rename', 'duplicate', 'delete']);
  await menuItem(page, 'rename').click();
  await answerPrompt(page, 'Level 0 Renamed');
  await expectLabelVisible(page, 'Level 0 Renamed');
  await expectLabelHidden(page, 'Level 0 Plan');

  // Duplicate it: the copy carries the same view with a new name.
  await rightClickRow(page, 'Level 0 Renamed');
  await menuItem(page, 'duplicate').click();
  await expectLabelVisible(page, 'Level 0 Renamed (copy)');
  await expectLabelVisible(page, 'Level 0 Renamed');

  // Delete the copy: the original survives.
  await rightClickRow(page, 'Level 0 Renamed (copy)');
  await menuItem(page, 'delete').click();
  await answerConfirm(page);
  await expectLabelHidden(page, 'Level 0 Renamed (copy)');
  await expectLabelVisible(page, 'Level 0 Renamed');

  // Clicking elsewhere closes the menu.
  await rightClickRow(page, 'Level 0 Renamed');
  await page.mouse.click(600, 400);
  await expect(page.locator('#obs-project-browser-menu')).toBeHidden({ timeout: 15000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G11 menu: New Sheet from the Sheets root, then Rename and Delete it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  await rightClickRow(page, 'Sheets (all)');
  await expectMenuItems(page, ['new-sheet', 'open-sheets', 'expand-all']);
  await menuItem(page, 'new-sheet').click();
  await expectLabelVisible(page, 'A-001 — Sheet 1');

  await rightClickRow(page, 'A-001 — Sheet 1');
  await menuItem(page, 'rename').click();
  await answerPrompt(page, 'Site Plan');
  await expectLabelVisible(page, 'A-001 — Site Plan');
  await expectLabelHidden(page, 'A-001 — Sheet 1');

  await rightClickRow(page, 'A-001 — Site Plan');
  await menuItem(page, 'delete').click();
  await answerConfirm(page);
  await expectLabelHidden(page, 'A-001 — Site Plan');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G11 menu: New Phase from the Phases root, then Duplicate and Delete it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  await rightClickRow(page, '4D Phases');
  await expectMenuItems(page, ['new-phase', 'open-timeline', 'expand-all']);
  await menuItem(page, 'new-phase').click();
  await answerPrompt(page, 'Construction');
  await expectLabelVisible(page, 'Construction');

  await rightClickRow(page, 'Construction');
  await menuItem(page, 'duplicate').click();
  await expectLabelVisible(page, 'Construction (copy)');
  await expectLabelVisible(page, 'Construction');

  await rightClickRow(page, 'Construction (copy)');
  await menuItem(page, 'delete').click();
  await answerConfirm(page);
  await expectLabelHidden(page, 'Construction (copy)');
  await expectLabelVisible(page, 'Construction');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G11 menu: built-in family Delete is disabled; New Selection Set needs a selection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await enterPlatform(page);
  await openProjectBrowser(page);

  // The store refuses to remove built-in families, so the menu must show
  // Delete disabled with a reason — never as a live action that fails.
  await toggleRow(page, 'Families');
  await expectLabelVisible(page, 'Basic Wall');
  await rightClickRow(page, 'Basic Wall');
  await expectMenuItems(page, ['open', 'rename', 'duplicate', 'delete']);
  await expect(menuItem(page, 'delete')).toHaveAttribute('data-disabled', 'true');
  await expect(menuItem(page, 'rename')).not.toHaveAttribute('data-disabled', 'true');
  await expect(menuItem(page, 'duplicate')).not.toHaveAttribute('data-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#obs-project-browser-menu')).toBeHidden({ timeout: 15000 });

  // A selection set is saved from the current selection; with none selected
  // the action is disabled rather than creating an empty set.
  await rightClickRow(page, 'Groups');
  await expect(menuItem(page, 'new-set')).toHaveAttribute('data-disabled', 'true');

  expect(errors, errors.join('\n')).toEqual([]);
});
