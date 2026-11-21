import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import JSZip from 'jszip';

/**
 * Publish-as-web-page (differentiation item 6):
 *   create a project → author a wall → publish (palette command) →
 *   the downloaded .zip is a complete static site → serve it from a
 *   plain static server UNDER A SUBPATH (no app server, no backend) →
 *   the published page boots, auto-opens the model, and the wall is in
 *   the 3D scene → the published viewer can even import an IFC there
 *   (proving the web-ifc path is subpath-relative).
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

// The app's own telemetry fires console errors in any run here (visits
// endpoint 404s on vite preview, ipapi.co has no route out of the VM,
// icon CDNs are CSP-blocked). Those sources are proven benign by URL in
// the response log; any other failed response is still fatal. Bare
// "Failed to load resource" messages carry no URL, so they are judged
// through the recorded request/response URLs, not the text.
const TELEMETRY = [/visits/, /ipapi\.co/, /workers\.dev/, /iconify\.design/, /unisvg\.com/, /simplesvg\.com/, /ERR_TUNNEL_CONNECTION_FAILED/];

function watch(page: Page): { errors: string[]; badUrls: string[] } {
  const errors: string[] = [];
  const badUrls: string[] = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !TELEMETRY.some((re) => re.test(m.text()))
      && !m.text().startsWith('Failed to load resource')) errors.push('console: ' + m.text().slice(0, 300));
  });
  page.on('requestfailed', (r) => badUrls.push(r.url()));
  page.on('response', (r) => { if (r.status() >= 400) badUrls.push(r.url()); });
  return { errors, badUrls };
}

function assertClean(w: { errors: string[]; badUrls: string[] }, where: string) {
  expect(w.errors, `page errors on ${where}`).toEqual([]);
  const unexplained = w.badUrls.filter((u) => !TELEMETRY.some((re) => re.test(u)));
  expect(unexplained, `failed requests on ${where} that are not known telemetry`).toEqual([]);
}

/** Minimal static file server for one directory tree (no app server). */
function serveStatic(root: string, port: number): Promise<http.Server> {
  const types: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain',
    '.obsproj': 'application/octet-stream', '.webmanifest': 'application/manifest+json',
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

test('publish: model + viewer as a static page under a subpath', async ({ page }) => {
  test.setTimeout(600_000);
  const appWatch = watch(page);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-publish-'));

  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.publishWeb),
    { timeout: 60_000, message: 'publish-web feature not wired' }).toBe(true);

  // 1. A real project with a real wall.
  await page.evaluate(async () => {
    await (window as any).__OBS_CTX__.features.projects.createProject('Publish Demo');
  });
  const wallId = await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [0, 0, 0], end: [4, 0, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  expect(wallId, 'authoring refused the wall').toBeTruthy();

  // 2. Publish through the palette command; capture the .zip download.
  // The palette shows only the first 40 commands alphabetically on an
  // empty query, so filter by typing "publish" first. Ctrl+P opens the
  // palette; under heavy VM load the keystroke has been seen not to land,
  // so fall back to the palette's own open() API (the filter + row click
  // below still go through the real palette UI).
  await page.keyboard.press('Control+p');
  const paletteOpen = await page.evaluate(async () => {
    const cp = (window as any).__OBS_CTX__?.features?.commandPalette;
    for (let i = 0; i < 10; i++) {
      if (cp?.isOpen?.()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    cp?.open?.();
    return !!cp?.isOpen?.();
  });
  expect(paletteOpen, 'command palette did not open').toBe(true);
  const palette = page.locator('#obs-command-palette');
  await expect(palette.locator('input')).toBeVisible({ timeout: 10_000 });
  await palette.locator('input').fill('publish');
  await expect(palette.getByText('Publish: export this model as a web page', { exact: false }).first())
    .toBeVisible({ timeout: 10_000 });
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 });
  await palette.getByText('Publish: export this model as a web page', { exact: false }).first().click();
  const download = await downloadPromise;
  const zipPath = path.join(tmp, 'publish-demo-web.zip');
  await download.saveAs(zipPath);
  const zipBytes = fs.statSync(zipPath).size;
  console.log('PUBLISH-ZIP ' + zipBytes + ' bytes');
  expect(zipBytes, 'published zip is suspiciously small').toBeGreaterThan(10 * 1024 * 1024);

  // 3. The zip is a complete static site: rewritten index.html, the model,
  //    and the viewer files — no app server involved from here on.
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const names = Object.values(zip.files).filter((f) => !f.dir).map((f) => f.name);
  expect(names, 'published zip has no model').toContain('model.obsproj');
  expect(names, 'published zip has no index.html').toContain('index.html');
  expect(names.filter((n) => n.startsWith('assets/')).length, 'published zip has no viewer assets').toBeGreaterThan(100);
  expect(names, 'published zip must not carry the service worker').not.toContain('sw.js');
  const indexHtml = await zip.file('index.html')!.async('string');
  expect(indexHtml, 'published index.html has no published marker').toContain('window.__OBS_PUBLISHED__');
  expect(indexHtml, 'published index.html still has root-absolute asset refs').not.toMatch(/(href|src)="\/[^"]*"/);
  expect(indexHtml, 'published index.html title is not the project').toContain('<title>Publish Demo — OpenBIMStudio</title>');
  const modelBytes = await zip.file('model.obsproj')!.async('nodebuffer');
  expect(modelBytes.length, 'model.obsproj is empty').toBeGreaterThan(100);

  // 4. Extract under a subpath and serve it with a plain static server.
  const siteRoot = path.join(tmp, 'site');
  const publishedDir = path.join(siteRoot, 'publish-demo');
  fs.mkdirSync(publishedDir, { recursive: true });
  for (const name of names) {
    const dest = path.join(publishedDir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await zip.file(name)!.async('nodebuffer'));
  }
  const server = await serveStatic(siteRoot, 3108);
  try {
    // 5. The published page boots on its own, auto-opens the model, and
    //    the wall is really in the 3D scene — from a subpath, with no
    //    app server, no backend, no account.
    const pub = await page.context().newPage();
    const pubWatch = watch(pub);
    await pub.goto('http://127.0.0.1:3108/publish-demo/index.html');
    await expect.poll(() => pub.evaluate(() => (window as any).__OBS_PUBLISHED__?.model),
      { timeout: 30_000, message: 'published marker not set' }).toBe('model.obsproj');
    await expect.poll(() => pub.evaluate(() => {
      const ctx = (window as any).__OBS_CTX__;
      if (!ctx?.features?.authoring) return 0;
      return ctx.features.authoring.getElements().length;
    }), { timeout: 120_000, message: 'published model did not open' }).toBeGreaterThanOrEqual(1);
    await expect.poll(() => pub.evaluate(() => {
      const ctx = (window as any).__OBS_CTX__;
      if (!ctx?.world?.scene?.three) return 0;
      const ids = new Set<string>();
      ctx.world.scene.three.traverse((o: any) => { if (o?.userData?.elementId) ids.add(o.userData.elementId); });
      return ids.size;
    }), { timeout: 60_000, message: 'published wall not in the 3D scene' }).toBeGreaterThanOrEqual(1);
    await expect(pub.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 30_000 });

    // 6. The published viewer is a full viewer, not a crippled one: it can
    //    import an IFC under the subpath (web-ifc path is page-relative).
    await pub.evaluate((text) => {
      const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
      host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, WALL_IFC);
    await expect.poll(() => pub.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size),
      { timeout: 120_000, message: 'IFC import in the published page' }).toBeGreaterThanOrEqual(1);

    assertClean(pubWatch, 'the published page');
    await pub.close();
  } finally {
    server.close();
  }

  assertClean(appWatch, 'the app while publishing');
  fs.rmSync(tmp, { recursive: true, force: true });
});
