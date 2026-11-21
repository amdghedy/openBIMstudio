import { test, expect, type Page } from '@playwright/test';

/**
 * G2 — contextual Modify tab completion (Revit 2D environment audit).
 *
 * Proves in the real app that:
 *  1. Selecting authored elements shows a Modify tab with the Measure panel
 *     and Filter + Select Previous in the Select panel (all pre-existing
 *     panels intact, in order).
 *  2. Filter actually narrows a mixed wall+column selection to walls only.
 *  3. Select Previous restores the pre-filter selection.
 *  4. The placement tab (Modify | Place Wall) also carries the Measure panel.
 *  5. Selecting a linked IFC element shows the view-only Modify subset:
 *     View commands enabled, Make Editable present, transforms disabled
 *     with the not-editable reason shown, no Measure/Filter.
 *
 * Setup uses the public __OBS_CTX__ / __obsAuthoring API (the same surface
 * other specs use) to create/select elements deterministically; every
 * assertion is on the visible ribbon UI.
 *
 * Run: npx playwright test tests/e2e/modify-tab-completion.spec.ts --project=chromium
 * (needs a build first: the config's webServer runs `npm run preview`.)
 */

async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

const WALL_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('wall.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#10);
#10=IFCUNITASSIGNMENT((#11));
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCSITE('2VqzM6bXH7ugTO1ZoXRFzp',$,'S',$,$,#31,$,$,.ELEMENT.,$,$,$,$,$);
#31=IFCLOCALPLACEMENT($,#21);
#40=IFCRELAGGREGATES('3VqzM6bXH7ugTO1ZoXRFzq',$,$,$,#1,(#30));
#50=IFCWALL('1VqzM6bXH7ugTO1ZoXRFzr',$,'Wall 1',$,$,#51,#60,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#31,#21);
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#21,#64,3.);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,5.,0.2);
#64=IFCDIRECTION((0.,0.,1.));
#65=IFCAXIS2PLACEMENT2D(#66,$);
#66=IFCCARTESIANPOINT((0.,0.));
#70=IFCRELCONTAINEDINSPATIALSTRUCTURE('4VqzM6bXH7ugTO1ZoXRFzs',$,$,$,(#50),#30);
ENDSEC;
END-ISO-10303-21;
`;

test('modify tab completion: Measure + Filter + Select Previous, linked view-only subset', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);

  const ctxTab = () => page.locator('button.obs-ribbon__tab[data-tab="ctx-place"]');
  const strip = page.locator('.obs-ribbon__strip');
  const selectedIds = (): Promise<string[]> =>
    page.evaluate(() => [...((window as any).__OBS_CTX__.features.authoring.getSelectedIds?.() ?? [])] as string[]);

  // ── 1. Authored mixed selection: wall + column ──────────────────────────
  const ids = await page.evaluate(async () => {
    const a = (window as any).__obsAuthoring;
    const wall = await a.createElementByType('wall', { start: [-2, 0], end: [2, 0], height: 3, thickness: 0.4 });
    const col = await a.createElementByType('column', { point: [4, 0], height: 3, thickness: 0.3 });
    return { wall, col };
  });
  expect(ids.wall, 'authored wall created').toBeTruthy();
  expect(ids.col, 'authored column created').toBeTruthy();
  await page.evaluate((sel) => {
    (window as any).__OBS_CTX__.features.authoring.selectAllAuthored([sel.wall, sel.col]);
  }, ids);
  await expect(ctxTab()).toHaveText('Modify | Multi-Select', { timeout: 15000 });

  // All pre-existing panels intact and in order, Measure appended last.
  expect(await strip.locator('.obs-ribbon-group__label').allTextContents()).toEqual(
    ['Select', 'Properties', 'Clipboard', 'Modify', 'Geometry', 'Constraints', 'Create', 'View', 'Measure']);
  await expect(strip.getByRole('button', { name: 'Measure', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Clear Meas.', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Select Previous', exact: true })).toBeVisible();
  // Pre-existing selection tools still there.
  await expect(strip.getByRole('button', { name: 'Select Similar', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Move', exact: true })).toBeEnabled();
  await expect(strip.getByRole('button', { name: 'Join Walls', exact: true })).toBeVisible();

  // ── 2. Filter narrows the mixed selection to walls only ─────────────────
  await strip.getByRole('button', { name: 'Filter', exact: true }).click();
  const modal = page.locator('.obs-form-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  const modalLabels = await modal.locator('label').allTextContents();
  expect(modalLabels).toEqual(['Columns (1)', 'Walls (1)']);
  const boxes = modal.locator('input[type="checkbox"]');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).uncheck(); // Columns — first box (most-common first, ties by label)
  await modal.getByRole('button', { name: 'Apply Filter', exact: true }).click();
  await expect(modal).toBeHidden({ timeout: 10000 });
  await expect.poll(selectedIds, { timeout: 15000 }).toEqual([ids.wall]);
  await expect(ctxTab()).toHaveText('Modify | Walls', { timeout: 15000 });

  // ── 3. Select Previous restores the wall+column selection ───────────────
  await strip.getByRole('button', { name: 'Select Previous', exact: true }).click();
  await expect.poll(async () => (await selectedIds()).sort(), { timeout: 15000 })
    .toEqual([ids.wall, ids.col].sort());
  await expect(ctxTab()).toHaveText('Modify | Multi-Select', { timeout: 15000 });

  // ── 4. Placement tab also carries the Measure panel ─────────────────────
  // NOTE: with a selection active, the app's #obs-options-bar (mounted on
  // document.body when ctx.rightHost is unavailable at setup) sits at the
  // top of the page and covers the ribbon tab row, so no tab is clickable
  // until the selection is cleared. That overlap is pre-existing (untouched
  // by this branch) — Esc first, as a user would.
  await page.keyboard.press('Escape');
  await expect.poll(selectedIds, { timeout: 15000 }).toEqual([]);
  await page.locator('button.obs-ribbon__tab[data-tab="architecture"]').click();
  await strip.getByRole('button', { name: 'Wall', exact: true }).click();
  await expect(ctxTab()).toHaveText('Modify | Place Wall', { timeout: 15000 });
  await expect(strip.getByRole('button', { name: 'Measure', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Clear Meas.', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // ── 5. Linked selection: view-only subset ───────────────────────────────
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC loaded' }).toBeGreaterThanOrEqual(1);
  await page.evaluate(async () => {
    const ctx = (window as any).__OBS_CTX__;
    // A real click on a fragment clears the authored selection first; mirror that.
    ctx.features.authoring.selectAllAuthored([]);
    const modelId = [...ctx.fragments.list.keys()][0];
    const model = ctx.fragments.list.get(modelId);
    const geoIds = await model.getItemsIdsWithGeometry();
    ctx.features.selection.replace({ [modelId]: new Set([geoIds[0]]) });
    await ctx.features.selection.applyToHighlighter();
  });
  await expect(ctxTab()).toHaveText('Modify | Linked Selection', { timeout: 15000 });
  expect(await strip.locator('.obs-ribbon-group__label').allTextContents()).toEqual(['View', 'Linked', 'Modify']);
  await expect(strip.getByRole('button', { name: 'Make Editable', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Isolate', exact: true })).toBeEnabled();
  await expect(strip.getByRole('button', { name: 'Zoom', exact: true })).toBeEnabled();
  const move = strip.getByRole('button', { name: 'Move', exact: true });
  await expect(move).toBeDisabled();
  await expect(move).toHaveAttribute('title', /not editable/i);
  await expect(strip.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
  await expect(strip).toContainText('Linked elements are not editable');
  // No Measure / Filter in the linked tab (the honest subset is View + Make Editable).
  await expect(strip.getByRole('button', { name: 'Measure', exact: true })).toHaveCount(0);
  await expect(strip.getByRole('button', { name: 'Filter', exact: true })).toHaveCount(0);

  expect(errors, errors.join('\n')).toEqual([]);
});
