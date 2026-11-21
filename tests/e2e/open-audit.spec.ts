import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';

/**
 * One-click open-standards audit (differentiation item 5):
 *   import a small IFC wall → author a second wall overlapping it →
 *   run the audit (IDS + clash → BCF) → the report panel shows the
 *   real counts → Download BCF yields a real .bcfzip whose markup
 *   contains the clash topic and the IDS violation topic.
 * A second run through the palette command (no IDS loaded) proves the
 * command wiring and the honest "IDS skipped" path.
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

const AUDIT_IDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Audit demo rules</title><version>1</version><author>openBIMstudio audit</author></info>
  <specifications>
    <specification name="Walls are named" identifier="wall-named" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute></requirements>
    </specification>
    <specification name="Walls carry a description" identifier="wall-desc" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><attribute cardinality="required"><name><simpleValue>Description</simpleValue></name></attribute></requirements>
    </specification>
    <specification name="Walls carry a fire rating" identifier="wall-fire" ifcVersion="IFC4">
      <applicability><entity><name><simpleValue>IfcWall</simpleValue></name></entity></applicability>
      <requirements><property cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><name><simpleValue>FireRating</simpleValue></name></property></requirements>
    </specification>
  </specifications>
</ids>`;

const TELEMETRY = [/visits/, /ipapi\.co/, /workers\.dev/, /iconify\.design/, /unisvg\.com/, /simplesvg\.com/, /ERR_TUNNEL_CONNECTION_FAILED/];
// Bare "Failed to load resource" console messages carry no URL, so they
// are excused here as text and judged instead through the recorded
// request/response URLs (badUrls, asserted at the end) — a 404 on any
// non-telemetry URL still fails the spec there.
// The app's telemetry fires console errors in any run here (the visits
// endpoint 404s on vite preview, ipapi.co has no route out of the VM,
// and the icon loader still attempts runtime fetches to icon CDNs that
// are CSP-blocked). Those three sources are proven benign by URL in the
// response log; any other failed response is still fatal. Bare
// "Failed to load resource" console messages carry no URL, so they are
// judged here through the recorded request/response URLs, not the text.

async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

test('one-click audit: IDS + clash → BCF report and download', async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  const badUrls: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !TELEMETRY.some((re) => re.test(m.text()))
      && !m.text().startsWith('Failed to load resource')) errors.push('console: ' + m.text().slice(0, 300));
  });
  page.on('requestfailed', (r) => badUrls.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) badUrls.push(r.url()); });

  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.openAudit),
    { timeout: 60_000, message: 'open-audit feature not wired' }).toBe(true);

  // 1. Import the IFC wall (the IDS section reads imported models).
  await page.evaluate((text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size),
    { timeout: 90_000, message: 'IFC import' }).toBeGreaterThanOrEqual(1);

  // 2. Author a second wall overlapping the imported one (x 2..6 vs 0..5).
  const wallId = await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [2, 0, 0], end: [6, 0, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  expect(wallId, 'authoring refused the overlapping wall').toBeTruthy();

  // 3. Run the audit with the IDS document.
  const report = await page.evaluate(async (idsXml) => {
    const audit = (window as any).__OBS_CTX__.features.openAudit;
    const r = await audit.runOpenAudit({ idsXml });
    audit.showAuditReport(r);
    return r;
  }, AUDIT_IDS_XML);
  console.log('AUDIT-REPORT ' + JSON.stringify({
    ids: report.ids, clash: report.clash, bcf: report.bcf,
    findings: report.findings.map((f: any) => `${f.source}/${f.severity}: ${f.title}`),
  }));
  expect(report.ids.status, 'IDS did not run: ' + JSON.stringify(report.ids)).toBe('run');
  expect(report.ids.passed, 'expected the named-wall check to pass').toBeGreaterThanOrEqual(1);
  // Both the missing Description and the missing FireRating fail: a
  // required property that is absent from a readable model is a real
  // failure, not an "unverifiable". (The engine reports unverifiable
  // only when the model cannot expose properties at all.)
  expect(report.ids.failed, 'expected Description + FireRating to fail').toBe(2);
  expect(report.findings.some((f: any) => f.title.includes('description')),
    'no finding names the missing Description').toBe(true);
  expect(report.findings.some((f: any) => f.title.includes('fire rating')),
    'no finding names the missing FireRating').toBe(true);
  expect(report.clash.status, 'clash did not run: ' + JSON.stringify(report.clash)).toBe('run');
  expect(report.clash.found, 'expected the overlapping walls to clash').toBeGreaterThanOrEqual(1);
  expect(report.bcf.topicCount, 'BCF topics must cover every clash + every FAILED IDS check (warnings are listed, not issued)')
    .toBe(report.clash.found + report.findings.filter((f: any) => f.source === 'ids' && f.severity === 'error').length);
  expect(report.bcf.bytes, 'BCF blob is empty').toBeGreaterThan(0);

  // 4. The report panel shows the real counts.
  const panel = page.locator('#obs-open-audit');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await expect(panel).toContainText('Walls carry a description');
  await expect(panel).toContainText('clash');

  // 5. Download BCF: a real .bcfzip whose markup names both topics.
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  await panel.locator('[data-bcf]').click();
  const download = await downloadPromise;
  const bcfPath = path.join(os.tmpdir(), 'audit-e2e.bcfzip');
  await download.saveAs(bcfPath);
  const zip = await JSZip.loadAsync(fs.readFileSync(bcfPath));
  const markups = Object.keys(zip.files).filter((n) => n.endsWith('markup.bcf'));
  expect(markups.length, 'no markup.bcf in the downloaded .bcfzip: ' + Object.keys(zip.files).join(',')).toBe(report.bcf.topicCount);
  const markupTexts = await Promise.all(markups.map((n) => zip.file(n)!.async('string')));
  const joined = markupTexts.join('\n');
  expect(joined, 'downloaded BCF has no clash topic').toMatch(/Hard Clash|INTERSECT/i);
  expect(joined, 'downloaded BCF has no IDS violation topic').toMatch(/Walls carry a description/);
  fs.unlinkSync(bcfPath);

  // 6. The palette command runs the audit too — with no IDS loaded it
  //    honestly reports IDS as skipped instead of inventing a pass.
  await page.keyboard.press('Control+p');
  const palette = page.locator('#obs-command-palette');
  await expect(palette.getByText('Audit: run open-standards audit', { exact: false }).first())
    .toBeVisible({ timeout: 10_000 });
  await palette.getByText('Audit: run open-standards audit', { exact: false }).first().click();
  await expect.poll(() => page.evaluate(() => {
    const r = (window as any).__OBS_CTX__?.features?.openAudit?.getLastAuditReport?.();
    return r ? r.ids.status : null;
  }), { timeout: 120_000, message: 'palette audit did not finish' }).toBe('skipped');
  await expect(panel).toContainText('Skipped');

  expect(errors, 'page errors during the audit run').toEqual([]);
  // A bare "Failed to load resource" carries no URL, so a 404/failed
  // request is only excused when its own URL is a known telemetry source.
  const unexplained = badUrls.filter((u) => !TELEMETRY.some((re) => re.test(u)));
  expect(unexplained, 'failed requests that are not known telemetry').toEqual([]);
});
