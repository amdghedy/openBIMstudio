import { test, expect, type Page } from '@playwright/test';

/**
 * G3 Tab-cycle in 3D — Revit 2D audit gap G3, 3D half.
 *
 * Proves in the real app, with real mouse/keyboard input, that hovering
 * the crossing of two authored walls in the 3D viewport and pressing Tab
 * cycles the pre-highlight through the overlapping elements (status-bar
 * readout "Tab 2/2: …"), and clicking selects the cycled element — not
 * the topmost hit. The proof is order-independent (wall names collide in
 * this app, so the test shows Tab+click selects one wall and
 * Tab+Tab+click selects the other).
 *
 * Fixture walls are created through the authoring API's own
 * history-wrapped createElementByType (the same path the draw tools use);
 * the hover / Tab / click / Esc under test are real user input.
 * Run: npx playwright test tests/e2e/g3-tab-cycle-3d.spec.ts --project=chromium
 */
test('G3 Tab-cycle in 3D: hover two crossing walls, Tab cycles pre-highlight, click selects the cycled one', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => !!(await page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring)), { timeout: 60000 }).toBe(true);

  // ── Fixture: two crossing walls (horizontal + vertical, cross at 0,0)
  const wallIds = await page.evaluate(async () => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    const w1 = await a.createElementByType('wall', { start: [-4, 0], end: [4, 0] });
    const w2 = await a.createElementByType('wall', { start: [0, -3], end: [0, 3] });
    return [w1, w2];
  });
  expect(wallIds[0], 'wall 1 created').toBeTruthy();
  expect(wallIds[1], 'wall 2 created').toBeTruthy();
  expect(wallIds[0], 'two distinct walls').not.toBe(wallIds[1]);

  const selectedIds = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring?.getSelectedIds?.() ?? []);
  const statusBarText = () => page.locator('.bb-status').innerText();

  // Fit the model, then project the crossing point (0, 1.0, 0) — mid-height
  // where the two walls overlap — to screen coordinates through the live
  // camera matrices. The canvas centre is not reliable: after fit the
  // walls can sit off-centre and only a few pixels wide.
  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible({ timeout: 30000 });
  const cross = await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera.three;
    const apply = (m: number[], v: number[]) => [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
      m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
    const clip = apply(cam.projectionMatrix.elements, apply(cam.matrixWorldInverse.elements, [0, 1.0, 0, 1]));
    const ndcX = clip[0] / clip[3], ndcY = clip[1] / clip[3];
    const rect = document.querySelector('canvas')!.getBoundingClientRect();
    return {
      x: rect.left + ((ndcX + 1) / 2) * rect.width,
      y: rect.top + ((1 - ndcY) / 2) * rect.height,
      behind: clip[3] < 0,
    };
  });
  expect(cross.behind, 'crossing is in front of the camera').toBe(false);
  const cx = cross.x, cy = cross.y;

  // ── Hover the crossing: the preselection hover card appears
  await page.mouse.move(cx, cy);
  await expect.poll(async () => await page.locator('.obs-bim-hovercard[data-visible="1"]').count(), { timeout: 15000 }).toBe(1);

  // ── Tab once: status bar shows the cycle at 2/2
  await page.keyboard.press('Tab');
  await expect.poll(async () => await statusBarText(), { timeout: 10000 }).toContain('Tab 2/2:');

  // ── Click selects the cycled element (2/2)
  await page.mouse.click(cx, cy);
  await expect.poll(async () => (await selectedIds()).length, { timeout: 10000 }).toBe(1);
  const firstId = (await selectedIds())[0];
  expect(wallIds, 'clicked selection is one of the fixture walls').toContain(firstId);

  // ── Tab twice (wrap to 1/2), click selects the OTHER wall
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await expect.poll(async () => await statusBarText(), { timeout: 10000 }).toContain('Tab 2/2:');
  await page.keyboard.press('Tab');
  await expect.poll(async () => await statusBarText(), { timeout: 10000 }).toContain('Tab 1/2:');
  await page.mouse.click(cx, cy);
  await expect.poll(async () => (await selectedIds()).length, { timeout: 10000 }).toBe(1);
  const secondId = (await selectedIds())[0];
  expect(secondId, 'second Tab+click selects the other wall').not.toBe(firstId);
  expect([firstId, secondId].sort(), 'both walls are the cycle').toEqual([...wallIds].sort());

  // ── Esc resets the cycle readout
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await expect.poll(async () => await statusBarText(), { timeout: 10000 }).toContain('Tab 2/2:');
  await page.keyboard.press('Escape');
  await expect.poll(async () => await statusBarText(), { timeout: 10000 }).not.toContain('Tab 2/2:');

  expect(errors, errors.join('\n')).toEqual([]);
});
