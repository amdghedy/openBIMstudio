import { test, expect, type Page } from '@playwright/test';

/**
 * "Select Similar" calls a method the selection engine lacks (item 6).
 *
 * Two entries to the same command were broken in different ways:
 *  - The ribbon / context-menu command (runModify "select-similar")
 *    called window.__obsSelection.selectSimilar — a method that object
 *    never had (it only exposes the SelectionEngine class), so it always
 *    warned and did nothing. It is rewired to the authoring selection:
 *    every element of the seed's type.
 *  - The BIM toolbox command (selectSimilar3d) called
 *    authoring.setSelectedIds — a method the authoring API never had —
 *    and its ?? fallback named selectIds, also missing, so it reported
 *    success while selecting nothing. The API now implements
 *    setSelectedIds (the replace-selection primitive) and the pack calls
 *    it directly, failing closed with a warning if it ever goes missing.
 *    (Invert Selection and Clear Selection in the same pack had the same
 *    hole and are fixed the same way; unit tests pin them.)
 *
 * Proves in the real app:
 *  1. Ribbon Select Similar on one wall selects every wall, not the column.
 *  2. Context-menu Select Similar (right-click the wall → Select flyout)
 *     does the same through the second UI entry point.
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

async function setupModel(page: Page): Promise<{ wall1: string; wall2: string; col: string }> {
  const ids = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    const wall1 = await a.createElementByType('wall', { start: [-4, 0], end: [0, 0] });
    const wall2 = await a.createElementByType('wall', { start: [2, 0], end: [6, 0] });
    const col = await a.createElementByType('column', { point: [0, 4], height: 3, thickness: 0.3 });
    return { wall1, wall2, col };
  });
  expect(ids.wall1, 'wall 1 created').toBeTruthy();
  expect(ids.wall2, 'wall 2 created').toBeTruthy();
  expect(ids.col, 'column created').toBeTruthy();
  return ids as { wall1: string; wall2: string; col: string };
}

async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...((window as any).__OBS_CTX__.features.authoring.getSelectedIds?.() ?? [])].sort() as string[]);
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__obsAuthoring), { timeout: 30000 }).toBe(true);
}

/** Project world (x, 1.5, z) through the live 3D camera (G5 pattern). */
function makeProjector(page: Page) {
  return (wx: number, wz: number) =>
    page.evaluate(([wx2, wz2]) => {
      const cam = (window as any).__OBS_CTX__.world.camera.three;
      const canvas = document.querySelector('canvas')!;
      const rect = canvas.getBoundingClientRect();
      const [px, py, pz] = [wx2, 1.5, wz2];
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

test('ribbon Select Similar selects every wall, not the column', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openApp(page);
  const ids = await setupModel(page);
  await page.evaluate((id) => {
    (window as any).__OBS_CTX__.features.authoring.selectAllAuthored([id]);
  }, ids.wall1);
  await expect.poll(async () => selectedIds(page), { timeout: 15000 }).toEqual([ids.wall1]);

  // The strip only switches to the contextual groups once the selection
  // sync lands — wait for the Select group before clicking.
  const strip = page.locator('.obs-ribbon__strip');
  await expect(strip.locator('.obs-ribbon-group__label', { hasText: 'Select' }).first())
    .toBeVisible({ timeout: 15000 });
  await strip.getByRole('button', { name: 'Select Similar', exact: true }).click();
  await expect.poll(async () => selectedIds(page), { timeout: 15000 })
    .toEqual([ids.wall1, ids.wall2].sort());

  expect(errors, errors.join('\n')).toEqual([]);
});

test('context-menu Select Similar selects every wall, not the column', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await openApp(page);
  const ids = await setupModel(page);

  // Frame the wall and right-click it off-centre: the temp-dim label
  // sits at the wall midpoint (-2) and swallows pointer events, so the
  // click goes to x=-3.5. Right-clicking an unselected authored element
  // selects it first (the menu then acts on it).
  const project = makeProjector(page);
  await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera;
    cam.controls.setLookAt(0, 4, 14, 0, 1.2, 0, false);
  });
  await page.waitForTimeout(500);
  await expect.poll(async () => {
    const a = await project(-4, 0);
    const b = await project(0, 0);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }, { timeout: 30000 }).toBeGreaterThan(100);
  await expect.poll(async () => {
    const p = await project(-3.5, 0);
    if (p.behind) return false;
    const hit = await page.evaluate(({ x, y }) =>
      (window as any).__OBS_CTX__.features.authoring.pickAuthoredElementAt({ clientX: x, clientY: y }),
      { x: p.x, y: p.y },
    );
    return hit === ids.wall1;
  }, { timeout: 30000 }).toBe(true);
  const pt = await project(-3.5, 0);
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
  const menu = page.locator('#obs-context-menu');
  await expect(menu).toBeVisible({ timeout: 15000 });
  // "Select Similar" lives in the Select flyout — hover it open first.
  // (The Modify flyout has a second, hidden "Select Similar" row, so the
  // click targets the visible one only.)
  await menu.getByText('Select', { exact: true }).first().hover();
  await menu.locator('span:visible', { hasText: 'Select Similar' }).click();
  await expect.poll(async () => selectedIds(page), { timeout: 15000 })
    .toEqual([ids.wall1, ids.wall2].sort());

  expect(errors, errors.join('\n')).toEqual([]);
});
