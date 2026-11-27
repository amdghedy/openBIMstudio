import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import { openPaletteWith } from './palette';

/**
 * 2D-23 — BEDIT updates the library copy too, not just doc.blocks.
 *
 * The block library is the catalog shared by every drawing in this
 * browser (localStorage "obs.cad.blocks"): BLOCK writes a new block to
 * both the library and the drawing, REFCLOSE writes the library only,
 * and BEDIT used to write the document only — so a library block edited
 * in a drawing kept its stale definition in the library, and the next
 * INSERT from the library placed the old version.
 *
 * Proved in the real app:
 *  1. A library block MYBLOCK (seeded in localStorage: 2 LINEs, base
 *     0,0) opens in BEDIT from the library; a LINE drawn in the session
 *     and BCLOSE redefines it with 3 objects, and the log reports
 *     "Library copy updated."
 *  2. The library stored in localStorage now holds MYBLOCK with 3 LINEs
 *     (the drawn one at 0,10-10,10 included) — the next INSERT from the
 *     library would place the edited definition.
 *  3. QSAVE writes MYBLOCK with 3 LINEs in the document's BLOCKS section.
 *  4. Control case: CHAIR, imported from DXF (a document-only block,
 *     never in the library), edited in BEDIT and closed — its BCLOSE
 *     line carries no library note, and the stored library still holds
 *     only MYBLOCK: editing a document-only block never stocks the
 *     library with it.
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

/** The seeded library block: an L of two LINEs, base 0,0. */
const seededLibrary = [
  {
    name: 'MYBLOCK',
    base: { x: 0, y: 0 },
    entities: [
      { type: 'LINE', layer: '0', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
      { type: 'LINE', layer: '0', start: { x: 10, y: 0 }, end: { x: 10, y: 10 } },
    ],
    layers: [{ name: '0', color: 7 }],
  },
];

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

async function readLibrary(page: Page): Promise<any[]> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('obs.cad.blocks') ?? '[]'));
}

test('2D-23 BEDIT: closing a library block redefines the library copy too', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  // Seed the library before the editor module first imports it, then
  // reload so the shared library loads the seeded definition.
  await page.evaluate((seed) => localStorage.setItem('obs.cad.blocks', JSON.stringify(seed)), seededLibrary);
  await page.reload();
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
  await run('NATIVEBLOCKS ON');
  await expect.poll(async () => /NATIVEBLOCKS: ON/.test(await hist()), { timeout: 10000 }).toBe(true);

  // 1. BEDIT the library block MYBLOCK (no document copy yet — BEDIT
  //    materialises it from the library), draw the top edge, BCLOSE.
  await run('BEDIT MYBLOCK');
  await expect.poll(async () => /BEDIT: editing "MYBLOCK"/.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeVisible();
  await expectCensus(/LINE=2/);
  let box = await canvasBox();
  let map = await calibrate(page, box);
  const clickWorld = async (wx: number, wy: number) => {
    const s = { x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy };
    await page.mouse.click(s.x, s.y);
  };
  await run('LINE');
  await clickWorld(0, 10);
  await clickWorld(10, 10);
  await page.keyboard.press('Escape');
  await expectCensus(/LINE=3/);
  await run('BCLOSE');
  await expect.poll(async () => /BCLOSE: block "MYBLOCK" redefined \(3 object\(s\), base 0, 0\) — 0 reference\(s\) updated\. Library copy updated\./.test(await hist()), { timeout: 10000 }).toBe(true);
  await expect(banner).toBeHidden();

  // 2. The stored library now holds the edited definition.
  {
    const lib = await readLibrary(page);
    expect(lib.map((b: any) => b.name)).toEqual(['MYBLOCK']);
    const mine = lib[0];
    expect(mine.entities.length, `expected 3 entities in the stored MYBLOCK, got ${mine.entities.length}`).toBe(3);
    const added = mine.entities.find((e: any) => e.type === 'LINE' && Math.abs(e.start.x) < 0.1 && Math.abs(e.start.y - 10) < 0.1 && Math.abs(e.end.x - 10) < 0.1 && Math.abs(e.end.y - 10) < 0.1);
    expect(added, 'the LINE drawn in the session is missing from the stored library copy').toBeTruthy();
    expect(mine.base).toEqual({ x: 0, y: 0 });
  }

  // 3. QSAVE: the document's MYBLOCK carries the same 3 LINEs.
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    await d.saveAs(testInfo.outputPath('saved-after-bedit-lib-2d23.dxf'));
    const text = fs.readFileSync(testInfo.outputPath('saved-after-bedit-lib-2d23.dxf'), 'utf8');
    const mine = blockDef(text, 'MYBLOCK');
    expect(mine, 'no MYBLOCK block in the saved DXF').toBeTruthy();
    expect(mine!.entities.filter((r) => r.type === 'LINE').length).toBe(3);
  }

  // 4. Control case: CHAIR is a document-only block (imported from DXF).
  //    Editing it in BEDIT must NOT stock the library with it.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'chair.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/INSERT=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  await run('BEDIT CHAIR');
  await expect.poll(async () => /BEDIT: editing "CHAIR"/.test(await hist()), { timeout: 10000 }).toBe(true);
  box = await canvasBox();
  map = await calibrate(page, box);
  await run('LINE');
  await clickWorld(15, 25);
  await clickWorld(25, 25);
  await page.keyboard.press('Escape');
  await expectCensus(/LINE=2/);
  await run('BCLOSE');
  await expect.poll(async () => /BCLOSE: block "CHAIR" redefined \(3 object\(s\), base 10, 20\) — 2 reference\(s\) updated\./.test(await hist()), { timeout: 10000 }).toBe(true);
  {
    const lines = (await hist()).split('\n').filter((l) => l.includes('BCLOSE: block "CHAIR"'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[lines.length - 1].includes('Library copy updated'), 'CHAIR BCLOSE line must carry no library note').toBe(false);
  }
  {
    const lib = await readLibrary(page);
    expect(lib.map((b: any) => b.name)).toEqual(['MYBLOCK']);
    expect(lib[0].entities.length).toBe(3);
  }
  {
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await run('QSAVE');
    const d = await dl;
    await d.saveAs(testInfo.outputPath('saved-after-chair-2d23.dxf'));
    const text = fs.readFileSync(testInfo.outputPath('saved-after-chair-2d23.dxf'), 'utf8');
    const chair = blockDef(text, 'CHAIR');
    expect(chair!.entities.filter((r) => r.type === 'LINE').length).toBe(2);
    const mine = blockDef(text, 'MYBLOCK');
    expect(mine!.entities.filter((r) => r.type === 'LINE').length).toBe(3);
  }

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
