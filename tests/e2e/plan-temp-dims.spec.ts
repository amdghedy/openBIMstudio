import { test, expect, type Page } from '@playwright/test';

/**
 * G13 — temporary dimensions in plan: select a wall -> temp dims appear to
 * the nearest references -> click a label, type a new value -> the wall
 * moves / resizes accordingly.
 *
 * Run ONLY against this branch's own build on :3100 (see
 * playwright.g13.config.ts next to the audit): the repo's default config
 * reuses any server already on :3000, and a sibling worktree's preview
 * server would make this spec silently test the wrong build.
 *   npx vite build && npx vite preview --port 3100 --host 127.0.0.1
 *   npx playwright test --config playwright.g13.config.ts tests/e2e/plan-temp-dims.spec.ts --project=chromium
 *
 * The [data-obs-plan-temp-dim] labels exist only in the G13 build, so their
 * presence also proves the page under test is this build, not base.
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

/** Map a plan world point (x east, z north, metres) to client pixels. */
async function worldToClient(page: Page, wx: number, wz: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([x, z]) => {
    const svg = document.querySelector('.obs-plan-overlay svg') as unknown as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = x; pt.y = -z;
    const sp = pt.matrixTransform(svg.getScreenCTM()!);
    return { x: sp.x, y: sp.y };
  }, [wx, wz]);
}

async function wallParams(page: Page, id: string): Promise<{ start: number[]; end: number[] } | null> {
  return page.evaluate((wid) => {
    const els = (window as any).__obsAuthoring.getElements();
    const el = els.find((e: any) => e.id === wid);
    return el ? { start: [...el.params.start], end: [...el.params.end] } : null;
  }, id);
}

async function waitWall(page: Page, id: string, sx: number, sz: number, ex: number, ez: number): Promise<void> {
  await expect.poll(async () => wallParams(page, id), { timeout: 15000 }).toEqual({
    start: [sx, sz], end: [ex, ez],
  });
}

test('plan temp dims: select a wall -> dims to nearest refs -> click-to-edit moves/resizes it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(() => !!(window as any).__obsAuthoring, null, { timeout: 30000 });

  // Fixture (same layout as the node test): A (0..4, z=0), B (6..10, z=0)
  // collinear, C (6..10, z=3) parallel to B.
  const ids = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    const mk = (s: number[], e: number[]) => a.createElementByType('wall', { start: s, end: e });
    return { A: await mk([0, 0], [4, 0]), B: await mk([6, 0], [10, 0]), C: await mk([6, 3], [10, 3]) };
  });
  expect(ids.B, 'wall B was not created').toBeTruthy();

  // Open the plan view.
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.obs-plan-overlay')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.obs-plan-overlay svg *').length > 10,
    null, { timeout: 30000 },
  );
  // The "Generating plan…" overlay covers the whole canvas while the plan
  // regenerates: a click that lands while it is up hits the overlay, not
  // the SVG, and selects nothing. Wait until it is actually hidden.
  await page.waitForFunction(() => {
    const text = [...document.querySelectorAll('.obs-plan-overlay div')]
      .find((el) => el.textContent === 'Generating plan…');
    return !text || getComputedStyle(text.parentElement as Element).display === 'none';
  }, null, { timeout: 60000 });

  // Select wall B by clicking its midpoint.
  const mid = await worldToClient(page, 8, 0);
  await page.mouse.click(mid.x, mid.y);
  const labels = page.locator('[data-obs-plan-temp-dim]');
  await expect(labels).toHaveCount(3, { timeout: 15000 });

  // Length of B, gap to A at B's start, perpendicular gap to C.
  await expect(page.locator('[data-temp-dim-param="length"]')).toHaveText('4.000 m');
  await expect(page.locator('[data-temp-dim-param="gapStart"]')).toHaveText('2.000 m');
  await expect(page.locator('[data-temp-dim-param="gapPerp"]')).toHaveText('3.000 m');
  await expect(page.locator('[data-temp-dim-param="gapEnd"]')).toHaveCount(0);

  // 1. Edit the start gap 2 m -> 3 m: B's start moves to x=7, far end fixed.
  await page.locator('[data-temp-dim-param="gapStart"]').click();
  const input = page.locator('.obs-plan-temp-dim-input');
  await expect(input).toBeVisible({ timeout: 5000 });
  await expect(input).toHaveValue('2.000 m');
  await input.fill('3 m');
  await input.press('Enter');
  await waitWall(page, ids.B, 7, 0, 10, 0);
  await expect(page.locator('[data-temp-dim-param="gapStart"]')).toHaveText('3.000 m');
  await expect(page.locator('[data-temp-dim-param="length"]')).toHaveText('3.000 m');

  // 2. Edit the perpendicular gap 3 m -> 4 m: the whole wall moves away from C.
  await page.locator('[data-temp-dim-param="gapPerp"]').click();
  await expect(input).toBeVisible({ timeout: 5000 });
  await expect(input).toHaveValue('3.000 m');
  await input.fill('4 m');
  await input.press('Enter');
  await waitWall(page, ids.B, 7, -1, 10, -1);
  await expect(page.locator('[data-temp-dim-param="gapPerp"]')).toHaveText('4.000 m');

  // 3. Edit the length 3 m -> 5 m: right end fixed at x=10, start moves to x=5.
  await page.locator('[data-temp-dim-param="length"]').click();
  await expect(input).toBeVisible({ timeout: 5000 });
  await expect(input).toHaveValue('3.000 m');
  await input.fill('5 m');
  await input.press('Enter');
  await waitWall(page, ids.B, 5, -1, 10, -1);
  await expect(page.locator('[data-temp-dim-param="length"]')).toHaveText('5.000 m');

  expect(errors, errors.join('\n')).toEqual([]);
});
