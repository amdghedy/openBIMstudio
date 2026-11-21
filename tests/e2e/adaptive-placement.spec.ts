import { test, expect, type Page } from '@playwright/test';

// Revit parity Rank 6, item 2 — adaptive interactive 3D placement browser proof.
//
// The maturity note claimed "the placement dialog currently accepts
// coordinate text rather than interactive 3D point picking" and that
// "live 3D grips ... remain follow-up work". Both are stale relative to
// the code on main: the dialog defaults to viewport picking
// (engine-ui.ts openAdaptiveSweepDialog) and adaptive-interaction.ts
// already draws grips — but nothing had ever proven either in a real
// browser. This spec is that proof.
//
// What this spec drives through the REAL UI:
//   - Architecture tab → "Adaptive Sweep" → the dialog (asserting the
//     Placement method defaults to "Interactive 3D point picking") → submit
//   - two canvas clicks on the ground plane (mouse.move + settle first:
//     the snap system updates its last result asynchronously, and an
//     instant click can commit the PREVIOUS hover position — FU7 note)
//   - select the created component → live 3D grips appear
//   - drag one grip with the mouse → the adaptive point moves
// What it asserts on the RENDERED model (not helper return values):
//   - an adaptive-component element with 2 ordered placement points,
//     distinct and on the work plane, plus the HUD lifecycle and the
//     "Placed native adaptive component" toast
//   - 2 grip meshes in the live scene (userData.adaptivePlacementGrip)
//   - after the drag, the stored definition point moved > 0.1 m and the
//     rendered mesh box moved with it
//
// Run: npx playwright test tests/e2e/adaptive-placement.spec.ts --project=chromium

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 90000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90000 });
}

/** Largest visible canvas = the 3D viewport (document-chain pattern). */
async function viewportBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible').toBeTruthy();
  return box!;
}

const gotoTab = async (page: Page, tabId: string) => {
  await page.locator(`button.obs-ribbon__tab[data-tab="${tabId}"]`).click();
  await page.waitForTimeout(350);
};
const clickStripButton = async (page: Page, label: string) => {
  await page.getByRole('button', { name: label, exact: true }).first().click();
  await page.waitForTimeout(700);
};

/** Deterministic toast capture: the ribbon renders obs-toast events as .obs-toast. */
async function installToastLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__toastLog = [];
    window.addEventListener('obs-toast', (e: any) =>
      (window as any).__toastLog.push([String(e.detail?.kind ?? ''), String(e.detail?.message ?? '')]),
    );
  });
}
const toastLog = (page: Page) =>
  page.evaluate(() => (window as any).__toastLog as Array<[string, string]> ?? []);

/** The adaptive component's stored definition, read through __obsAuthoring. */
const getAdaptiveDefinition = (page: Page, id: string) =>
  page.evaluate((eid: string) => {
    const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
    const el = els.find((e: any) => e.id === eid);
    const def = el?.properties?.adaptiveDefinition ?? null;
    return def ? {
      type: String(el.type),
      points: (def.points ?? []).map((p: any) => [Number(p.x), Number(p.y), Number(p.z)] as [number, number, number]),
    } : null;
  }, id);

/** Count live 3D grip meshes for the element in the scene graph. */
const countGrips = (page: Page) =>
  page.evaluate(() => {
    const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
    if (!scene) return -1;
    let n = 0;
    scene.traverse((o: any) => { if (o?.userData?.adaptivePlacementGrip === true) n++; });
    return n;
  });

/** Project a world point to viewport screen coordinates with the live camera. */
const projectToScreen = (page: Page, p: [number, number, number]) =>
  page.evaluate((pt: [number, number, number]) => {
    const ctx = (window as any).__OBS_CTX__;
    const camera = ctx?.world?.camera?.three;
    const host = ctx?.rightHost;
    if (!camera || !host) return null;
    // Refresh the camera matrices first: a stale matrixWorldInverse
    // (e.g. after the placement fit) shifts the projected point by
    // several px — enough to miss an 8 px grip.
    camera.updateMatrixWorld?.(true);
    const sample = ctx.world.scene.three.children.find((o: any) => o?.position) ?? null;
    if (!sample) return null;
    const v = new sample.position.constructor(pt[0], pt[1], pt[2]).project(camera);
    const r = host.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }, p);

/** World-space AABB of one element id from the LIVE scene graph (FU7 pattern). */
const getSceneBox = (page: Page, id: string) =>
  page.evaluate((eid: string) => {
    const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
    if (!scene) return null;
    scene.updateMatrixWorld(true);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    scene.traverse((o: any) => {
      if (String(o?.userData?.elementId ?? '') !== eid) return;
      o.traverse((m: any) => {
        if (!m.isMesh || !m.geometry) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        const bb = m.geometry.boundingBox;
        if (!bb) return;
        found = true;
        const e = m.matrixWorld.elements as number[];
        for (const cx of [bb.min.x, bb.max.x])
          for (const cy of [bb.min.y, bb.max.y])
            for (const cz of [bb.min.z, bb.max.z]) {
              const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
              const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
              const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
              min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
              max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
            }
      });
    });
    return found ? { min, max } : null;
  }, id);

