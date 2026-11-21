import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Offline-first, proven (differentiation item 4):
 *   Phase A (online, build #1) — load the app, let the service worker take
 *     control, model a wall, save the project to IndexedDB, import a small
 *     IFC (this warms the versioned web-ifc WASM into the version cache),
 *     save again.
 *   Rebuild — `npm run build` in the spec: a fresh BUILD hash (the per-build
 *     cache rotates) with the SAME web-ifc pin. This is the "re-pin" the
 *     registry used to require a full cache refresh for.
 *   Phase B (offline, build #2) — the new worker activates, the old build
 *     cache is gone, the version cache must still be there; go offline,
 *     reload, and the app must load from cache, auto-reopen the project
 *     with the wall, and import the IFC again — with zero /web-ifc/
 *     requests reaching the network.
 *
 * The spec manages its own preview server (the config has no webServer)
 * and its own persistent browser profile, because Cache Storage,
 * localStorage and IndexedDB must survive the rebuild + reload. The
 * profile lives under the item dir (outside the repo) and is wiped at the
 * start of every run.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROFILE = path.resolve(REPO, '..', 'offline-profile');
const PORT = 3107;
const ORIGIN = `http://localhost:${PORT}`;

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

// The app's own telemetry fires console errors on any preview run here:
// the visits endpoint 404s on vite preview and is CSP-blocked to the
// Workers host, and ipapi.co has no route out of the VM. The icon loader
// also tries third-party CDNs (api.iconify.design / unisvg / simplesvg)
// for icons at runtime and is CSP-blocked — a pre-existing hole in the
// "no third-party runtime dependency" story, recorded as a known gap in
// the registry; it does not break the app. Those sources are filtered;
// anything else is a real failure. Bare "Failed to load resource"
// messages carry no URL, so they are judged through requestfailed below,
// which sees the URL.
const TELEMETRY = [/visits/, /ipapi\.co/, /workers\.dev/, /api\.iconify\.design/, /api\.unisvg\.com/, /api\.simplesvg\.com/];

async function startPreview(): Promise<ChildProcess> {
  // Spawn vite directly (not `npm run preview`): killing the npm wrapper
  // leaves the vite child orphaned and holding the port, so the next run
  // silently talks to a stale server.
  const server = spawn('./node_modules/.bin/vite', ['preview', '--port', String(PORT), '--strictPort'], {
    cwd: REPO, stdio: 'pipe',
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const res = await fetch(ORIGIN + '/');
      if (res.ok) return server;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('preview server did not start on ' + PORT);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function stopPreview(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    server.once('exit', done);
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* */ } done(); }, 10_000);
  });
  // Confirm the port is really free — a stale server here makes the next
  // startPreview silently serve the old build.
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(ORIGIN + '/');
      if (!res.ok) return;
    } catch { return; }
    if (Date.now() > deadline) throw new Error('preview server still listening on ' + PORT + ' after stop');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForSwControlled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { active: !!reg?.active, controlled: !!navigator.serviceWorker.controller };
  }), { timeout: 60_000, message: 'service worker active + controlling' }).toMatchObject({ active: true, controlled: true });
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

async function webIfcCacheEntries(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('obs-webifc-')) continue;
      const cache = await caches.open(name);
      for (const req of await cache.keys()) out.push(`${name} :: ${req.url}`);
    }
    return out;
  });
}

async function sceneElementCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ctx = (window as any).__OBS_CTX__;
    const ids = new Set<string>();
    ctx?.world?.scene?.three?.traverse((o: any) => {
      if (o?.userData?.elementId) ids.add(o.userData.elementId);
    });
    return ids.size;
  });
}

async function importWallIfc(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'wall.ifc', { type: 'application/octet-stream' }));
    host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, WALL_IFC);
}

