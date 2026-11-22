import { test, expect, type Page } from '@playwright/test';

// Follow-up 6 — ribbon flow for generic family hosting (Slice 9 service + UI).
//
// What this spec drives through the REAL UI:
//   - wall: ribbon Wall button + two canvas clicks + Enter (document-chain pattern)
//   - family instance: Parametric Families panel → pick the
//     Basic Column family → "Place instance" → one canvas click
//   - hosting: ribbon "Host Family" → form-modal selects → submit
//   - host move: Edit tab → Modify Move dialog (numeric dx) → submit
//   - re-host on face: ribbon "Host Family" again → face option → submit
// State is read through window.__obsAuthoring (the same handle the app's
// own UI modules use); toast feedback is captured from the obs-toast
// window event the ribbon's toast host renders.
//
// What it does NOT drive through the UI:
//   - the panel open: the Ctrl+Shift+F shortcut does NOT deliver the F
//     keydown in this Playwright/Chromium environment (probed: only the
//     Control/Shift modifier keydowns arrive, for both
//     Control+Shift+F and Control+Shift+KeyF, and a synthetic
//     window.dispatchEvent keydown is likewise not observed) — so the
//     spec opens the panel through its __obsParamFamilyPanel handle,
//     the same entry point the command palette's "Parametric Families
//     Panel" command calls (run: () => toggleParamFamilyPanel()). The
//     panel's own FAM launch button is display:none, so there is no
//     clickable open path. Everything INSIDE the panel (family select,
//     Place button) is real DOM interaction, and the viewport click
//     that places the instance is a real canvas click.
//   - wall selection before the Move: canvas-click selection of one thin
//     wall is not reliably drivable, so the selection is set through
//     __obsAuthoring.setSelectedAuthored — the same API the Family Browser
//     uses. It is set while the Move dialog is open (the dialog reads the
//     selection at submit time), because with a selection active the Edit
//     strip swaps to a contextual set and the v68 Move button disappears.
//     The move itself (dialog fields + submit + command pipeline) is real UI.
//
// Run ONLY against this branch's own build on :3122 (see
// playwright.family-hosting.config.ts at the repo root): the repo's
// default config reuses any server already on :3000, and a sibling
// worktree's preview server would make this spec silently test the
// wrong build.
//   npx vite build && npx vite preview --port 3122 --host 127.0.0.1 --strictPort
// Marker check first (served page must be THIS build):
//   curl -s http://127.0.0.1:3122/ | grep -o 'assets/index-[^"]*\.js'
//   must equal the asset in dist/index.html
// Then, one spec at a time (1.5-CPU VM — never run browser specs concurrently):
//   npx playwright test --config playwright.family-hosting.config.ts tests/e2e/family-hosting-ribbon.spec.ts --project=chromium
// Audit re-run 2026-11-22 on main 7f07c3d9: 1 passed / 1 failed at first
// — the face re-host test expected 2 "Hosted" toasts and got 4: every
// notify()-originated toast crossed the obs-toast bus twice (the ribbon
// bridge re-dispatched via toast(); regression from 9c2209ce). Fixed by
// splitting renderToast out of toast() and having the bridge render
// directly (src/shell/ribbon.ts); re-run 2 passed (2.4m).

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
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

/** Authored elements, read through the same handle the app's UI uses. */
const getElements = (page: Page) =>
  page.evaluate(() => {
    const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
    return els.map((e: any) => ({
      id: String(e.id),
      type: String(e.type),
      name: String(e.name ?? e.id),
      familyId: e.familyId ? String(e.familyId) : null,
      hostId: e.hostId ? String(e.hostId) : null,
      hostAttachment: e.hostAttachment ? JSON.parse(JSON.stringify(e.hostAttachment)) : null,
      start: e.params?.start ? [...e.params.start] : null,
      end: e.params?.end ? [...e.params.end] : null,
      point: e.params?.point ? [...e.params.point] : null,
      elevation: typeof e.params?.elevation === 'number' ? e.params.elevation : null,
      rotation: typeof e.params?.rotation === 'number' ? e.params.rotation : null,
    }));
  });

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

