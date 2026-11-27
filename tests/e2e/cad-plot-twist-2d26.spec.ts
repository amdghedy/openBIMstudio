import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';

/**
 * 2D-26 — viewport twist in plot: a layout viewport twisted 90° plots
 * its model content rotated by -90°, as the canvas shows it.
 *
 * Reference model, opened from DXF (the home screen's 2D Open — the
 * full open path, which keeps layouts; the in-viewer import is a merge
 * and drops them): one model LINE (0,0)-(100,0) and one paper-space
 * VIEWPORT (group 67 = 1) over it — centre (210,148.5), 400x280 mm,
 * looking at model (50,0) with viewHeight 100 (scale 2.8), twist 90
 * (group 51).
 *
 * Proved in the real app:
 *  1. PLOT with the imported layout + Vector PDF downloads
 *     "drawing-Layout 1.pdf": one A3-landscape page, vector, holding a
 *     VERTICAL segment 280 mm long at the viewport centre (x = 210 mm)
 *     — the horizontal model LINE rotated by -90°.
 *  2. No horizontal 280 mm segment exists at the untwisted position
 *     (y = 148.5 mm): the content is genuinely rotated, not merely
 *     present. (The viewport border's horizontals are 400 mm.)
 *  3. The log carries the "vector PDF of layout" line.
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
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0,
  0, 'VIEWPORT', 67, 1, 8, '0', 10, 210, 20, 148.5, 30, 0, 40, 400, 41, 280, 12, 50, 22, 0, 45, 100, 51, 90,
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

/** True when some vertical segment sits at x (±0.15 pt) with the given length (±0.15 pt). */
function verticalAt(segs: Array<{ x1: number; y1: number; x2: number; y2: number }>, x: number, len: number): boolean {
  return segs.some((s) => Math.abs(s.x1 - x) < 0.15 && Math.abs(s.x2 - x) < 0.15 && Math.abs(Math.abs(s.y2 - s.y1) - len) < 0.15);
}

/** True when some horizontal segment has the given length (±0.15 pt). */
function horizontalLength(segs: Array<{ x1: number; y1: number; x2: number; y2: number }>, want: number): boolean {
  return segs.some((s) => Math.abs(s.y2 - s.y1) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - want) < 0.15);
}

test('2D-26 viewport twist in plot: a twisted viewport plots its content rotated', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String((e as Error).stack || e)));
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  // Open (not import) the file from the home screen's 2D zone: the
  // open path loads the whole drawing, layouts included — the
  // in-viewer import is a merge and drops incoming layouts.
  await page.locator('#obs-2d-file').setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  const lastCensus = async () => {
    await run('CENSUS');
    const lines = (await hist()).split('\n').filter((l) => l.includes('CENSUS:'));
    return lines[lines.length - 1] ?? '';
  };

  // 1. The file opened with its model LINE and its twisted layout.
  await expect.poll(lastCensus, { timeout: 15000 }).toMatch(/LINE=1/);
  await expect(page.locator('[data-r=tabs]').first().locator('button[data-li="0"]')).toHaveText('Layout 1', { timeout: 15000 });
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. PLOT the imported layout ("Layout 1") as a vector PDF.
  await run('PLOT');
  await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-p=layout]')).toHaveValue('-1');
  await page.locator('[data-p=layout]').selectOption('0');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('[data-p=vector]').click();
  const d = await dl;
  expect(d.suggestedFilename(), 'twisted layout PDF name').toBe('drawing-Layout 1.pdf');
  const pdfPath = testInfo.outputPath('twist-2d26.pdf');
  await d.saveAs(pdfPath);
  await expect.poll(async () => /PLOT: vector PDF of layout "Layout 1"/.test(await hist()), { timeout: 10000 }).toBe(true);
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  expect(doc.getPageCount(), 'twisted layout PDF is one page').toBe(1);
  const pg = doc.getPage(0);
  expect(Math.abs(pg.getWidth() - 420 * PT), 'page width').toBeLessThan(0.5);
  expect(Math.abs(pg.getHeight() - 297 * PT), 'page height').toBeLessThan(0.5);
  const segs = lineSegments(await pageContent(doc, 0));
  expect(segs.length, 'page holds border + background + LINE').toBe(8);
  // The horizontal model LINE, rotated -90°: a vertical 280 mm segment
  // at the viewport centre (x = 210 mm).
  expect(verticalAt(segs, 210 * PT, 280 * PT), `page must hold the rotated 280mm LINE at x=210mm, got ${JSON.stringify(segs)}`).toBe(true);
  // And not the untwisted horizontal LINE (the border horizontals are 400 mm).
  expect(horizontalLength(segs, 280 * PT), `page must not hold an untwisted 280mm horizontal, got ${JSON.stringify(segs)}`).toBe(false);

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
