import { test, expect } from '@playwright/test';

/**
 * G5 double-click spec — Revit 2D environment, audit gap G5.
 *
 * Proves in the real app, with real mouse double-clicks (no test hooks
 * driving the commands directly):
 *   3D: double-click a wall opens Type Properties for that wall;
 *   plan: double-click a wall opens Type Properties for that wall;
 *   plan: double-click a text note still opens the text editor, and the
 *         edited text is saved.
 *
 * The fixture wall is created through the authoring API's own
 * history-wrapped createElementByType (the same path the draw tools use);
 * the click points are computed from the app's own rendered geometry
 * (Three.js camera projection in 3D, the plan SVG's screen CTM in plan).
 * Run against this branch's own preview server on a distinct port — the
 * default :3000 config reuses any server already listening there, which
 * can silently serve another worktree's build. Serve this branch's dist
 * on its own port (e.g. :3100) and point Playwright at it with a config
 * that sets that port as baseURL with reuseExistingServer: false; the
 * spec asserts a build marker up front and fails fast on a wrong build.
 */

test('G5 double-click: wall opens Type Properties in 3D and plan; annotation still edits text', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  const authoringCard = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(authoringCard).toBeVisible({ timeout: 30000 });
  await authoringCard.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });

  const authoring = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring ?? null);
  await expect.poll(async () => !!(await authoring()), { timeout: 30000 }).toBe(true);
  await page.waitForFunction(() => !!(window as any).__obsBIMExperience, undefined, { timeout: 60000 });

  // Build marker: refuse to run against a stale build. The repo's default
  // Playwright config reuses any server already listening on :3000, so
  // another worktree's preview can silently serve the wrong build. This
  // branch's dblclick-fit handle exposes `handleDoubleClick` (pre-G5
  // builds expose only `fitUnderCursor`); if it is absent, the loaded
  // page is not this branch — fail here, not on a misleading assertion.
  // Run this spec against this branch's own preview port (see the header).
  await page.waitForFunction(
    () => typeof (window as any).__OBS_CTX__?.features?.dblclickFit?.handleDoubleClick === 'function',
    undefined, { timeout: 60000 },
  );

  // ── Fixture: one wall, x -4..4 at z=0 ──
  const wallId = await page.evaluate(async () => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    return a.createElementByType('wall', { start: [-4, 0], end: [4, 0] });
  });
  expect(wallId, 'wall created').toBeTruthy();

  const typeDialog = page.locator('.obs-bim-dialog h2', { hasText: 'Type Properties' });
  const closeTypeDialog = async () => {
    await page.locator('.obs-bim-dialog__close').click();
    await expect(page.locator('.obs-bim-dialog-host')).toHaveAttribute('data-visible', '0');
  };

  // ── 3D: frame the wall, then double-click it off-centre ──
  // The default home camera sits at (50,50,50), where an 8 m wall spans
  // ~37 px and the editable temp-dim label (which sits at the wall
  // midpoint and swallows pointer events — see the PR description) covers
  // it entirely. So frame the wall with the camera controls' own setLookAt
  // (the orbit spec drives the camera the same way) and click the wall at
  // x=-2, well clear of the midpoint label.
  // Project world (x, 1.5, 0) through the live camera by hand (THREE is
  // not a page global): view matrix then projection matrix, both plain
  // column-major element arrays on the camera object.
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
  // Wait until the wall is actually framed large. The pick check below
  // alone is not enough: it can pass spuriously on the edge of the tiny
  // un-framed wall (default camera at (50,50,50)), whose midpoint is
  // covered by the editable temp-dim label — the second click of the
  // double-click would then land on the label and be swallowed. The
  // projected span only exceeds 150 px once the camera has really moved.
  await expect.poll(async () => {
    const a = await projectWallPoint(-4);
    const b = await projectWallPoint(4);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }, { timeout: 30000 }).toBeGreaterThan(150);
  // Prove the pick path sees the wall at the projected point before
  // double-clicking there (mesh built + camera framed).
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
  await page.mouse.dblclick(wallPt.x, wallPt.y);
  await expect(typeDialog).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.obs-bim-dialog__header p')).toContainText('wall');
  await expect(page.locator('.obs-bim-dialog__hint')).toContainText('wall type defaults');
  await closeTypeDialog();

  // ── Plan: double-click the same wall ──
  // First deselect: with the wall selected the options bar is visible and
  // its strip intercepts pointer events on the ribbon's View tab (the
  // click retries until the test times out). Esc clears the selection —
  // the same neutral state the smoke spec clicks the ribbon from — and
  // the plan double-click below re-selects the wall itself.
  await page.keyboard.press('Escape');
  await expect.poll(async () => page.evaluate(() =>
    (window as any).__OBS_CTX__.features.authoring.getSelectedIds().length,
  ), { timeout: 30000 }).toBe(0);
  const ribbon = page.locator('.obs-ribbon');
  await ribbon.getByRole('button', { name: 'View', exact: true }).click();
  await ribbon.getByRole('button', { name: 'Plan', exact: true }).click();
  await expect(page.locator('#obs-plan-cmdline input')).toBeVisible({ timeout: 30000 });
  await expect.poll(async () => page.evaluate(() => {
    const svg = document.querySelector('.obs-plan-overlay svg');
    return svg ? svg.querySelectorAll('line,path,rect,polygon').length : 0;
  }), { timeout: 30000 }).toBeGreaterThan(0);
  // World (0,0) is the wall midpoint; the plan SVG uses world coords
  // directly (y = -worldZ), so its own screen CTM gives the click point.
  const planWallPt = await page.evaluate(() => {
    const svg = document.querySelector('.obs-plan-overlay svg') as unknown as SVGSVGElement;
    const pt = svg.createSVGPoint();
    pt.x = 0; pt.y = 0;
    const sp = pt.matrixTransform(svg.getScreenCTM()!);
    return { x: sp.x, y: sp.y };
  });
  await page.mouse.dblclick(planWallPt.x, planWallPt.y);
  await expect(typeDialog).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.obs-bim-dialog__header p')).toContainText('wall');
  await closeTypeDialog();

  // ── Plan annotation: double-click a note still edits its text ──
  await page.evaluate(() => {
    (window as any).__obsPlanAnno.load({ notes: [{ x: 0, z: -2.5, text: 'G5-NOTE' }] });
  });
  const note = page.locator('.obs-plan-overlay svg text', { hasText: 'G5-NOTE' }).first();
  await expect(note).toBeVisible({ timeout: 10000 });
  const noteBox = (await note.boundingBox())!;
  await page.mouse.dblclick(noteBox.x + noteBox.width / 2, noteBox.y + noteBox.height / 2);
  const modal = page.locator('.obs-form-modal-overlay');
  await expect(modal).toBeVisible({ timeout: 10000 });
  await expect(modal.getByText('Edit note')).toBeVisible();
  const input = modal.locator('input').first();
  await expect(input).toHaveValue('G5-NOTE');
  await input.fill('G5-NOTE-EDITED');
  await modal.getByRole('button', { name: 'OK' }).click();
  const noteText = await page.evaluate(() =>
    (window as any).__obsPlanAnno.serialize().notes[0].text);
  expect(noteText).toBe('G5-NOTE-EDITED');

  expect(errors, errors.join('\n')).toEqual([]);
});