/** Draw one wall with the ribbon Wall tool; returns the wall element. */
async function drawWall(page: Page, box: { x: number; y: number; width: number; height: number }) {
  const cx = box.x + box.width / 2;
  const wallY = box.y + box.height / 2 + box.height * 0.05;
  await gotoTab(page, 'architecture');
  await clickStripButton(page, 'Wall');
  const tool = await page.evaluate(
    () => (window as any).__OBS_CTX__?.features?.authoring?.getActiveTool?.() ?? null,
  );
  expect(tool, 'Wall tool becomes active from the ribbon click').toBe('wall');
  await page.mouse.click(cx - box.width * 0.2, wallY);
  await page.mouse.click(cx + box.width * 0.2, wallY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  const wall = await page.waitForFunction(
    () => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      return els.find((e: any) => e.type === 'wall' && e.params?.start && e.params?.end) ?? null;
    },
    undefined,
    { timeout: 20000 },
  ).then((h) => h.evaluate((e: any) => ({
    id: String(e.id),
    start: [...e.params.start] as [number, number],
    end: [...e.params.end] as [number, number],
  })));
  return { wall, cx, wallY };
}

/** Place a Basic Column family instance with the Parametric Families panel. */
async function placeColumn(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  at: { x: number; y: number },
) {
  // The panel boots late: its critical-gaps-boot step runs after the
  // familyHosting registration, and the whole boot takes ~35 s on a slow
  // VM. Wait for the handle instead of assuming it exists yet.
  await page.waitForFunction(
    () => !!(window as any).__obsParamFamilyPanel,
    undefined,
    { timeout: 90000 },
  );
  // Open via the panel handle (see the header: the Ctrl+Shift+F shortcut
  // does not deliver the F keydown in this environment).
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.open?.());
  await expect(page.locator('#obs-param-family-panel.is-open')).toBeVisible({ timeout: 15000 });
  const famId = await page.evaluate(() => {
    const sel = document.querySelector('#obs-param-family-panel [data-family]') as HTMLSelectElement | null;
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.textContent === 'Basic Column (column)');
    return opt ? opt.value : null;
  });
  expect(famId, 'the Basic Column family must be listed in the panel').toBeTruthy();
  await page.locator('#obs-param-family-panel [data-family]').selectOption(famId!);
  await page.locator('#obs-param-family-panel [data-act="place"]').click();
  await page.waitForTimeout(500);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');
  // Close the panel so it cannot cover later ribbon/dialog clicks.
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.close?.());
  await page.waitForTimeout(400);
  const col = await page.waitForFunction(
    () => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      return els.find((e: any) => e.type === 'column' && e.familyId && e.params?.point) ?? null;
    },
    undefined,
    { timeout: 20000 },
  ).then((h) => h.evaluate((e: any) => ({
    id: String(e.id),
    point: [...e.params.point] as [number, number],
    familyId: String(e.familyId),
  })));
  return col;
}

/** Move the given elements through the Edit → Modify Move dialog. */
async function moveViaDialog(page: Page, ids: string[], dx: number, dz: number) {
  // The v68 Move button only exists in the full Edit strip: with a
  // selection active the strip swaps to a contextual set and the button
  // disappears. The dialog reads the selection at SUBMIT time
  // (openModifyMoveDialog), so open it first, then make the selection
  // while the modal is open.
  await gotoTab(page, 'edit');
  await page.locator('button.obs-rb[title*="v68 command pipeline"]').first().click();
  const moveModal = page.locator('.obs-form-modal');
  await expect(moveModal).toBeVisible({ timeout: 15000 });
  await expect(moveModal.getByText('Modify Engine — Move')).toBeVisible();
  await page.evaluate((ids: string[]) => {
    (window as any).__obsAuthoring?.setSelectedAuthored?.(ids, 'replace');
  }, ids);
  await moveModal.locator('input').nth(0).fill(String(dx));
  await moveModal.locator('input').nth(1).fill(String(dz));
  await moveModal.getByRole('button', { name: 'Move Selection', exact: true }).click();
  await page.waitForTimeout(800);
}

/** Expected facing of a hosted instance: the host normal, left of the wall tangent. */
function expectedFacing(wall: { start: [number, number]; end: [number, number] }): number {
  const a = Math.atan2(wall.end[1] - wall.start[1], wall.end[0] - wall.start[0]) * 180 / Math.PI;
  const r = a + 90;
  return ((r + 180) % 360 + 360) % 360 - 180;
}
/** Clear the authored selection so #obs-options-bar hides — with a
 *  selection active the bar overlays the ribbon tabs row and intercepts
 *  tab clicks. Escape is the user path ("One Esc cancels everything"). */
