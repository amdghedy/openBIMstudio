import { test, expect, type Page } from '@playwright/test';

/**
 * G10 — Properties palette Type Selector + dock-left (Revit 2D audit).
 *
 * Proves in the real app, with real mouse input (no test hooks driving
 * the commands directly):
 *   1. selecting a wall opens the Properties palette with a Type Selector
 *      at the top, listing the wall's types, current type inferred;
 *   2. picking another type re-types the wall (thickness follows the new
 *      type) while an instance height override survives;
 *   3. "Edit Type" opens Type Properties for the selected type;
 *   4. the palette is docked left by default AND reserves its column:
 *      the viewport shifts right by the palette width (not an overlay).
 *
 * The fixture wall is created through the authoring API's own
 * history-wrapped createElementByType (the same path the draw tools use);
 * the click point is computed from the app's own rendered geometry
 * (Three.js camera projection, as in the G5 spec). The height override
 * is written to the element's params the same way the palette's own
 * field writes do (direct param write + rebuild), before the re-type.
 *
 * IMPORTANT (G3 finding): the repo's Playwright config reuses any server
 * already listening on :3000, so this spec must be run against its own
 * build on a distinct port (e.g. :3110) with a temporary config — never
 * trust :3000. The `dockSide` marker assertion below fails on any build
 * without this change, so a wrong-server run fails loudly instead of
 * passing against the wrong build.
 * Run: npx vite build && npx playwright test tests/e2e/revit-2d-g10-type-selector.spec.ts --project=chromium --config=<temp config on :3110>
 */

