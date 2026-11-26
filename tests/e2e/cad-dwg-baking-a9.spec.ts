import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * AutoCAD 2D parity A9 — DWG geometry-baking fix.
 *
 * The A8 spec recorded as a follow-up that a DWG re-import while a paper
 * layout was on screen baked the model geometry into every paper layout,
 * so a QSAVE after a DWG import tripled the model entities (24 LINE
 * records for an 8-LINE drawing, dimension text x3). The cause was
 * `addEntities` pushing every incoming entity into BOTH the current
 * space's list and `modelEnts` with no space guard, plus `mergeCadFile`
 * targeting the current space instead of model space.
 *
 * Proved in the real app:
 *  1. The A8 reference model (LINE + bulged LWPOLYLINE + DIMLINEAR
 *     "100.00 mm") with two paper layouts, DWGSAVE'd, then re-imported
 *     while Layout1 is on screen.
 *  2. CENSUS on Layout1 is empty — no baked copies (on base: LINE=8,
 *     LWPOLYLINE=1, TEXT=1).
 *  3. CENSUS in Model is exactly the merge: LINE=16, LWPOLYLINE=2,
 *     TEXT=2 (8 live + 8 incoming).
 *  4. QSAVE writes 16 LINE records total (9 ENTITIES + 7 in the *D1
 *     block), 2 TEXT records, 1 DIMENSION — not 24 / 3 — and the
 *     *Paper_Space blocks carry no LINE / LWPOLYLINE / TEXT.
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
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LWPOLYLINE', 8, '0', 90, 2, 70, 0, 10, 0, 20, 0, 42, 1, 10, 100, 20, 0,
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
function recStr(r: { groups: Map<number, string[]> }, code: number, nth = 0): string | undefined {
  return r.groups.get(code)?.[nth];
}

/** Entity counts per DXF section / BLOCKS block (the baking proof needs the split). */
function countByBlock(text: string): Record<string, Record<string, number>> {
  const per: Record<string, Record<string, number>> = {};
  let section = '';
  let block: string | null = null;
  for (const r of dxfRecords(text)) {
    if (r.type === 'SECTION') { section = recStr(r, 2) ?? ''; block = null; continue; }
    if (r.type === 'ENDSEC') { section = ''; block = null; continue; }
    if (r.type === 'BLOCK') { block = recStr(r, 2) ?? ''; continue; }
    if (r.type === 'ENDBLK') { block = null; continue; }
    const key = section === 'BLOCKS' && block ? `BLOCK:${block}` : section || '(none)';
    per[key] ??= {};
    per[key][r.type] = (per[key][r.type] ?? 0) + 1;
  }
  return per;
}

