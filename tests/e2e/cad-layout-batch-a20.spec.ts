import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';
import * as fs from 'fs';
import * as zlib from 'zlib';
import { PDFDocument } from 'pdf-lib';

/**
 * AutoCAD 2D parity A20 — sheet-systems bridge: CAD layouts as vector PDF.
 *
 * Reference model, imported from DXF: an L of two LINEs (0,0)-(100,0)
 * and (0,0)-(0,50). Two paper layouts are created in-app (Layout1,
 * Layout2), each with an MVIEW viewport over the same model — Layout1
 * at 1:50, Layout2 at 1:100.
 *
 * Proved in the real app:
 *  1. The batch plotter lists both CAD layouts (checked, A3 landscape)
 *     in its CAD section, read live from the current drawing.
 *  2. "Instead of BIM sheets" publishes a 3-page vector PDF: the cover
 *     plus one page per CAD layout, each at the layout's own A3 paper
 *     size — no BIM sheet pages.
 *  3. The pages are vector, not raster: each CAD page's decoded content
 *     stream holds real line operators, and the model LINE lands at the
 *     viewport scale — 2 mm (5.67 pt) on the 1:50 page, 1 mm (2.83 pt)
 *     on the 1:100 page. (Each layout also ships its A13 default
 *     full-sheet viewport, whose fit-scale LINE is ~420 mm — the
 *     assertion picks the short MVIEW LINE, not the fit one.)
 *  4. The sheets panel lists both CAD layouts as read-only sheets
 *     (number/name from the layout name, paper from its page setup)
 *     after the viewer is closed — the registry is the last-opened
 *     drawing, so the bridge survives the viewer closing.
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
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 100, 21, 0, 31, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 0, 21, 50, 31, 0,
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
  // Sequential PDF path parse: "m" sets the current point, "l" draws
  // from it. (pdf-lib does not emit a uniform "m m l" per line, so
  // zipping separate m- and l-lists misaligns after the first line.)
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

/** True when some horizontal segment has the given length (±0.15 pt). */
function horizontalLength(segs: Array<{ x1: number; y1: number; x2: number; y2: number }>, want: number): boolean {
  return segs.some((s) => Math.abs(s.y2 - s.y1) < 0.01 && Math.abs(Math.abs(s.x2 - s.x1) - want) < 0.15);
}

