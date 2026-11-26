import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Import → edit → undo → save → reload: state is identical.
 *
 * Replaces the earlier fixme version, which was written against
 * data-testid hooks (import-ifc, model-tree, element-count, tool-move,
 * save-project) the app never had, so it could never run. This version
 * drives the real surfaces the other specs use:
 *   - the command palette ("New project"),
 *   - an IFC drop on the canvas host (the real import path),
 *   - the authoring service's real Move path
 *     (transformElements → history.push),
 *   - Ctrl+Z (global-undo → the one canonical history stack),
 *   - Ctrl+S (the projects module's own save handler),
 *   - a real reload, after which boot auto-reopens the last project
 *     (obs.projects.lastId → openProject).
 *
 * Chain under test: new project → import an IFC wall → author a wall →
 * move it +5 m in x (real Move path) → undo → save → reload → both the
 * imported model and the wall are back, the wall in its pre-edit state.
 */

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
#40=IFCRELAGGREGATES('3VqzM6bXH7ugTO1ZoXRFzq',$,'S',$,$,#1,(#30));
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

/** Leave the welcome screen the way a user does (the 3D BIM Platform card). */
async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

/** Run a command palette entry: type a fragment, then click the exact row. */
async function runCommand(page: Page, query: string, label: string): Promise<void> {
  await openPaletteWith(page, query);
  const palette = page.locator('#obs-command-palette');
  const row = palette.getByText(label, { exact: false }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(palette).toBeHidden({ timeout: 10000 });
}

test('import, edit, undo, save, reload: state is identical', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__obsAuthoring), { timeout: 30000 }).toBe(true);

  // 1. New project (save needs one open; createProject clears the scene,
  //    so the project must exist BEFORE the import).
  await runCommand(page, 'New project', 'New project');
  const nameInput = page.locator('.obs-form-modal input').first();
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill('E2E edit-undo-save');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.projects.lastId')), { timeout: 30000 }).not.toBeNull();
  const projectId = (await page.evaluate(() => localStorage.getItem('obs.projects.lastId'))) as string;
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.features?.projects?.isTransitioning?.() ?? false), { timeout: 30000 }).toBe(false);

  // 2. Import the IFC as a user drop (the real import path).
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC loaded' }).toBeGreaterThanOrEqual(1);

  // 3. Author a wall (0,0)→(4,0), then move it +5 in x through the real
  //    Move path (transformElements → history.push).
  const wallId = await page.evaluate(() => {
    const a = (window as any).__obsAuthoring;
    return a.createElementByType('wall', { start: [0, 0], end: [4, 0] }) as string;
  });
  expect(wallId, 'authored wall created').toBeTruthy();
  const wallParams = () => page.evaluate((id) => {
    const el = (window as any).__obsAuthoring.getElementById(id);
    return el ? { id: el.id, start: [...el.params.start], end: [...el.params.end] } : null;
  }, wallId);
  expect((await wallParams())?.start?.[0], 'wall starts at x=0').toBe(0);

  await page.evaluate((id) => {
    (window as any).__obsAuthoring.transformElements([id], (el: any) => {
      el.params.start[0] += 5;
      el.params.end[0] += 5;
    });
  }, wallId);
  await expect.poll(async () => (await wallParams())?.start?.[0] ?? null, { timeout: 30000, message: 'wall moved' }).toBe(5);

  // 4. Ctrl+Z — the one keyboard undo path reverts the move.
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await wallParams())?.start?.[0] ?? null, { timeout: 30000, message: 'move undone' }).toBe(0);
  const beforeSave = await wallParams();
  expect(beforeSave).toEqual({ id: wallId, start: [0, 0], end: [4, 0] });

  // 5. Ctrl+S — the projects module's own save handler.
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.features?.projects?.getSaveState?.()?.state ?? null), { timeout: 30000, message: 'project saved' }).toBe('saved');

  // 6. Reload. Boot auto-reopens the last project (obs.projects.lastId).
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.features?.projects?.getCurrentProject?.()?.id ?? null), { timeout: 90000, message: 'project auto-reopened' }).toBe(projectId);
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 60000 });

  // 7. State is identical: the imported model is back, and the wall is
  //    back with the same id in its pre-edit position.
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.fragments?.list?.size ?? 0), { timeout: 90000, message: 'imported model restored' }).toBeGreaterThanOrEqual(1);
  await expect.poll(async () => (await wallParams())?.id ?? null, { timeout: 60000, message: 'authored wall restored' }).toBe(wallId);
  expect(await wallParams(), 'wall state identical after save + reload').toEqual(beforeSave);

  // Uncaught page errors fail the chain. Console resource errors (blocked
  // analytics/CSP-gated calls, missing optional assets) are environment
  // noise on an offline runner, so they are collected for context but not
  // asserted — same convention as document-chain.spec.ts.
  const fatal = errors.filter((e) => /pageerror/.test(e));
  expect(fatal, `uncaught page errors: ${fatal.join('\n')}`).toEqual([]);
});