async function clearSelection(page: Page) {
  await page.keyboard.press('Escape');
  const hidden = await page.waitForFunction(
    () => {
      const bar = document.querySelector('#obs-options-bar') as HTMLElement | null;
      return !bar || getComputedStyle(bar).display === 'none';
    },
    undefined,
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  if (!hidden) {
    await page.evaluate(() => (window as any).__obsAuthoring?.setSelectedAuthored?.([], 'replace'));
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(300);
}

/** Open the Host Family dialog and submit it with the given host option value. */
async function hostViaDialog(page: Page, hostValue: string) {
  await clearSelection(page);
  await gotoTab(page, 'architecture');
  await clickStripButton(page, 'Host Family');
  const modal = page.locator('.obs-form-modal');
  await expect(modal).toBeVisible({ timeout: 15000 });
  const selects = modal.locator('select');
  await expect(selects).toHaveCount(2);
  await selects.nth(1).selectOption(hostValue);
  await modal.getByRole('button', { name: 'Host Family', exact: true }).click();
  await page.waitForTimeout(800);
}

test('ribbon hosts a family instance on a wall, it follows a host move, and re-hosts on a face', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  await installToastLog(page);
  const box = await viewportBox(page);

  // ── 1. Wall via the ribbon + canvas clicks
  const { wall, cx, wallY } = await drawWall(page, box);
  console.log('[ribbon-host] wall:', wall.id, wall.start, '→', wall.end);

  // ── 2. Family instance via the Parametric Families panel + canvas click.
  // Place it just off the wall line (60 px below it on screen) so its
  // projection onto the wall is well inside the segment.
  const col = await placeColumn(page, box, { x: cx, y: wallY + 60 });
  console.log('[ribbon-host] column:', col.id, 'family', col.familyId, 'at', col.point);

  // ── 3. Host on the wall through the ribbon dialog (defaults: the only
  // instance, the wall host — the first host option).
  await hostViaDialog(page, `wall:${wall.id}`);
  const hosted = (await getElements(page)).find((e) => e.id === col.id)!;
  expect(hosted.hostAttachment, 'the column must carry a host attachment after the dialog').toBeTruthy();
  expect(hosted.hostAttachment.hostKind).toBe('wall');
  expect(hosted.hostAttachment.hostId).toBe(wall.id);
  expect(hosted.hostAttachment.hostVersion).toBe(1);
  // The wall is drawn along the screen, which is diagonal in plan — so
  // the facing is the wall's own normal, not a fixed 90°.
  expect(hosted.rotation).toBeCloseTo(expectedFacing(wall), 0);
  // The attachment parameters are real values inside the host's range.
  const wallLen = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  expect(hosted.hostAttachment.s).toBeGreaterThanOrEqual(0);
  expect(hosted.hostAttachment.s).toBeLessThanOrEqual(wallLen);
  expect(hosted.hostAttachment.elevation).toBeGreaterThanOrEqual(0);
  expect(hosted.hostAttachment.elevation).toBeLessThanOrEqual(3);
  const toasts1 = await toastLog(page);
  expect(
    toasts1.some(([k, m]) => k === 'success' && m.startsWith('Hosted')),
    `a success toast must confirm the hosting (log: ${JSON.stringify(toasts1)})`,
  ).toBe(true);
  console.log('[ribbon-host] wall attachment:', JSON.stringify(hosted.hostAttachment), 'point:', hosted.point);

  // ── 4. Move the host wall +1 m in X through the Modify Move dialog.
  const before = { wallStartX: wall.start[0], colX: hosted.point![0] };
  await moveViaDialog(page, [wall.id], 1, 0);
  const afterMove = await page.waitForFunction(
    (args: { wallId: string; colId: string; x0: number }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      const w = els.find((e: any) => e.id === args.wallId);
      const c = els.find((e: any) => e.id === args.colId);
      if (!w || !c) return null;
      if (Math.abs(w.params.start[0] - (args.x0 + 1)) > 0.01) return null;
      return {
        wallStart: [...w.params.start],
        colPoint: [...c.params.point],
        hostVersion: c.hostAttachment?.hostVersion ?? null,
        hostKind: c.hostAttachment?.hostKind ?? null,
      };
    },
    { wallId: wall.id, colId: col.id, x0: before.wallStartX },
    { timeout: 30000 },
  ).then((h) => h.evaluate((v: any) => v));
  expect(afterMove, 'the wall must move +1 m in X and the column must follow').toBeTruthy();
  expect(afterMove!.colPoint[0]).toBeCloseTo(before.colX + 1, 2);
  expect(afterMove!.colPoint[1]).toBeCloseTo(hosted.point![1], 2);
  expect(afterMove!.hostVersion, 'the attachment version must refresh on the host move').toBe(2);
  expect(afterMove!.hostKind).toBe('wall');
  console.log('[ribbon-host] after wall move +1 X: wall start', afterMove!.wallStart, 'column', afterMove!.colPoint);

  // ── 5. Re-host the same instance on the wall's face, again via the dialog.
  await hostViaDialog(page, `face:${wall.id}`);
  const faced = (await getElements(page)).find((e) => e.id === col.id)!;
  expect(faced.hostAttachment.hostKind).toBe('face');
  expect(faced.hostAttachment.hostId).toBe(wall.id);
  expect(faced.hostAttachment.u).toBeGreaterThanOrEqual(0);
  expect(faced.hostAttachment.u).toBeLessThanOrEqual(wallLen);
  expect(faced.hostAttachment.v).toBeGreaterThanOrEqual(0);
  expect(faced.hostAttachment.v).toBeLessThanOrEqual(3);
  expect(faced.rotation).toBeCloseTo(expectedFacing(wall), 0);
  const toasts2 = await toastLog(page);
  expect(
    toasts2.filter(([k, m]) => k === 'success' && m.startsWith('Hosted')).length,
    `a second success toast must confirm the face hosting (log: ${JSON.stringify(toasts2)})`,
  ).toBe(2);
  console.log('[ribbon-host] face attachment:', JSON.stringify(faced.hostAttachment), 'point:', faced.point);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('hosting reports an error when the instance does not fit the host', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  await installToastLog(page);
  const box = await viewportBox(page);

  const { wall, cx, wallY } = await drawWall(page, box);
  const col = await placeColumn(page, box, { x: cx, y: wallY + 60 });
  console.log('[ribbon-host-error] column:', col.id, 'at', col.point, 'wall:', wall.start, '→', wall.end);

  // Move the column off the wall segment — computed from the live
  // geometry, not from screen pixels (the default camera puts the wall
  // ~85 m long and viewport clicks snap to endpoints, so a "far corner"
  // click is not a reliable miss). Shifting it along the wall tangent
  // until s = -5 m guarantees the attach cannot fit.
  const move = await page.evaluate((args: { wallId: string; colId: string }) => {
    const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
    const w = els.find((e: any) => e.id === args.wallId);
    const c = els.find((e: any) => e.id === args.colId);
    const dx = w.params.end[0] - w.params.start[0];
    const dy = w.params.end[1] - w.params.start[1];
    const L = Math.hypot(dx, dy);
    const tx = dx / L, ty = dy / L;
    const s = (c.params.point[0] - w.params.start[0]) * tx + (c.params.point[1] - w.params.start[1]) * ty;
    const shift = -(s + 5); // new s = -5 m, outside [0, L]
    return { dx: shift * tx, dz: shift * ty, s };
  }, { wallId: wall.id, colId: col.id });
  console.log('[ribbon-host-error] column s =', move.s.toFixed(2), 'moving by', move.dx.toFixed(2), move.dz.toFixed(2));
  await moveViaDialog(page, [col.id], move.dx, move.dz);
  const moved = (await getElements(page)).find((e) => e.id === col.id)!;
  expect(moved.point).toBeTruthy();
  console.log('[ribbon-host-error] column after move:', moved.point);

  await hostViaDialog(page, `wall:${wall.id}`);
  const toasts = await toastLog(page);
  expect(
    toasts.some(([k, m]) => k === 'error' && m.startsWith('Hosting failed')),
    `an error toast must report the failed hosting (log: ${JSON.stringify(toasts)})`,
  ).toBe(true);
  const els = await getElements(page);
  const untouched = els.find((e) => e.id === col.id)!;
  expect(untouched.hostAttachment, 'a failed attach must leave the instance freestanding').toBeNull();
  expect(errors, errors.join('\n')).toEqual([]);
});
