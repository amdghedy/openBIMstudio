import { test, expect, type Page } from '@playwright/test';

/**
 * G14 — snap overrides in plan: right-click menu + two-letter keys arm a
 * one-shot override (Endpoint / Midpoint / Center / Intersection /
 * Nearest); the next snap pick uses only that kind, then the override
 * clears. Esc / tool change disarm it; Shift-ortho still wins.
 *
 * Run ONLY against this branch's own build on :3113 (see
 * playwright.g14.config.ts next to the audit): the repo's default config
 * reuses any server already on :3000, and a sibling worktree's preview
 * server would make this spec silently test the wrong build.
 *   cd wt-g14 && npx vite build && npx vite preview --port 3113 --host 127.0.0.1 --strictPort
 *   npx playwright test --config ../playwright.g14.config.ts tests/e2e/revit-2d-g14-snap-overrides.spec.ts --project=chromium
 *
 * The "Snap Overrides" menu section exists only in the G14 build, so its
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

/** The plan footer status line (the plan panel writes it via [data-status]). */
async function footerStatus(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('.obs-plan-overlay [data-status]');
    return el ? (el.textContent ?? '') : '';
  });
}

async function openPlan(page: Page): Promise<void> {
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
}

async function setup(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(() => !!(window as any).__obsAuthoring, null, { timeout: 30000 });

  // Fixture: wall A (0..4, z=0), wall B (6..10, z=0).
  await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    await a.createElementByType('wall', { start: [0, 0], end: [4, 0] });
    await a.createElementByType('wall', { start: [6, 0], end: [10, 0] });
  });
  await openPlan(page);

  // Activate the model-line tool the way a user does: type ML in the plan
  // command line, Enter. (A model line, not a wall: walls are stored with
  // a location-line offset, so a placed wall's start is not the click
  // point; a model line stores the exact pick, which is what this spec
  // asserts on.)
  const empty = await worldToClient(page, 5, 3);
  await page.mouse.click(empty.x, empty.y);
  await page.keyboard.type('ml');
  await page.keyboard.press('Enter');
  await expect.poll(() => footerStatus(page), { timeout: 15000 }).toContain('Place mline');
}

test('snap overrides: menu arms Endpoint, next pick ignores the midpoint, override clears', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);

  // 1. Right-click menu lists the overrides — and only the kinds the plan
  // snapper can produce (no perpendicular / tangent / quadrant / vertex).
  const nearMid = await worldToClient(page, 2, 0.1);
  await page.mouse.click(nearMid.x, nearMid.y, { button: 'right' });
  const menu = page.locator('#obs-plan-ctx');
  await expect(menu).toBeVisible({ timeout: 5000 });
  await expect(menu).toContainText('Snap Overrides');
  for (const label of ['Endpoint (SE)', 'Midpoint (SM)', 'Center (SC)', 'Intersection (SI)', 'Nearest (SN)']) {
    await expect(menu).toContainText(label);
  }
  expect(await menu.textContent()).not.toMatch(/Perpendicular|Tangent|Quadrant|Vertex/);

  // 2. Arm Endpoint from the menu; the footer says so.
  await menu.getByText('Endpoint (SE)', { exact: true }).click();
  await expect.poll(() => footerStatus(page), { timeout: 5000 })
    .toContain('Snap override: Endpoint — next pick only');

  // 3. The discriminating pick: click just off wall A's midpoint. Without
  // the override this snaps to the midpoint (2, 0); with Endpoint armed
  // there is no endpoint in tolerance, so the click lands raw at (2, 0.1).
  await page.mouse.move(nearMid.x, nearMid.y);
  await expect.poll(() => footerStatus(page), { timeout: 5000 }).toContain('Snap override: Endpoint');
  await page.mouse.click(nearMid.x, nearMid.y);

  // 4. Second pick on wall A's start end: snaps to the endpoint (0, 0)
  // and consumes the override (one-shot). Finish the chain.
  const nearEnd = await worldToClient(page, 0.05, 0.05);
  await page.mouse.click(nearEnd.x, nearEnd.y);
  await page.keyboard.press('Enter');

  // The new model line runs from the raw click point to the snapped
  // endpoint — never through the midpoint.
  const lines = await page.evaluate(() => {
    const els = (window as any).__obsAuthoring.getElements();
    return els.filter((e: any) => e.type === 'mline')
      .map((e: any) => ({ start: [...e.params.start], end: [...e.params.end] }));
  });
  const placed = lines.find((w: any) => {
    const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 0.06 && Math.abs(a[1] - b[1]) < 0.06;
    return (near(w.start, [2, 0.1]) && near(w.end, [0, 0]))
      || (near(w.start, [0, 0]) && near(w.end, [2, 0.1]));
  });
  expect(placed, `no model line from (2, 0.1) to (0, 0) in ${JSON.stringify(lines)}`).toBeTruthy();

  // 5. The override is spent: moving the mouse no longer shows it.
  const far = await worldToClient(page, 8, 0.1);
  await page.mouse.move(far.x, far.y);
  await expect.poll(() => footerStatus(page), { timeout: 5000 }).not.toContain('Snap override');

  expect(errors, errors.join('\n')).toEqual([]);
});

test('snap overrides: typing SE arms Endpoint, Esc disarms it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);

  // Click empty space to focus the canvas (starts a chain — Esc cancels
  // it below), then type the two-letter override.
  const empty = await worldToClient(page, 5, 3);
  await page.mouse.click(empty.x, empty.y);
  await page.keyboard.press('s');
  await page.keyboard.press('e');
  await expect.poll(() => footerStatus(page), { timeout: 5000 })
    .toContain('Snap override: Endpoint — next pick only');

  await page.keyboard.press('Escape');
  await expect.poll(() => footerStatus(page), { timeout: 5000 }).not.toContain('Snap override');

  expect(errors, errors.join('\n')).toEqual([]);
});
