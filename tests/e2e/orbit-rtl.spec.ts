import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

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

test('Family sketch window: a parametric rectangle and a polygon with a hole create real families', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.family), { timeout: 30000 }).toBe(true);
  const open = async () => {
    await page.keyboard.press('Control+p');
    await page.keyboard.type('Family sketch: new family');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-sketch-editor]')).toBeVisible({ timeout: 10000 });
  };
  const click = async (fx: number, fy: number) => {
    const b = (await page.locator('[data-sketch-editor] [data-svg]').boundingBox())!;
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  };
  const familyByName = (name: string) => page.evaluate((n) => {
    const svc = (window as any).__OBS_CTX__.features.family;
    const f = svc.list().find((x: any) => x.name === n);
    return f ? JSON.parse(JSON.stringify(f)) : null;
  }, name);

  // 1) Parametric rectangle.
  await open();
  const ed = page.locator('[data-sketch-editor]');
  await ed.locator('[data-name]').fill('E2E Pad');
  await ed.locator('[data-tool="rect"]').click();
  await click(0.4, 0.4); await click(0.6, 0.55);
  await ed.locator('[data-apply]').click();
  await expect(ed).toHaveCount(0, { timeout: 10000 });
  const pad = await familyByName('E2E Pad');
  expect(pad, 'family created').not.toBeNull();
  const names = pad.parameters.map((p: any) => p.name);
  expect(names, JSON.stringify(names)).toEqual(expect.arrayContaining(['sketchWidth', 'sketchLength', 'sketchDepth']));
  expect(pad.geometry.profile?.kind ?? pad.geometry.parts?.[0]?.profile?.kind, 'rect profile kept parametric').toBe('rect');

  // 2) Square outline with a square hole.
  await open();
  await ed.locator('[data-name]').fill('E2E Holed');
  await ed.locator('[data-tool="polygon"]').click();
  for (const [x, y] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]]) await click(x, y);
  await ed.locator('[data-close]').click();
  await ed.locator('[data-hole]').click();
  await ed.locator('[data-tool="rect"]').click();
  await click(0.45, 0.45); await click(0.55, 0.55);
  await ed.locator('[data-apply]').click();
  await expect(ed).toHaveCount(0, { timeout: 10000 });
  const holed = await familyByName('E2E Holed');
  expect(holed, 'holed family created').not.toBeNull();
  const g = holed.geometry.holes ? holed.geometry : holed.geometry.parts?.find((p: any) => p.holes);
  expect(g?.holes?.length, JSON.stringify(holed.geometry).slice(0, 300)).toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

// ---- 3D sectioning: does the Section Box really clip the model on screen?
async function loadWallIfc(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC model loaded' }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(1500);
}

/** Minimal 8-bit non-interlaced PNG decoder (the page CSP blocks decoding inside the browser). Returns RGB(A) bytes. */
function decodePng(buf: Buffer): { w: number; h: number; bpp: number; data: Buffer } {
  let o = 8, w = 0, h = 0, ct = 0; const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x], a = x >= bpp ? out[dst + x - bpp] : 0, b = y > 0 ? out[dst - stride + x] : 0, c = x >= bpp && y > 0 ? out[dst - stride + x - bpp] : 0;
      let r = v;
      if (f === 1) r = v + a; else if (f === 2) r = v + b; else if (f === 3) r = v + ((a + b) >> 1);
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[dst + x] = r & 255;
    }
  }
  return { w, h, bpp, data: out };
}

/** Number of canvas pixels that differ clearly from the canvas corner colour (a crude "something is drawn" measure). */
async function drawnPixels(page: import('@playwright/test').Page): Promise<number> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
  const { data, bpp } = decodePng(shot);
  const bg = [data[0], data[1], data[2]];
  let n = 0;
  for (let i = 0; i < data.length; i += bpp) if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 60) n++;
  return n;
}

