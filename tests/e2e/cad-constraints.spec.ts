import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Phase 4: a constraint applied from the Parametric tab is RECORDED (not just applied once) and the solver
// commands report on it. Also pins that the new buttons are reachable from the ribbon.
const D = (...a: (string | number)[]) => a.join('\n') + '\n';
const one = D(0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 4, 0, 'ENDSEC', 0, 'EOF');

test('2D editor: constraints are recorded and solvable from the ribbon', async ({ page }) => {
  test.setTimeout(150000);
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
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(one) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');

  // Nothing recorded yet: the ribbon buttons answer honestly instead of doing nothing.
  await page.locator('[data-ribtab=parametric]').first().click();
  await expect(page.locator('[data-a=gc-solve]').first()).toBeVisible();
  await page.locator('[data-a=gc-list]').first().click();
  await expect.poll(hist).toContain('GCLIST: no recorded constraints');

  // Keyboard-driven path: select the line, record HORIZONTAL + LEN 10 (a 10 x 4 diagonal must become 10 x 0).
  await run('SELECTALL');
  await run('GCADD H');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: recorded 1 horizontal');
  await run('GCADD LEN 10');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: recorded 1 length');
  // Horizontal AND vertical AND length 10 on one line cannot hold: refused and reported, not silently applied.
  await run('GCADD V');
  await expect.poll(hist, { timeout: 10000 }).toContain('GCADD: not recorded.');

  await page.locator('[data-a=gc-list]').first().click();
  await expect.poll(hist).toMatch(/#1 horizontal — ok/);
  await expect.poll(hist).toMatch(/#2 length = 10(\.0+)?( \w+)? — ok/);
  await page.locator('[data-a=gc-solve]').first().click();
  await expect.poll(hist).toContain('GCSOLVE:');
  expect(errors, errors.join('\n')).toEqual([]);
});

// Diagnostic + regression: whatever the layout, a click ON the rendered line must pick it. The line's screen
// position is read back from the canvas pixels, so the test fails with real numbers if world<->screen disagree.
test('2D editor: a pick tool hits the line where it is actually drawn', async ({ page }) => {
  test.setTimeout(150000);
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  const cmd = page.locator('[data-r=cmd]').first();
  const run = async (c: string) => { await cmd.fill(c); await cmd.press('Enter'); };
  const hist = async () => page.locator('[data-r=cmdhist]').first().innerText();
  await page.locator('[data-r=importfile]').first().setInputFiles({ name: 'one.dxf', mimeType: 'text/plain', buffer: Buffer.from(one) });
  await expect.poll(async () => { await run('CENSUS'); return /LINE=1/.test(await hist()); }, { timeout: 15000 }).toBe(true);
  await run('ZOOM E');
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const c = document.querySelector('[data-r=cv]') as HTMLCanvasElement;
    const r = c.getBoundingClientRect();
    const g = c.getContext('2d')!;
    const { width: w, height: h } = c;
    const d = g.getImageData(0, 0, w, h).data;
    const bgR = d[0], bgG = d[1], bgB = d[2];
    const xs: number[] = [], ys: number[] = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (Math.abs(d[i] - bgR) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bgB) > 300) { xs.push(x); ys.push(y); }
    }
    xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
    const m = (a: number[]) => a[Math.floor(a.length / 2)] ?? -1;
    return { n: xs.length, px: m(xs), py: m(ys), w, h, left: r.left, top: r.top, cw: r.width, ch: r.height };
  });
  expect(info.n, 'no bright pixels: the line is not drawn at all ' + JSON.stringify(info)).toBeGreaterThan(20);
  const sx = info.left + (info.px / info.w) * info.cw, sy = info.top + (info.py / info.h) * info.ch;
  await run('HORIZONTAL');
  await page.mouse.move(sx, sy);
  await page.mouse.click(sx, sy);
  const text = await hist();
  expect(text.includes('recorded as constraint #1') || text.includes('constraint applied'), 'pick missed the drawn line ' + JSON.stringify({ info, sx, sy }) + '\n' + text.slice(-400)).toBe(true);
});
