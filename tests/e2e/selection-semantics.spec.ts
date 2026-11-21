import { test, expect, type Page } from '@playwright/test';

/**
 * G4 selection semantics in the real plan view (Revit 2D gap G4 + G15):
 * Shift-click removes from a multi-selection, the Filter dialog narrows a
 * mixed wall + column selection by category, Ctrl+Left restores the
 * previous selection, and right-click → Select All Instances selects all
 * walls (visible in view). Uses the visible UI only.
 *
 * Run: npx playwright test tests/e2e/selection-semantics.spec.ts --project=chromium
 */

async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function openPlan(page: Page): Promise<void> {
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('#obs-plan-cmdline input')).toBeVisible({ timeout: 30000 });
}

/** Map a plan-world point (metres) to client pixels via the SVG's own transform (mirrors clientToWorld). */
async function worldToClient(page: Page, wx: number, wz: number): Promise<{ x: number; y: number }> {
  return await page.evaluate(({ wx, wz }) => {
    const svg = [...document.querySelectorAll('.obs-plan-overlay svg')]
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 200 && r.height > 200)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0]?.s as SVGSVGElement | undefined;
    if (!svg) throw new Error('plan svg not found');
    const pt = svg.createSVGPoint();
    pt.x = wx;
    pt.y = -wz; // screen y is -worldZ
    const ctm = svg.getScreenCTM();
    if (!ctm) throw new Error('plan svg has no screen transform');
    const c = pt.matrixTransform(ctm);
    return { x: c.x, y: c.y };
  }, { wx, wz });
}

async function clickWorld(page: Page, wx: number, wz: number): Promise<void> {
  const p = await worldToClient(page, wx, wz);
  await page.mouse.click(p.x, p.y);
}

async function clickWorldWith(page: Page, wx: number, wz: number, key: 'Control' | 'Shift'): Promise<void> {
  const p = await worldToClient(page, wx, wz);
  await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  await page.keyboard.up(key);
}

/** Run a plan command through the command line (WA wall, CM column, SEL select). */
async function planCommand(page: Page, cmd: string): Promise<void> {
  const line = page.locator('#obs-plan-cmdline input');
  await line.click();
  await line.fill(cmd);
  await line.press('Enter');
}

function planFooter(page: Page) {
  return page.locator('.obs-plan-overlay [data-status]');
}

test('plan: Shift-click removes, Filter narrows a mixed selection, Ctrl+Left restores, right-click Select All Instances', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await openPlan(page);

  // ── Draw two walls and one column in the plan ──────────────────────────
  // Note: after a canvas click, focus stays in the command-line input, so a
  // bare Enter would submit the (empty) command line instead of finishing
  // the chain — finish each wall with the FIN command instead.
  await planCommand(page, 'wa');
  await expect(page.getByText('Place wall', { exact: false }).first()).toBeVisible({ timeout: 10000 });
  await clickWorld(page, -4, 0);
  await clickWorld(page, 4, 0);
  await planCommand(page, 'fin');
  await expect(planFooter(page)).toHaveText(/wall path finished/, { timeout: 10000 });
  await clickWorld(page, -4, 3);
  await clickWorld(page, 4, 3);
  await planCommand(page, 'fin');
  await expect(planFooter(page)).toHaveText(/wall path finished/, { timeout: 10000 });
  await planCommand(page, 'cm');
  await clickWorld(page, 0, -3);
  await planCommand(page, 'sel');
  // Let the plan regenerate after the last placement.
  await page.waitForTimeout(1500);

  // ── Click wall 1, Ctrl-click wall 2 → 2 selected ───────────────────────
  await clickWorld(page, 0, 0);
  await expect(planFooter(page)).toHaveText(/Selected wall/, { timeout: 10000 });
  await clickWorldWith(page, 0, 3, 'Control');
  await expect(planFooter(page)).toHaveText(/2 selected/, { timeout: 10000 });

  // ── Shift-click wall 2 → removed, back to the single wall ─────────────
  await clickWorldWith(page, 0, 3, 'Shift');
  await expect(planFooter(page)).toHaveText(/Selected wall/, { timeout: 10000 });
  await expect(planFooter(page)).not.toHaveText(/2 selected/);

  // ── Ctrl-click the column → mixed wall + column selection ─────────────
  await clickWorldWith(page, 0, -3, 'Control');
  await expect(planFooter(page)).toHaveText(/2 selected/, { timeout: 10000 });

  // ── Filter dialog: uncheck walls → only the column stays ──────────────
  await page.getByRole('button', { name: 'Filter…', exact: true }).click();
  const modal = page.locator('.obs-form-modal-overlay');
  await expect(modal.getByText('Filter Selection')).toBeVisible({ timeout: 10000 });
  await expect(modal.getByText('wall (1)')).toBeVisible();
  await expect(modal.getByText('column (1)')).toBeVisible();
  await page.evaluate(() => {
    const labels = [...document.querySelectorAll('.obs-form-modal-overlay label')];
    const label = labels.find((l) => l.textContent?.trim() === 'wall (1)');
    const input = label?.parentElement?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (!input) throw new Error('wall checkbox not found');
    if (input.checked) input.click();
  });
  await modal.getByRole('button', { name: 'Apply Filter', exact: true }).click();
  await expect(planFooter(page)).toHaveText(/Filter applied · 1 element selected/, { timeout: 10000 });

  // ── Ctrl+Left restores the previous (wall + column) selection ──────────
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await page.keyboard.press('Control+ArrowLeft');
  await expect(planFooter(page)).toHaveText(/Previous selection restored · 2 elements selected/, { timeout: 10000 });

  // ── Right-click a wall → Select All Instances → both walls ─────────────
  const wall1 = await worldToClient(page, 0, 0);
  await page.mouse.click(wall1.x, wall1.y, { button: 'right' });
  const ctxMenu = page.locator('#obs-plan-ctx');
  await expect(ctxMenu).toBeVisible({ timeout: 10000 });
  await ctxMenu.getByText('Select All Instances', { exact: true }).click();
  await expect(planFooter(page)).toHaveText(/Select All Instances · 2 elements selected/, { timeout: 10000 });

  expect(errors, errors.join('\n')).toEqual([]);
});
