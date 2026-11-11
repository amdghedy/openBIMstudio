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

const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('wall.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSITE('2VqzM6bXH7ugTO1ZoXRFzp',$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#40=IFCRELAGGREGATES('3VqzM6bXH7ugTO1ZoXRFzq',$,$,$,#1,(#30));
#50=IFCWALL('1VqzM6bXH7ugTO1ZoXRFzr',$,'Wall 1',$,$,#51,#60,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#31,#21);
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#21,#64,3.);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,5.,0.2);
#64=IFCDIRECTION((0.,0.,1.));
#65=IFCAXIS2PLACEMENT2D(#66,$);
#66=IFCCARTESIANPOINT((0.,0.));
#70=IFCRELCONTAINEDINSPATIALSTRUCTURE('4VqzM6bXH7ugTO1ZoXRFzs',$,$,$,(#50),#30);
ENDSEC;
END-ISO-10303-21;
`;

test('3D export includes an imported IFC model, with the wall on layer A-WALL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);

  // Drop the IFC file onto the viewport, as a user would.
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC model loaded into the scene' }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);

  await page.keyboard.press('Control+p');
  await page.keyboard.type('Views to CAD');
  await page.keyboard.press('Enter');
  const dlg = page.locator('#obs-export-cad');
  await expect(dlg).toBeVisible({ timeout: 10000 });
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await dlg.locator('[data-go3d]').click();
  const d = await dl;
  const text = (await import('fs')).readFileSync((await d.path())!, 'utf8');
  const msg = await dlg.locator('[data-msg]').innerText();
  expect(text, `3D DXF from IFC. Dialog said: ${msg}`).toContain('3DFACE');
  expect(text, msg).toContain('A-WALL');
  // The wall is 5 m x 0.2 m x 3 m: the exported extents should be about that, in millimetres.
  const xs = Array.from(text.matchAll(/\n10\n(-?[\d.]+)\n/g)).map((m) => parseFloat(m[1]));
  const zs = Array.from(text.matchAll(/\n30\n(-?[\d.]+)\n/g)).map((m) => parseFloat(m[1]));
  expect(Math.max(...zs) - Math.min(...zs), `height span (mm). ${msg}`).toBeGreaterThan(2900);
  expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(3100);
  expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(4900);
  expect(errors, errors.join('\n')).toEqual([]);
});

/** An IFC with a grid of walls (n x n), to give the viewport a realistic amount of geometry. */
function manyWallsIfc(n: number): string {
  const head = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('walls.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSITE('2VqzM6bXH7ugTO1ZoXRFzp',$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#40=IFCRELAGGREGATES('3VqzM6bXH7ugTO1ZoXRFzq',$,$,$,#1,(#30));
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,4.,0.2);
#64=IFCDIRECTION((0.,0.,1.));
#65=IFCAXIS2PLACEMENT2D(#66,$);
#66=IFCCARTESIANPOINT((0.,0.));
`;
  const body: string[] = []; const ids: string[] = [];
  let id = 100;
  const guid = (i: number) => { const a = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$'; let s = ''; let v = i + 12345; for (let k = 0; k < 22; k++) { s += a[v % 64]; v = Math.floor(v / 64) + k * 7 + 1; } return s; };
  for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
    const pt = id++, ax = id++, lp = id++, solid = id++, rep = id++, pds = id++, wall = id++;
    body.push(`#${pt}=IFCCARTESIANPOINT((${x * 6}.,${y * 6}.,0.));`);
    body.push(`#${ax}=IFCAXIS2PLACEMENT3D(#${pt},$,$);`);
    body.push(`#${lp}=IFCLOCALPLACEMENT(#31,#${ax});`);
    body.push(`#${solid}=IFCEXTRUDEDAREASOLID(#63,#21,#64,3.);`);
    body.push(`#${rep}=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#${solid}));`);
    body.push(`#${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}));`);
    body.push(`#${wall}=IFCWALL('${guid(wall)}',$,'W${wall}',$,$,#${lp},#${pds},$,.STANDARD.);`);
    ids.push(`#${wall}`);
  }
  const rel = `#${id}=IFCRELCONTAINEDINSPATIALSTRUCTURE('4VqzM6bXH7ugTO1ZoXRFzs',$,$,$,(${ids.join(',')}),#30);`;
  return head + body.join('\n') + '\n' + rel + '\nENDSEC;\nEND-ISO-10303-21;\n';
}

test('PROFILE: orbit a 1,600-wall model with the CPU profiler on (prints the hottest functions)', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);
  const ifc = manyWallsIfc(40);
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'walls.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, ifc);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 180000, message: 'model loaded' }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(3000);

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  await page.evaluate(() => {
    (window as any).__long = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) (window as any).__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
  });
  await cdp.send('Profiler.start');
  const t0 = Date.now();
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 0; i < 6; i++) { await page.mouse.move(cx + 200 * Math.sin(i), cy + 80 * Math.cos(i), { steps: 40 }); }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const wall = Date.now() - t0;
  const { profile } = await cdp.send('Profiler.stop');

  // Self time per function.
  const nodes = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
  const self = new Map<string, number>();
  const dt: number[] = profile.timeDeltas;
  profile.samples.forEach((id: number, i: number) => {
    const n = nodes.get(id)!; const f = n.callFrame;
    const key = `${f.functionName || '(anonymous)'}  ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
  });
  const total = Array.from(self.values()).reduce((a, b) => a + b, 0);
  const top = Array.from(self.entries()).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms  ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`);
  const long = await page.evaluate(() => (window as any).__long as number[]);
  const stats = await page.evaluate(() => { const c = (window as any).__OBS_CTX__; let meshes = 0, tris = 0; c.world.scene.three.traverse((o: any) => { if (o.isMesh) { meshes++; const g = o.geometry; tris += g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3; } }); return { meshes, tris: Math.round(tris), models: c.fragments.list.size }; });
  const report = `ORBIT PROFILE  wall time ${wall} ms for 240 mouse moves; models ${stats.models}, meshes ${stats.meshes}, triangles ${stats.tris}\nlong tasks (ms): ${long.length} total, longest ${Math.max(0, ...long)}, sum ${long.reduce((a, b) => a + b, 0)}\n--- top self time ---\n${top.join('\n')}`;
  console.log(report);
  test.info().annotations.push({ type: 'orbit-profile', description: report });
  (await import('fs')).mkdirSync('test-results', { recursive: true });
  (await import('fs')).writeFileSync('test-results/orbit-profile.txt', report);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('smooth navigation lowers the render resolution while dragging and restores it afterwards', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.world?.renderer?.three), { timeout: 30000 }).toBe(true);
  const ratio = () => page.evaluate(() => (window as any).__OBS_CTX__.world.renderer.three.getPixelRatio() as number);
  const before = await ratio();
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(cx + 60, cy + 20, { steps: 6 });
  const during = await ratio();
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(600);
  const after = await ratio();
  expect(during, `during drag (before ${before})`).toBeLessThan(before);
  expect(after, 'restored after the drag').toBe(before);
  expect(errors, errors.join('\n')).toEqual([]);
});
