import { test, expect } from '@playwright/test';

// Real-browser checks for two things that were only unit-tested: Shift+drag orbit, and Arabic (right-to-left) boot.
// Run on CI by .github/workflows/browser-smoke.yml (not part of the unit-test job).

test('Shift+drag orbit restores an upright camera and applies far fewer camera updates than pointer events', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => !!(window as any).__OBS_CTX__?.world?.camera?.controls, null, { timeout: 30000 });

  // Leave the camera tilted (as a Top / saved view can) and count camera-controls updates during the drag.
  await page.evaluate(() => {
    const c = (window as any).__OBS_CTX__.world.camera;
    c.three.up.set(0, 0, -1);
    const orig = c.controls.setLookAt.bind(c.controls);
    (window as any).__orbitCalls = 0;
    c.controls.setLookAt = (...a: unknown[]) => { (window as any).__orbitCalls++; return orig(...a); };
  });

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  const EVENTS = 40;
  await page.mouse.move(cx + 240, cy + 90, { steps: EVENTS });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera.three;
    return { up: [cam.up.x, cam.up.y, cam.up.z], calls: (window as any).__orbitCalls as number };
  });
  expect(r.up[1], `camera.up after orbit: ${r.up}`).toBeGreaterThan(0.999);
  expect(r.calls, 'orbit moved the camera').toBeGreaterThan(0);
  expect(r.calls, `camera updates (${r.calls}) should be well below pointer events (${EVENTS})`).toBeLessThan(EVENTS * 0.8);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Arabic locale boots right-to-left without uncaught errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('obs.locale', 'ar'); } catch { /* */ } });
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  // No horizontal page overflow introduced by the mirrored layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/rtl-ar.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});