test('G10: wall Type Selector re-types the wall, Edit Type opens, palette docks left with a reserved column', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  const authoringCard = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(authoringCard).toBeVisible({ timeout: 30000 });
  await authoringCard.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });

  // ── Marker: this build (and only this build) exposes dockSide() ──
  // Fails loudly if the spec ever runs against a server without G10.
  await expect.poll(async () =>
    page.evaluate(() => typeof (window as any).__OBS_CTX__?.features?.propertyPalette?.dockSide === 'function'),
    { timeout: 30000 }).toBe(true);

  const authoring = () => page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring ?? null);
  await expect.poll(async () => !!(await authoring()), { timeout: 30000 }).toBe(true);
  await page.waitForFunction(() => !!(window as any).__obsBIMExperience, undefined, { timeout: 60000 });

  // ── Fixture: one wall, x -4..4 at z=0 (placed exactly as the Wall tool places it) ──
  const wallId = await page.evaluate(async () => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    return a.createElementByType('wall', { start: [-4, 0], end: [4, 0] });
  });
  expect(wallId, 'wall created').toBeTruthy();

  const wallParams = () => page.evaluate((id) => {
    const el = (window as any).__OBS_CTX__.features.authoring.getElementById(id);
    return el ? { thickness: el.params.thickness, height: el.params.height, wallTypeId: el.properties?.wallTypeId ?? null, layers: el.properties?.layers ?? null } : null;
  }, wallId);
  // Default placed wall: 0.255 m compound exterior.
  await expect.poll(async () => (await wallParams())?.thickness, { timeout: 15000 }).toBe(0.255);

  // Viewport x while the palette is closed (baseline for the dock-reservation check).
  const viewportBox = () => page.locator('#viewport').boundingBox();
  const closedBox = await viewportBox();
  expect(closedBox).not.toBeNull();

  // ── Instance override: height 4.5 m (written the way the palette writes it) ──
  await page.evaluate((id) => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    const el = a.getElementById(id);
    el.params.height = 4.5;
    a.rebuildAuthored();
  }, wallId);
  await expect.poll(async () => (await wallParams())?.height, { timeout: 15000 }).toBe(4.5);

  // ── Frame the wall and click it (off-centre: the midpoint temp-dim label swallows clicks) ──
  const projectWallPoint = (wx: number) =>
    page.evaluate((wx2) => {
      const cam = (window as any).__OBS_CTX__.world.camera.three;
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      const [px, py, pz] = [wx2, 1.5, 0];
      const mv = cam.matrixWorldInverse.elements as number[];
      const vx = mv[0] * px + mv[4] * py + mv[8] * pz + mv[12];
      const vy = mv[1] * px + mv[5] * py + mv[9] * pz + mv[13];
      const vz = mv[2] * px + mv[6] * py + mv[10] * pz + mv[14];
      const vw = mv[3] * px + mv[7] * py + mv[11] * pz + mv[15];
      const pr = cam.projectionMatrix.elements as number[];
      const cx = pr[0] * vx + pr[4] * vy + pr[8] * vz + pr[12] * vw;
      const cy = pr[1] * vx + pr[5] * vy + pr[9] * vz + pr[13] * vw;
      const cw = pr[3] * vx + pr[7] * vy + pr[11] * vz + pr[15] * vw;
      const nx = cx / cw, ny = cy / cw;
      return {
        x: (nx * 0.5 + 0.5) * rect.width + rect.left,
        y: (-ny * 0.5 + 0.5) * rect.height + rect.top,
        behind: cw <= 0,
      };
    }, wx);
  await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera;
    cam.controls.setLookAt(0, 4, 14, 0, 1.2, 0, false);
  });
  await page.waitForTimeout(500);
  await expect.poll(async () => {
    const p = await projectWallPoint(-2);
    if (p.behind) return false;
    const hit = await page.evaluate(({ x, y }) =>
      (window as any).__OBS_CTX__.features.authoring.pickAuthoredElementAt({ clientX: x, clientY: y }),
      { x: p.x, y: p.y },
    );
    return hit === wallId;
  }, { timeout: 30000 }).toBe(true);
  const wallPt = await projectWallPoint(-2);
  await page.mouse.click(wallPt.x, wallPt.y);

  // ── 1. The Type Selector is at the top of the palette ──
  const selector = page.locator('[data-testid="type-selector"]');
  await expect(selector).toBeVisible({ timeout: 15000 });
  await expect(selector).toHaveValue('compound-exterior');
  const optionTexts = await selector.locator('option').allTextContents();
  expect(optionTexts).toContain('Basic Wall: Generic 200mm');
  expect(optionTexts).toContain('Basic Wall: Concrete 300mm');
  expect(optionTexts).not.toContain('Curtain Wall: Glazed System');

  // ── 4. Docked left with a RESERVED column (viewport shifts right) ──
  const dockSide = await page.evaluate(() =>
    (window as any).__OBS_CTX__.features.propertyPalette.dockSide());
  expect(dockSide).toBe('left');
  const dockCol = page.locator('#obs-pp-dock-left');
  await expect(dockCol).toBeVisible({ timeout: 10000 });
  const dockBox = await dockCol.boundingBox();
  expect(dockBox).not.toBeNull();
  expect(dockBox!.width).toBeGreaterThanOrEqual(300);
  expect(dockBox!.width).toBeLessThanOrEqual(340);
  const openBox = await viewportBox();
  expect(openBox).not.toBeNull();
  const shift = openBox!.x - closedBox!.x;
  expect(shift).toBeGreaterThanOrEqual(300);
  expect(shift).toBeLessThanOrEqual(340);

  // ── 2. Pick another type: the wall re-types, the override survives ──
  await selector.selectOption('compound-concrete');
  await expect.poll(async () => await wallParams(), { timeout: 15000 }).toEqual({
    thickness: 0.3,
    height: 4.5,
    wallTypeId: 'compound-concrete',
    layers: 'Concrete Core 0.30|#9ca3af',
  });
  await expect(selector).toHaveValue('compound-concrete');

  // ── 3. Edit Type opens Type Properties ──
  await page.locator('[data-testid="edit-type"]').click();
  const typeDialog = page.locator('.obs-bim-dialog h2', { hasText: 'Type Properties' });
  await expect(typeDialog).toBeVisible({ timeout: 10000 });
  await page.locator('.obs-bim-dialog__close').click();
  await expect(page.locator('.obs-bim-dialog-host')).toHaveAttribute('data-visible', '0');

  expect(errors, errors.join('\n')).toEqual([]);
});
