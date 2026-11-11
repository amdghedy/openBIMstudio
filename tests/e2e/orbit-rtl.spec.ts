import { test, expect } from '@playwright/test';

// Real-browser checks for two things that were only unit-tested: Shift+drag orbit, and Arabic (right-to-left) boot.
// Run on CI by .github/workflows/browser-smoke.yml (not part of the unit-test job).

test('Shift+drag orbit restores an upright camera and never applies more camera updates than pointer events', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
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
  // Never more camera updates than pointer events. Strict coalescing is proven by tests/orbit-frame.test.cjs; whether a
  // headless run merges events depends on how fast it renders frames, so it is not asserted here.
  expect(r.calls, `camera updates (${r.calls}) must not exceed pointer events (${EVENTS})`).toBeLessThanOrEqual(EVENTS);
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

test('Export > Views to CAD: dialog creates standard views and downloads real DXF files', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await page.waitForFunction(() => !!(window as any).__obsAuthoring, null, { timeout: 30000 });

  // A wall so the views have something to draw.
  await page.evaluate(() => (window as any).__obsAuthoring.setAuthoringTool('wall'));
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx - 100, cy); await page.mouse.click(cx - 100, cy);
  await page.mouse.move(cx + 100, cy); await page.mouse.click(cx + 100, cy);
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');

  await page.keyboard.press('Control+p');
  await page.keyboard.type('Views to CAD');
  await page.keyboard.press('Enter');
  const dlg = page.locator('#obs-export-cad');
  await expect(dlg).toBeVisible({ timeout: 10000 });
  if (await dlg.locator('[data-make]').count()) await dlg.locator('[data-make]').click();
  await expect(dlg.locator('[data-view]').first()).toBeVisible();
  await dlg.locator('[data-format]').selectOption('dxf');
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await dlg.locator('[data-go]').click();
  const d = await dl;
  const name = d.suggestedFilename();
  expect(name.endsWith('.zip') || name.endsWith('.dxf'), `downloaded ${name}`).toBe(true);
  const msg = await dlg.locator('[data-msg]').innerText();
  expect(msg, msg).toMatch(/Exported \d+ DXF file/);
  const dl3 = page.waitForEvent('download', { timeout: 30000 });
  await dlg.locator('[data-go3d]').click();
  const d3 = await dl3;
  expect(d3.suggestedFilename()).toBe('openbimstudio-model-3d.dxf');
  const text3 = (await import('fs')).readFileSync((await d3.path())!, 'utf8');
  expect(text3, 'real 3D DXF content').toContain('3DFACE');
  expect(text3.trimEnd().endsWith('EOF')).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
