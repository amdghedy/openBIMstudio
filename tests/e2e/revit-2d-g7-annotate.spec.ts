import { test, expect, type Page } from '@playwright/test';

/**
 * Revit 2D environment audit gap G7 — annotate distinctions.
 *
 * Proves in the real app, in the plan view:
 *  1. Room tag tags only rooms (a click inside a room places "Room 101
 *     Office"; a click on a wall with the Room tag active places nothing
 *     and says so).
 *  2. Continuous dimension chains two segments (three boundary picks +
 *     an empty-space click place two dimension labels, not one).
 *  3. Detail Line vs Insulation render differently (insulation draws a
 *     batting wave; a detail line stays a plain line).
 *
 * Run against THIS branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3101 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3101 and which starts no webServer.
 * Each test first proves it loaded the G7 build (verifyOwnBuild): on the
 * pre-G7 build the Space button is a live tag button; here it is a
 * planned() stub carrying data-planned="1".
 */

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

/**
 * Prove the loaded page is THIS branch's build before asserting anything.
 * G7 turned the Space tag into a planned() stub; the pre-G7 build has it
 * as a live button with no data-planned marker. Fails fast with a clear
 * message instead of silently testing the wrong build.
 */
async function verifyOwnBuild(page: Page): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'Annotate', exact: true }).click();
  const space = ribbon.getByRole('button', { name: 'Space', exact: true });
  await expect(space).toBeVisible({ timeout: 15000 });
  await expect(space).toHaveAttribute('data-planned', '1');
}

async function openPlan(page: Page): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('.obs-plan-overlay')).toBeVisible({ timeout: 15000 });
  await waitPlanRendered(page);
}

/** The plan sets the SVG viewBox when renderPlan runs — wait for it, so a
 * later step never types or clicks while the plan is still generating. */
async function waitPlanRendered(page: Page): Promise<void> {
  await expect.poll(async () => page.evaluate(() =>
    document.querySelector('.obs-plan-overlay svg')?.getAttribute('viewBox'),
  ), { timeout: 30000 }).not.toBeNull();
}

/** Footer stats: "N authored · M fragments · K segments · zoom 100%". */
async function planStats(page: Page): Promise<string> {
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.obs-plan-overlay span')];
    const el = els.find((e) => /^\d+ authored ·/.test((e.textContent || '').trim()));
    return (el?.textContent || '').trim();
  });
}

async function ribbonButton(page: Page, tab: string, name: string, hint?: string): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: tab, exact: true }).click();
  await ribbon.getByRole('button', { name, exact: true }).click();
  if (hint) {
    // Ribbon tools arm via a 40 ms setTimeout — wait for the plan hint to
    // show the tool before clicking, so the click cannot land in the
    // previous tool (or in Select).
    await expect(page.getByText(hint, { exact: false }).first()).toBeVisible({ timeout: 15000 });
  }
}

/** Map a plan world point (x east, z north, metres) to page coordinates. */
async function worldToScreen(page: Page, wx: number, wz: number): Promise<{ x: number; y: number }> {
  return page.evaluate(({ wx, wz }) => {
    const svg = document.querySelector('.obs-plan-overlay svg') as SVGSVGElement | null;
    if (!svg) throw new Error('plan svg not found');
    const rect = svg.getBoundingClientRect();
    const vb = (svg.getAttribute('viewBox') || '0 0 100 100').split(/\s+/).map(Number);
    const [minX, minY, w, h] = vb;
    // screen() flips Z so north points up: screen y = -z.
    return { x: rect.x + ((wx - minX) / w) * rect.width, y: rect.y + ((-wz - minY) / h) * rect.height };
  }, { wx, wz });
}

async function clickWorld(page: Page, wx: number, wz: number): Promise<void> {
  const p = await worldToScreen(page, wx, wz);
  await page.mouse.click(p.x, p.y);
}

async function planSvgTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('.obs-plan-overlay svg text')].map((t) => (t.textContent || '').trim()).filter(Boolean));
}

async function planFooter(page: Page): Promise<string> {
  return (await page.locator('.obs-plan-overlay [data-status]').textContent()) ?? '';
}

/**
 * Draw one wall in plan via the plan command line (like the smoke spec).
 * The ribbon Wall button would also arm the 3D wall tool, whose Options
 * Bar then sits over the ribbon tabs and blocks the next tab click; the
 * command line arms the plan tool only. The input is clicked and filled
 * (not bare-letter typed) so the step does not depend on the key handler
 * winning a race with plan generation; Enter still runs the real command
 * parser. The wait afterwards polls the footer author count — counting
 * SVG lines is vacuous, the cursor overlay draws lines of its own.
 */
