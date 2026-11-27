import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * Annotation completion (AutoCAD parity A10).
 *
 * Reference drawing: two LINEs, imported from DXF:
 *   A (100,200)-(900,200) · B (300,100)-(300,700)
 *
 * Proved in the real app:
 *  1. DIMORDINATE (X): feature A-end (900,200), leader end (950,210) —
 *     the history reports "DIMORDINATE (X): 900.00…"; the dimension is a
 *     real DIMENSION dimType 6 in the saved DXF (group 13 = leader end).
 *  2. DIMORDINATE (Y): feature B-bottom (300,100), leader end (360,260) —
 *     "DIMORDINATE (Y): 100.00…"; second dimType 6 in the saved DXF.
 *     (The leader end sits 60 units clear of both reference lines so no
 *     OSNAP perpendicular snap moves it; (310,150) snapped onto line B.)
 *  3. ARC centre-start-end: `ARC C`, clicks (500,400) centre, (600,400)
 *     start, (500,500) end — R=100.00, CENSUS ARC=1. (The old code only
 *     knew 3-point arcs; `ARC C` did nothing.)
 *  4. MTEXT: `MTEXT`, two corners (100,500)-(400,500) — the modal's
 *     Width field reads 300, the placed text is a wrapping TEXT with a
 *     column width, and the saved DXF carries a real MTEXT record
 *     (group 41 = 300). (The old ribbon "MText" just opened TEXT.)
 *  5. Leader: `QLEADER`, tip (700,600), landing (760,660), text
 *     "NOTE-LEADER" — CENSUS shows the arrowhead LWPOLYLINE + LINE +
 *     TEXT, and they survive QSAVE → reload → re-import. (The old
 *     Leader pushed a transient markup that never reached the file.)
 *  6. Round trip: QSAVE, parse the downloaded DXF in Node (two
 *     DIMENSION dimType 6 + one MTEXT), reload, re-import, CENSUS
 *     identical (LINE=11, TEXT=4, LWPOLYLINE=1, ARC=1).
 *
 * Calibration runs with OSNAP off (A16 lesson): the coords readout shows
 * the snapped cursor while OSNAP is on, which contaminates the map. OSNAP
 * is switched back on for the ordinate feature picks (they must land
 * exactly on the endpoints) and off again for the free-point picks.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already on :3000, so a
 * run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3117 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3117 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const refDxf = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 100, 20, 200, 11, 900, 21, 200,
  0, 'LINE', 8, '0', 10, 300, 20, 100, 11, 300, 21, 700,
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
const recVal = (rec: { pairs: Array<[string, string]> }, code: string | number, n = 0): string | undefined =>
  rec.pairs.filter(([c]) => c === String(code)).map(([, v]) => v)[n];
const recNum = (rec: { pairs: Array<[string, string]> }, code: string | number, n = 0): number | undefined => {
  const v = recVal(rec, code, n);
  return v === undefined ? undefined : parseFloat(v);
};

