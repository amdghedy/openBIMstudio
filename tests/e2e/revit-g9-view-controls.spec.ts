import { test, expect, type Page } from '@playwright/test';

/**
 * Revit 2D environment audit gap G9 — view controls.
 *
 * Proves in the real app:
 *   1. the plan header scale list is the full Revit-style set (1:5–1:1000)
 *      and picking 1:20 re-renders the plan at that scale (the wall poché
 *      pattern tile — sized in paper millimetres at the view scale —
 *      shrinks by exactly 100/20 = 5x against 1:100);
 *   2. the View tab Crop toggle follows the active view: with the plan open
 *      it toggles the plan's own crop region, and when the active view is
 *      switched to another id it toggles that view's region instead,
 *      leaving the plan's region untouched;
 *   3. View Properties "Underlay: Below" renders the level underneath
 *      (Level 0) greyed beneath the live Level 1 plan, and switching back
 *      to None removes it.
 *
 * Run: npx vite build, then serve this worktree's build on its own port
 * (never :3000 — other worktrees' previews may live there) and run with
 * a Playwright config pointed at that port, e.g. port 3109:
 * npx playwright test tests/e2e/revit-g9-view-controls.spec.ts
 * --project=chromium. The spec asserts the 16-option scale list as a
 * build marker first, so a wrong build fails fast.
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function openPlan(page: Page): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.obs-plan-overlay')).toBeVisible({ timeout: 30000 });
  // Build marker: only the G9 build offers the full scale list. If this
  // fails, the spec is running against the wrong build — stop, do not
  // trust anything after it.
  const scale = page.locator('.obs-plan-overlay select[title="View Scale"]');
  await expect(scale).toBeVisible({ timeout: 15000 });
  await expect(scale.locator('option')).toHaveCount(16);
  await expect(scale.locator('option[value="5"]')).toHaveText('1 : 5');
  await expect(scale.locator('option[value="1000"]')).toHaveText('1 : 1000');
  // Readiness: the first plan generation must have finished (the loading
  // overlay covers the canvas while it runs and would swallow clicks).
  // The footer counts the empty plan once that generation lands.
  await expect(page.locator('.obs-plan-overlay').getByText(/0 authored/, { exact: false }).first())
    .toBeVisible({ timeout: 60000 });
}

/** Draw one wall in the plan with the command line (WA) + two clicks. */
async function drawWallInPlan(page: Page): Promise<void> {
  const line = page.locator('#obs-plan-cmdline input');
  await expect(line).toBeVisible({ timeout: 15000 });
  await line.focus();
  await line.fill('wa');
  await line.press('Enter');
  await expect(page.getByText('Place wall', { exact: false }).first())
    .toBeVisible({ timeout: 15000 });
  const svg = page.locator('.obs-plan-overlay svg').first();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  const cy = box!.y + box!.height / 2;
  await page.mouse.click(box!.x + box!.width * 0.4, cy);
  await page.mouse.click(box!.x + box!.width * 0.6, cy);
  await page.keyboard.press('Escape');
  // The plan regenerates after the placement; the footer counts authored.
  await expect(page.locator('.obs-plan-overlay').getByText(/1 authored/, { exact: false }).first())
    .toBeVisible({ timeout: 30000 });
}

/**
 * Draw one column (CM) + one click. A column is used for the scale proof
 * because its cut fill always carries a hatch pattern ("concrete"), while
 * a default wall's fill is a solid colour with no pattern def at all —
 * so only a column leaves a paper-scale-sized pattern tile in the SVG.
 */
async function drawColumnInPlan(page: Page): Promise<void> {
  const line = page.locator('#obs-plan-cmdline input');
  await expect(line).toBeVisible({ timeout: 15000 });
  await line.focus();
  await line.fill('cm');
  await line.press('Enter');
  const svg = page.locator('.obs-plan-overlay svg').first();
  const box = await svg.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height / 2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.obs-plan-overlay').getByText(/1 authored/, { exact: false }).first())
    .toBeVisible({ timeout: 30000 });
  await expect(page.locator('.obs-plan-overlay svg pattern[id="obs-poche-concrete"]'))
    .toBeAttached({ timeout: 15000 });
}

/** The crop bridge registers late in critical-gaps-boot (renderer-ready or
 *  a 120 s fallback), so a test that needs it must wait for it — up to
 *  150 s on a loaded VM — rather than assuming boot has finished. */
async function waitForCropBridge(page: Page): Promise<void> {
  await expect.poll(async () =>
    page.evaluate(() => typeof (window as any).__obsCropRegion),
    { timeout: 150000 },
  ).toBe('object');
}

/** Poché pattern tile width — sized in paper mm at the view scale. */
async function pochePatternWidth(page: Page): Promise<number> {
  const w = await page.locator('.obs-plan-overlay svg pattern[id^="obs-poche-"]')
    .first()
    .getAttribute('width', { timeout: 15000 });
  expect(w).not.toBeNull();
  return Number(w);
}

