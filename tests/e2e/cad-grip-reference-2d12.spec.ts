import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * Grip Reference option (2D-12, AutoCAD R during a grip edit).
 *
 * Reference drawing, imported from DXF: one LINE (0,0)-(10,0), plus two
 * POINTs (-100,-100) and (200,200) as extent anchors so ZOOM E leaves
 * margin for the reference / new-point clicks.
 *
 * Proved in the real app:
 *  1. Grip Scale (Enter x3) + R: reference point (5,0) sets the
 *     reference length 5; new point (20,0) scales x4 about the grip
 *     (0,0) -> the line becomes (0,0)-(40,0).
 *  2. Grip Rotate (Enter x2) + R: reference point (0,10) sets the
 *     reference angle 90 deg; new point (10,0) rotates -90 deg about
 *     the grip (0,0) -> the line becomes (0,0)-(0,-40).
 *  3. QSAVE: the saved DXF carries the final geometry.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the map is re-solved
 * from the live canvas box right before each step's first click (A15
 * lesson). ORTHO/POLAR/OTRACK stay off so the clicks land where the
 * calibration says they land.
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npm run build && python3 -m http.server 3140 --directory dist
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3140 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 0,
  0, 'POINT', 8, '0', 10, -100, 20, -100,
  0, 'POINT', 8, '0', 10, 200, 20, 200,
  0, 'ENDSEC', 0, 'EOF',
);

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

/** Solve screen→world from two mouse samples per axis (OSNAP off). */
async function calibrate(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<Affine> {
  const midY = box.y + box.height / 2;
  const midX = box.x + box.width / 2;
  await page.mouse.move(box.x + box.width * 0.25, midY);
  await page.waitForTimeout(150);
  const w1 = await readCoords(page);
  await page.mouse.move(box.x + box.width * 0.75, midY);
  await page.waitForTimeout(150);
  const w2 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.25);
  await page.waitForTimeout(150);
  const w3 = await readCoords(page);
  await page.mouse.move(midX, box.y + box.height * 0.75);
  await page.waitForTimeout(150);
  const w4 = await readCoords(page);
  const px1 = box.x + box.width * 0.25, px2 = box.x + box.width * 0.75;
  const py1 = box.y + box.height * 0.25, py2 = box.y + box.height * 0.75;
  expect(Math.abs(w2.x - w1.x), 'calibration: no world-X change across the canvas').toBeGreaterThan(0.1);
  expect(Math.abs(w4.y - w3.y), 'calibration: no world-Y change across the canvas').toBeGreaterThan(0.1);
  const sx = (w2.x - w1.x) / (px2 - px1);
  const sy = (w4.y - w3.y) / (py2 - py1);
  return { sx, ox: w1.x - sx * px1, sy, oy: w3.y - sy * py1 };
}

/** Minimal DXF record reader for the saved-file assertions. */
function dxfRecords(text: string): Array<{ type: string; pairs: Array<[string, string]> }> {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const recs: Array<{ type: string; pairs: Array<[string, string]> }> = [];
  let cur: { type: string; pairs: Array<[string, string]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim(), value = lines[i + 1];
    if (code === '0') { cur = { type: value.trim(), pairs: [] }; recs.push(cur); }
    else if (cur) cur.pairs.push([code, value]);
  }
  return recs;
}
const recNum = (rec: { pairs: Array<[string, string]> }, code: string | number, n = 0): number | undefined => {
  const v = rec.pairs.filter(([c]) => c === String(code)).map(([, x]) => x)[n];
  return v === undefined ? undefined : parseFloat(v);
};

