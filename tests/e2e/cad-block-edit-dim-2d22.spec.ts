import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * 2D-22 — dimensions authored inside BEDIT become real DIMENSION entities
 * in the block definition, not plain geometry + a stale live record.
 *
 * Reference model, imported from DXF with native blocks on: block
 * "CHAIR" (base 10,20) holding one LINE and one LWPOLYLINE, placed
 * twice (at 0,0 and at 100,0) — the same fixture as the A9 spec.
 *
 * Proved in the real app:
 *  1. DIMLINEAR (10,20)-(30,20), dim line at (20,30), placed inside a
 *     BEDIT CHAIR session: CENSUS shows the dimension's geometry in the
 *     session (LINE=8, TEXT=1) and the log reports "DIMLINEAR: 20.00 mm.
 *     Dimension placed".
 *  2. BCLOSE redefines CHAIR with 3 objects (LINE, LWPOLYLINE,
 *     DIMENSION) — the 7 LINEs + TEXT of the dimension are replaced by
 *     one DIMENSION entity; the model shows INSERT=2 only, nothing leaks.
 *  3. QSAVE writes a DIMENSION record inside the CHAIR block (dimType 0,
 *     extension origins 10,20 / 30,20, definition point 20,30, text
 *     "20.00 mm") and no TEXT entity in the block; the model ENTITIES carry
 *     no DIMENSION.
 *  4. Re-entering BEDIT CHAIR shows DIMENSION=1 in the session CENSUS —
 *     the entity round-trips as an entity, and it draws (the DIMENSION
 *     draw case renders it from its definition points; a failure there
 *     would surface as a page error).
 *  5. Discard path: a second DIMLINEAR in a session closed with BCLOSE
 *     DISCARD leaves the definition unchanged — QSAVE still shows
 *     exactly one DIMENSION in CHAIR, the first one; the discarded
 *     dimension's record is dropped with its geometry.
 *
 * Calibration runs with OSNAP off (A16 lesson) and the screen->world
 * map is re-solved from the live canvas before each absolute pick
 * (A15 lesson). Tolerances follow the A7/A11 convention (2 decimals).
 *
 * Run against this branch's own build on its own port (never :3000):
 *   npx vite build && npx vite preview --port 3119 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3119 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 1, 0, 'LAYER', 2, '0', 70, 0, 62, 7, 6, 'CONTINUOUS', 0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 8, '0', 2, 'CHAIR', 70, 0, 10, 10, 20, 20, 30, 0, 3, 'CHAIR',
  0, 'LINE', 8, '0', 10, 10, 20, 20, 30, 0, 11, 30, 21, 20, 31, 0,
  0, 'LWPOLYLINE', 8, '0', 90, 3, 70, 0, 10, 10, 20, 20, 10, 10, 20, 40, 10, 30, 20, 40,
  0, 'ENDBLK', 8, '0',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'INSERT', 8, '0', 2, 'CHAIR', 10, 0, 20, 0, 30, 0,
  0, 'INSERT', 8, '0', 2, 'CHAIR', 10, 100, 20, 0, 30, 0,
  0, 'ENDSEC', 0, 'EOF',
);

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

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
  const sx = (w2.x - w1.x) / (px2 - px1);
  const sy = (w4.y - w3.y) / (py2 - py1);
  return { sx, ox: w1.x - sx * px1, sy, oy: w3.y - sy * py1 };
}

/** Minimal DXF record splitter (the A11 pattern). */
function dxfRecords(text: string): { type: string; groups: Map<number, string[]> }[] {
  const lines = text.split(/\r?\n/);
  const recs: { type: string; groups: Map<number, string[]> }[] = [];
  let cur: { type: string; groups: Map<number, string[]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    const val = lines[i + 1];
    if (code === 0) {
      cur = { type: val.trim(), groups: new Map() };
      recs.push(cur);
    } else if (cur) {
      const arr = cur.groups.get(code) ?? [];
      arr.push(val);
      cur.groups.set(code, arr);
    }
  }
  return recs;
}
function recNum(r: { groups: Map<number, string[]> }, code: number, nth = 0): number | undefined {
  const v = r.groups.get(code)?.[nth];
  return v === undefined ? undefined : parseFloat(v);
}
function recStr(r: { groups: Map<number, string[]> }, code: number, nth = 0): string | undefined {
  return r.groups.get(code)?.[nth];
}

