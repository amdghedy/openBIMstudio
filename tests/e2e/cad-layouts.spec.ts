import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * CAD shell layouts (AutoCAD parity A13).
 *
 * The MODEL/PAPER status button rendered a label with no click handler
 * (display-only), there was no "+" / new-layout button (creation was
 * command-line only), every layout switch wiped the view history (so
 * Zoom Previous reported "No previous view" after a switch), and UNDO /
 * REDO operated on whichever entity list happened to be current — an edit
 * made in model space and undone from a paper layout pushed model
 * entities into the layout's list.
 *
 * Proves in the real app, with an L of two model lines:
 *  1. The tab strip shows Model + "+" even with no layouts, and "+"
 *     creates Layout1 with a viewport and switches to it (status PAPER,
 *     LAYOUT lists "1. Layout1 (0 ents)", CENSUS is empty there).
 *  2. The MODEL/PAPER status button toggles space for real, both ways,
 *     returning to the last paper layout.
 *  3. Zoom Previous survives a layout switch: after a window zoom and a
 *     layout round-trip, ZOOM P restores the pre-window view — proved by
 *     the view centre read back through the coordinate readout (the
 *     refit after the round-trip centres on the shrunken model, the
 *     restored view centres on the original extents).
 *  4. UNDO survives layout switches: an ERASE undone after two switches
 *     restores the line exactly once (the old code restored it twice in
 *     model space, and leaked it into a layout when undone from paper).
 *  5. Undoing a model edit while in paper space leaves the layout
 *     untouched (CENSUS empty, LAYOUT still "0 ents"), and the restored
 *     line is pickable at its real position after the round-trip (the
 *     cached model index is fresh).
 *
 * Screen↔world calibration: after ZOOM E the view is an unknown affine
 * map, so the spec reads the status-bar coordinate readout at two mouse
 * positions per axis and solves the map instead of guessing pixels (same
 * approach as cad-fillet-chamfer.spec.ts). Picks land mid-segment, well
 * outside the OSNAP aperture of any endpoint, so no object snap can move
 * the pick point onto a corner.
 *
 * Run against this branch's own build on its own port (never :3000 —
 * the repo's Playwright config reuses any server already listening on
 * :3000, so a run there can silently test another worktree's build):
 *   npx vite build && npx vite preview --port 3118 --host 127.0.0.1
 *   then run this spec with a Playwright config whose baseURL is
 *   http://127.0.0.1:3118 and which starts no webServer.
 */

