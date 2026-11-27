import { test, expect, type Page } from '@playwright/test';

/**
 * Browser crash recovery — issue #91 (browser half) / #101.
 *
 * Proves the real application flow, not a helper:
 *   1. create a project in the UI and make it dirty (place a wall);
 *   2. WITHOUT any unload/refresh, the crash marker must already be in
 *      localStorage — the marker used to be written only on beforeunload,
 *      which never fires on a renderer crash, so a real crash left no
 *      marker and no recovery notice on the next boot;
 *   3. crash the renderer via CDP Page.crash (a genuine crash: no
 *      beforeunload, no visibilitychange, no cleanup handlers run);
 *   4. fresh boot in a new context restored from the pre-crash storage
 *      state: the recovery banner must appear, pointing at the
 *      autosaved checkpoints. (A new context is used because the
 *      crashed page object is dead and headless-shell shares the
 *      renderer across same-origin pages; the storage state is the
 *      real marker the app wrote, captured before the crash.)
 *
 * Run: npx playwright test tests/e2e/crash-recovery.spec.ts --project=chromium
 * (Chromium only: Page.crash is a CDP feature and the recovery banner is
 * browser-agnostic once the marker exists.)
 */

async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

test('renderer crash with unsaved changes shows the recovery banner on reload', async ({ page, browser }) => {
  test.setTimeout(600000); // two cold boots + SwiftShader on a weak VM are slow
  const t0 = Date.now();
  const stamp = (m: string) => console.log(`[crash-recovery ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
  stamp('booted, ribbon visible');
  await enterPlatform(page);
  stamp('entered platform');

  // Create a project through the visible UI (Ctrl+N → "New project" prompt).
  // NOTE: the home screen has its own hidden #obs-new-name input with the
  // same aria-label, so target the modal card explicitly.
  await page.keyboard.press('Control+n');
  const nameInput = page.locator('.obs-form-modal input[type="text"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill('Crash recovery test');
  await nameInput.press('Enter');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('obs.projects.lastId')), { timeout: 30000 })
    .not.toBeNull();
  stamp('project created');

  // Make the document dirty: 2D plan → wall tool → two clicks place a wall.
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  const line = page.locator('#obs-plan-cmdline input');
  await expect(line).toBeVisible({ timeout: 15000 });
  await page.mouse.move(600, 400);
  await page.keyboard.type('wa');
  await expect(line).toHaveValue('wa');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Place wall', { exact: false }).first()).toBeVisible({ timeout: 15000 });
  stamp('wall tool active');
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.5);
  stamp('wall clicks done');

  // The crash marker must ALREADY exist — no unload, no refresh, no
  // visibility change has happened. This is the eager-write behaviour.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('obs.session.unsaved')), {
      timeout: 15000,
      message: 'crash marker must be written eagerly when the document goes dirty',
    })
    .not.toBeNull();

  // Capture the browser's persisted storage BEFORE the crash: the
  // crash marker the app just wrote is part of it. (A storage round-trip
  // is exactly what a reload reads — the marker is the real one the app
  // wrote, not a fixture.)
  const state = await page.context().storageState();
  stamp('marker polled OK, storage captured');

  // Genuine renderer crash: no beforeunload, no cleanup handlers.
  // Fire-and-forget: Page.crash kills the target, so awaiting the send
  // hangs until Playwright's internal CDP timeout (minutes in
  // headless-shell) — the crash itself happens immediately and the
  // 'crash' event below is the signal to proceed.
  const crashed = new Promise<void>((resolve) => page.once('crash', () => resolve()));
  const cdp = await page.context().newCDPSession(page);
  void cdp.send('Page.crash').catch(() => { /* target died mid-send: expected */ });
  await Promise.race([crashed, page.waitForTimeout(10000)]);
  stamp('renderer crashed');

  // Fresh boot in a new context restored from the pre-crash storage:
  // the recovery banner must appear. (The crashed page object is dead
  // and headless-shell shares the renderer across same-origin pages,
  // so no live page from the crashed context can be reused.)
  const ctx2 = await browser.newContext({ storageState: state });
  const page2 = await ctx2.newPage();
  await page2.goto('/');
  await expect(page2.locator('canvas').first()).toBeVisible({ timeout: 60000 });
  stamp('fresh boot, canvas visible');
  const banner = page2.locator('#obs-recovery-banner');
  await expect(banner).toBeVisible({ timeout: 60000 });
  await expect(banner).toContainText('Previous session ended without a clean save');
  stamp('BANNER VISIBLE');
  expect(errors, errors.join('\n')).toEqual([]);
  // Explicit teardown: closing a crashed context can hang the runner's
  // fixture teardown, so close everything ourselves (bounded) first.
  await ctx2.close().catch(() => {});
  await Promise.race([
    page.context().close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  stamp('teardown done');
});