test('A20 sheet-systems bridge: batch publish plots every CAD layout as vector PDF', async ({ page }, testInfo) => {
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
  const setToggle = async (sel: string, on: boolean) => {
    const btn = page.locator(sel);
    const active = await btn.evaluate((el) => el.classList.contains('active'));
    if (active !== on) await btn.click();
  };
  const canvasBox = async () => (await page.locator('[data-r=cv]').first().boundingBox())!;
  const tabs = page.locator('[data-r=tabs]').first();

  // OSNAP/POLAR/OTRACK/GRID off for calibration and free-point picks.
  await setToggle('[data-s=snap]', false);
  await setToggle('[data-s=polar]', false);
  await setToggle('[data-s=otrack]', false);
  await setToggle('[data-s=grid]', false);

  // 1. Import the reference model.
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(refDxf) });
  await expectCensus(/LINE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);

  // 2. Two paper layouts via the "+" tab button.
  const newLayoutBtn = tabs.locator('button[data-new-layout]');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="0"]')).toHaveText('Layout1');
  await newLayoutBtn.click();
  await expect(tabs.locator('button[data-li="1"]')).toHaveText('Layout2');

  // 3. An MVIEW viewport on each layout, at a different scale.
  const makeViewport = async (li: string, scaleValue: string, scaleLabel: string, layoutName: string) => {
    await tabs.locator(`button[data-li="${li}"]`).click();
    await expect(tabs.locator(`button[data-li="${li}"]`)).toHaveClass(/on/);
    await run('ZOOM E');
    await page.waitForTimeout(600);
    const box = await canvasBox();
    const map = await calibrate(page, box);
    const clickWorld = async (wx: number, wy: number) => {
      await page.mouse.click((wx - map.ox) / map.sx, (wy - map.oy) / map.sy);
    };
    await run('MVIEW');
    await expect.poll(async () => /specify the first corner/.test(await hist()), { timeout: 10000 }).toBe(true);
    await clickWorld(30, 30);
    await clickWorld(267, 180);
    const mvScale = page.locator('[data-r=mv-scale]');
    await expect(mvScale).toBeVisible({ timeout: 10000 });
    await mvScale.selectOption(scaleValue);
    await page.locator('[data-r=mv-create]').click();
    await expect.poll(async () => new RegExp(`MVIEW: viewport created on "${layoutName}" at ${scaleLabel}`).test(await hist()), { timeout: 15000 }).toBe(true);
  };
  await makeViewport('0', '0.02', '1:50', 'Layout1');
  await makeViewport('1', '0.01', '1:100', 'Layout2');

  // 3b. Single-layout PLOT: the Vector PDF button downloads a one-page
  //      vector PDF of the current layout (Layout2, 1:100).
  await run('PLOT');
  await expect(page.locator('[data-p=go]')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('[data-p=layout]')).toHaveValue('1');
  const vdl = page.waitForEvent('download', { timeout: 60000 });
  await page.locator('[data-p=vector]').click();
  const vd = await vdl;
  expect(vd.suggestedFilename(), 'vector PDF name').toBe('drawing-Layout2.pdf');
  const vPath = testInfo.outputPath('single-a20.pdf');
  await vd.saveAs(vPath);
  await expect.poll(async () => /PLOT: vector PDF of layout "Layout2"/.test(await hist()), { timeout: 10000 }).toBe(true);
  const vdoc = await PDFDocument.load(fs.readFileSync(vPath));
  expect(vdoc.getPageCount(), 'single-layout PDF is one page').toBe(1);
  const vp = vdoc.getPage(0);
  expect(Math.abs(vp.getWidth() - 420 * PT), 'single page width').toBeLessThan(0.5);
  expect(Math.abs(vp.getHeight() - 297 * PT), 'single page height').toBeLessThan(0.5);
  const vsegs = lineSegments(await pageContent(vdoc, 0));
  expect(vsegs.length, 'single page has vector segments').toBeGreaterThan(0);
  expect(horizontalLength(vsegs, 1 * PT), `single Layout2 PDF must hold the 1mm model LINE, got ${JSON.stringify(vsegs)}`).toBe(true);

  // 4. Close the viewer (the batch-plot modal sits below the viewer
  //    shell, so the panel is used with the viewer closed — and the
  //    registry is the last-opened drawing, so the layouts survive).
  const dirtyVisible = await page.locator('.cadtab__dirty').first().isVisible().catch(() => false);
  await page.locator('.cadtab__x').first().click();
  if (dirtyVisible) {
    await page.getByRole('button', { name: 'Confirm' }).click({ timeout: 10000 });
  }
  await expect(page.locator('#obs-cad-shell')).toBeHidden({ timeout: 15000 });

  // 5. Batch plot: the CAD section lists both layouts; publish them
  //    instead of the BIM sheets.
  await openPaletteWith(page, 'Export: Enterprise Multi-Sheet Batch Plot');
  await page.keyboard.press('Enter');
  const modal = page.locator('#obs-batch-plot-modal');
  await expect(modal).toBeVisible({ timeout: 15000 });
  const cadCbs = modal.locator('.obs-bp-cad-cb');
  await expect(cadCbs).toHaveCount(2);
  await expect(cadCbs.nth(0)).toHaveAttribute('data-name', 'Layout1');
  await expect(cadCbs.nth(1)).toHaveAttribute('data-name', 'Layout2');
  await expect(cadCbs.nth(0)).toBeChecked();
  await expect(cadCbs.nth(1)).toBeChecked();
  await expect(modal.locator('#obs-bp-cad-mode')).toBeVisible();
  await modal.locator('#obs-bp-cad-mode').selectOption('only');
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await modal.locator('#obs-bp-plot-btn').click();
  const d = await dl;
  const pdfPath = testInfo.outputPath('batch-a20.pdf');
  await d.saveAs(pdfPath);
  await expect(modal).toBeHidden({ timeout: 15000 });

  // 6. The PDF: cover + one vector page per CAD layout, at A3.
  const doc = await PDFDocument.load(fs.readFileSync(pdfPath));
  expect(doc.getPageCount(), 'cover + Layout1 + Layout2').toBe(3);
  for (const i of [1, 2]) {
    const p = doc.getPage(i);
    expect(Math.abs(p.getWidth() - 420 * PT), `page ${i + 1} width`).toBeLessThan(0.5);
    expect(Math.abs(p.getHeight() - 297 * PT), `page ${i + 1} height`).toBeLessThan(0.5);
  }
  const cover = await pageContent(doc, 0);
  expect(cover.includes('BT'), 'cover has text operators').toBe(true);
  const p1 = lineSegments(await pageContent(doc, 1));
  expect(p1.length, 'Layout1 page has vector segments').toBeGreaterThan(0);
  expect(horizontalLength(p1, 2 * PT), `Layout1 (1:50) page must hold the 2mm model LINE, got ${JSON.stringify(p1)}`).toBe(true);
  const p2 = lineSegments(await pageContent(doc, 2));
  expect(p2.length, 'Layout2 page has vector segments').toBeGreaterThan(0);
  expect(horizontalLength(p2, 1 * PT), `Layout2 (1:100) page must hold the 1mm model LINE, got ${JSON.stringify(p2)}`).toBe(true);

  // 7. Sheets panel: both CAD layouts appear as read-only sheets.
  await page.locator('button.obs-ribbon__tab[data-tab="file"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Sheets', exact: true }).first().click();
  await page.waitForTimeout(700);
  const cadRows = page.locator('.obs-sheets__row--cad');
  await expect(cadRows).toHaveCount(2, { timeout: 15000 });
  await expect(cadRows.nth(0)).toContainText('Layout1');
  await expect(cadRows.nth(1)).toContainText('Layout2');
  await expect(cadRows.nth(0)).toContainText('A3 landscape');

  expect(errors, `page errors: ${errors.join('\n')}`).toEqual([]);
});
