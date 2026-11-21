import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Native IFC typed export (Revit parity rank 1) — end to end in a real
 * Chromium browser:
 *   import a small authored IFC (wall + door + window + roof) → make
 *   editable → export IFC4 → the download must carry the real entity
 *   names (IFCWALL / IFCDOOR / IFCWINDOW), the unsupported roof must fall
 *   back to IFCBUILDINGELEMENTPROXY, and the conversion report must be
 *   surfaced — the export's change-history entry records the typed /
 *   proxied counts and names the proxied source type. A report that is
 *   computed but never shown is a silent fallback, which is exactly the
 *   GAP-05 defect this rank closes.
 *
 * Drives the visible UI (command palette) and reads state only through
 * the public ctx.features API — the same surface other specs use.
 */

const MIXED_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('mixed.ifc','2026-01-01T00:00:00',(''),(''),'','','');
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
#41=IFCDIRECTION((0.,0.,1.));
#50=IFCWALL('1VqzM6bXH7ugTO1ZoXRFzr',$,'Wall 1',$,$,#51,#60,$,.STANDARD.);
#51=IFCLOCALPLACEMENT(#31,#21);
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#21,#41,3.);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#65,5.,0.2);
#65=IFCAXIS2PLACEMENT2D(#66,$);
#66=IFCCARTESIANPOINT((0.,0.));
#70=IFCRELCONTAINEDINSPATIALSTRUCTURE('4VqzM6bXH7ugTO1ZoXRFzs',$,$,$,(#50),#30);
#80=IFCDOOR('5VqzM6bXH7ugTO1ZoXRFza',$,'Door 1',$,$,#81,#90,$,2.1,0.9,.DOOR.,.SINGLE_SWING_LEFT.,$);
#81=IFCLOCALPLACEMENT(#31,#21);
#90=IFCPRODUCTDEFINITIONSHAPE($,$,(#91));
#91=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#92));
#92=IFCEXTRUDEDAREASOLID(#93,#21,#41,2.1);
#93=IFCRECTANGLEPROFILEDEF(.AREA.,$,#95,0.9,0.1);
#95=IFCAXIS2PLACEMENT2D(#96,$);
#96=IFCCARTESIANPOINT((0.,0.));
#100=IFCRELCONTAINEDINSPATIALSTRUCTURE('6VqzM6bXH7ugTO1ZoXRFzb',$,$,$,(#80),#30);
#110=IFCWINDOW('7VqzM6bXH7ugTO1ZoXRFzc',$,'Window 1',$,$,#111,#120,$,1.5,1.2,.WINDOW.,.SINGLE_PANEL.,$);
#111=IFCLOCALPLACEMENT(#31,#21);
#120=IFCPRODUCTDEFINITIONSHAPE($,$,(#121));
#121=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#122));
#122=IFCEXTRUDEDAREASOLID(#123,#21,#41,1.5);
#123=IFCRECTANGLEPROFILEDEF(.AREA.,$,#125,1.2,0.1);
#125=IFCAXIS2PLACEMENT2D(#126,$);
#126=IFCCARTESIANPOINT((0.,0.));
#130=IFCRELCONTAINEDINSPATIALSTRUCTURE('8VqzM6bXH7ugTO1ZoXRFzd',$,$,$,(#110),#30);
#140=IFCROOF('9VqzM6bXH7ugTO1ZoXRFze',$,'Roof 1',$,$,#141,#150,$,.FLAT_ROOF.);
#141=IFCLOCALPLACEMENT(#31,#21);
#150=IFCPRODUCTDEFINITIONSHAPE($,$,(#151));
#151=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#152));
#152=IFCEXTRUDEDAREASOLID(#153,#21,#41,0.3);
#153=IFCRECTANGLEPROFILEDEF(.AREA.,$,#155,5.,0.2);
#155=IFCAXIS2PLACEMENT2D(#156,$);
#156=IFCCARTESIANPOINT((0.,0.));
#160=IFCRELCONTAINEDINSPATIALSTRUCTURE('AVqzM6bXH7ugTO1ZoXRFzf',$,$,$,(#140),#30);
ENDSEC;
END-ISO-10303-21;
`;

async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  // The home overlay mounts late in boot; on the shared-CPU VM that can
  // take far longer than the suite's 30 s default. If the platform is
  // already entered by the time the hero would appear (overlay closed,
  // ctx ready), proceed instead of failing — the hero click is the means,
  // being inside the platform is the end.
  try {
    await page.locator('#obs-hero-3d').click({ timeout: 120000 });
  } catch {
    const alreadyIn = await page.evaluate(() => {
      const ctx = (window as any).__OBS_CTX__;
      return !!ctx?.fragments && !document.querySelector('.obs-home.is-open');
    });
    if (!alreadyIn) throw new Error('home hero never appeared and platform was not entered');
  }
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

const exportHistory = (page: Page) =>
  page.evaluate(() =>
    ((window as any).__OBS_CTX__?.features?.nativeIfc?.getIfcChangeHistory?.() ?? [])
      .filter((h: any) => h.action === 'export-ifc'),
  );

test('native IFC typed export: wall/door/window stay typed, roof proxies with a surfaced report', async ({ page }) => {
  // Four conversions on the shared-CPU VM (SwiftShader) take far longer
  // than the suite's 60 s default; the assertion is unchanged, only the
  // waits account for this VM's speed (see browser-repro notes).
  test.setTimeout(480000);
  const errors: string[] = [];
  const consoleLog: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    consoleLog.push(`[${m.type()}] ${m.text().slice(0, 220)}`);
    if (consoleLog.length > 500) consoleLog.splice(0, consoleLog.length - 500);
  });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);

  // 1. Import the mixed IFC as a user drop
  await page.evaluate(async (text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'mixed.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, MIXED_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 90000, message: 'IFC loaded' }).toBeGreaterThanOrEqual(1);

  // 2. Make model editable — all four elements (including the roof) become twins
  await runCommand(page, 'Make model editable', 'Native IFC: Make model editable');
  await expect.poll(
    () => page.evaluate(() => (window as any).__OBS_CTX__?.features?.nativeIfc?.nativeIfcStatus?.()?.twinCount ?? 0),
    { timeout: 240000, message: 'native twins created (wall + door + window + roof)' },
  ).toBe(4);

  // 3. Export updated IFC4 and read the downloaded file
  const dl = page.waitForEvent('download', { timeout: 60000 });
  await runCommand(page, 'Export updated IFC', 'Native IFC: Export updated IFC');
  const d = await dl;
  expect(d.suggestedFilename().toLowerCase()).toContain('.ifc');
  const text = (await import('fs')).readFileSync((await d.path())!, 'utf8');

  // 4. Typed entities survive export; the unsupported roof is exactly one proxy
  expect(text).toContain('IFCWALL(');
  expect(text).toContain('IFCDOOR(');
  expect(text).toContain('IFCWINDOW(');
  const proxyCount = (text.match(/IFCBUILDINGELEMENTPROXY\(/g) ?? []).length;
  expect(proxyCount, `expected exactly 1 proxy (the roof); file has ${proxyCount}`).toBe(1);
  expect(text).toContain('Roof 1');
  // The source GlobalIds survive too (the twin keeps its identity — the
  // FRAG _guid is what the writer preserves, not a fresh derived GUID).
  expect(text).toContain("'1VqzM6bXH7ugTO1ZoXRFzr'");
  expect(text).toContain("'5VqzM6bXH7ugTO1ZoXRFza'");

  // 5. The conversion report is surfaced: the export's change-history entry
  // records typed/proxied counts and names the proxied source type.
  await expect.poll(() => exportHistory(page).then((rows) => rows.length), { timeout: 20000, message: 'export recorded in change history' }).toBeGreaterThanOrEqual(1);
  const entry = (await exportHistory(page)).at(-1) as any;
  expect(entry.typed, `history entry: ${JSON.stringify(entry)}`).toBe(3);
  expect(entry.proxied, `history entry: ${JSON.stringify(entry)}`).toBe(1);
  expect(
    (entry.proxiedTypes ?? []).some((t: string) => /roof/i.test(t)),
    `history entry proxiedTypes: ${JSON.stringify(entry)}`,
  ).toBe(true);
  expect(entry.summary).toContain('3 typed, 1 proxied');

  expect(errors, errors.join('\n')).toEqual([]);
});
