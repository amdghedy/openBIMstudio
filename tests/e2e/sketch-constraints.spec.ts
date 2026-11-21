import { test, expect, type Page } from '@playwright/test';

// Revit parity Rank 6, item 3 — sketch-constraints browser proof.
//
// Slice 5 proved dimension-driven sketch constraints at node level only
// (5 tests incl. fast-check properties); no Chromium spec had ever driven
// the sketch editor, and the registry still noted the drawing window was
// never used in a real browser. This spec drives it.
//
// What this spec drives through the REAL UI:
//   - Parametric Families panel → "New from sketch…" → the drawing window
//   - Rectangle tool + two clicks on the SVG grid → a 2×1 m outline
//     (the editor's own status line confirms "2.00 × 1.00 m, area 2.000 m²")
//   - "Create family" → the family exists with dimension-driven
//     parameters (sketchWidth / sketchLength, type-scope, defaults 2 / 1)
//   - panel "Rebuild geometry" → the preview mesh in the live scene
//   - edit the sketchWidth panel input → "Save type values" → rebuild
// What it asserts on the RENDERED model (not helper return values):
//   - the preview object's live-scene AABB is 2 × 0.3 × 1 m after the
//     sketch, then 3 × 0.3 × 1 m after the width edit — the drawn
//     dimension drives the geometry, and editing the dimension re-drives it
//
// Run: npx playwright test tests/e2e/sketch-constraints.spec.ts --project=chromium

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 90000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 90000 });
}

/** World-space AABB of the named object in the LIVE scene graph. */
const getPreviewBox = (page: Page) =>
  page.evaluate(() => {
    const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
    if (!scene) return null;
    const obj = scene.getObjectByName('obs-param-preview');
    if (!obj) return null;
    scene.updateMatrixWorld(true);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let found = false;
    obj.traverse((m: any) => {
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const bb = m.geometry.boundingBox;
      if (!bb) return;
      found = true;
      const e = m.matrixWorld.elements as number[];
      for (const cx of [bb.min.x, bb.max.x])
        for (const cy of [bb.min.y, bb.max.y])
          for (const cz of [bb.min.z, bb.max.z]) {
            const x = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
            const y = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
            const z = e[2] * cx + e[6] * cy + e[10] * cz + e[14];
            min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
            max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
          }
    });
    return found ? { min, max } : null;
  });

