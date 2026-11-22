import { test, expect, type Page } from '@playwright/test';

/**
 * Options bar vs ribbon tab row (pre-existing audit bug).
 *
 * The options bar mounted on document.body when ctx.rightHost was
 * unavailable at setup, so at top:0 of the page it covered the ribbon
 * tab row while a selection was active — no tab was clickable until the
 * selection was cleared (the modify-tab-completion spec worked around
 * it with an Escape first). The bar now re-parents into the viewport
 * host below the ribbon as soon as the host exists.
 *
 * Proves in the real app, with a wall selected (so the Modify options
 * bar is showing):
 *  1. the bar lives inside #viewport, below the ribbon — its top edge is
 *     at or below the ribbon's bottom edge;
 *  2. the ribbon's View tab is the topmost element at its own centre
 *     (the bar no longer intercepts the click);
 *  3. clicking the View tab actually switches the ribbon to the View
 *     groups, while the selection stays active and the bar stays visible
 *     (the fix moves the bar, it does not hide it).
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3114 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3114 and which starts no webServer.
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

test('options bar sits below the ribbon; tabs stay clickable with a selection active', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__obsAuthoring), { timeout: 30000 }).toBe(true);

  // A wall selected, so the Modify options bar shows.
  const wallId = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [-4, 0], end: [4, 0] }) as string;
  });
  expect(wallId, 'authored wall created').toBeTruthy();
  await page.evaluate((id) => {
    (window as any).__OBS_CTX__.features.authoring.selectAllAuthored([id]);
  }, wallId);
  const bar = page.locator('#obs-options-bar');
  await expect.poll(async () => page.evaluate(() =>
    getComputedStyle(document.querySelector('#obs-options-bar')!).display,
  ), { timeout: 15000 }).toBe('flex');
  await expect(bar).toContainText('Modify');

  // 1. The bar lives inside #viewport, below the ribbon.
  const geometry = await page.evaluate(() => {
    const b = document.querySelector('#obs-options-bar')!;
    const ribbon = document.querySelector('.obs-ribbon')!;
    const br = b.getBoundingClientRect();
    const rr = ribbon.getBoundingClientRect();
    return {
      parentId: b.parentElement?.id ?? null,
      barTop: br.y,
      ribbonBottom: rr.y + rr.height,
    };
  });
  expect(geometry.parentId).toBe('viewport');
  expect(geometry.barTop).toBeGreaterThanOrEqual(geometry.ribbonBottom);

  // 2. The View tab — not the bar — is on top at the tab's own centre.
  const topAtViewTab = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('.obs-ribbon button')]
      .find((b) => b.textContent?.trim() === 'View')!;
    const r = tab.getBoundingClientRect();
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as Element | null;
    return { tag: top?.tagName ?? null, dataTab: top?.getAttribute?.('data-tab') ?? null, id: top?.id ?? null };
  });
  expect(topAtViewTab.tag).toBe('BUTTON');
  expect(topAtViewTab.dataTab).toBe('view');
  expect(topAtViewTab.id).not.toBe('obs-options-bar');

  // 3. Clicking the View tab switches the ribbon — with the selection
  // still active and the bar still showing.
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  const strip = page.locator('.obs-ribbon__strip');
  await expect(strip.locator('.obs-ribbon-group__label', { hasText: 'Crop View' }).first())
    .toBeVisible({ timeout: 15000 });
  const selected = await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.authoring.getSelectedIds?.() ?? []);
  expect(selected).toEqual([wallId]);
  await expect.poll(async () => page.evaluate(() =>
    getComputedStyle(document.querySelector('#obs-options-bar')!).display,
  ), { timeout: 15000 }).toBe('flex');

  expect(errors, errors.join('\n')).toEqual([]);
});