/** Entities inside a named BLOCK in the BLOCKS section, plus the BLOCK record itself. */
function blockDef(text: string, name: string): { block: { type: string; groups: Map<number, string[]> }; entities: { type: string; groups: Map<number, string[]> }[] } | null {
  const recs = dxfRecords(text);
  let inBlocks = false;
  let cur: string | null = null;
  let found: { type: string; groups: Map<number, string[]> } | null = null;
  const entities: { type: string; groups: Map<number, string[]> }[] = [];
  for (const r of recs) {
    if (r.type === 'SECTION') { inBlocks = recStr(r, 2) === 'BLOCKS'; cur = null; continue; }
    if (r.type === 'ENDSEC') { inBlocks = false; cur = null; continue; }
    if (!inBlocks) continue;
    if (r.type === 'BLOCK') { cur = recStr(r, 2) ?? null; if (cur === name) found = r; continue; }
    if (r.type === 'ENDBLK') { if (cur === name) return found ? { block: found, entities } : null; cur = null; continue; }
    if (cur === name && found) entities.push(r);
  }
  return null;
}

/** DIMENSION records in the ENTITIES section of a saved DXF. */
function modelDimensions(text: string): { type: string; groups: Map<number, string[]> }[] {
  const recs = dxfRecords(text);
  let inEntities = false;
  const out: { type: string; groups: Map<number, string[]> }[] = [];
  for (const r of recs) {
    if (r.type === 'SECTION') { inEntities = recStr(r, 2) === 'ENTITIES'; continue; }
    if (r.type === 'ENDSEC') { inEntities = false; continue; }
    if (inEntities && r.type === 'DIMENSION') out.push(r);
  }
  return out;
}

