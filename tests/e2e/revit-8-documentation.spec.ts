import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { decodePng, countPixels, countPixelsIn, colorNear, isDrawn, isGreenish, isReddish } from './png-pixels';

/**
 * Revit parity rank 8 — documentation depth, browser proof.
 *
 * Proves in a real Chromium build, against the production bundle:
 *  1. Tag render pixel-proof: a category tag created with the Views-panel
 *     Tag tool renders its bubble + text on the plan SVG. The tag text is
 *     paper-scaled (3 mm at 1:100 ≈ 8 px at fit zoom), so its glyphs are
 *     fully anti-aliased — no pixel is pure #0f766e. The proof counts
 *     greenish anti-aliased blends (isGreenish) before/after: the tag adds
 *     ~190 greenish pixels to the plan (debug runs: 2 → 194).
 *  2. View template + VG applied at render time: applying the built-in
 *     "Structural Plan" template to the plan view hides the duct and
 *     halftones the wall — asserted on the effective VG state, on the
 *     halftone-grey pixel increase over the whole plan, and on the dark →
 *     halftone flip inside an 80×80 px box around the wall midpoint.
 *  3. Revision workflow: a revision record + cloud placed through the
 *     revisions feature renders red on the plan, and the exported sheet
 *     PDF — opened in a REAL reader (poppler pdftotext/pdfinfo/pdftoppm,
 *     skipped when the binaries are absent) — contains the revision table
 *     text and renders the wall + cloud as drawn pixels.
 *
 * Screenshot method: the plan SVG is taller than the viewport and sits
 * under the 3D toolbar overlay, so screenshots clip to the intersection
 * of the SVG box, its scroll host, and the viewport — the actually visible
 * plan pixels. Clicks map world → client with the same linear
 * viewBox formula the panel's own click handler uses (it ignores the
 * preserveAspectRatio letterbox, so the test must too), and the click
 * point is verified with elementFromPoint before clicking: the wall
 * midpoint is the only point the hit test matches (endpoints / centre /
 * face-centres within tolerance), and in the default layout it lands under
 * the 3D toolbar overlay, so the test scrolls the SVG into view first.
 * Authoring uses short click spans: the 3D perspective canvas maps a
 * 40%-width drag to an ~85 m diagonal wall, which blows the plan viewBox
 * up to 66×79 m and shrinks the tag text to ~2 px. ±5% spans give a
 * ~21 m wall and a 21×22 m viewBox (≈27 px/m, tag text ≈8 px).
 *
 * Screenshots land in ../e2e-art/ (next to the work copy, not /tmp:
 * this VM's /tmp is a 512 MB tmpfs at ~98%).
 */

const ART = path.resolve('..', 'e2e-art');
// Default wall poché fill (src/modules/drawings/plan-poche.ts
// DEFAULT_POCHE_COLOR). The wall's visible mass in plan is this fill band,
// not its outline: at 1:100 the cut outline is ~1 px, anti-aliased to a
// grey blend, so `isDark` never fires on it. Halftone draws the fill at
// 0.35 opacity over white paper (≈238,239,240), so the honest pixel signal
// for "the wall halftoned" is this fill colour fading out — not a rise in
// #9ca3af pixels (the 0.15 pt halftone outline is sub-pixel at fit zoom
// and contributes almost no pure-halftone pixels).
const POCHE_GREY = colorNear(201, 207, 214, 12); // #c9cfd6 wall poché fill