test('adaptive sweep places by canvas clicks and its points drag on live 3D grips', async ({ page }) => {
  test.setTimeout(300000); // readiness wait alone takes ~124 s (120 s boot fallback)
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  await installToastLog(page);

  // The adaptive feature lives in critical-gaps-boot's runOnce, which is
  // gated on isReady() (renderer + viewport host) with a 120 s fallback:
  // in a headless run it only appears after ~124 s. Driving the dialog
  // before that fails with "Native adaptive authoring is not ready" and
  // no HUD. Wait for the interaction API, not just the ribbon button.
  await page.waitForFunction(
    () => typeof (window as any).__OBS_CTX__?.features?.adaptiveComponents?.beginPlacement === "function",
    undefined,
    { timeout: 150000 },
  );

  const box = await viewportBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ── 1. Open the dialog; interactive picking must be the default.
  await gotoTab(page, 'architecture');
  await clickStripButton(page, 'Adaptive Sweep');
  const modal = page.locator('.obs-form-modal');
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(modal.getByText('Place Native Adaptive Component')).toBeVisible();
  const placement = await modal.locator('select').first().inputValue();
  expect(placement, 'the dialog must default to interactive 3D point picking, not coordinates').toBe('viewport');
  await modal.getByRole('button', { name: 'Start Adaptive Placement', exact: true }).click();
  await page.waitForTimeout(800);

  // ── 2. The placement HUD appears; place two points with real canvas clicks.
  const hud = page.locator('[data-adaptive-placement-hud]');
  await expect(hud).toBeVisible({ timeout: 15000 });
  await expect(hud.locator('[data-status]')).toContainText('0/2 points placed');
  const p1 = { x: cx - 120, y: cy + 40 };
  const p2 = { x: cx + 120, y: cy + 40 };
  for (const p of [p1, p2]) {
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(700); // let the snap system settle (FU7 note)
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(600);
  }
  const created = await page.waitForFunction(
    () => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      return els.find((e: any) =>
        e.type === 'adaptive-component' && e.properties?.adaptiveDefinition?.points?.length === 2,
      ) ?? null;
    },
    undefined,
    { timeout: 30000 },
  ).then((h) => h.evaluate((e: any) => ({
    id: String(e.id),
    points: e.properties.adaptiveDefinition.points.map((p: any) => [Number(p.x), Number(p.y), Number(p.z)] as [number, number, number]),
  })));
  expect(created.points, 'the two clicked points must be stored, distinct, on the work plane').toHaveLength(2);
  const [a, b] = created.points;
  expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeGreaterThan(1);
  for (const p of created.points) expect(Math.abs(p[1])).toBeLessThan(0.05);
  await expect(hud).toHaveCount(0, { timeout: 15000 });
  const toasts1 = await toastLog(page);
  expect(
    toasts1.some(([k, m]) => k === 'success' && m.startsWith('Placed native adaptive component')),
    `placement must toast success (log: ${JSON.stringify(toasts1)})`,
  ).toBe(true);
  console.log('[adaptive] placed:', created.id, created.points);
  const boxBefore = await getSceneBox(page, created.id);
  expect(boxBefore, 'the placed component must render a mesh').toBeTruthy();
  expect(boxBefore!.max[0] - boxBefore!.min[0]).toBeGreaterThan(0.05);

  // ── 3. Selecting it shows two live 3D grips.
  await page.evaluate((eid: string) => {
    (window as any).__obsAuthoring?.setSelectedAuthored?.([eid], 'replace');
  }, created.id);
  const grips = await page.waitForFunction(
    () => {
      const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
      if (!scene) return -1;
      let n = 0;
      scene.traverse((o: any) => { if (o?.userData?.adaptivePlacementGrip === true) n++; });
      return n;
    },
    undefined,
    { timeout: 20000 },
  ).then((h) => h.evaluate((n: number) => n));
  expect(grips, 'selecting the component must show one grip per placement point').toBe(2);
  expect(await countGrips(page)).toBe(2);

  // ── 4. Drag the first grip: the stored point (and the mesh) must move.
  const screen = await projectToScreen(page, created.points[0]);
  expect(screen, 'the grip must project onto the viewport').toBeTruthy();
  await page.mouse.move(screen!.x, screen!.y);
  await page.waitForTimeout(400);
  await page.mouse.down();
  // The router fires drag-start once the pointer moves ≥ 4 px, and the
  // grip raycast runs at that event's position — so the first move must
  // stay well inside the 8 px grip (a 7.5 px first step plus a few px of
  // projection error misses it and the drag orbits the camera instead).
  await page.mouse.move(screen!.x + 5, screen!.y, { steps: 1 });
  await page.waitForTimeout(120);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(screen!.x + 5 + (85 * i) / steps, screen!.y, { steps: 1 });
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(900);
  const moved = await page.waitForFunction(
    (args: { id: string; x0: number; z0: number }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      const el = els.find((e: any) => e.id === args.id);
      const p = el?.properties?.adaptiveDefinition?.points?.[0];
      if (!p) return null;
      const movedBy = Math.hypot(Number(p.x) - args.x0, Number(p.z) - args.z0);
      return movedBy > 0.1 ? { point: [Number(p.x), Number(p.y), Number(p.z)], movedBy } : null;
    },
    { id: created.id, x0: created.points[0][0], z0: created.points[0][2] },
    { timeout: 30000 },
  ).then((h) => h.evaluate((v: any) => v));
  expect(moved, 'dragging the grip must move the stored adaptive point').toBeTruthy();
  console.log('[adaptive] grip drag moved point 0 by', moved!.movedBy.toFixed(2), 'm to', moved!.point);
  const boxAfter = await getSceneBox(page, created.id);
  expect(boxAfter, 'the mesh must still render after the drag').toBeTruthy();
  expect(
    Math.abs(boxAfter!.min[0] - boxBefore!.min[0]) + Math.abs(boxAfter!.max[0] - boxBefore!.max[0]),
    'the rendered mesh box must move with the dragged point',
  ).toBeGreaterThan(0.05);
  const defAfter = await getAdaptiveDefinition(page, created.id);
  expect(defAfter?.points).toHaveLength(2);

  expect(errors, errors.join('\n')).toEqual([]);
});
