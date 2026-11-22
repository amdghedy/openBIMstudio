import { test, expect, type Page } from '@playwright/test';

/**
 * History-mediated mutations reach the open plan (item 5).
 *
 * Before this fix, move/copy via history.exec (and undo/redo, and every
 * history.push site) recorded the command without notifying the authoring
 * listeners, so an open plan missed a 3D move/copy until the next
 * notifying change or a manual Regenerate. The history manager now has
 * an onMutation bus (microtask-deferred, so it fires after the caller's
 * synchronous mutation completes) and authoring subscribes it to
 * notifyAuthoringChange.
 *
 * Proves in the real app, with the plan open and NO Regenerate press:
 *  1. Moving a wall in 3D through the real Move path
 *     (__obsAuthoring.transformElements -> history.push) moves the
 *     wall's lines in the plan SVG.
 *  2. Undo (Ctrl+Z -> history undo) moves it back in the plan.
 *  3. Copying the wall through the real Copy tool
 *     (ribbon Copy -> base click -> target click -> history.exec)
 *     adds a second wall to the docked plan.
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

async function waitPlanReady(page: Page): Promise<void> {
  await expect(page.locator('.obs-plan-overlay')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.obs-plan-overlay svg *').length > 10,
    null, { timeout: 30000 },
  );
  // The "Generating plan…" overlay covers the whole canvas while the plan
  // regenerates: wait until it is actually hidden before reading geometry.
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

/**
 * Furthest x of any cut wall line, in model units (the plan draws
 * segments as <line x1 y1 x2 y2> in model coordinates). Only lines in
 * the "cut" style (#111827) count — the plan also draws a light grid
 * (#eceff3/#d1d5db) that spans past the model. A wall (0,0)->(4,0)
 * reads 4; moved +5 in x it reads 9.
 */
async function planMaxX2(page: Page): Promise<number> {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('.obs-plan-overlay svg line')]
      .filter((l) => l.getAttribute('stroke') === '#111827');
    let max = -Infinity;
    for (const l of lines) {
      max = Math.max(max, Number(l.getAttribute('x1')), Number(l.getAttribute('x2')));
    }
    return max;
  });
}

async function openPlan(page: Page): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await waitPlanReady(page);
}

/** Project world (x, 0, z) through the live 3D camera (G5 pattern).
 * y=0, not 1.5: the Modify tools read the click point on the ground
 * plane, so the projected point must be the ground point itself — a
 * y=1.5 projection lands on the ground metres away from the wall. */
function makeProjector(page: Page) {
  return (wx: number, wz: number) =>
    page.evaluate(([wx2, wz2]) => {
      const cam = (window as any).__OBS_CTX__.world.camera.three;
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      const [px, py, pz] = [wx2, 0, wz2];
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
    }, [wx, wz]);
}

test('a 3D move (and its undo) live-syncs to the open plan', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__obsAuthoring), { timeout: 30000 }).toBe(true);

  const wallId = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [0, 0], end: [4, 0] }) as string;
  });
  expect(wallId, 'authored wall created').toBeTruthy();

  await openPlan(page);
  expect(await planStats(page).then((s) => s.authored), 'plan shows the one wall').toBe(1);
  expect(await planMaxX2(page), 'wall spans x 0..4 in the plan').toBeCloseTo(4, 0);

  // Move the wall +5 in x through the real Move path (transformElements
  // -> history.push). No Regenerate press: the plan must follow on its own.
  await page.evaluate((id) => {
    (window as any).__obsAuthoring.transformElements([id], (el: any) => {
      el.params.start[0] += 5;
      el.params.end[0] += 5;
    });
  }, wallId);
  await expect.poll(async () => planMaxX2(page), { timeout: 30000 }).toBeGreaterThan(8.9);
  expect(await planMaxX2(page), 'moved wall spans x 5..9 in the plan').toBeCloseTo(9, 0);

  // Undo moves it back — the undo path notifies too.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => planMaxX2(page), { timeout: 30000 }).toBeLessThan(4.1);
  expect(await planMaxX2(page), 'undone wall is back at x 0..4').toBeCloseTo(4, 0);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a 3D copy through the real Copy tool live-syncs to the docked plan', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__obsAuthoring), { timeout: 30000 }).toBe(true);

  const wallId = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [0, 0], end: [4, 0] }) as string;
  });
  expect(wallId, 'authored wall created').toBeTruthy();

  // Dock the plan so the 3D viewport stays clickable beside it.
  await openPlan(page);
  await page.locator('[data-obs-plan-dock]').click();
  await expect.poll(async () => page.evaluate(
    () => (document.querySelector('.obs-plan-overlay') as HTMLElement).dataset.planDockMode ?? null,
  ), { timeout: 10000 }).toBe('docked-right');
  expect((await planStats(page)).authored, 'plan shows the one wall').toBe(1);

  // Frame the wall and select it, then arm the Copy tool.
  const project = makeProjector(page);
  await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera;
    cam.controls.setLookAt(0, 4, 14, 0, 1.2, 0, false);
  });
  await page.waitForTimeout(500);
  await expect.poll(async () => {
    const a = await project(-4, 0);
    const b = await project(4, 0);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }, { timeout: 30000 }).toBeGreaterThan(150);
  await page.evaluate((id) => {
    (window as any).__OBS_CTX__.features.authoring.selectAllAuthored([id]);
  }, wallId);
  // Arm the Modify Copy tool (the ribbon's contextual Modify tab — its
  // button is labelled "Copy Move", NOT the Clipboard Copy, and NOT the
  // options bar's Copy, which is the multi-move drag tool). Wait for the
  // contextual tab's groups first: the strip only switches to them once
  // the selection sync lands.
  const strip = page.locator('.obs-ribbon__strip');
  await expect(strip.locator('.obs-ribbon-group__label', { hasText: 'Modify' }).first())
    .toBeVisible({ timeout: 15000 });
  await page.locator('.obs-ribbon-group')
    .filter({ has: page.locator('.obs-ribbon-group__label', { hasText: 'Modify' }) })
    .getByRole('button', { name: 'Copy Move', exact: true }).click();

  // Base click at world (0,0), target click at world (0,5): the copy
  // lands 5 m away in z. Both clicks land on the canvas, not on the wall.
  const base = await project(0, 0);
  const target = await project(0, 5);
  expect(base.behind, 'base point is in front of the camera').toBe(false);
  expect(target.behind, 'target point is in front of the camera').toBe(false);
  await page.mouse.click(base.x, base.y);
  await page.waitForTimeout(300);
  await page.mouse.click(target.x, target.y);

  // The docked plan gains the copied wall with no Regenerate press.
  await expect.poll(async () => (await planStats(page)).authored, { timeout: 30000 }).toBe(2);

  expect(errors, errors.join('\n')).toEqual([]);
});
