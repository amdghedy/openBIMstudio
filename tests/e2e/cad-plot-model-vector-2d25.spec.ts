import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';

/**
 * 2D-25 — Model vector plot: the single-PLOT dialog's Vector PDF button
 * plots Model space through the same layout pipeline as a layout.
 *
 * Reference model, imported from DXF: an L of two LINEs (10,10)-(110,10)
 * and (10,10)-(10,60) — model bounds 100 x 50 units.
 *
 * Proved in the real app:
 *  1. PLOT with Model + Area Extents + Scale Fit downloads
 *     "drawing-Model.pdf": one A3-landscape page, vector (real line
 *     operators in the decoded content stream), the 100-unit LINE
 *     spanning the full 420 mm page width at fit scale — and no
 *     viewport border: the stream holds exactly 5 segments, the two
 *     model LINEs plus the 3 edges of the white page-background rect
 *     downloadCadLayoutPdf draws on every page (a border would add
 *     a second rectangle path, 8 segments).
 *  2. PLOT again with Scale 1:50 downloads the same file name with the
 *     LINE at 2 mm (5.67 pt) — the dialog's numeric scale applies.
 *  3. The log carries the "vector PDF of Model" line for both plots.
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
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 10, 20, 10, 30, 0, 11, 110, 21, 10, 31, 0,
  0, 'LINE', 8, '0', 10, 10, 20, 10, 30, 0, 11, 10, 21, 60, 31, 0,
  0, 'ENDSEC', 0, 'EOF',
);

/** Decoded content stream of one page of a pdf-lib PDF. */
async function pageContent(doc: PDFDocument, index: number): Promise<string> {
  const page = doc.getPage(index);
  const refs = (page as any).node.Contents().asArray() as any[];
  let out = '';
  for (const ref of refs) {
    const stream = doc.context.lookup(ref) as any;
    const raw = Buffer.from(stream.getContents());
    try {
      out += zlib.inflateSync(raw).toString('latin1');
    } catch {
      out += raw.toString('latin1');
    }
  }
  return out;
}

/** Line segments ("m … l" operators) of a decoded content stream. */
function lineSegments(content: string): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  let cur: { x: number; y: number } | null = null;
  for (const m of content.matchAll(/(-?[\d.]+) (-?[\d.]+) ([ml])/g)) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]);
    if (m[3] === 'm') {
      cur = { x, y };
    } else if (cur) {
      segs.push({ x1: cur.x, y1: cur.y, x2: x, y2: y });
      cur = { x, y };
    }
  }
  return segs;
}

const PT = 72 / 25.4; // mm -> pt

/** True when some segment has the given length (±0.15 pt), any orientation. */
function segmentOfLength(segs: Array<{ x1: number; y1: number; x2: number; y2: number }>, want: number): boolean {
  return segs.some((s) => Math.abs(Math.hypot(s.x2 - s.x1, s.y2 - s.y1) - want) < 0.15);
}

test('2D-25 Model vector plot: PLOT Vector PDF plots Model at the dialog scale and area', async ({ page }, testInfo) => {
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
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };

  // OSNAP/POLAR/OTRACK/GRID off (no canvas picks in this spec, but keep
  // the view deterministic for the display-area default).
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setToggle('[data-s=grid]', false);

  // 1. Import the reference model.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect.poll(lastCensus, { timeout: 15000 }).toMatch(/LINE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. PLOT: Model is the default layout; Area Extents, Scale Fit,
  //    Vector PDF downloads "drawing-Model.pdf".
  await run('PLOT');
  await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-p=layout]')).toHaveValue('-1');
  await page.locator('[data-p=area]').selectOption('extents');
  const dl1 = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('[data-p=vector]').click();
  const d1 = await dl1;
  expect(d1.suggestedFilename(), 'Model vector PDF name').toBe('drawing-Model.pdf');
  const p1Path = testInfo.outputPath('model-fit-2d25.pdf');
  await d1.saveAs(p1Path);
  await expect.poll(async () => /PLOT: vector PDF of Model \(A3 landscape\) downloading/.test(await hist()), { timeout: 10000 }).toBe(true);
  const doc1 = await PDFDocument.load(fs.readFileSync(p1Path));
  expect(doc1.getPageCount(), 'Model fit PDF is one page').toBe(1);
  const pg1 = doc1.getPage(0);
  expect(Math.abs(pg1.getWidth() - 420 * PT), 'fit page width').toBeLessThan(0.5);
  expect(Math.abs(pg1.getHeight() - 297 * PT), 'fit page height').toBeLessThan(0.5);
  const segs1 = lineSegments(await pageContent(doc1, 0));
  expect(segs1.length, 'fit page has vector segments').toBeGreaterThan(0);
  expect(segmentOfLength(segs1, 420 * PT), `fit page must hold the 420mm model LINE, got ${JSON.stringify(segs1)}`).toBe(true);
  expect(segmentOfLength(segs1, 210 * PT), `fit page must hold the 210mm model LINE, got ${JSON.stringify(segs1)}`).toBe(true);
  // No viewport border: exactly the two model LINEs plus the 3 edges
  // of the white page-background rect — a border would add a second
  // rectangle path (8 segments total).
  expect(segs1.length, `fit page must hold only the 2 LINEs + background rect, got ${JSON.stringify(segs1)}`).toBe(5);

  // 3. PLOT again: same area (remembered), Scale 1:50 — the LINE lands
  //    at 2 mm.
  await run('PLOT');
  await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-p=layout]')).toHaveValue('-1');
  await expect(page.locator('[data-p=area]')).toHaveValue('extents');
  await page.locator('[data-p=scale]').selectOption('0.02');
  const dl2 = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('[data-p=vector]').click();
  const d2 = await dl2;
  expect(d2.suggestedFilename(), 'Model 1:50 PDF name').toBe('drawing-Model.pdf');
  const p2Path = testInfo.outputPath('model-150-2d25.pdf');
  await d2.saveAs(p2Path);
  await expect.poll(async () => /PLOT: vector PDF of Model \(A3 landscape\) downloading/.test(await hist()), { timeout: 10000 }).toBe(true);
  const doc2 = await PDFDocument.load(fs.readFileSync(p2Path));
  expect(doc2.getPageCount(), 'Model 1:50 PDF is one page').toBe(1);
  const segs2 = lineSegments(await pageContent(doc2, 0));
  expect(segs2.length, '1:50 page holds only the 2 LINEs + background rect').toBe(5);
  expect(segmentOfLength(segs2, 2 * PT), `1:50 page must hold the 2mm model LINE, got ${JSON.stringify(segs2)}`).toBe(true);

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
