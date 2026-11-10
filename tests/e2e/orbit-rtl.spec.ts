import { test, expect } from '@playwright/test';

// Real-browser checks for two things that were only unit-tested: Shift+drag orbit, and Arabic (right-to-left) boot.
// Run on CI by .github/workflows/browser-smoke.yml (not part of the unit-test job).

test('Shift+drag orbit restores an upright camera and applies far fewer camera updates than pointer events', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => !!(window as any).__OBS_CTX__?.world?.camera?.controls, null, { timeout: 30000 });

  // Leave the camera tilted (as a Top / saved view can) and count camera-controls updates during the drag.
  await page.evaluate(() => {
    const c = (window as any).__OBS_CTX__.world.camera;
    c.three.up.set(0, 0, -1);
    const orig = c.controls.setLookAt.bind(c.controls);
    (window as any).__orbitCalls = 0;
    c.controls.setLookAt = (...a: unknown[]) => { (window as any).__orbitCalls++; return orig(...a); };
  });

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  const EVENTS = 40;
  await page.mouse.move(cx + 240, cy + 90, { steps: EVENTS });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);

  const r = await page.evaluate(() => {
    const cam = (window as any).__OBS_CTX__.world.camera.three;
    return { up: [cam.up.x, cam.up.y, cam.up.z], calls: (window as any).__orbitCalls as number };
  });
  expect(r.up[1], `camera.up after orbit: ${r.up}`).toBeGreaterThan(0.999);
  expect(r.calls, 'orbit moved the camera').toBeGreaterThan(0);
  expect(r.calls, `camera updates (${r.calls}) should be well below pointer events (${EVENTS})`).toBeLessThan(EVENTS * 0.8);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('Arabic locale boots right-to-left without uncaught errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem('obs.locale', 'ar'); } catch { /* */ } });
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
  // No horizontal page overflow introduced by the mirrored layout.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'test-results/rtl-ar.png' });
  expect(errors, errors.join('\n')).toEqual([]);
});

test('editable grips show an open hand on hover and a closed hand while dragging, and the drag moves the vertex', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await page.waitForFunction(() => !!(window as any).__obsAuthoring && !!(window as any).__OBS_CTX__?.world?.camera?.three, null, { timeout: 30000 });

  // Draw a slab by clicking four corners on the ground, then Enter, then select it.
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => (window as any).__obsAuthoring.setAuthoringTool('slab'));
  for (const [dx, dy] of [[-120, -80], [120, -80], [120, 80], [-120, 80]]) { await page.mouse.move(cx + dx, cy + dy); await page.mouse.click(cx + dx, cy + dy); }
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (window as any).__obsAuthoring.getElementCount() >= 1, null, { timeout: 10000 });
  await page.evaluate(() => (window as any).__obsAuthoring.setAuthoringTool('select'));
  await page.mouse.move(cx, cy); await page.mouse.click(cx, cy);

  const info = await page.evaluate(() => {
    const a = (window as any).__obsAuthoring, cam = (window as any).__OBS_CTX__.world.camera.three;
    const el = a.getElements().find((e: any) => e.type === 'slab');
    const v = el.params.polygon[0];
    const p = { x: v[0], y: el.params.elevation, z: v[1] };
    const w = cam.position.constructor; const vec = new w(p.x, p.y, p.z).project(cam);
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return { id: el.id, v, sx: r.left + (vec.x + 1) / 2 * r.width, sy: r.top + (1 - vec.y) / 2 * r.height };
  });
  const host = () => page.evaluate(() => (document.querySelector('canvas')!.parentElement as HTMLElement).style.cursor);
  await page.mouse.move(info.sx + 40, info.sy + 40); await page.mouse.move(info.sx, info.sy);
  const hostCursor = () => page.evaluate(() => ((window as any).__OBS_CTX__.rightHost as HTMLElement).style.cursor);
  const selected = await page.evaluate(() => (window as any).__obsAuthoring.getSelectedIds());
  expect(await hostCursor(), `open hand over the grip (selected: ${JSON.stringify(selected)}, grip at ${info.sx.toFixed(0)},${info.sy.toFixed(0)})`).toBe('grab');
  await page.mouse.down();
  const cursors: string[] = [];
  const sample = hostCursor;
  for (let i = 1; i <= 8; i++) { await page.mouse.move(info.sx + i * 4, info.sy + i * 3); cursors.push(await sample()); }
  const mid = await page.evaluate((id) => (window as any).__obsAuthoring.getElementById(id).params.polygon[0], info.id);
  await page.mouse.up();
  const after = await page.evaluate((id) => (window as any).__obsAuthoring.getElementById(id).params.polygon[0], info.id);
  const moved = Math.hypot(after[0] - info.v[0], after[1] - info.v[1]);
  const poly = await page.evaluate((id) => JSON.stringify((window as any).__obsAuthoring.getElementById(id).params.polygon), info.id);
  const diag = `polygon ${poly}; cursors during drag: ${JSON.stringify(cursors)}; vertex before ${info.v} mid ${mid} after ${after}; grip screen pos ${info.sx.toFixed(0)},${info.sy.toFixed(0)};`;
  expect(cursors.some((c) => c === 'grabbing'), 'grabbing cursor during the drag. ' + diag).toBe(true);
  expect(moved, 'vertex moved. ' + diag).toBeGreaterThan(0.05);
  void host;
  expect(errors, errors.join('\n')).toEqual([]);
});