test('A9 DWG geometry-baking fix: re-import on a sheet does not bake the model into it', async ({ page }, testInfo) => {
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
  const spaceBtn = page.locator('[data-s=space]').first();
  const tabs = page.locator('[data-r=tabs]').first();
  const newLayoutBtn = tabs.locator('button[data-new-layout]');
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

  // OSNAP off for calibration (A16 lesson).
  await setOsnap(false);

  // 1. Import the reference model.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/LINE=1/);
  await expectCensus(/LWPOLYLINE=1/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. DIMLINEAR (0,0)-(100,0), placement (50,-70) — the A8 pattern:
  //    wheel out first, re-solve the map, POLAR/OTRACK off, OSNAP on
  //    for the endpoints, off for the free placement point.
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const clickWorld = async (wx: number, wy: number) => {
    const s = { x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy };
    await page.mouse.click(s.x, s.y);
  };
  const recalibrate = async () => {
    box = await canvasBox();
    map = await calibrate(page, box);
  };
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  await recalibrate();
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setOsnap(true);
  await run('DIMLINEAR');
  await clickWorld(0, 0);
  await clickWorld(100, 0);
  await setOsnap(false);
  await clickWorld(50, -70);
  await expect.poll(async () => /DIMLINEAR: 100\.00 mm/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 3. Two paper layouts.
  await newLayoutBtn.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await expect(tabs.locator('button[data-li="0"]')).toHaveText('Layout1');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="1"]')).toHaveText('Layout2');
  // Back to Layout1 — the re-import below must happen while a paper
  // layout is on screen (the exact condition that baked the model).
  await tabs.locator('button[data-li="0"]').click();
  await expect(tabs.locator('button[data-li="0"]')).toHaveClass(/on/);

  // 4. DWGSAVE, then re-import the .dwg while Layout1 is on screen.
  const dwgPath = testInfo.outputPath('roundtrip-a9.dwg');
  {
    const dl = page.waitForEvent('download', { timeout: 120000 });
    await run('DWGSAVE');
    const d = await dl;
    expect(d.suggestedFilename(), 'DWG download name').toMatch(/\.dwg$/);
    await d.saveAs(dwgPath);
    await expect.poll(async () => /2 paper-space sheet\(s\) written/.test(await hist()), { timeout: 15000 }).toBe(true);
  }
  const dwgBytes = fs.readFileSync(dwgPath);
  expect(dwgBytes.length, 'empty DWG download').toBeGreaterThan(1000);
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'roundtrip-a9.dwg', mimeType: 'application/octet-stream', buffer: dwgBytes });
  await expect.poll(async () => /IMPORT: merged roundtrip-a9\.dwg/.test(await hist()), { timeout: 30000 }).toBe(true);
  await expect(tabs.locator('button[data-li="0"]')).toBeVisible({ timeout: 30000 });
  await expect(tabs.locator('button[data-li="1"]')).toBeVisible({ timeout: 30000 });

  // 5. CENSUS on Layout1: empty — no baked copies (on base: LINE=8,
  //    LWPOLYLINE=1, TEXT=1).
  await expect.poll(async () => {
    const c = await lastCensus();
    return !/LINE=|LWPOLYLINE=|TEXT=/.test(c) ? c : '';
  }, { timeout: 15000 }).toContain('CENSUS: (empty)');

  // 6. CENSUS in Model: exactly the merge (8 live + 8 incoming).
  await tabs.locator('button[data-li="-1"]').click();
  await expect(spaceBtn).toHaveText('MODEL');
  await expectCensus(/LINE=16/);
  await expectCensus(/LWPOLYLINE=2/);
  await expectCensus(/TEXT=2/);

  // 7. QSAVE: 16 LINE records total (not 24), 2 TEXTs (not 3),
  //    1 DIMENSION, and the *Paper_Space blocks carry no geometry.
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    const savedPath = testInfo.outputPath('saved-after-dwg-a9.dxf');
    await d.saveAs(savedPath);
    const text = fs.readFileSync(savedPath, 'utf8');
    const per = countByBlock(text);
    const total = (type: string) => Object.values(per).reduce((n, b) => n + (b[type] ?? 0), 0);
    expect(total('LINE'), `QSAVE LINE records (per-block: ${JSON.stringify(per)})`).toBe(16);
    expect(total('TEXT'), `QSAVE TEXT records (per-block: ${JSON.stringify(per)})`).toBe(2);
    expect(total('DIMENSION'), 'QSAVE DIMENSION records').toBe(1);
    const paperBlocks = Object.entries(per).filter(([k]) => /^BLOCK:\*Paper_Space/i.test(k));
    // The writer emits one legacy *Paper_Space block per EXTRA sheet (the
    // first layout's entities live in ENTITIES with group 67=1 instead) —
    // with two layouts that is exactly one block.
    expect(paperBlocks.length, 'expected one *Paper_Space block (Layout2) in the saved DXF').toBe(1);
    for (const [k, counts] of paperBlocks) {
      expect(counts['LINE'] ?? 0, `${k} carries baked LINEs`).toBe(0);
      expect(counts['LWPOLYLINE'] ?? 0, `${k} carries baked LWPOLYLINEs`).toBe(0);
      expect(counts['TEXT'] ?? 0, `${k} carries baked TEXT`).toBe(0);
    }
    // The first layout's entities live in ENTITIES with group 67=1 — the
    // baked copies would land here (on base: 8 LINEs + 1 LWPOLYLINE +
    // 1 TEXT with 67=1).
    const paperSpaceEnts = dxfRecords(text).filter(
      (r) => r.groups.get(67)?.includes('1') && (r.type === 'LINE' || r.type === 'LWPOLYLINE' || r.type === 'TEXT'),
    );
    expect(paperSpaceEnts.length, `ENTITIES carries ${paperSpaceEnts.length} baked paper-space record(s) with 67=1`).toBe(0);
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