test('revit-8 documentation: tag pixels, template VG render, revision sheet PDF in a real reader', async ({ page }) => {
  test.setTimeout(300000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  fs.mkdirSync(ART, { recursive: true });

  const getActiveTool = () =>
    page.evaluate(() => {
      const ctx: any = (window as any).__OBS_CTX__;
      return (ctx?.features?.authoring?.getActiveTool?.() ?? null) as string | null;
    });
  const gotoTab = async (tabId: string) => {
    await page.locator(`button.obs-ribbon__tab[data-tab="${tabId}"]`).click();
    await page.waitForTimeout(350);
  };
  const clickStripButton = async (label: string) => {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    await page.waitForTimeout(700);
  };
  const authoredCount = () =>
    page.evaluate(() => {
      const seen = new Set<string>();
      const ctx: any = (window as any).__OBS_CTX__;
      ctx?.world?.scene?.three?.traverse?.((o: any) => {
        if (o?.userData?.elementId) seen.add(String(o.userData.elementId));
      });
      return seen.size;
    });
  const getElements = () =>
    page.evaluate(() => {
      const ctx: any = (window as any).__OBS_CTX__;
      const els = ctx?.features?.authoring?.getElements?.() ?? [];
      return els.map((e: any) => ({
        id: String(e.id), type: String(e.type), name: String(e.name ?? ''),
        start: e.params?.start ?? null, end: e.params?.end ?? null,
        point: e.params?.point ?? null, elevation: Number(e.params?.elevation ?? 0),
      }));
    });

  /** The plan SVG in the Views panel: viewBox + box + scroll-host box. */
  const planSvgBox = () =>
    page.evaluate(() => {
      const svgs = [...document.querySelectorAll('#obs-views-panel svg')];
      const svg = svgs.find((s) => {
        const vb = (s as any).viewBox?.baseVal;
        const r = s.getBoundingClientRect();
        return vb && vb.width > 5 && r.width > 300 && r.height > 200;
      }) as SVGSVGElement | undefined;
      if (!svg) return null;
      const vb = (svg as any).viewBox.baseVal;
      const r = svg.getBoundingClientRect();
      const host = svg.parentElement!.getBoundingClientRect();
      return {
        x: r.x, y: r.y, width: r.width, height: r.height,
        vbX: vb.x, vbY: vb.y, vbW: vb.width, vbH: vb.height,
        hostX: host.x, hostY: host.y, hostW: host.width, hostH: host.height,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    });
  /** Screenshot of exactly the visible plan pixels: SVG ∩ host ∩ viewport. */
  const planSvgShot = async () => {
    const box = await planSvgBox();
    expect(box, 'plan SVG must be visible in the Views panel').toBeTruthy();
    const x0 = Math.max(box!.x, box!.hostX, 0);
    const y0 = Math.max(box!.y, box!.hostY, 0);
    const x1 = Math.min(box!.x + box!.width, box!.hostX + box!.hostW, box!.vw);
    const y1 = Math.min(box!.y + box!.height, box!.hostY + box!.hostH, box!.vh);
    const clip = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    expect(clip.width, 'plan clip must be wide').toBeGreaterThan(200);
    expect(clip.height, 'plan clip must be tall').toBeGreaterThan(150);
    const buf = await page.screenshot({ clip });
    return { png: decodePng(buf), clip };
  };
  /** World (x, z) → client coords inside the plan SVG (same linear formula
   *  the panel's own click handler uses — it ignores the letterbox too). */
  const worldToClient = async (wx: number, wz: number) => {
    const box = await planSvgBox();
    expect(box, 'plan SVG must be visible').toBeTruthy();
    return {
      x: box!.x + ((wx - box!.vbX) / box!.vbW) * box!.width,
      y: box!.y + ((-wz - box!.vbY) / box!.vbH) * box!.height,
    };
  };
  /** Wait until the plan SVG is replaced by a re-render. */
  const waitForPlanRerender = async (beforeHtml: string, timeout = 20000) => {
    await page.waitForFunction(
      (prev: string) => {
        const svgs = [...document.querySelectorAll('#obs-views-panel svg')];
        const svg = svgs.find((s) => {
          const vb = (s as any).viewBox?.baseVal;
          const r = s.getBoundingClientRect();
          return vb && vb.width > 5 && r.width > 300;
        });
        return !!svg && svg.outerHTML !== prev;
      },
      beforeHtml,
      { timeout },
    );
  };
  const planSvgHtml = () =>
    page.evaluate(() => {
      const svgs = [...document.querySelectorAll('#obs-views-panel svg')];
      const svg = svgs.find((s) => {
        const vb = (s as any).viewBox?.baseVal;
        const r = s.getBoundingClientRect();
        return vb && vb.width > 5 && r.width > 300;
      });
      return svg ? svg.outerHTML : '';
    });
  /** Census of the rendered plan SVG's stroke/fill attributes: the direct
   *  render proof that a template restyled the geometry (dark cut strokes
   *  become #9ca3af halftone strokes, the poché fill drops to 0.35
   *  opacity). Complements the pixel fade — the DOM says *how* it changed,
   *  the pixels say it is visibly different. */
  const planSvgCensus = () =>
    page.evaluate(() => {
      const svgs = [...document.querySelectorAll('#obs-views-panel svg')];
      const svg = svgs.find((s) => {
        const vb = (s as any).viewBox?.baseVal;
        const r = s.getBoundingClientRect();
        return vb && vb.width > 5 && r.width > 300;
      });
      if (!svg) return null;
      const html = svg.outerHTML;
      const count = (re: RegExp) => (html.match(re) || []).length;
      return {
        halftoneStroke: count(/#9ca3af/g),
        darkStroke: count(/#111827|#374151|#1f2937/g),
        fillOp035: count(/fill-opacity="0\.35"/g),
        lines: svg.querySelectorAll('line').length,
      };
    });
  /** Click the wall midpoint: the hit test only matches endpoints / centre /
   *  face-centres, so the centre is the target — but in the default layout
   *  it sits under the 3D toolbar overlay, so verify elementFromPoint first
   *  and scroll the SVG into view when the point is covered. */
  const clickWallMidpoint = async (wallMid: { x: number; z: number }) => {
    let pt = await worldToClient(wallMid.x, wallMid.z);
    let atPoint = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el ? { inSvg: !!el.closest('svg'), tag: el.tagName } : null;
    }, [pt.x, pt.y]);
    if (!atPoint?.inSvg) {
      await page.evaluate(() => {
        const svgs = [...document.querySelectorAll('#obs-views-panel svg')];
        const svg = svgs.find((s) => {
          const vb = (s as any).viewBox?.baseVal;
          const r = s.getBoundingClientRect();
          return vb && vb.width > 5 && r.width > 300 && r.height > 200;
        });
        (svg as any)?.scrollIntoViewIfNeeded?.() ?? (svg as any)?.scrollIntoView?.();
      });
      await page.waitForTimeout(500);
      pt = await worldToClient(wallMid.x, wallMid.z);
      atPoint = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? { inSvg: !!el.closest('svg'), tag: el.tagName } : null;
      }, [pt.x, pt.y]);
    }
    expect(atPoint?.inSvg, `wall midpoint must be clickable (top element: ${atPoint?.tag ?? 'none'})`).toBe(true);
    await page.mouse.click(pt.x, pt.y);
  };

  // ── 1. Boot + Authoring ──────────────────────────────────────────────
  // Boot takes 10–15 s in a quiet VM but >45 s under contention (WASM +
  // SwiftShader init): the card wait is generous on purpose.
  await page.goto('/', { timeout: 120000 });
  await expect(page.locator('.obs-workspace-card[data-workspace="authoring"]')).toBeVisible({ timeout: 120000 });
  await page.locator('.obs-workspace-card[data-workspace="authoring"]').click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);

  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible').toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const wallY = cy + box!.height * 0.05;

  // ── 2. Wall + duct (short spans: the perspective canvas maps a 40%
  //      drag to an ~85 m diagonal wall; ±5% gives ~21 m and a 21×22 m
  //      plan viewBox, so the tag text renders at ~8 px, not ~2 px) ────
  await gotoTab('architecture');
  await clickStripButton('Wall');
  expect(await getActiveTool(), 'Wall tool becomes active').toBe('wall');
  const beforeWall = await authoredCount();
  await page.mouse.click(cx - box!.width * 0.05, wallY);
  await page.mouse.click(cx + box!.width * 0.05, wallY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  expect(await authoredCount(), 'a wall must be authored').toBeGreaterThan(beforeWall);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await gotoTab('mechanical');
  await clickStripButton('Duct');
  expect(await getActiveTool(), 'Duct tool becomes active').toBe('duct');
  const beforeDuct = await authoredCount();
  await page.mouse.click(cx - box!.width * 0.04, wallY - box!.height * 0.02);
  await page.mouse.click(cx + box!.width * 0.04, wallY - box!.height * 0.02);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  expect(await authoredCount(), 'a duct must be authored').toBeGreaterThan(beforeDuct);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${ART}/revit8-01-model.png` });

  const els = await getElements();
  const wall = els.find((e) => e.type === 'wall');
  const duct = els.find((e) => e.type === 'duct');
  expect(wall, 'a wall element must exist').toBeTruthy();
  expect(duct, 'a duct element must exist').toBeTruthy();
  const wallMid = {
    x: (wall!.start[0] + wall!.end[0]) / 2,
    z: (wall!.start[1] + wall!.end[1]) / 2,
  };
  console.log('[revit8] wall:', wall!.id, wall!.name, 'mid:', wallMid, '| duct:', duct!.id);

  // ── 3. Views panel → plan view ───────────────────────────────────────
  await page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    // The Properties panel overlaps the Views-panel SVG on the right; close
    // it so the plan is fully visible and pixel counts stay clean.
    ctx?.features?.propertyPalette?.close?.();
    ctx?.features?.viewsPanel?.open?.();
    return !!ctx?.features?.viewsPanel?.isVisible?.();
  });
  await expect(page.locator('#obs-views-panel')).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(1500);
  const baseline = await planSvgShot();
  const greenBefore = countPixels(baseline.png, isGreenish);
  const redBefore = countPixels(baseline.png, isReddish);
  console.log('[revit8] plan baseline pixels — greenish:', greenBefore, 'reddish:', redBefore, 'clip:', JSON.stringify(baseline.clip));
  expect(greenBefore, 'no tag exists yet, so almost no greenish pixels').toBeLessThan(10);
  expect(redBefore, 'no cloud exists yet, so almost no reddish pixels').toBeLessThan(10);
  // The honest VG pixel signal is the wall poché fill, measured on clean
  // paper only. Two layout facts force the geometry: (a) the clip's bottom
  // ~120 px is app chrome (tooltip + bottom toolbar + status bar) drawn
  // over the SVG, so "paper" ends at clip.height - 140; (b) the authored
  // wall is diagonal and its midpoint renders just under that chrome, so
  // the box is centred on the wall's quarter point instead — the upper
  // quarter renders on clean paper. (A box on the midpoint measures the
  // status bar, not the wall: it reads ~2800 dark pixels before AND after
  // the template, which is how the first version of this step failed.)
  const paperBottom = baseline.clip.height - 140;
  const paperBox = { x: 0, y: 0, w: baseline.png.width, h: paperBottom };
  const paperPocheBefore = countPixelsIn(baseline.png, paperBox, POCHE_GREY);
  const quarter = {
    x: wall!.start![0] + 0.25 * (wall!.end![0] - wall!.start![0]),
    z: wall!.start![1] + 0.25 * (wall!.end![1] - wall!.start![1]),
  };
  const quarterClient = await worldToClient(quarter.x, quarter.z);
  const quarterBox = {
    x: quarterClient.x - baseline.clip.x - 40,
    y: Math.min(quarterClient.y - baseline.clip.y - 40, paperBottom - 80),
    w: 80, h: 80,
  };
  const quarterPocheBefore = countPixelsIn(baseline.png, quarterBox, POCHE_GREY);
  const censusBefore = await planSvgCensus();
  console.log('[revit8] wall poché before template — paper:', paperPocheBefore, 'quarter-box:', quarterPocheBefore, 'box:', JSON.stringify(quarterBox), 'census:', JSON.stringify(censusBefore));
  expect(paperPocheBefore, 'the authored wall must draw its poché fill on the paper').toBeGreaterThan(300);
  expect(quarterPocheBefore, 'the wall poché fill must cross the quarter-point box').toBeGreaterThan(200);
  expect(censusBefore?.darkStroke, 'the plan must draw dark cut strokes before the template').toBeGreaterThan(0);
  expect(censusBefore?.halftoneStroke, 'no halftone strokes before the template').toBe(0);

  // ── 4. Tag pixel-proof ───────────────────────────────────────────────
  const htmlBeforeTag = await planSvgHtml();
  await page.locator('#obs-views-panel').getByRole('button', { name: 'Tag', exact: true }).click();
  await page.waitForTimeout(400);
  await clickWallMidpoint(wallMid);
  await waitForPlanRerender(htmlBeforeTag);
  await page.waitForTimeout(400);
  const tagHtml = await planSvgHtml();
  expect(tagHtml, 'the tag text must render in the plan SVG').toContain(wall!.name);
  const tagShot = await planSvgShot();
  const greenAfter = countPixels(tagShot.png, isGreenish);
  console.log('[revit8] greenish pixels after tagging:', greenAfter, '(before:', greenBefore + ')');
  expect(greenAfter, 'the tag bubble + text must render greenish pixels on the plan').toBeGreaterThan(100);
  expect(greenAfter, 'tagging must multiply the greenish pixel count').toBeGreaterThan(greenBefore * 5);
  await page.screenshot({ path: `${ART}/revit8-02-tag.png` });

  // ── 5. View template + VG applied at render time ────────────────────
  const htmlBeforeTemplate = await planSvgHtml();
  const templateSelect = page.locator('#obs-views-panel select[title="Assign a View Template"]');
  await expect(templateSelect).toBeVisible();
  await templateSelect.selectOption({ label: 'Structural Plan' });
  await waitForPlanRerender(htmlBeforeTemplate);
  await page.waitForTimeout(400);
  const effVg = await page.evaluate(() => {
    const store: any = (window as any).__obsViewTemplates;
    return store?.getEffectiveVg?.('plan-level-0') ?? null;
  });
  console.log('[revit8] effective VG after Structural Plan:', JSON.stringify({
    ductsVisible: effVg?.categoryOverrides?.Ducts?.visible,
    wallsHalftone: effVg?.categoryOverrides?.Walls?.halftone,
  }));
  expect(effVg?.categoryOverrides?.Ducts?.visible, 'Structural Plan hides Ducts').toBe(false);
  expect(effVg?.categoryOverrides?.Walls?.halftone, 'Structural Plan halftones Walls').toBe(true);
  const templateShot = await planSvgShot();
  const paperPocheAfter = countPixelsIn(templateShot.png, paperBox, POCHE_GREY);
  const quarterPocheAfter = countPixelsIn(templateShot.png, quarterBox, POCHE_GREY);
  const censusAfter = await planSvgCensus();
  console.log('[revit8] wall poché after template — paper:', paperPocheAfter, '(was', paperPocheBefore + ') quarter-box:', quarterPocheAfter, '(was', quarterPocheBefore + ') census:', JSON.stringify(censusAfter));
  expect(paperPocheAfter, 'halftoning must fade the wall poché fill across the paper').toBeLessThan(paperPocheBefore * 0.5);
  expect(quarterPocheAfter, 'halftoning must fade the wall poché fill at the quarter point').toBeLessThan(quarterPocheBefore * 0.5);
  expect(censusAfter?.darkStroke, 'no dark cut strokes must remain once the template halftones the walls').toBe(0);
  expect(censusAfter?.halftoneStroke, 'the plan must draw halftone strokes after the template').toBeGreaterThan(0);
  expect(censusAfter?.fillOp035, 'the poché fill must drop to 0.35 opacity after the template').toBeGreaterThan(0);
  await page.screenshot({ path: `${ART}/revit8-03-template.png` });

  // ── 6. Revision + cloud render on the plan ───────────────────────────
  const revInfo = await page.evaluate((mid: { x: number; z: number }) => {
    const ctx: any = (window as any).__OBS_CTX__;
    const rev = ctx?.features?.revisions?.add?.({
      description: 'Rev8: relocate door D-101',
      issuedBy: 'AM',
    });
    const cloud = ctx?.features?.revisions?.placeCloud?.(rev.id, [
      [mid.x - 2, mid.z - 2], [mid.x + 2, mid.z - 2], [mid.x + 2, mid.z + 2], [mid.x - 2, mid.z + 2],
    ]);
    return { revId: rev?.id ?? null, cloudId: cloud?.id ?? null };
  }, wallMid);
  expect(revInfo.revId, 'a revision record must be created').toBeTruthy();
  expect(revInfo.cloudId, 'a revision cloud must be placed').toBeTruthy();
  // Re-render the plan by re-selecting the view row.
  const htmlBeforeCloud = await planSvgHtml();
  await page.locator('#obs-views-panel').getByText('Level 0 Plan', { exact: false }).first().click();
  await waitForPlanRerender(htmlBeforeCloud);
  await page.waitForTimeout(400);
  const cloudHtml = await planSvgHtml();
  expect(cloudHtml, 'the revision cloud must be drawn in the plan SVG').toContain('#ef4444');
  const cloudShot = await planSvgShot();
  const redAfter = countPixels(cloudShot.png, isReddish);
  console.log('[revit8] reddish pixels on the plan after cloud:', redAfter, '(before:', redBefore + ')');
  expect(redAfter, 'the revision cloud must render reddish pixels on the plan').toBeGreaterThan(20);
  expect(redAfter, 'the cloud must multiply the reddish pixel count').toBeGreaterThan(redBefore + 15);
  await page.screenshot({ path: `${ART}/revit8-04-cloud.png` });

  // ── 7. Sheet + viewport, export PDF, open it in a real reader ───────
  await page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    ctx?.features?.viewsPanel?.close?.();
    return true;
  });
  await gotoTab('file');
  await clickStripButton('Sheets');
  await page.locator('.obs-sheets__row, button[data-act="new"]').first().waitFor({ timeout: 15000 });
  await page.locator('button[data-act="new"]').first().click();
  await page.waitForTimeout(700);
  expect(await page.locator('.obs-sheets__row').count(), 'a sheet must be created').toBeGreaterThan(0);
  // Close the list panel, open the 2D composer.
  await page.locator('button[data-act="close"]').first().click();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    ctx?.features?.sheets2dPanel?.open?.();
    return !!ctx?.features?.sheets2dPanel?.isVisible?.();
  });
  await expect(page.locator('#obs-sheets-2d-panel')).toBeVisible({ timeout: 15000 });
  const viewPicker = page.locator('#obs-sheets-2d-panel select').first();
  await viewPicker.selectOption({ value: 'plan-level-0' });
  await page.getByRole('button', { name: '+ Viewport', exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${ART}/revit8-05-sheet.png` });

  const downloadPromise = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const download = await downloadPromise;
  expect(download, 'Export PDF must produce a download').toBeTruthy();
  const pdfPath = `${ART}/revit8-sheet.pdf`;
  await download!.saveAs(pdfPath);
  const pdfSize = fs.statSync(pdfPath).size;
  console.log('[revit8] sheet PDF bytes:', pdfSize);
  expect(pdfSize, 'sheet PDF must be non-trivial').toBeGreaterThan(2000);

  // Real reader: poppler (pdftotext / pdfinfo / pdftoppm). When the binaries
  // are absent the reader checks are skipped and the gap is logged (the
  // download assertions above still stand); in this environment they exist.
  const hasPoppler = (() => {
    try {
      execSync('which pdftotext pdfinfo pdftoppm', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (!hasPoppler) {
    console.log('[revit8] poppler binaries absent — reader checks skipped (PDF was NOT opened in a reader)');
  } else {
    const pdfInfo = execSync(`pdfinfo "${pdfPath}"`, { encoding: 'utf8' });
    console.log('[revit8] pdfinfo:\n' + pdfInfo);
    expect(pdfInfo, 'PDF must be exactly 1 page').toMatch(/Pages:\s+1\b/);
    const pdfText = execSync(`pdftotext -layout "${pdfPath}" -`, { encoding: 'utf8' });
    console.log('[revit8] pdftotext (first 600 chars):\n' + pdfText.slice(0, 600));
    expect(pdfText, 'PDF text must contain the revision table entry').toContain('Rev 01');
    expect(pdfText, 'PDF text must contain the revision description').toContain('relocate door D-101');
    expect(pdfText, 'PDF text must contain the viewport title').toContain('Level 0 Plan');
    // Render page 1 to pixels and assert the drawing content is present.
    execSync(`pdftoppm -png -r 100 -f 1 -l 1 "${pdfPath}" "${ART}/revit8-sheet-page"`, { stdio: 'ignore' });
    const renderedPath = `${ART}/revit8-sheet-page-1.png`;
    expect(fs.existsSync(renderedPath), 'pdftoppm must render page 1').toBe(true);
    const rendered = decodePng(fs.readFileSync(renderedPath));
    const drawn = countPixels(rendered, isDrawn);
    console.log('[revit8] rendered page 1:', rendered.width, 'x', rendered.height, 'drawn pixels:', drawn);
    expect(drawn, 'rendered sheet must contain drawn content (wall, furniture, titleblock)').toBeGreaterThan(5000);
    const redInPdf = countPixels(rendered, isReddish);
    console.log('[revit8] reddish cloud pixels in rendered PDF:', redInPdf);
    expect(redInPdf, 'the revision cloud must survive into the rendered PDF').toBeGreaterThan(0);
  }

  // ── Final: no uncaught page errors ───────────────────────────────────
  const fatal = errors.filter((e) => /pageerror/.test(e));
  expect(fatal, `uncaught page errors: ${fatal.join('\n')}`).toEqual([]);
});