test('G9: full scale list — picking 1:20 re-renders the plan at 1:20', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await openPlan(page);
  await drawColumnInPlan(page);

  const scale = page.locator('.obs-plan-overlay select[title="View Scale"]');
  await expect(scale).toHaveValue('100');
  const w100 = await pochePatternWidth(page);
  expect(w100).toBeGreaterThan(0);

  await scale.selectOption('20');
  await expect(page.locator('.obs-plan-overlay').getByText('View Scale 1:20', { exact: false }).first())
    .toBeVisible({ timeout: 15000 });
  await expect(scale).toHaveValue('20');
  const w20 = await pochePatternWidth(page);
  // paperMmToWorld(1) is (1/1000) * scale, so the tile is 5x smaller at 1:20.
  expect(w20 / w100).toBeCloseTo(0.2, 2);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G9: crop toggle follows the active view', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await openPlan(page);

  // The bridge registers late in boot; wait for it before asserting.
  await waitForCropBridge(page);
  // The open plan marks itself the active crop view.
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__obsCropRegion?.getActive?.()),
  ).toBe('plan-view-1');

  const ribbon = page.locator('.obs-ribbon');
  const cropGroup = page.locator('.obs-ribbon-group', {
    has: page.locator('.obs-ribbon-group__label', { hasText: 'Crop View' }),
  }).first();
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await expect(cropGroup).toBeVisible({ timeout: 15000 });
  await cropGroup.getByRole('button', { name: 'Toggle', exact: true }).click();
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__obsCropRegion?.get?.('plan-view-1')?.enabled),
  ).toBe(true);
  await expect(page.locator('.obs-plan-overlay [data-obs-crop-ui]').first())
    .toBeAttached({ timeout: 15000 });

  // Switch the active view elsewhere: the toggle must now act there, and
  // leave the plan's region exactly as it was — that is the follow-active
  // behaviour, not a hardcoded "plan-view-1".
  await page.evaluate(() => (window as any).__obsCropRegion?.setActive?.('plan-view-2'));
  await cropGroup.getByRole('button', { name: 'Toggle', exact: true }).click();
  await expect.poll(async () =>
    page.evaluate(() => (window as any).__obsCropRegion?.get?.('plan-view-2')?.enabled),
  ).toBe(true);
  expect(await page.evaluate(() =>
    (window as any).__obsCropRegion?.get?.('plan-view-1')?.enabled)).toBe(true);
  await page.evaluate(() => (window as any).__obsCropRegion?.setActive?.('plan-view-1'));

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G9: Underlay Below renders the lower level greyed beneath', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await openPlan(page);
  // Wall is authored on the default level (Level 0).
  await drawWallInPlan(page);

  const plan = page.locator('.obs-plan-overlay');
  // Switch the plan to Level 1: the title block follows the level. (The
  // footer still counts the Level 0 wall — the Level 1 plan includes it as
  // a "below" element — so the title, not the authored count, proves the
  // switch.)
  const levelSelect = plan.locator('> div').first().locator('select').first();
  await levelSelect.selectOption('1');
  await expect(plan.locator('svg text', { hasText: 'Plan: Level 1' }).first())
    .toBeAttached({ timeout: 30000 });
  await expect(plan.locator('[data-obs-underlay]')).toHaveCount(0);

  // ...until Underlay: Below shows Level 0 greyed underneath.
  const underlaySelect = plan.locator('select', {
    has: page.locator('option[value="Below"]'),
  }).first();
  await underlaySelect.selectOption('Below');
  const underlay = plan.locator('[data-obs-underlay="Level 0"]');
  await expect(underlay).toBeAttached({ timeout: 30000 });
  const segs = underlay.locator('[data-obs-underlay-seg]');
  await expect(segs.first()).toBeAttached({ timeout: 15000 });
  expect(await segs.count()).toBeGreaterThan(0);
  const stroke = await segs.first().getAttribute('stroke');
  expect(stroke).toBe('#9ca3af');
  // Beneath the live geometry: the underlay group precedes the main group.
  const order = await page.evaluate(() => {
    const svg = document.querySelector('.obs-plan-overlay svg')!;
    const kids = [...svg.children];
    const u = kids.findIndex((el) => el.getAttribute('data-obs-underlay') !== null);
    const main = kids.findIndex((el) =>
      el.tagName.toLowerCase() === 'g' &&
      el.getAttribute('data-obs-underlay') === null &&
      el.getAttribute('data-obs-cad-link') === null &&
      el.getAttribute('data-obs-crop-ui') === null);
    return { u, main };
  });
  expect(order.u).toBeGreaterThanOrEqual(0);
  expect(order.main).toBeGreaterThan(order.u);

  // Back to None: the underlay is gone.
  await underlaySelect.selectOption('None');
  await expect(plan.locator('[data-obs-underlay]')).toHaveCount(0, { timeout: 15000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