async function drawWall(page: Page, x1: number, z1: number, x2: number, z2: number): Promise<void> {
  await waitPlanRendered(page);
  const line = page.locator('#obs-plan-cmdline input');
  await expect(line).toBeVisible({ timeout: 15000 });
  await line.click();
  await line.fill('wa');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Place wall', { exact: false }).first()).toBeVisible({ timeout: 15000 });
  await clickWorld(page, x1, z1);
  await clickWorld(page, x2, z2);
  // The wall lands after an async plan regeneration: wait until the footer
  // counts it as an authored element before doing anything else with it.
  await expect.poll(async () => planStats(page), { timeout: 20000 }).toMatch(/^[1-9]\d* authored/);
  await page.keyboard.press('Escape');
}

test('G7: Room tag tags only rooms', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await verifyOwnBuild(page);

  // A real room in the app's room store, before the plan opens so its
  // boundary renders with the plan.
  const roomId = await page.evaluate(() => {
    const store = (window as any).__obsRooms;
    if (!store) throw new Error('rooms store not loaded');
    const room = store.createRoom({
      name: 'Office', number: '101',
      boundary: [{ x: -2, z: -1.5 }, { x: 2, z: -1.5 }, { x: 2, z: 1.5 }, { x: -2, z: 1.5 }],
    });
    return room.id as string;
  });
  expect(roomId).toMatch(/^room-/);

  await openPlan(page);
  // The room boundary + name render in the plan.
  await expect.poll(async () => (await planSvgTexts(page)).filter((s) => s.includes('101 Office')), { timeout: 15000 }).toHaveLength(1);

  // A wall to click on: outside the room, so the Room tag must refuse it.
  await drawWall(page, -3, -3, 3, -3);

  await ribbonButton(page, 'Annotate', 'Room tag', 'Room tag · click near element');
  await clickWorld(page, 0, 0);
  await expect.poll(async () => (await planSvgTexts(page)).filter((s) => s === 'Room 101 Office'), { timeout: 15000 }).toHaveLength(1);

  // Same tool, on the wall: no second tag, and the footer says why.
  await clickWorld(page, 0, -3);
  await expect.poll(async () => planFooter(page), { timeout: 10000 }).toContain('no room here');
  expect((await planSvgTexts(page)).filter((s) => s === 'Room 101 Office')).toHaveLength(1);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G7: Continuous dimension chains two segments', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await verifyOwnBuild(page);
  await openPlan(page);

  await drawWall(page, -4, 0, 4, 0);

  const before = await planSvgTexts(page);
  await ribbonButton(page, 'Annotate', 'Continuous', 'Continuous Dimension · pick boundaries');
  // The header Chain checkbox follows the Continuous mode.
  await expect.poll(async () => page.evaluate(() =>
    [...document.querySelectorAll('.obs-plan-overlay input[type="checkbox"]')].some((c) => (c as HTMLInputElement).checked),
  ), { timeout: 10000 }).toBe(true);

  // Three boundaries: left end, a face point, right end — then an
  // empty-space click places the chain.
  await clickWorld(page, -4, 0);
  await clickWorld(page, 1, 0);
  await clickWorld(page, 4, 0);
  await clickWorld(page, 0, 4);

  // Exactly two new dimension labels appear (two chained segments, not a
  // single aligned dimension), with different lengths.
  await expect.poll(async () => (await planSvgTexts(page)).length, { timeout: 15000 }).toBe(before.length + 2);
  const labels = (await planSvgTexts(page)).slice(before.length);
  expect(new Set(labels).size).toBe(2);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('G7: Detail Line and Insulation render differently', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await verifyOwnBuild(page);
  await openPlan(page);

  await ribbonButton(page, 'Annotate', 'Detail Line', 'Modify | Place mline · Enter finish path');
  await clickWorld(page, -3, 1);
  await clickWorld(page, 3, 1);
  await page.keyboard.press('Escape');

  await ribbonButton(page, 'Annotate', 'Insulation', 'Modify | Place insulation · Enter finish path');
  await clickWorld(page, -3, -1);
  await clickWorld(page, 3, -1);
  await page.keyboard.press('Escape');

  // Exactly one batting wave: the insulation run. The detail line has none.
  await expect.poll(async () => page.evaluate(() =>
    document.querySelectorAll('.obs-plan-overlay svg [data-obs-insulation="batting"]').length,
  ), { timeout: 15000 }).toBe(1);
  const plainLines = await page.evaluate(() =>
    [...document.querySelectorAll('.obs-plan-overlay svg line')]
      .filter((l) => !l.hasAttribute('data-obs-insulation')).length);
  expect(plainLines).toBeGreaterThan(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
