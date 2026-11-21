import { test, expect, type Page } from '@playwright/test';

/**
 * G3 Tab-cycle spec — Revit 2D audit gap G3.
 *
 * Proves in the real app, with real mouse/keyboard input:
 *   hovering the crossing of two walls and pressing Tab cycles the
 *   pre-highlight through the overlapping elements (footer readout
 *   "Tab 2/2: …", amber outline on the cycled wall), Tab again wraps to
 *   "Tab 1/2", and clicking selects the cycled element — not the topmost
 *   hit. Esc then resets the cycle (footer "Cancelled", amber gone).
 *
 * Fixture walls are created through the authoring API's own
 * history-wrapped createElementByType (the same path the draw tools use);
 * the hover / Tab / click / Esc under test are real user input.
 * Run: npx playwright test tests/e2e/g3-tab-cycle.spec.ts --project=chromium
 */
test('G3 Tab-cycle: hover two crossing walls, Tab cycles pre-highlight, click selects the cycled one', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });

  const authoring = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring ?? null);
  await expect.poll(async () => !!(await authoring()), { timeout: 60000 }).toBe(true);

  // ── Fixture: two crossing walls (horizontal + vertical, cross at 0,0)
  const wallIds = await page.evaluate(async () => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    const w1 = await a.createElementByType('wall', { start: [-4, 0], end: [4, 0] });
    const w2 = await a.createElementByType('wall', { start: [0, -3], end: [0, 3] });
    return [w1, w2];
  });
  expect(wallIds[0], 'wall 1 created').toBeTruthy();
  expect(wallIds[1], 'wall 2 created').toBeTruthy();

  const wallInfo = () =>
    page.evaluate(() => {
      const els = (window as any).__OBS_CTX__?.features?.authoring?.getElements?.() ?? [];
      return els
        .filter((e: any) => e.type === 'wall')
        .map((e: any) => ({ id: e.id, name: e.name, start: e.params?.start, end: e.params?.end }));
    });
  await expect.poll(async () => (await wallInfo()).length, { timeout: 30000 }).toBe(2);
  const walls = await wallInfo();
  expect(new Set(walls.map((w) => w.id)).size, 'two distinct walls').toBe(2);
  // Wall names collide in this app (both may be "Wall 1"), so the fixture
  // walls are told apart by geometry: walls[0] is horizontal, walls[1] vertical.
  const horizontalWall = walls.find((w) => w.start[1] === w.end[1]);
  const verticalWall = walls.find((w) => w.start[0] === w.end[0]);
  expect(horizontalWall, 'horizontal fixture wall').toBeTruthy();
  expect(verticalWall, 'vertical fixture wall').toBeTruthy();

  // ── Open the plan view (View tab → Plan)
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  const overlay = page.locator('.obs-plan-overlay');
  await expect(overlay).toBeVisible({ timeout: 30000 });
  const svg = overlay.locator('svg').first();
  await expect.poll(async () => await svg.locator('line').count(), { timeout: 60000 }).toBeGreaterThan(0);

  const footerStatus = () =>
    page.evaluate(() => document.querySelector('.obs-plan-overlay [data-status]')?.textContent ?? '');
  const amberCount = () =>
    svg.locator('line[stroke="#f59e0b"]').count();
  const selectedIds = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring?.getSelectedIds?.() ?? []);

  // Screen position of world (0,0) — the crossing — from the plan SVG viewBox.
  const cross = await page.evaluate(() => {
    const s = document.querySelector('.obs-plan-overlay svg') as SVGSVGElement;
    const vb = s.viewBox.baseVal;
    const r = s.getBoundingClientRect();
    return {
      x: r.left + ((0 - vb.x) / vb.width) * r.width,
      y: r.top + ((0 - vb.y) / vb.height) * r.height,
    };
  });
  expect(cross.x, 'crossing is on screen').toBeGreaterThan(0);
  expect(cross.y, 'crossing is on screen').toBeGreaterThan(0);

  // The cycled wall is identified from the amber highlight itself: the
  // horizontal wall's segments are horizontal SVG lines, the vertical
  // wall's are vertical. (Wall names collide — both may be "Wall 1" — so
  // the footer readout names the candidate but cannot identify it.)
  const amberWallId = async (): Promise<string> => {
    const orientation = await page.evaluate(() => {
      const lines = [...document.querySelectorAll('.obs-plan-overlay svg line[stroke="#f59e0b"]')];
      if (!lines.length) return 'none';
      // The longest amber line is the wall edge; the short end caps run
      // perpendicular to it and must not decide the orientation.
      let best: Element | null = null;
      let bestLen = -1;
      for (const l of lines) {
        const x1 = Number(l.getAttribute('x1')), y1 = Number(l.getAttribute('y1'));
        const x2 = Number(l.getAttribute('x2')), y2 = Number(l.getAttribute('y2'));
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len > bestLen) { bestLen = len; best = l; }
      }
      if (!best) return 'none';
      const x1 = Number(best.getAttribute('x1')), y1 = Number(best.getAttribute('y1'));
      const x2 = Number(best.getAttribute('x2')), y2 = Number(best.getAttribute('y2'));
      if (Math.abs(y1 - y2) < 1e-9 && Math.abs(x1 - x2) > 1e-9) return 'horizontal';
      if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) > 1e-9) return 'vertical';
      return 'mixed';
    });
    expect(orientation, 'amber highlight has a single orientation').not.toBe('none');
    expect(orientation, 'amber highlight is one wall, not both').not.toBe('mixed');
    return (orientation === 'horizontal' ? horizontalWall : verticalWall)!.id;
  };

  // ── Hover the crossing, Tab once: pre-highlight moves to 2/2
  await page.mouse.move(cross.x, cross.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('Tab 2/2:');
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('click to select');
  await expect.poll(async () => await amberCount(), { timeout: 10000 }).toBeGreaterThan(0);
  const secondId = await amberWallId();

  // ── Tab again: wraps back to 1/2 (two overlapping elements)
  await page.keyboard.press('Tab');
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('Tab 1/2:');
  const firstId = await amberWallId();
  expect(firstId, 'wrap returns to the other wall').not.toBe(secondId);
  expect([horizontalWall!.id, verticalWall!.id].sort(), 'both walls are the cycle').toEqual([firstId, secondId].sort());

  // ── Click selects the cycled element (1/2), not the topmost hit
  await page.mouse.click(cross.x, cross.y);
  await expect.poll(async () => await selectedIds(), { timeout: 10000 }).toEqual([firstId]);
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('Selected');
  await expect.poll(async () => await amberCount(), { timeout: 10000 }).toBe(0);

  // ── Esc resets the cycle: hover, Tab, Esc → "Cancelled", amber gone
  await page.mouse.move(cross.x, cross.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('Tab 2/2:');
  await page.keyboard.press('Escape');
  await expect.poll(async () => await footerStatus(), { timeout: 10000 }).toContain('Cancelled');
  await expect.poll(async () => await amberCount(), { timeout: 10000 }).toBe(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