test('2D editor: ordinate dimensions, arc variants, MTEXT, leader as entity, DXF round trip', async ({ page }, testInfo) => {
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
  const setOsnap = async (on: boolean) => {
    const btn = page.locator('[data-s=snap]');
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  // ORTHO loads from persisted settings and constrains every point entry
  // to horizontal/vertical from the anchor (line 8688) — a leader end at
  // (950,210) becomes (950,200) and a mid-tool recalibration reads a
  // frozen Y. Force it off for the whole spec; no pick here needs it.
  // POLAR and OTRACK are ON BY DEFAULT and do the same through
  // constrainInputPoint: POLAR snaps the second point onto 90° rays from
  // the anchor, OTRACK onto the anchor's axis lines. All three go off.
  const setToggle = async (name: string, on: boolean) => {
    const btn = page.locator(`[data-s=${name}]`);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const setOrtho = (on: boolean) => setToggle('ortho', on);
  const setPolar = (on: boolean) => setToggle('polar', on);
  const setOtrack = (on: boolean) => setToggle('otrack', on);
  const focusCanvas = async () => {
    await page.evaluate(() => (document.querySelector('[data-r=cv]') as HTMLElement | null)?.focus());
  };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'ref.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=2/.test(await hist()); }, { timeout: 15000 }).toBe(true);

  // Calibrate with OSNAP off, then back on for the endpoint picks.
  await setOsnap(false);
  await setOrtho(false);
  await setPolar(false);
  await setOtrack(false);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  let map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  // The map goes stale if the canvas resizes after calibration (A15's
  // failure: a leader end landed 50 units off and perpendicular-snapped
  // onto a reference line). Re-solve from the live canvas box right
  // before each absolute (unsnapped) pick; the snapped feature picks
  // and the difference-based arc/MTEXT picks do not need it.
  const recalibrate = async () => {
    const live = (await page.locator('[data-r=cv]').first().boundingBox())!;
    map = await calibrate(page, live);
  };
  const clickWorld = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };

  // 1. DIMORDINATE (X): feature A-end (900,200) → "900.00".
  //    The feature pick needs OSNAP on (exact endpoint); the leader end
  //    is a free point, so OSNAP goes off before it — with OSNAP on, the
  //    leader end perpendicular-snaps onto line A (950,210 → 950,200).
  await setOsnap(true);
  await run('DIMORDINATE');
  await clickWorld(900, 200);
  await setOsnap(false);
  await recalibrate();
  await clickWorld(950, 210);
  await expect.poll(async () => /DIMORDINATE \(X\): 900\.00/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 2. DIMORDINATE (Y): feature B-bottom (300,100) → "100.00".
  //    The leader end stays inside the fitted view (ZOOM E fits tight
  //    vertically, so a point above B's top edge would fall off-canvas).
  //    Same OSNAP dance: on for the feature pick, off for the free
  //    leader end (with OSNAP on it snapped onto line B: 360,260 → 300,270.88).
  await setOsnap(true);
  await run('DIMORDINATE');
  await clickWorld(300, 100);
  await setOsnap(false);
  await recalibrate();
  await clickWorld(360, 260);
  await expect.poll(async () => /DIMORDINATE \(Y\): 100\.00/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 3. ARC centre-start-end: `ARC C`, centre (500,400), start (600,400), end (500,500).
  await setOsnap(false);
  await focusCanvas();
  await run('ARC C');
  await clickWorld(500, 400);
  await clickWorld(600, 400);
  await clickWorld(500, 500);
  await expect.poll(async () => /Arc added \(centre-start-end\): R=100\.00/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 4. MTEXT: two corners (100,500)-(400,500) — the modal's Width reads 300.
  await run('MTEXT');
  await clickWorld(100, 500);
  await clickWorld(400, 500);
  const modal = page.locator('.obs-form-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  const widthInput = modal.locator('input[type=number]').nth(1);
  // Clicks land within a fraction of a world unit of the intended corners,
  // so the width is 300 to within float noise — not exactly 300.
  const widthVal = parseFloat(await widthInput.inputValue());
  expect(Math.abs(widthVal - 300)).toBeLessThan(0.01);
  await modal.locator('textarea').first().fill('WRAPPED TEXT HERE IS LONG ENOUGH TO WRAP');
  await modal.locator('button', { hasText: 'Place multiline text' }).click();
  await expect.poll(async () => /MTEXT placed/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 5. Leader: tip (700,600), landing (760,660), text "NOTE-LEADER".
  await run('QLEADER');
  await clickWorld(700, 600);
  await clickWorld(760, 660);
  const leaderInput = page.locator('.obs-form-modal input[type=text]').first();
  await expect(leaderInput).toBeVisible({ timeout: 10000 });
  await leaderInput.fill('NOTE-LEADER');
  await leaderInput.press('Enter');
  await expect.poll(async () => /Leader added: "NOTE-LEADER"/.test(await hist()), { timeout: 15000 }).toBe(true);

  // 6. Live counts: 2 ref LINEs + 4 + 4 ordinate LINEs + 1 leader LINE;
  //    TEXT: 2 ordinate + 1 leader + 1 MTEXT; arrowhead LWPOLYLINE; ARC.
  const live = await census();
  expect(live.LINE).toBe(11);
  expect(live.TEXT).toBe(4);
  expect(live.LWPOLYLINE).toBe(1);
  expect(live.ARC).toBe(1);

  // 7. QSAVE: parse the downloaded DXF in Node.
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await run('QSAVE');
  const d = await dl;
  // saveAs() waits for the download to finish writing; reading d.path()
  // straight after waitForEvent('download') can catch a partially written
  // file (2D-14; the A11 spec already uses this pattern).
  const dxfPath = testInfo.outputPath('saved-a10.dxf');
  await d.saveAs(dxfPath);
  const dxfText = fs.readFileSync(dxfPath, 'utf8');
  const recs = dxfRecords(dxfText);
  const dims = recs.filter((r) => r.type === 'DIMENSION');
  expect(dims.length).toBe(2);
  for (const dim of dims) {
    expect(recNum(dim, 70)! & 7).toBe(6);
    expect(recNum(dim, 70)).toBe(38); // dimType 6 + exclusive-block bit
  }
  // Leader ends land with calibration float noise (~5e-5), so compare
  // with tolerance rather than exact equality.
  const leaderEnds = dims.map((r) => [recNum(r, 13)!, recNum(r, 23)!]).sort();
  const expectedEnds = [[360, 260], [950, 210]];
  expect(leaderEnds.length).toBe(expectedEnds.length);
  for (let i = 0; i < expectedEnds.length; i++) {
    expect(Math.abs(leaderEnds[i][0] - expectedEnds[i][0])).toBeLessThan(0.01);
    expect(Math.abs(leaderEnds[i][1] - expectedEnds[i][1])).toBeLessThan(0.01);
  }
  const mtexts = recs.filter((r) => r.type === 'MTEXT');
  expect(mtexts.length).toBe(1);
  expect(Math.abs(recNum(mtexts[0], 41)! - 300)).toBeLessThan(0.01);
  expect(recVal(mtexts[0], 1)).toContain('WRAPPED TEXT HERE IS LONG ENOUGH TO WRAP');

  // 8. Reload, re-import the saved file: the same counts prove the file
  //    stands alone and the leader/ordinate survive as geometry.
  await page.reload();
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'saved.dxf', mimeType: 'text/plain', buffer: Buffer.from(dxfText) });
  await expect.poll(async () => { const c = await census(); return c.LINE === 11 && c.TEXT === 4; }, { timeout: 30000 }).toBe(true);
  const back = await census();
  expect(back.LINE).toBe(11);
  expect(back.TEXT).toBe(4);
  expect(back.LWPOLYLINE).toBe(1);
  expect(back.ARC).toBe(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