test('sketch editor draws a parametric rectangle and the width dimension drives the rebuild', async ({ page }) => {
  test.setTimeout(300000); // the panel-handle wait alone takes ~124 s (120 s boot fallback)
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);

  // ── 1. Open the panel (handle entry point: the Ctrl+Shift+F shortcut
  // does not deliver the F keydown in this environment — FU6/FU7 note)
  // and launch the sketch editor for a NEW family.
  await page.waitForFunction(
    () => !!(window as any).__obsParamFamilyPanel,
    undefined,
    { timeout: 150000 },
  );
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.open?.());
  await expect(page.locator('#obs-param-family-panel.is-open')).toBeVisible({ timeout: 15000 });
  await page.locator('#obs-param-family-panel [data-act="sketch-new"]').click();
  const editor = page.locator('[data-sketch-editor]');
  await expect(editor).toBeVisible({ timeout: 15000 });
  await expect(editor.getByText('Family sketch · new family')).toBeVisible();

  // ── 2. Rectangle tool: two clicks on the SVG grid.
  // SVG is 640×420 viewBox, origin at centre, 80 px/m, 0.25 m snap.
  // (−1, +0.5) → (1, −0.5) is a 2 × 1 m rect centred on the origin.
  await editor.locator('[data-tool="rect"]').click();
  const svgBox = await editor.locator('[data-svg]').boundingBox();
  expect(svgBox, 'the sketch SVG must be laid out').toBeTruthy();
  const at = (sx: number, sy: number) => ({
    x: svgBox!.x + (sx / 640) * svgBox!.width,
    y: svgBox!.y + (sy / 420) * svgBox!.height,
  });
  const c1 = at(320 - 80, 210 - 40);
  const c2 = at(320 + 80, 210 + 40);
  await page.mouse.click(c1.x, c1.y);
  await page.waitForTimeout(400);
  await page.mouse.click(c2.x, c2.y);
  await page.waitForTimeout(600);
  await expect(editor.locator('[data-status]')).toContainText('2.00 × 1.00 m', { timeout: 10000 });
  await expect(editor.locator('[data-status]')).toContainText('area 2.000 m²');
  // "Size as parameters" is checked by default: the rect becomes width/length params.
  await expect(editor.locator('[data-param]')).toBeChecked();

  // ── 3. Create the family; assert the dimension-driven parameters.
  await editor.locator('[data-apply]').click();
  await expect(editor).toHaveCount(0, { timeout: 15000 });
  const fam = await page.waitForFunction(
    () => {
      const svc = (window as any).__obsFamilyParametric ?? (window as any).__obsFamily ?? {};
      const list = svc.list?.() ?? [];
      return list.find((f: any) => f.name === 'Sketch family') ?? null;
    },
    undefined,
    { timeout: 20000 },
  ).then((h) => h.evaluate((f: any) => ({
    id: String(f.id),
    name: String(f.name),
    parameters: (f.parameters ?? []).map((p: any) => ({ name: p.name, scope: p.scope, def: p.default })),
    geometryKind: String(f.geometry?.kind ?? ''),
  })));
  expect(fam.geometryKind).toBe('extrusion');
  const byName = new Map(fam.parameters.map((p: any) => [p.name, p]));
  expect(byName.get('sketchWidth'), 'the drawn width must be a family parameter').toBeTruthy();
  expect(byName.get('sketchWidth').def).toBe(2);
  expect(byName.get('sketchWidth').scope).toBe('type');
  expect(byName.get('sketchLength').def).toBe(1);
  expect(byName.get('sketchDepth').def).toBe(0.3);
  console.log('[sketch] family:', fam.id, JSON.stringify(fam.parameters));

  // ── 4. Rebuild in the panel: the preview mesh is 2 × 0.3 × 1 m.
  await page.locator('#obs-param-family-panel [data-family]').selectOption(fam.id);
  await page.waitForTimeout(400);
  await page.locator('#obs-param-family-panel [data-act="rebuild"]').click();
  await page.waitForTimeout(900);
  const status = page.locator('#obs-param-family-panel [data-status]');
  await expect(status).toContainText('Geometry built', { timeout: 15000 });
  const box1 = await page.waitForFunction(
    () => {
      const scene = (window as any).__OBS_CTX__?.world?.scene?.three;
      return scene?.getObjectByName('obs-param-preview') ?? null;
    },
    undefined,
    { timeout: 20000 },
  ).then(() => getPreviewBox(page));
  expect(box1, 'the rebuilt preview must render').toBeTruthy();
  expect(box1!.max[0] - box1!.min[0]).toBeCloseTo(2, 2);
  expect(box1!.max[1] - box1!.min[1]).toBeCloseTo(0.3, 2);
  expect(box1!.max[2] - box1!.min[2]).toBeCloseTo(1, 2);
  // The extrusion is centred on the elevation plane (sketch-core
  // translates by elev+depth/2 after the pi/2 rotation), so with
  // depth 0.3 the solid spans y in [-0.15, +0.15], not [0, 0.3].
  expect(box1!.min[1]).toBeCloseTo(-0.15, 2);
  expect(box1!.max[1]).toBeCloseTo(0.15, 2);
  console.log('[sketch] preview box after sketch:', JSON.stringify(box1));

  // ── 5. Edit the width dimension in the panel → save → rebuild: 3 m wide.
  const widthInput = page.locator('#obs-param-family-panel [data-param="sketchWidth"]');
  await expect(widthInput).toHaveCount(1, { timeout: 15000 });
  await widthInput.fill('3');
  await page.locator('#obs-param-family-panel [data-act="apply-type"]').click();
  await page.waitForTimeout(600);
  await page.locator('#obs-param-family-panel [data-act="rebuild"]').click();
  await page.waitForTimeout(900);
  const box2 = await getPreviewBox(page);
  expect(box2, 'the rebuilt preview must still render').toBeTruthy();
  expect(box2!.max[0] - box2!.min[0]).toBeCloseTo(3, 2);
  expect(box2!.max[1] - box2!.min[1]).toBeCloseTo(0.3, 2);
  expect(box2!.max[2] - box2!.min[2]).toBeCloseTo(1, 2);
  console.log('[sketch] preview box after width edit:', JSON.stringify(box2));

  expect(errors, errors.join('\n')).toEqual([]);
});
