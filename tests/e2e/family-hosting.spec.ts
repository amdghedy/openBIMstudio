import { test, expect, type Page } from '@playwright/test';

/** Leave the welcome screen the way a user does (the 3D BIM Platform card); it covers the ribbon on first load. */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

// Slice 9 — generic family hosting, browser proof.
//
// This spec does NOT drive the ribbon (there is no hosting UI yet —
// that is the gap this slice closes at the model level). Instead it
// proves the shipped `familyHosting` service, registered by the
// parametric boot, loads and behaves identically in the browser's JS
// engine: wall + face attach, host-change propagation, and the audit.
// The geometry itself is pinned to closed forms by the node suite
// (tests/parametric-family-hosting.test.cjs, 18 assertions).
//
// Run: npx playwright test tests/e2e/family-hosting.spec.ts --project=chromium

test('family hosting runs in the browser: wall + face attach, host move, audit', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(
    () => (window as any).__OBS_CTX__?.features?.familyHosting,
    undefined,
    { timeout: 30000 },
  );

  const result = await page.evaluate(() => {
    const svc = (window as any).__OBS_CTX__.features.familyHosting;
    const wall = {
      id: 'wall-1', kind: 'wall',
      curve: { kind: 'line', start: [0, 0], end: [8, 0] },
      baseZ: 0, height: 3, version: 1, thickness: 0.2,
    };
    const a = svc.attachToWall(wall, [2, 0.3, 1.2]);
    const p = svc.placement(wall, a);
    const el: any = { id: 'el-1', kind: 'family', familyId: 'fam-plinth', familyTypeId: null, params: {}, metadata: {} };
    svc.applyToElement(el, a, p);
    const moved = { ...wall, curve: { kind: 'line', start: [0, 2], end: [8, 2] }, version: 2 };
    const r = svc.evaluateAfterHostChange(wall, moved, [a]);
    const p2 = r.moved[0].placement;
    svc.applyToElement(el, { ...a, hostVersion: 2 }, p2);
    const face = {
      id: 'face-1', kind: 'face',
      origin: [0, 0, 0], normal: [0, 1, 0], uAxis: [1, 0, 0],
      uMin: 0, uMax: 4, vMin: 0, vMax: 3, version: 1,
    };
    const fa = svc.attachToFace(face, [2, 0.15, 1.5]);
    const fp = svc.placement(face, fa);
    const orphan: any = { id: 'el-orphan', kind: 'family', familyId: 'fam-plinth', familyTypeId: null, params: {}, metadata: {}, hostId: 'wall-missing' };
    const audit = svc.audit([el, orphan], new Map([['wall-1', moved]]));
    return {
      attach: { s: a.s, elevation: a.elevation, offset: a.offset },
      placement: { point: p.point, elevation: p.elevation, rotation: p.rotation },
      element: { point: el.params.point, elevation: el.params.elevation, rotation: el.params.rotation, hostVersion: el.hostAttachment.hostVersion },
      afterMove: { kind: r.kind, point: p2.point, invalid: r.invalid.length },
      face: { u: fa.u, v: fa.v, offset: fa.offset, point: fp.point, elevation: fp.elevation, rotation: fp.rotation },
      audit: { total: audit.total, orphaned: audit.orphaned.length, invalid: audit.invalid.length, stale: audit.stale.length },
    };
  });

  // Wall attach: s / elevation / offset from the world point.
  expect(result.attach.s).toBeCloseTo(2, 6);
  expect(result.attach.elevation).toBeCloseTo(1.2, 6);
  expect(result.attach.offset).toBeCloseTo(0.3, 6);
  // Placement faces the host normal (+y for a wall running +x).
  expect(result.placement.point[0]).toBeCloseTo(2, 6);
  expect(result.placement.point[1]).toBeCloseTo(0.3, 6);
  expect(result.placement.elevation).toBeCloseTo(1.2, 6);
  expect(result.placement.rotation).toBeCloseTo(90, 6);
  // The element carries the derived placement.
  expect(result.element.point[0]).toBeCloseTo(2, 6);
  expect(result.element.point[1]).toBeCloseTo(2.3, 6); // after the host move
  expect(result.element.elevation).toBeCloseTo(1.2, 6);
  expect(result.element.rotation).toBeCloseTo(90, 6);
  expect(result.element.hostVersion).toBe(2);
  // Host moved +2 in y: the instance followed its host parameters.
  expect(result.afterMove.kind).toBe('curve-edit');
  expect(result.afterMove.point[0]).toBeCloseTo(2, 6);
  expect(result.afterMove.point[1]).toBeCloseTo(2.3, 6);
  expect(result.afterMove.invalid).toBe(0);
  // Face attach: (u, v) + offset; placement faces the normal.
  expect(result.face.u).toBeCloseTo(2, 6);
  expect(result.face.v).toBeCloseTo(1.5, 6);
  expect(result.face.offset).toBeCloseTo(0.15, 6);
  expect(result.face.point[0]).toBeCloseTo(2, 6);
  expect(result.face.point[1]).toBeCloseTo(0.15, 6);
  expect(result.face.elevation).toBeCloseTo(1.5, 6);
  expect(result.face.rotation).toBeCloseTo(90, 6);
  // Audit: the orphaned element is reported, the moved one is clean.
  expect(result.audit.total).toBe(2);
  expect(result.audit.orphaned).toBe(1);
  expect(result.audit.invalid).toBe(0);
  expect(result.audit.stale).toBe(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