test('2D editor: grip Reference option scales and rotates against a picked point', async ({ page }, testInfo) => {
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  const census = async (): Promise<Record<string, number>> => {
    await run('CENSUS');
    const text = await hist();
    const lines = text.split('\n').filter((l) => /CENSUS: /.test(l));
    const last = lines[lines.length - 1] ?? '';
    const out: Record<string, number> = {};
    for (const m of last.matchAll(/([A-Z0-9]+)=(\d+)/g)) out[m[1]] = Number(m[2]);
    return out;
  };
  const setToggle = async (name: string, on: boolean) => {
    const btn = page.locator(`[data-s=${name}]`);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'ref.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(async () => { const c = await census(); return c.LINE === 1 && c.POINT === 2; }, { timeout: 15000 }).toBe(true);

  // Calibrate with OSNAP off, then keep OSNAP/ORTHO/POLAR/OTRACK off.
  await setToggle('snap', false);
  await setToggle('ortho', false);
  await setToggle('polar', false);
  await setToggle('otrack', false);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  let map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const recalibrate = async () => {
    const live = (await page.locator('[data-r=cv]').first().boundingBox())!;
    map = await calibrate(page, live);
  };
  const clickWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };
  /** Type R mid-drag: opens the dynamic command prompt, Enter arms Reference. */
  const armReference = async () => {
    await page.keyboard.press('r');
    await expect(page.getByLabel('Drawing command or numeric input')).toBeVisible({ timeout: 10000 });
    await page.keyboard.press('Enter');
    await expect.poll(hist, { timeout: 10000 }).toContain('Reference: specify reference point');
  };

  // 1. Grip Scale (Enter x3) + R: reference (5,0) -> length 5; new (20,0)
  //    scales x4 about the grip (0,0): the line becomes (0,0)-(40,0).
  await recalibrate();
  await clickWorld(5, 0); // select the line alone
  {
    const g = toScreen(0, 0);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // stretch -> move -> rotate -> scale
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Scale');
    await armReference();
    await page.mouse.up(); // suspends the drag: no commit, grip stays hot
    await clickWorld(5, 0); // reference point
    await expect.poll(hist, { timeout: 10000 }).toContain('specify new length');
    await clickWorld(20, 0); // new point: applies x4, release commits
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 2. Grip Rotate (Enter x2) + R: reference (0,10) -> angle 90 deg; new
  //    (10,0) rotates -90 deg about the grip (0,0): (0,0)-(0,-40).
  await recalibrate();
  await clickWorld(20, 0); // select the line alone (now (0,0)-(40,0))
  {
    const g = toScreen(0, 0);
    await page.mouse.move(g.x, g.y);
    await page.mouse.down();
    await focusCanvas();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // stretch -> move -> rotate
    await expect.poll(hist, { timeout: 10000 }).toContain('Grip mode: Rotate');
    await armReference();
    await page.mouse.up(); // suspends the drag
    await clickWorld(0, 10); // reference point
    await expect.poll(hist, { timeout: 10000 }).toContain('specify new angle');
    await clickWorld(10, 0); // new point: applies -90 deg, release commits
  }
  await expect.poll(hist, { timeout: 10000 }).toContain('Grip edit: object updated');

  // 3. Live counts unchanged by the grip edits (same entities, moved).
  const live = await census();
  expect(live.LINE).toBe(1);
  expect(live.POINT).toBe(2);

  // 4. QSAVE: parse the downloaded DXF in Node.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  const savedPath = testInfo.outputPath('saved-2d12.dxf');
  await d.saveAs(savedPath);
  const dxfText = fs.readFileSync(savedPath, 'utf8');
  const recs = dxfRecords(dxfText);
  const lines = recs.filter((r) => r.type === 'LINE');
  expect(lines.length).toBe(1);
  const line = lines[0];
  // 0.5 tolerance: the scale factor compounds the two clicks'
  // screen->world round-trips, so the end lands ~0.1 off the exact -40.
  expect(recNum(line, 10)).toBeCloseTo(0, 1);
  expect(recNum(line, 20)).toBeCloseTo(0, 1);
  expect(recNum(line, 11)).toBeCloseTo(0, 1);
  expect(recNum(line, 21)).toBeCloseTo(-40, 0.5);

  expect(errors, errors.join('\n')).toEqual([]);
});
