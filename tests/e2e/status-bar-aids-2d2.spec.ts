import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Main-shell status-bar drafting-aid toggles (2D-2 — A12 follow-up).
 *
 * The CAD viewer's drafting aids (GRID, SNAP, OSNAP, ORTHO, POLAR,
 * OTRACK, DUCS, DYN, LWT) used to live only inside the per-tab engine
 * closure, so the main-shell status bar showed no toggles at all. The
 * fix shares them through `cad-drafting-aids.ts`: the shell bar toggles
 * the same flags the viewer toggles switch, and reflects the current
 * state either way.
 *
 * Proves in the real app, through the real UI only:
 *  1. The shell status bar shows all nine aid buttons, at the viewer
 *     defaults (OSNAP/GRID/POLAR/OTRACK/DUCS/DYN/LWT on; SNAP/ORTHO off).
 *  2. Toggling OSNAP in the shell bar flips it off and back on.
 *  3. Toggling ORTHO on in the shell bar is visible in the Drawing
 *     Editor's own status bar when the editor opens.
 *  4. Toggling ORTHO off in the editor's status bar is reflected in
 *     the shell bar once the drawing is closed.
 *  5. DUCS (2D-29) shows in both status bars at its default (on), and
 *     toggling it in the editor is reflected in the shell bar.
 *
 * Run against a preview server on a distinct port (the repo config
 * reuses any server already on :3000, so a sibling worktree's build
 * could be tested by mistake — see the port rule in the task brief):
 *   npx vite build
 *   python3 -m http.server 3122 --directory dist
 *   npx playwright test --config=playwright.2d2aids.config.ts --project=chromium
 */

const AIDS = ['grid', 'snap', 'osnap', 'ortho', 'polar', 'otrack', 'ducs', 'dyn', 'lwt'] as const;

function shellAid(page: Page, key: string) {
  return page.locator(`.bb-status [data-aid="${key}"]`);
}

function cadAid(page: Page, key: string) {
  return page.locator(`.obs-cad-shell [data-s="${key}"]`).first();
}

test('shell status bar toggles the same drafting aids as the Drawing Editor', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  // Deterministic defaults: the shared aids persist in localStorage.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await expect(page.locator('.bb-status')).toBeVisible({ timeout: 30000 });

  // 1. All nine buttons, at the viewer defaults.
  const defaults: Record<string, boolean> = {
    grid: true, snap: false, osnap: true, ortho: false,
    polar: true, otrack: true, ducs: true, dyn: true, lwt: true,
  };
  for (const key of AIDS) {
    await expect(shellAid(page, key)).toBeVisible({ timeout: 15000 });
    await expect(shellAid(page, key)).toHaveAttribute(
      'aria-pressed', String(defaults[key]), { timeout: 15000 },
    );
  }

  // 2. Shell OSNAP toggles off and back on.
  await shellAid(page, 'osnap').click();
  await expect(shellAid(page, 'osnap')).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });
  await shellAid(page, 'osnap').click();
  await expect(shellAid(page, 'osnap')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });

  // 3. Shell ORTHO on carries into the Drawing Editor.
  await shellAid(page, 'ortho').click();
  await expect(shellAid(page, 'ortho')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell')).toBeVisible({ timeout: 30000 });
  await expect(cadAid(page, 'snap')).toBeVisible({ timeout: 30000 });
  await expect(cadAid(page, 'snap')).toHaveClass(/active/);
  await expect(cadAid(page, 'ortho')).toHaveClass(/active/);

  // 5. DUCS shows in the editor at its default (on); toggling it there
  // is reflected in the shell bar once the drawing is closed.
  await expect(cadAid(page, 'ducs')).toBeVisible({ timeout: 30000 });
  await expect(cadAid(page, 'ducs')).toHaveClass(/active/);
  await cadAid(page, 'ducs').click();
  await expect(cadAid(page, 'ducs')).not.toHaveClass(/active/);

  // 4. Editor ORTHO off is reflected in the shell bar after closing.
  await cadAid(page, 'ortho').click();
  await expect(cadAid(page, 'ortho')).not.toHaveClass(/active/);
  await page.locator('.obs-cad-shell .cadtab__x').first().click();
  await expect(page.locator('.obs-cad-shell')).toBeHidden({ timeout: 30000 });
  await expect(page.locator('.bb-status')).toBeVisible({ timeout: 30000 });
  await expect(shellAid(page, 'ortho')).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });
  await expect(shellAid(page, 'osnap')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
  await expect(shellAid(page, 'ducs')).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 });

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