test('SECTION BOX: clips the model on screen and restores it when switched off', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadWallIfc(page);
  // Look straight down at the wall (5 m x 0.2 m x 3 m) from above.
  await page.evaluate(async () => {
    const c = (window as any).__OBS_CTX__.world.camera.controls;
    await c.setLookAt(2.5, 14, 0.1, 2.5, 0, 0.1, false);
  });
  await page.waitForTimeout(500);
  const before = await drawnPixels(page);
  await page.screenshot({ path: 'test-results/section-0-before.png' });

  const info = await page.evaluate(() => {
    const sb = (window as any).__OBS_CTX__.features.sectionBox;
    sb.enable(0.5);
    const b = sb.getBox();
    return { active: sb.isActive(), min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z], planes: ((window as any).__OBS_CTX__.world.renderer.three.clippingPlanes ?? []).length };
  });
  await page.waitForTimeout(500);
  const full = await drawnPixels(page);
  await page.screenshot({ path: 'test-results/section-1-box-on.png' });

  // Cut the box in half along X (keep x <= 2.5).
  const half = await page.evaluate(() => {
    const sb = (window as any).__OBS_CTX__.features.sectionBox; const b = sb.getBox(); b.max.x = (b.min.x + b.max.x) / 2; sb.setBox(b);
    return ((window as any).__OBS_CTX__.world.renderer.three.clippingPlanes ?? []).length;
  });
  let halved = await drawnPixels(page);
  for (let i = 0; i < 12 && full - halved <= 400; i++) { await page.waitForTimeout(500); halved = await drawnPixels(page); } // the clipper registers planes asynchronously
  await page.screenshot({ path: 'test-results/section-2-halved.png' });

  await page.evaluate(() => (window as any).__OBS_CTX__.features.sectionBox.disable());
  await page.waitForTimeout(500);
  const after = await drawnPixels(page);
  const dbg = await page.evaluate(() => (window as any).__OBS_CTX__.features.sectionBox.debugPlanes());
  console.log('SECTION-DBG ' + JSON.stringify(dbg));
  const planesAfter = await page.evaluate(() => ((window as any).__OBS_CTX__.world.renderer.three.clippingPlanes ?? []).length);

  const diag = `before ${before}, box-on ${full}, halved ${halved}, after-off ${after}; box ${JSON.stringify(info)}; planes after off ${planesAfter}; planes after edit ${half}`;
  console.log('SECTION-DIAG ' + diag);
  expect(info.active, diag).toBe(true);
  expect(full - halved, 'half the wall (~1000 px at this zoom) is clipped away. ' + diag).toBeGreaterThan(400);
  expect(halved, 'something remains. ' + diag).toBeGreaterThan(0);
  expect(Math.abs(after - before), 'switching off restores the view. ' + diag).toBeLessThan(before * 0.1 + 50);
  expect(half, 'editing the box replaces its planes instead of stacking them. ' + diag).toBe(6);
  expect(planesAfter, diag).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('SECTION BOX: dragging a face arrow with a real mouse moves that face and keeps exactly 6 planes', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadWallIfc(page);
  const setup = await page.evaluate(async () => {
    const ctx = (window as any).__OBS_CTX__;
    const sb = ctx.features.sectionBox; sb.enable(0.5);
    const b = sb.getBox(); const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2;
    await ctx.world.camera.controls.setLookAt(cx, cy + 3, 14, cx, cy, 0, false);
    await new Promise((r) => setTimeout(r, 600));
    const cam = ctx.world.camera.three; cam.updateMatrixWorld(true);
    let h: any = null;
    ctx.world.scene.three.traverse((o: any) => { if (o.name === 'obs-section-box-handles') h = o; });
    let target: any = null;
    h?.traverse((o: any) => { const u = o.userData; if (!target && u?.kind === 'section-box-face' && u.axis === 'x' && u.sign === 1 && u.part === 'arrow') target = o; });
    if (!target) return { err: 'no +X arrow handle found' };
    const p = target.getWorldPosition(new (cam.position.constructor)());
    p.project(cam);
    const rect = ctx.world.renderer.three.domElement.getBoundingClientRect();
    return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height, maxX: b.max.x, w: rect.width };
  });
  expect((setup as any).err, JSON.stringify(setup)).toBeUndefined();
  const s = setup as { x: number; y: number; maxX: number };
  await page.mouse.move(s.x, s.y); await page.waitForTimeout(150);
  const cursor = await page.evaluate(() => (window as any).__OBS_CTX__.world.renderer.three.domElement.style.cursor);
  await page.mouse.down();
  const midDown = await page.evaluate(() => ({ dragging: (window as any).__OBS_CTX__.features.sectionBox.debugPlanes().dragging, controls: (window as any).__OBS_CTX__.world.camera.controls.enabled }));
  await page.mouse.move(s.x - 60, s.y, { steps: 8 });
  const midMove = await page.evaluate(() => ({ dragging: (window as any).__OBS_CTX__.features.sectionBox.debugPlanes().dragging, maxX: (window as any).__OBS_CTX__.features.sectionBox.getBox().max.x }));
  console.log('SECTION-MID ' + JSON.stringify({ midDown, midMove }));
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => { const sb = (window as any).__OBS_CTX__.features.sectionBox; return { maxX: sb.getBox().max.x, planes: sb.debugPlanes() }; });
  const diag = `start ${JSON.stringify(s)} cursorOnHover=${cursor} after ${JSON.stringify(after)}`;
  console.log('SECTION-DRAG ' + diag);
  expect(cursor, 'hovering the arrow shows a grab hand. ' + diag).toBe('grab');
  expect(after.maxX, 'dragging left shrinks the +X face. ' + diag).toBeLessThan(s.maxX - 0.2);
  expect(after.planes.renderer, 'still exactly 6 planes. ' + diag).toBe(6);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('3D DIMENSION (Measure): one Esc cancels the active dimension command and its unfinished dimension; finished ones stay until deleted; Clear deletes all', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadWallIfc(page);
  await page.evaluate(async () => {
    const c = (window as any).__OBS_CTX__.world.camera.controls;
    await c.setLookAt(2.5, 14, 0.1, 2.5, 0, 0.1, false);
  });
  await page.waitForTimeout(500);
  const box = (await page.locator('canvas').first().boundingBox())!;
  const at = (fx: number, fy: number) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
  const st = () => page.evaluate(() => (window as any).__obsMeasure.state());
  const click = async (fx: number, fy: number) => { const p = at(fx, fy); await page.mouse.click(p.x, p.y); await page.waitForTimeout(500); };
  await page.evaluate(() => { (window as any).__obsMeasure.setMode('distance'); (window as any).__obsMeasure.enable(); });
  await page.waitForTimeout(400);

  await click(0.35, 0.4); await click(0.65, 0.4);          // dimension 1
  const one = await st();
  await click(0.35, 0.6); await click(0.65, 0.6);          // dimension 2
  const two = await st();
  await click(0.5, 0.3);                                    // first point of dimension 3
  const pend = await st();
  await page.keyboard.press('Escape');
  const afterEsc1 = await st();
  await page.keyboard.press('Escape'); // pressing Esc again with nothing active must be harmless
  const afterEsc2 = await st();
  const diag = JSON.stringify({ one, two, pend, afterEsc1, afterEsc2 });
  console.log('MEASURE-DIAG ' + diag);
  expect(one.labels, 'dimension 1 is drawn. ' + diag).toBeGreaterThan(0);
  expect(two.labels, 'dimension 2 is added, not replacing 1. ' + diag).toBeGreaterThan(one.labels);
  expect(pend.pending, 'first point of dimension 3 is pending. ' + diag).toBe(1);
  expect(afterEsc1.pending + afterEsc1.pendingBalls, 'Esc cancels the unfinished dimension and its marker. ' + diag).toBe(0);
  expect(afterEsc1.enabled, 'one Esc cancels the dimension command completely. ' + diag).toBe(false);
  expect(afterEsc1.labels, 'Esc does not delete finished dimensions. ' + diag).toBe(two.labels);
  expect(afterEsc2.labels, 'finished dimensions remain. ' + diag).toBe(two.labels);

  await page.evaluate(() => (window as any).__obsMeasure.clear());
  const cleared = await st();
  console.log('MEASURE-CLEARED ' + JSON.stringify(cleared));
  expect(cleared.labels + cleared.graphics + cleared.obcDims + cleared.pending, 'Clear deletes every dimension. ' + JSON.stringify(cleared)).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('3D DIMENSION (Measure): XYZ, angle and chain modes complete, Esc cancels each unfinished one, Clear deletes all', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadWallIfc(page);
  await page.evaluate(async () => {
    await (window as any).__OBS_CTX__.world.camera.controls.setLookAt(2.5, 14, 0.1, 2.5, 0, 0.1, false);
  });
  await page.waitForTimeout(500);
  const box = (await page.locator('canvas').first().boundingBox())!;
  const st = () => page.evaluate(() => (window as any).__obsMeasure.state());
  const click = async (fx: number, fy: number) => { await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy); await page.waitForTimeout(450); };
  const start = (m: string) => page.evaluate((mode) => { const o = (window as any).__obsMeasure; o.setMode(mode); o.enable(); }, m);
  const log: Record<string, unknown> = {};

  await start('xyz'); await page.waitForTimeout(300);
  await click(0.3, 0.35); await click(0.6, 0.5);
  log.xyzDone = await st();
  await click(0.4, 0.7);
  log.xyzPending = await st();
  await page.keyboard.press('Escape');
  log.xyzEsc = await st();

  await start('angle'); await page.waitForTimeout(300);
  await click(0.3, 0.3); await click(0.5, 0.5); await click(0.7, 0.3);
  log.angleDone = await st();
  await click(0.4, 0.7); await click(0.5, 0.8);
  log.anglePending = await st();
  await page.keyboard.press('Escape');
  log.angleEsc = await st();

  await start('chain'); await page.waitForTimeout(300);
  await click(0.3, 0.7); await click(0.4, 0.75); await click(0.5, 0.7);
  log.chainDone = await st();
  await page.keyboard.press('Escape');
  log.chainEsc = await st();

  await page.evaluate(() => (window as any).__obsMeasure.clear());
  log.cleared = await st();
  const d = JSON.stringify(log);
  console.log('MEASURE-MODES ' + d);
  const L = log as any;
  expect(L.xyzDone.labels, 'xyz draws X/Y/Z + total labels. ' + d).toBeGreaterThanOrEqual(2);
  expect(L.xyzPending.pending, d).toBe(1);
  expect(L.xyzEsc.pending + L.xyzEsc.pendingBalls, 'xyz Esc cancels pending. ' + d).toBe(0);
  expect(L.xyzEsc.enabled, d).toBe(false);
  expect(L.xyzEsc.labels, 'xyz Esc keeps finished. ' + d).toBe(L.xyzDone.labels);
  expect(L.angleDone.labels, 'angle adds a label. ' + d).toBeGreaterThan(L.xyzEsc.labels);
  expect(L.anglePending.pending, d).toBe(2);
  expect(L.angleEsc.pending + L.angleEsc.pendingBalls, 'angle Esc cancels pending. ' + d).toBe(0);
  expect(L.angleEsc.labels, 'angle Esc keeps finished. ' + d).toBe(L.angleDone.labels);
  expect(L.chainDone.labels, 'chain adds segment labels. ' + d).toBeGreaterThan(L.angleEsc.labels);
  expect(L.chainEsc.pending + L.chainEsc.pendingBalls, 'chain Esc leaves no marker. ' + d).toBe(0);
  expect(L.chainEsc.enabled, d).toBe(false);
  expect(L.cleared.labels + L.cleared.graphics + L.cleared.pending + L.cleared.pendingBalls, 'Clear deletes all. ' + d).toBe(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('WALK MODE: smooth constant-speed walking, stops at a wall without passing or jittering, Esc leaves cleanly', async ({ page }) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await loadWallIfc(page);
  // Stand 6 m in front of the wall (wall at z=0, spanning x -2.5..2.5) looking at it.
  await page.evaluate(async () => {
    await (window as any).__OBS_CTX__.world.camera.controls.setLookAt(0, 1.7, 6, 0, 1.7, 0, false);
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => (window as any).__OBS_CTX__.features.walkMode.enable());
  await page.waitForTimeout(600);
  const enabled = await page.evaluate(() => (window as any).__OBS_CTX__.features.walkMode.isEnabled());
  expect(enabled, 'walk mode starts').toBe(true);
  // Sample the walker pose on every animation frame while W is held.
  const startPose = await page.evaluate(() => (window as any).__OBS_CTX__.features.walkMode.getPose());
  console.log('WALK-START ' + JSON.stringify(startPose));
  await page.evaluate(() => {
    const w = window as any; w.__walkSamples = []; w.__walkRec = true;
    const loop = (t: number) => { const p = w.__OBS_CTX__.features.walkMode.getPose(); if (p) w.__walkSamples.push([t, p.x, p.y, p.z]); if (w.__walkRec) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(4500);
  await page.keyboard.up('w');
  await page.waitForTimeout(700);
  const samples: number[][] = await page.evaluate(() => { const w = window as any; w.__walkRec = false; return w.__walkSamples; });
  // Speeds per frame.
  const v: number[] = [], t: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i][0] - samples[i - 1][0]) / 1000; if (dt <= 0) continue;
    v.push(Math.hypot(samples[i][1] - samples[i - 1][1], samples[i][3] - samples[i - 1][3]) / Math.min(dt, 0.05)); t.push(samples[i][0]);
  }
  const cruise = v.filter((x) => x > 2.5 && x < 4);
  const mean = cruise.reduce((a, b) => a + b, 0) / Math.max(1, cruise.length);
  const sd = Math.sqrt(cruise.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, cruise.length));
  const minZ = Math.min(...samples.map((s) => s[3]));
  const lastZ = samples[samples.length - 1][3];
  const lastSecond = samples.filter((s) => s[0] > samples[samples.length - 1][0] - 1000);
  const jitterAtWall = Math.max(...lastSecond.map((s) => s[3])) - Math.min(...lastSecond.map((s) => s[3]));
  const ys = samples.map((s) => s[2]); const yRange = Math.max(...ys) - Math.min(...ys);
  const frameMs = samples.length > 1 ? (samples[samples.length - 1][0] - samples[0][0]) / (samples.length - 1) : 0;
  const diag = { frames: samples.length, frameMs: +frameMs.toFixed(1), cruiseFrames: cruise.length, meanSpeed: +mean.toFixed(2), sdSpeed: +sd.toFixed(2), minZ: +minZ.toFixed(3), lastZ: +lastZ.toFixed(3), jitterAtWall: +jitterAtWall.toFixed(4), eyeYRange: +yRange.toFixed(4) };
  console.log('WALK-DIAG ' + JSON.stringify(diag));
  console.log('WALK-TAIL ' + JSON.stringify(samples.slice(-22).map((q) => [Math.round(q[0]), +q[1].toFixed(3), +q[3].toFixed(3)])));
  const d = JSON.stringify(diag);
  expect(cruise.length, 'it actually walked at normal speed. ' + d).toBeGreaterThan(5);
  expect(sd / mean, 'speed is steady while walking (low frame-to-frame variation). ' + d).toBeLessThan(0.15);
  expect(minZ, 'the walker never passes through the wall (z=0, half thickness 0.1 + body 0.32). ' + d).toBeGreaterThan(0.1);
  expect(jitterAtWall, 'no shaking while pressed against the wall. ' + d).toBeLessThan(0.02);
  expect(yRange, 'eye height stays level on flat floor. ' + d).toBeLessThan(0.05);

  // Esc leaves cleanly and hands the camera back.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => { const c = (window as any).__OBS_CTX__; return { walking: c.features.walkMode.isEnabled(), controls: c.world.camera.controls.enabled, up: c.world.camera.three.up.y }; });
  console.log('WALK-AFTER ' + JSON.stringify(after));
  expect(after.walking, 'Esc exits walk mode').toBe(false);
  expect(after.controls, 'orbit controls are back').toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
