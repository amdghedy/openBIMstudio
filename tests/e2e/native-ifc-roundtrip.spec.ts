import { test, expect, type Page } from '@playwright/test';

/**
 * Native IFC round-trip — the “git for BIM” core workflow, end to end:
 *   import IFC → make editable → commit v1 → edit → commit v2 → diff
 *   → restore v1 (with auto-stash) → export IFC4.
 *
 * Drives the visible UI (command palette, modals) and reads state only
 * through the public ctx.features API — the same surface other specs use.
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

async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

/** Run a command palette entry: type a fragment, then click the exact row. */
async function runCommand(page: Page, query: string, label: string): Promise<void> {
  await page.keyboard.press('Control+p');
  const palette = page.locator('#obs-command-palette');
  await expect(palette).toBeVisible({ timeout: 10000 });
  await page.keyboard.type(query);
  const row = palette.getByText(label, { exact: false }).first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await expect(palette).toBeHidden({ timeout: 10000 });
}

const nativeIfc = (page: Page) =>
  page.evaluate(() => {
    const ctx = (window as any).__OBS_CTX__;
    return {
      twins: ctx?.features?.nativeIfc?.nativeIfcStatus?.() ?? null,
      versions: ctx?.features?.nativeIfcVersions?.status?.() ?? null,
    };
  });

test('native IFC: import → editable → commit → diff → restore → export', async ({ page }) => {
  const errors: string[] = [];
  const consoleLog: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    consoleLog.push(`[${m.type()}] ${m.text().slice(0, 220)}`);
    if (consoleLog.length > 500) consoleLog.splice(0, consoleLog.length - 500);
  });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);

  // 1. Import the IFC as a user drop
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC loaded' }).toBeGreaterThanOrEqual(1);

  // 2. Make model editable
  await runCommand(page, 'Make model editable', 'Native IFC: Make model editable');
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.features?.nativeIfc?.nativeIfcStatus?.()?.twinCount ?? 0), { timeout: 60000, message: 'native twin created' }).toBeGreaterThanOrEqual(1);

  // 3. Commit with a message via the promptLine modal (the auto baseline from
  //    step 2 already exists, so this is the second version)
  await runCommand(page, 'Commit version', 'Native IFC: Commit version');
  const modalInput = page.locator('.obs-form-modal input').first();
  await expect(modalInput).toBeVisible({ timeout: 10000 });
  await modalInput.fill('baseline wall as imported');
  await page.keyboard.press('Enter');
  await expect.poll(() => nativeIfc(page).then((s) => s.versions?.count ?? 0), { timeout: 20000, message: 'baseline committed' }).toBe(2);
  const v1Twins = (await nativeIfc(page)).twins?.twinCount ?? 0;

  // 4. Move the wall 1 m east through the public twin store
  await page.evaluate(() => {
    const fe = (window as any).__OBS_CTX__.features.fragEdit;
    const edits = fe.serialize();
    edits.forEach((e: any) => { e.position = [e.position[0] + 1, e.position[1], e.position[2]]; });
    return fe.deserialize(edits);
  });
  await runCommand(page, 'Commit version', 'Native IFC: Commit version');
  await expect(page.locator('.obs-form-modal input').first()).toBeVisible({ timeout: 10000 });
  await page.locator('.obs-form-modal input').first().fill('wall moved 1m east');
  await page.keyboard.press('Enter');
  await expect.poll(() => nativeIfc(page).then((s) => s.versions?.count ?? 0), { timeout: 20000, message: 'moved commit' }).toBe(3);

  // 5. Diff last two versions — the structured report must see the move
  await runCommand(page, 'Diff last versions', 'Native IFC: Diff last versions');
  const diff = page.locator('#obs-native-ifc-diff');
  await expect(diff).toBeVisible({ timeout: 10000 });
  await expect(diff).toContainText('moved · Δ 1.00m');
  await expect(diff).toContainText('1 changed');
  await diff.locator('[data-x]').click();
  await expect(diff).toBeHidden();

  // 6. Restore previous version (v1) — current edits are auto-stashed first
  try {
    await runCommand(page, 'Restore previous version', 'Native IFC: Restore previous version');
    const confirmOverlay = page.locator('.obs-form-modal-overlay');
    await expect(confirmOverlay).toBeVisible({ timeout: 10000 });
    await confirmOverlay.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => nativeIfc(page).then((s) => s.versions?.count ?? 0), { timeout: 30000, message: 'stash + restore recorded' }).toBe(4);
    // Twin store is back at v1 content (restored), and history logs the restore
    await expect.poll(
      () => page.evaluate(() => (window as any).__OBS_CTX__.features.nativeIfc.getIfcChangeHistory().some((h: any) => h.action === 'restore')),
      { timeout: 30000, message: 'restore logged in change history' },
    ).toBe(true);
  } catch (e) {
    throw new Error(`${(e as Error).message}\nrecent console:\n${consoleLog.slice(-20).join('\n')}`);
  }

  // 7. Export updated IFC4 — download fires and the export auto-commits
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await runCommand(page, 'Export updated IFC', 'Native IFC: Export updated IFC');
  const d = await dl;
  expect(d.suggestedFilename().toLowerCase()).toContain('.ifc');
  await expect.poll(() => nativeIfc(page).then((s) => s.versions?.count ?? 0), { timeout: 20000, message: 'export milestone commit' }).toBe(5);
  expect(v1Twins).toBeGreaterThanOrEqual(1);
  expect(errors, errors.join('\n')).toEqual([]);
});