test('2D-22 BEDIT: a dimension drawn in the session becomes a DIMENSION entity in the block', async ({ page }, testInfo) => {
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
  const lastCensus = async () => {
    await run('CENSUS');
    const lines = (await hist()).split('\n').filter((l) => l.includes('CENSUS:'));
    return lines[lines.length - 1] ?? '';
  };
  const expectCensus = async (re: RegExp) => {
    await expect.poll(lastCensus, { timeout: 15000 }).toMatch(re);
  };
  const expectCensusNot = async (re: RegExp) => {
    await expect.poll(async () => !re.test(await lastCensus()), { timeout: 15000 }).toBe(true);
  };
  const osnapBtn = page.locator('[data-s=snap]');
  const setOsnap = async (on: boolean) => {
    const active = await osnapBtn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await osnapBtn.click();
  };
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const banner = page.locator('[data-r=bedit]').first();

  // OSNAP off for calibration (A16 lesson); POLAR/OTRACK off for free-point picks.
  await setOsnap(false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);

  // Native blocks on, so the imported INSERTs stay references.
  await run('NATIVEBLOCKS ON');
  await expect.poll(async () => /NATIVEBLOCKS: ON/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 1. Import the reference model: two references to CHAIR.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'chair.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/INSERT=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. BEDIT CHAIR, then DIMLINEAR (10,20)-(30,20) with the dim line at (20,30).
  await run('BEDIT CHAIR');
  await expect.poll(async () => /BEDIT: editing "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeVisible();
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const clickWorld = async (wx: number, wy: number) => {
    const s = { x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy };
    await page.mouse.click(s.x, s.y);
  };
  await run('DIMLINEAR');
  await clickWorld(10, 20);
  await clickWorld(30, 20);
  await clickWorld(20, 30);
  await expect.poll(async () => /DIMLINEAR: 20\.00 mm\. Dimension placed/.test(await hist()), { timeout: 10000 }).toBe(true);
  // A linear dimension builds 7 LINEs + 1 TEXT on top of the chair's LINE=1.
  await expectCensus(/LINE=8/);
  await expectCensus(/TEXT=1/);
  await expectCensus(/LWPOLYLINE=1/);

  // 3. BCLOSE: the dimension's 8 entities become one DIMENSION entity.
  await run('BCLOSE');
  await expect.poll(async () => /BCLOSE: block "CHAIR" redefined \(3 object\(s\), base 10, 20\) — 2 reference\(s\) updated/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeHidden();
  await expectCensus(/INSERT=2/);
  await expectCensusNot(/LINE=/);
  await expectCensusNot(/TEXT=/);
  await expectCensusNot(/DIMENSION=/);

  // 4. QSAVE: the CHAIR block carries a real DIMENSION record, not plain geometry.
  const savedPath = testInfo.outputPath('saved-after-bedit-dim-2d22.dxf');
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    await d.saveAs(savedPath);
  }
  {
    const text = fs.readFileSync(savedPath, 'utf8');
    const chair = blockDef(text, 'CHAIR');
    expect(chair, 'no CHAIR block in the saved DXF').toBeTruthy();
    expect(chair!.entities.filter((r) => r.type === 'LINE').length).toBe(1);
    expect(chair!.entities.filter((r) => r.type === 'LWPOLYLINE').length).toBe(1);
    expect(chair!.entities.filter((r) => r.type === 'TEXT').length, 'dimension geometry was not replaced — plain TEXT leaked into the block').toBe(0);
    const dims = chair!.entities.filter((r) => r.type === 'DIMENSION');
    expect(dims.length, `expected 1 DIMENSION in the CHAIR block, got ${dims.length}`).toBe(1);
    const dim = dims[0];
    expect(recNum(dim, 70)).toBe(0); // rotated-linear
    expect(recStr(dim, 3)).toBe('ISO-25');
    expect(recNum(dim, 13)).toBeCloseTo(10, 2);
    expect(recNum(dim, 23)).toBeCloseTo(20, 2);
    expect(recNum(dim, 14)).toBeCloseTo(30, 2);
    expect(recNum(dim, 24)).toBeCloseTo(20, 2);
    expect(recNum(dim, 10)).toBeCloseTo(20, 2);
    expect(recNum(dim, 20)).toBeCloseTo(30, 2);
    expect(recStr(dim, 1)).toBe("20.00 mm");
    expect(modelDimensions(text).length, 'a DIMENSION leaked into the model ENTITIES').toBe(0);
  }

  // 5. Re-enter BEDIT: the DIMENSION entity is in the definition and readable.
  await run('BEDIT CHAIR');
  await expect.poll(async () => /BEDIT: editing "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expectCensus(/DIMENSION=1/);
  await expectCensus(/LINE=1/);
  await expectCensus(/LWPOLYLINE=1/);
  await run('BCLOSE DISCARD');
  await expect.poll(async () => /BEDIT: discarded changes to "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 6. Discard path: a second dimension drawn in a discarded session never
  //    reaches the definition, and its record is dropped with it. The
  //    dimension measures the chair's vertical edge (10,20)-(10,40) with
  //    its dim line at (15,30) — inside the fitted session view, so all
  //    three picks land on the canvas.
  await run('BEDIT CHAIR');
  await expect.poll(async () => /BEDIT: editing "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  box = await canvasBox();
  map = await calibrate(page, box);
  await run('DIMLINEAR');
  await clickWorld(10, 20);
  await clickWorld(10, 40);
  await clickWorld(15, 30);
  await expect.poll(async () => /DIMLINEAR: 20\.00 mm\. Dimension placed/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expectCensus(/TEXT=1/);
  await run('BCLOSE DISCARD');
  await expect.poll(async () => /BEDIT: discarded changes to "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    await d.saveAs(testInfo.outputPath('saved-after-discard-dim-2d22.dxf'));
    const text = fs.readFileSync(testInfo.outputPath('saved-after-discard-dim-2d22.dxf'), 'utf8');
    const chair = blockDef(text, 'CHAIR');
    const dims = chair!.entities.filter((r) => r.type === 'DIMENSION');
    expect(dims.length, 'discarded dimension leaked into the CHAIR block').toBe(1);
    expect(recNum(dims[0], 13)).toBeCloseTo(10, 2);
    expect(recNum(dims[0], 23)).toBeCloseTo(20, 2);
    expect(chair!.entities.filter((r) => r.type === 'TEXT').length).toBe(0);
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