const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const drawing = D(
  0, 'SECTION', 2, 'ENTITIES',
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 100, 21, 0,
  0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 0, 21, 100,
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

/** World point at the canvas centre, via the coordinate readout. */
async function centreCoords(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number }> {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  return readCoords(page);
}

test('2D editor: MODEL/PAPER toggle, new-layout button, undo survives layout switches', async ({ page }) => {
  test.setTimeout(240000);
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
  // The status bar's selection count only refreshes on a full updateStatus
  // (pre-existing staleness, A3 follow-up), so selection is observed
  // through the history log instead: each click appends one more
  // "1 object(s) selected" line.
  const selectedCount = async () => (await hist()).split('1 object(s) selected').length - 1;
  const spaceBtn = page.locator('[data-s=space]').first();
  const tabs = page.locator('[data-r=tabs]').first();
  const modelTab = tabs.locator('button[data-li="-1"]');
  const layoutTab = tabs.locator('button[data-li="0"]');
  const newLayoutBtn = tabs.locator('button[data-new-layout]');
  // A12 added a QAT to the main shell with the same data-qat values, so
  // scope to the CAD shell or .first() picks the hidden main-shell button.
  const undoBtn = page.locator('.obs-cad-shell [data-qat=undo]').first();
  const redoBtn = page.locator('.obs-cad-shell [data-qat=redo]').first();

  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'drawing.dxf', mimeType: 'text/plain', buffer: Buffer.from(drawing) });
  await expectCensus(/LINE=2/);
  await run('ZOOM E');
  await page.waitForTimeout(600);
  const box = (await page.locator('[data-r=cv]').first().boundingBox())!;
  const map = await calibrate(page, box);
  const toScreen = (wx: number, wy: number) => ({ x: (wx - map.ox) / map.sx, y: (wy - map.oy) / map.sy });
  const clickAt = async (wx: number, wy: number) => {
    const s = toScreen(wx, wy);
    await page.mouse.click(s.x, s.y);
  };

  // 1. Tab strip shows Model + "+" with no layouts yet; status is MODEL.
  await expect(spaceBtn).toHaveText('MODEL');
  await expect(modelTab).toBeVisible();
  await expect(modelTab).toHaveClass(/on/);
  await expect(newLayoutBtn).toBeVisible();

  // 2. Erase the horizontal line, then window-zoom: the view history must
  //    hold the pre-window view across the layout round-trip below.
  let selBefore = await selectedCount();
  await clickAt(50, 0);
  await expect.poll(selectedCount, { timeout: 10000 }).toBe(selBefore + 1);
  await run('ERASE');
  await expectCensus(/LINE=1/);
  await run('ZOOM W');
  {
    const p1 = toScreen(20, 20), p2 = toScreen(60, 60);
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p2.x, p2.y, { steps: 8 });
    await page.mouse.up();
  }
  await page.waitForTimeout(400);

  // 3. "+" creates Layout1 and switches to it; back to Model refits the
  //    shrunken model (only the vertical line is left: centre x = 0).
  await newLayoutBtn.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await expect(layoutTab).toHaveText('Layout1');
  await expect(layoutTab).toHaveClass(/on/);
  await expectCensus(/\(empty\)/);
  await modelTab.click();
  await expect(spaceBtn).toHaveText('MODEL');
  await expect(modelTab).toHaveClass(/on/);
  const refit = await centreCoords(page, box);
  expect(Math.abs(refit.x - 0), `refit centre x should be ~0, got ${refit.x}`).toBeLessThan(8);

  // 4. ZOOM P restores the pre-window view (centre x = 50): the view
  //    history survived the layout switches.
  await run('ZOOM P');
  await page.waitForTimeout(400);
  const restored = await centreCoords(page, box);
  expect(Math.abs(restored.x - 50), `restored centre x should be ~50, got ${restored.x}`).toBeLessThan(8);

  // 5. MODEL/PAPER status button toggles space both ways.
  await spaceBtn.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await expect(layoutTab).toHaveClass(/on/);
  await spaceBtn.click();
  await expect(spaceBtn).toHaveText('MODEL');
  await expect(modelTab).toHaveClass(/on/);
  await run('LAYOUT');
  await expect.poll(hist, { timeout: 10000 }).toContain('1. Layout1 (0 ents)');
  await expect.poll(hist, { timeout: 10000 }).toContain('Model (1 ents)');

  // 6. UNDO survives the switches: the erased line comes back exactly
  //    once, and REDO/UNDO still work afterwards.
  await undoBtn.click();
  await expectCensus(/LINE=2/);
  await redoBtn.click();
  await expectCensus(/LINE=1/);
  await undoBtn.click();
  await expectCensus(/LINE=2/);

  // 7. Undoing a model edit while in paper space leaves the layout
  //    untouched (no model entity leaks into it).
  const map2 = await calibrate(page, box);
  const toScreen2 = (wx: number, wy: number) => ({ x: (wx - map2.ox) / map2.sx, y: (wy - map2.oy) / map2.sy });
  selBefore = await selectedCount();
  await page.mouse.click(toScreen2(50, 0).x, toScreen2(50, 0).y);
  await expect.poll(selectedCount, { timeout: 10000 }).toBe(selBefore + 1);
  await run('ERASE');
  await expectCensus(/LINE=1/);
  await layoutTab.click();
  await expect(spaceBtn).toHaveText('PAPER');
  await undoBtn.click();
  await modelTab.click();
  await expect(spaceBtn).toHaveText('MODEL');
  await expectCensus(/LINE=2/);
  await layoutTab.click();
  await expectCensus(/\(empty\)/);
  await run('LAYOUT');
  await expect.poll(hist, { timeout: 10000 }).toContain('1. Layout1 (0 ents)');

  // 8. The restored line is pickable at its real position after the
  //    round-trip: the cached model index is fresh, not stale.
  await modelTab.click();
  const map3 = await calibrate(page, box);
  const toScreen3 = (wx: number, wy: number) => ({ x: (wx - map3.ox) / map3.sx, y: (wy - map3.oy) / map3.sy });
  selBefore = await selectedCount();
  await page.mouse.click(toScreen3(50, 0).x, toScreen3(50, 0).y);
  await expect.poll(selectedCount, { timeout: 10000 }).toBe(selBefore + 1);

  expect(errors, errors.join('\n')).toEqual([]);
});
