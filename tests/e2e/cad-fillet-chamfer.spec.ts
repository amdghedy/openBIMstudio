import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Fillet / Chamfer in-tool prompts + arc/polyline support (AutoCAD parity A6).
 *
 * FILLET / CHAMFER used to accept two LINEs only, with the radius /
 * distances settable only from the command line (FILLET R / FILLETRAD,
 * CHAMFER / CHAMFERD) and no trim/no-trim option. The fix prompts for the
 * radius / distances in-tool (type a value + Enter, Esc cancels, picking
 * the objects straight away keeps the current value), extends the trim
 * math to ARC entities and LWPOLYLINE segments, and adds Trim/No trim
 * (TRIMMODE, or T at the prompt).
 *
 * Proves in the real app, with two L-shaped line pairs and two quarter
 * arcs meeting at (100,0):
 *  1. FILLETRAD 7 feeds the in-tool prompt: invoking FILLET reports
 *     "Current fillet radius = 7" — the command-line setter and the tool
 *     share one source of truth (before A6 FILLETRAD wrote a store the
 *     tool never read).
 *  2. Typing 25 at the in-tool prompt, then picking the two lines,
 *     fillets them: the history reports "FILLET: R = 25 — 2 object(s)
 *     trimmed, 1 arc added" and CENSUS gains one ARC.
 *  3. TRIMMODE 0 + FILLET R 15 on the second line pair keeps both
 *     originals full length (No trim): the history says so, and the LINE
 *     count does not drop — the originals survive alongside the new arc.
 *  4. TRIMMODE 1 restores trimming; CHAMFER with d1=30, d2=20 typed at
 *     the in-tool prompts bevels the first pair: "CHAMFER: 30 × 20 —
 *     2 object(s) trimmed, 1 bevel added" and CENSUS gains one LINE
 *     (the bevel bar).
 *  5. FILLET R 10 on the two arcs fillets arc-to-arc: the history
 *     reports the fillet and CENSUS gains one more ARC.
 *
 * Screen↔world calibration: after ZOOM E the view is an unknown affine
 * map, so the spec reads the status-bar coordinate readout at two mouse
 * positions per axis and solves the map instead of guessing pixels (same
 * approach as cad-grid-snap.spec.ts). Picks land mid-segment, well
 * outside the OSNAP aperture of any endpoint, so no object snap can move
 * the pick point onto a corner.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3117 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3117 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const drawing = D(
  0, 'SECTION', 2, 'ENTITIES',
  // L pair 1 at the origin.
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 100,
  // L pair 2 at (200,0).
  0, 'LINE', 8, '0', 10, 200, 20, 0, 11, 300, 21, 0,
  0, 'LINE', 8, '0', 10, 200, 20, 0, 11, 200, 21, 100,
  // Two quarter arcs meeting at (100,0).
  0, 'ARC', 8, '0', 10, 0, 20, 0, 40, 100, 50, 0, 51, 90,
  0, 'ARC', 8, '0', 10, 200, 20, 0, 40, 100, 50, 90, 51, 180,
  0, 'ENDSEC', 0, 'EOF',
);

type Affine = { sx: number; ox: number; sy: number; oy: number };

async function readCoords(page: Page): Promise<{ x: number; y: number }> {
  const text = await page.locator('[data-s=coords]').first().innerText();
  const [x, y] = text.split(',').slice(0, 2).map((s) => parseFloat(s));
  expect(Number.isFinite(x) && Number.isFinite(y), `coords readout unparsable: ${text}`).toBe(true);
  return { x, y };
}

/** Solve screen→world from two mouse samples per axis. */
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

test('2D editor: FILLET/CHAMFER prompt in-tool, fillet arcs, and Trim/No trim', async ({ page }) => {
  test.setTimeout(180000);
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
  const census = async () => { await run('CENSUS'); return hist(); };

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(drawing) });
  await expect.poll(async () => { const h = await census(); return /LINE=4/.test(h) && /ARC=2/.test(h); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const clickAt = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };

  // 1. FILLETRAD feeds the in-tool prompt (one shared source of truth).
  await run('FILLETRAD 7');
  await expect.poll(hist, { timeout: 10000 }).toContain('FILLETRAD = 7');
  await run('FILLET');
  await expect.poll(hist, { timeout: 10000 }).toContain('Current fillet radius = 7');

  // 2. Type the radius at the in-tool prompt, pick the two lines, fillet.
  await run('25');
  await expect.poll(hist, { timeout: 10000 }).toContain('Fillet radius = 25');
  await clickAt(60, 0);
  await expect.poll(hist, { timeout: 10000 }).toContain('Select second object');
  await clickAt(0, 60);
  await expect.poll(hist, { timeout: 10000 }).toMatch(/FILLET: R = 25/);
  await expect.poll(hist, { timeout: 10000 }).toContain('1 arc added');
  await expect.poll(async () => { const h = await census(); return /LINE=4/.test(h) && /ARC=3/.test(h); }, { timeout: 15000 }).toBe(true);

  // 3. TRIMMODE 0: No trim keeps both originals full length.
  await run('TRIMMODE 0');
  await expect.poll(hist, { timeout: 10000 }).toContain('TRIMMODE = 0 (No trim)');
  await run('FILLET R 15');
  await expect.poll(hist, { timeout: 10000 }).toContain('Current fillet radius = 15');
  await clickAt(260, 0);
  await clickAt(200, 60);
  await expect.poll(hist, { timeout: 10000 }).toContain('kept full length (No trim), 1 arc added');
  await expect.poll(async () => { const h = await census(); return /LINE=4/.test(h) && /ARC=4/.test(h); }, { timeout: 15000 }).toBe(true);

  // 4. TRIMMODE 1 restores trimming; CHAMFER distances typed in-tool.
  await run('TRIMMODE 1');
  await expect.poll(hist, { timeout: 10000 }).toContain('TRIMMODE = 1 (Trim)');
  await run('CHAMFER');
  await expect.poll(hist, { timeout: 10000 }).toContain('Current chamfer distances = 5');
  // The first pair was trimmed by the R=25 fillet to (100,0)-(25,0) and
  // (0,100)-(0,25), so the chamfer cuts are measured from the corner and
  // must land on the remaining segments: 30 and 40 do.
  await run('30');
  await expect.poll(hist, { timeout: 10000 }).toContain('First chamfer distance = 30');
  await run('40');
  await expect.poll(hist, { timeout: 10000 }).toContain('Second chamfer distance = 40');
  await clickAt(60, 0);
  await clickAt(0, 60);
  await expect.poll(hist, { timeout: 10000 }).toMatch(/CHAMFER: 30/);
  await expect.poll(hist, { timeout: 10000 }).toContain('× 40');
  await expect.poll(hist, { timeout: 10000 }).toContain('1 bevel added');
  await expect.poll(async () => { const h = await census(); return /LINE=5/.test(h) && /ARC=4/.test(h); }, { timeout: 15000 }).toBe(true);

  // 5. Fillet between two arcs.
  await run('FILLET');
  await run('10');
  await expect.poll(hist, { timeout: 10000 }).toContain('Fillet radius = 10');
  await clickAt(70, 70);
  await clickAt(129, 71);
  await expect.poll(hist, { timeout: 10000 }).toMatch(/FILLET: R = 10/);
  await expect.poll(hist, { timeout: 10000 }).toContain('1 arc added');
  await expect.poll(async () => { const h = await census(); return /LINE=5/.test(h) && /ARC=5/.test(h); }, { timeout: 15000 }).toBe(true);

  expect(errors, errors.join('\n')).toEqual([]);
});