test('offline-first: load, model, save, rebuild, reload offline, import again', async () => {
  test.setTimeout(600_000);
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const errors: string[] = [];
  const failedRequests: string[] = [];
  let server: ChildProcess | null = null;
  let context: BrowserContext | null = null;
  let page!: Page;
  try {
    server = await startPreview();
    context = await chromium.launchPersistentContext(PROFILE, { headless: true });
    page = await context.newPage();
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (m.text().startsWith('Failed to load resource:')) return; // judged via requestfailed, with URLs
      if (!TELEMETRY.some((re) => re.test(m.text()))) errors.push('console: ' + m.text().slice(0, 300));
    });
    // Failed requests, judged by URL: telemetry + the pre-existing CDN
    // icon attempts are noise; /web-ifc/ is counted separately below.
    page.on('requestfailed', (req) => {
      const url = req.url();
      if (url.includes('/web-ifc/')) return;
      if (TELEMETRY.some((re) => re.test(url))) return;
      failedRequests.push(`${req.failure()?.errorText ?? 'failed'} ${url}`);
    });

    // ── Phase A: online, build #1 ──────────────────────────────────────
    await page.goto(ORIGIN + '/');
    // The worker registers on window load; a reload hands control to it.
    await page.waitForLoadState('load');
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.active)),
      { timeout: 60_000, message: 'service worker registered' }).toBe(true);
    await page.reload();
    await waitForSwControlled(page);
    const cachesA = await cacheNames(page);
    const buildCacheA = cachesA.find((n) => /^obs-[0-9a-f]{10}$/.test(n));
    expect(buildCacheA, 'no per-build cache after first load: ' + cachesA.join(',')).toBeTruthy();

    // Enter the workspace and prove the app is live.
    await expect(page.locator('#obs-hero-3d')).toBeVisible({ timeout: 60_000 });
    await page.locator('#obs-hero-3d').click({ timeout: 30_000 });
    await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.authoring),
      { timeout: 30_000, message: 'authoring ready' }).toBe(true);

    // Model one wall and save it to IndexedDB.
    const projectId = await page.evaluate(async () => {
      const ctx = (window as any).__OBS_CTX__;
      const project = await ctx.features.projects.createProject('Offline proof');
      const wallId = await ctx.features.authoring.createElementByType('wall', {
        start: [0, 0, 0], end: [4, 0, 0], elevation: 0, thickness: 0.2, height: 3,
      });
      if (!wallId) throw new Error('authoring refused the wall');
      await ctx.features.projects.saveProject(true);
      return project?.id ?? ctx.features.projects.getCurrentProject()?.id;
    });
    expect(projectId, 'no project id after create').toBeTruthy();
    await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.features.projects.getSaveState().state),
      { timeout: 30_000, message: 'save did not finish' }).toBe('saved');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.projects.lastId')),
      { timeout: 10_000 }).toBe(projectId);
    expect(await sceneElementCount(page)).toBeGreaterThanOrEqual(1);

    // Warm the web-ifc WASM: import the small IFC (first import is online).
    const fragmentsBefore = await page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size);
    await importWallIfc(page);
    await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size),
      { timeout: 90_000, message: 'IFC import (online warm-up)' }).toBeGreaterThan(fragmentsBefore);
    await page.evaluate(() => (window as any).__OBS_CTX__.features.projects.saveProject(true));
    await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.features.projects.getSaveState().state),
      { timeout: 30_000 }).toBe('saved');
    const wasmEntries = await webIfcCacheEntries(page);
    expect(wasmEntries.length, 'versioned web-ifc WASM not in the version cache: ' + (await cacheNames(page)).join(',')).toBeGreaterThan(0);
    expect(wasmEntries.some((e) => e.includes('/web-ifc/') && e.includes('web-ifc.wasm')),
      'version cache has no web-ifc.wasm: ' + wasmEntries.join(' | ')).toBe(true);

    // ── Rebuild: new BUILD hash, same web-ifc pin ───────────────────────
    await stopPreview(server);
    server = null;
    execSync('npm run build', { cwd: REPO, timeout: 300_000, stdio: 'pipe' });
    const buildB = fs.readFileSync(path.join(REPO, 'dist', 'sw.js'), 'utf8').match(/const BUILD = "([0-9a-f]{10})"/)?.[1];
    expect(buildB, 'rebuilt sw.js has no BUILD hash').toBeTruthy();
    expect(buildB).not.toBe(buildCacheA!.replace('obs-', ''));

    // ── Phase B: new worker, then fully offline ─────────────────────────
    server = await startPreview();
    await page.reload();
    // The new worker installs on navigation (updateViaCache:"none"); its
    // per-build cache appears at install, the old one disappears at
    // activate — poll both, activation can lag install.
    await expect.poll(() => cacheNames(page), { timeout: 60_000, message: 'new worker installed' })
      .toContain('obs-' + buildB);
    await waitForSwControlled(page);
    await expect.poll(() => cacheNames(page), { timeout: 60_000, message: 'old build cache evicted' })
      .not.toContain(buildCacheA!);
    const cachesB = await cacheNames(page);
    const buildCacheB = cachesB.find((n) => /^obs-[0-9a-f]{10}$/.test(n));
    expect(buildCacheB, 'no new per-build cache after rebuild: ' + cachesB.join(',')).toBeTruthy();
    expect(buildCacheB).not.toBe(buildCacheA);
    const wasmAfterRebuild = await webIfcCacheEntries(page);
    expect(wasmAfterRebuild.length, 'version cache lost across the rebuild: ' + cachesB.join(',')).toBeGreaterThan(0);

    await context.setOffline(true);
    // Count any /web-ifc/ request that reaches the network layer while offline.
    let webIfcNetworkRequests = 0;
    await page.route('**/web-ifc/**', async (route) => {
      webIfcNetworkRequests++;
      await route.abort();
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.authoring),
      { timeout: 60_000, message: 'app did not boot offline' }).toBe(true);
    // Auto-reopen must have restored the saved project with the wall.
    await expect.poll(() => page.evaluate(() => {
      const p = (window as any).__OBS_CTX__?.features?.projects?.getCurrentProject?.();
      return p ? (p.elements?.length ?? 0) : -1;
    }), { timeout: 60_000, message: 'project did not auto-reopen offline' }).toBeGreaterThanOrEqual(1);
    // The scene rebuild after rehydration lags the project data (async
    // fragment/mesh work, slower on a loaded VM), so poll, don't snapshot.
    await expect.poll(() => sceneElementCount(page),
      { timeout: 60_000, message: 'wall not in the 3D scene after offline reopen' }).toBeGreaterThanOrEqual(1);

    // Import the IFC again while offline: the WASM must come from the
    // version cache, so the import succeeds with no network traffic.
    const fragmentsReloaded = await page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size);
    await importWallIfc(page);
    await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size),
      { timeout: 90_000, message: 'IFC import (offline)' }).toBeGreaterThan(fragmentsReloaded);
    expect(webIfcNetworkRequests, 'web-ifc WASM was fetched from the network while offline').toBe(0);
    expect(errors, 'page errors during the offline run').toEqual([]);
    expect(failedRequests, 'failed network requests during the offline run').toEqual([]);
  } catch (e) {
    // On failure, say what the page saw — otherwise a boot failure leaves
    // only the Playwright timeout with no app-side evidence.
    console.log('OFFLINE-SPEC-DIAGNOSTICS errors=' + JSON.stringify(errors) +
      ' failedRequests=' + JSON.stringify(failedRequests) +
      ' url=' + (page?.url() ?? 'no-page'));
    throw e;
  } finally {
    await context?.close().catch(() => {});
    if (server) await stopPreview(server).catch(() => {});
  }
});
