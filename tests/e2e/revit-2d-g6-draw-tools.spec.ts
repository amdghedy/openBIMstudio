import { test, expect, type Page } from '@playwright/test';

/**
 * Revit 2D environment audit gap G6 — draw-tool ordering and grouping.
 *
 * Proves in the real app, on the Architecture tab, that the Build group
 * renders in Revit's order (Wall, Door, Window, Comp, Column, Roof,
 * Ceiling, Floor, Curtain Wall, Railing, Ramp, Stair, Room, Model Line,
 * Model Group), that Stair is a real placement tool (two canvas clicks
 * place a stair), and that Curtain Wall + Railing are present; and on the
 * Structure tab that Framing is Beam, Brace, Column, Wall, Floor, Truss
 * and the Foundations / Reinforcement groups carry Revit's names.
 *
 * Run: npx vite build && npx playwright test tests/e2e/revit-2d-g6-draw-tools.spec.ts --project=chromium
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

/** Button labels of one ribbon group, in DOM order. */
async function groupButtons(page: Page, groupLabel: string): Promise<string[]> {
  const group = page.locator('.obs-ribbon-group', { has: page.locator('.obs-ribbon-group__label', { hasText: groupLabel }) }).first();
  await expect(group).toBeVisible({ timeout: 15000 });
  return group.locator('.obs-ribbon-group__body .obs-rb').evaluateAll((btns) =>
    btns.map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim()));
}

test('G6: Architecture Build group renders in Revit order', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);

  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'Architecture', exact: true }).click();

  expect(await groupButtons(page, 'Build')).toEqual([
    'Wall', 'Door', 'Window', 'Comp', 'Objects', 'Column', 'Roof', 'Ceiling',
    'Floor', 'Curtain Wall', 'Railing', 'Ramp', 'Stair', 'Room',
    'Model Line', 'Model Group',
  ]);

  // Door/Window moved here — they must not also sit in Openings.
  expect(await groupButtons(page, 'Openings')).toEqual(['Opening', 'Shaft', 'Hosted Opening']);

  // No Beam in Architecture at all (Structure only).
  const archLabels = await page.locator('.obs-ribbon__strip .obs-rb').evaluateAll((btns) =>
    btns.map((b) => (b.getAttribute('aria-label') || '').trim()));
  expect(archLabels).not.toContain('Beam');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G6: Stair is a placement tool — two canvas clicks place a stair', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);

  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'Architecture', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Stair', exact: true }).click();
  // M2 placement hint, not an instant-build toast.
  await expect(page.getByText('Stair: click start, then end', { exact: false }).first())
    .toBeVisible({ timeout: 15000 });

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30000 });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  // Run start, then run end: placement point + run direction.
  await page.mouse.click(cx - 150, cy);
  await page.mouse.click(cx + 150, cy);
  await expect(page.getByText(/Stair 1 placed/, { exact: false }).first())
    .toBeVisible({ timeout: 15000 });

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G6: Structure Framing / Foundations / Reinforcement match Revit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);

  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'Structure', exact: true }).click();

  expect(await groupButtons(page, 'Framing')).toEqual(
    ['Beam', 'Brace', 'Column', 'Wall', 'Floor', 'Truss']);
  expect(await groupButtons(page, 'Foundations')).toEqual(
    ['Isolated', 'Wall', 'Slab', 'Pile']);
  expect(await groupButtons(page, 'Reinforcement')).toEqual(
    ['Generate Rebar', 'Export BBS', 'Clash Review']);

  expect(errors, errors.join('\n')).toEqual([]);
});
