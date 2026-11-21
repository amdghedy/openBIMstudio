import { test, expect, type Page } from '@playwright/test';

/**
 * G12 — plan dockable + live-sync subset (audit §2 G12, §3 item 11).
 *
 * Dock the plan beside 3D -> both visible, 3D resized to share the screen
 * -> add a wall in 3D (through the real authoring path,
 * __obsAuthoring.createElementByType -> createElement -> history.exec) ->
 * the docked plan updates WITHOUT pressing Regenerate -> undock back to
 * the modal overlay.
 *
 * This proves the reachable subsets ONLY. The plan is still an SVG
 * projection regenerated from the model, not a live view of the Three.js
 * scene — no "live views" claim is made. Tiled views (WT) are out of
 * reach and no WT control is added.
 *
 * Run ONLY against this branch's own build on :3112 (see
 * playwright.g12.config.ts next to the audit): the repo's default config
 * reuses any server already on :3000, and a sibling worktree's preview
 * server would make this spec silently test the wrong build.
 *   npx vite build && npx vite preview --port 3112 --host 127.0.0.1
 *   npx playwright test --config playwright.g12.config.ts tests/e2e/revit-2d-g12-dock-live-sync.spec.ts --project=chromium
 *
 * The [data-obs-plan-dock] button exists only in the G12 build, so its
 * presence also proves the page under test is this build, not base.
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function waitPlanReady(page: Page): Promise<void> {
  await expect(page.locator('.obs-plan-overlay')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.obs-plan-overlay svg *').length > 10,
    null, { timeout: 30000 },
  );
  // The "Generating plan…" overlay covers the whole canvas while the plan
  // regenerates: wait until it is actually hidden before clicking anything.
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll('.obs-plan-overlay div')]
      .find((el) => el.textContent === 'Generating plan…');
    return !text || getComputedStyle(text.parentElement as Element).display === 'none';
  }, null, { timeout: 60000 });
}

/** "N authored · M fragments · K segments" from the plan footer. */
async function planStats(page: Page): Promise<{ authored: number; segments: number }> {
  return page.evaluate(() => {
    const overlay = document.querySelector('.obs-plan-overlay') as HTMLElement;
    const m = overlay.textContent!.match(/(\d+) authored · (\d+) fragments · (\d+) segments/);
    if (!m) throw new Error(`plan footer stats not found in: ${overlay.textContent!.slice(0, 200)}`);
    return { authored: Number(m[1]), segments: Number(m[3]) };
  });
}

async function dockMode(page: Page): Promise<string | null> {
  return page.evaluate(
    () => (document.querySelector('.obs-plan-overlay') as HTMLElement).dataset.planDockMode ?? null,
  );
}

test('plan docks beside 3D and live-syncs a wall added in 3D', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(() => !!(window as any).__obsAuthoring, null, { timeout: 30000 });

  // One wall in the model before the plan opens.
  const idA = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [0, 0], end: [4, 0] });
  });
  expect(idA, 'wall A was not created').toBeTruthy();

  // Open the plan view (modal overlay, pre-G12 behaviour).
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await waitPlanReady(page);
  expect(await dockMode(page)).toBe('modal');
  const before = await planStats(page);
  expect(before.authored, 'plan shows the one wall').toBe(1);
  const modalBox = await page.locator('.obs-plan-overlay').boundingBox();
  expect(modalBox!.x, 'modal plan starts at the left edge').toBeCloseTo(0, 0);
  expect(modalBox!.width, 'modal plan spans the viewport').toBeCloseTo(1280, 0);

  // (a) Dock: the plan pins to the right and the 3D viewport shares the screen.
  await page.locator('[data-obs-plan-dock]').click();
  await expect.poll(async () => dockMode(page), { timeout: 10000 }).toBe('docked-right');
  const dockedBox = await page.locator('.obs-plan-overlay').boundingBox();
  expect(dockedBox!.width, 'docked plan is 560 px wide').toBeCloseTo(560, 0);
  expect(dockedBox!.x, 'docked plan sits at the right edge').toBeCloseTo(1280 - 560, 0);
  const viewportBox = await page.locator('#viewport').boundingBox();
  expect(viewportBox!.width, '3D viewport shrinks by the dock width').toBeCloseTo(1280 - 560, 0);
  expect(
    Math.abs(viewportBox!.x + viewportBox!.width - dockedBox!.x),
    '3D viewport ends where the docked plan begins',
  ).toBeLessThan(2);
  await expect(page.locator('#viewport canvas').first()).toBeVisible();
  await expect(page.locator('.obs-plan-overlay svg').first()).toBeVisible();

  // (b) Live-sync: add a wall in 3D; the docked plan must update with no
  // Regenerate press. (createElementByType runs the real 3D wall path:
  // createElement -> history.exec -> notifyAuthoringChange.)
  const idB = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [6, 0], end: [10, 0] });
  });
  expect(idB, 'wall B was not created').toBeTruthy();
  await expect.poll(async () => (await planStats(page)).authored, { timeout: 30000 })
    .toBe(2);
  const after = await planStats(page);
  expect(after.segments, 'new wall adds plan segments').toBeGreaterThan(before.segments);

  // Dock side switch: right -> bottom -> right (node tests pin the geometry).
  await page.locator('[data-obs-plan-dock-side]').click();
  await expect.poll(async () => dockMode(page), { timeout: 10000 }).toBe('docked-bottom');
  const bottomBox = await page.locator('.obs-plan-overlay').boundingBox();
  expect(bottomBox!.width, 'bottom-docked plan spans the width').toBeCloseTo(1280, 0);
  expect(bottomBox!.height, 'bottom-docked plan is 45% of the viewport').toBeCloseTo(720 * 0.45, 0);
  const viewportBottom = await page.locator('#viewport').boundingBox();
  expect(
    Math.abs(viewportBottom!.y + viewportBottom!.height - bottomBox!.y),
    '3D viewport ends where the bottom-docked plan begins',
  ).toBeLessThan(2);
  await page.locator('[data-obs-plan-dock-side]').click();
  await expect.poll(async () => dockMode(page), { timeout: 10000 }).toBe('docked-right');

  // Undock: back to the modal overlay, 3D viewport whole again.
  await page.locator('[data-obs-plan-dock]').click();
  await expect.poll(async () => dockMode(page), { timeout: 10000 }).toBe('modal');
  const undockedBox = await page.locator('.obs-plan-overlay').boundingBox();
  expect(undockedBox!.x, 'undocked plan is full-width again').toBeCloseTo(0, 0);
  expect(undockedBox!.width).toBeCloseTo(1280, 0);
  const viewportFull = await page.locator('#viewport').boundingBox();
  expect(viewportFull!.width, '3D viewport takes the full width again').toBeCloseTo(1280, 0);
  // Modal mode still shows the two walls (nothing was lost by docking).
  await expect.poll(async () => (await planStats(page)).authored, { timeout: 30000 }).toBe(2);

  expect(errors, errors.join('\n')).toEqual([]);
});
