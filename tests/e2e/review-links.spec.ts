import { test, expect, type Page } from '@playwright/test';
import * as http from 'node:http';
import * as fs from 'node:fs';
import JSZip from 'jszip';

/**
 * View-only review links with markup (differentiation item 8):
 *   author page authors a wall → snapshots the model through the review
 *   feature's snapshot (the exact bytes the Save-to-file command writes;
 *   a headless browser cannot drive the native file picker that command
 *   opens) → a plain static server hosts it (CORS open, as the author
 *   link → the wall is in the scene, the review banner is visible, review
 *   mode is on → activating the wall tool AND createElementByType are both
 *   refused and the model is unchanged → the reviewer selects the wall,
 *   creates an issue, exports the review as BCF → the .bcfzip re-parses to
 *   one topic with the title, the reviewer as author, a viewpoint camera
 *   and a snapshot → the author page imports that .bcfzip and the issue
 *   appears with its viewpoint.
 */

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

async function enterPlatform(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function save(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__OBS_CTX__.features.projects.saveProject(true));
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.features.projects.getSaveState().state),
    { timeout: 30_000, message: 'project did not reach saved state' }).toBe('saved');
}

async function elementIds(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.getElements().map((e: any) => e.id).sort());
}

async function sceneIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ctx = (window as any).__OBS_CTX__;
    if (!ctx?.world?.scene?.three) return [];
    const ids = new Set<string>();
    ctx.world.scene.three.traverse((o: any) => { if (o?.userData?.elementId) ids.add(o.userData.elementId); });
    return [...ids].sort();
  });
}


test('review links: view-only review, issue markup, BCF back to the author', async ({ page, browser }) => {
  test.setTimeout(600_000);
  const authorWatch = watch(page);

  // ── 1. Author: a real project with a real wall, saved. ──────────────
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.reviewLinks),
    { timeout: 60_000, message: 'review-links feature not wired' }).toBe(true);
  await page.evaluate(async () => {
    await (window as any).__OBS_CTX__.features.projects.createProject('Review Demo');
  });
  const wallId = await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [0, 0, 0], end: [4, 0, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  expect(wallId, 'authoring refused the wall').toBeTruthy();
  await save(page);

  // ── 2. Author: the model file — the exact snapshot the Save-to-file
  // command writes, read through the review feature's snapshot (a headless
  // browser cannot drive the native file picker that command opens).
  const modelB64: string | null = await page.evaluate(async () => {
    const snap = await (window as any).__OBS_CTX__.features.reviewLinks.snapshotProjectFile();
    if (!snap) return null;
    const buf = new Uint8Array(await snap.blob.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
    return btoa(bin);
  });
  expect(modelB64, 'no model snapshot').toBeTruthy();
  const modelBytes = Buffer.from(modelB64!, 'base64');
  expect(modelBytes.subarray(0, 8).toString('latin1'), 'snapshot is not an .obsproj').toBe('OBSPROJ1');

  // ── 3. Host it on a plain static server (CORS open, as a static host would). ──
  const server = http.createServer((req, res) => {
    if ((req.url ?? '') !== '/model.obsproj') { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': modelBytes.length,
      'access-control-allow-origin': '*',
    });
    res.end(modelBytes);
  });
  await new Promise<void>((resolve) => server.listen(3109, '127.0.0.1', () => resolve()));
  const reviewUrl = 'http://127.0.0.1:3107/?review=http://127.0.0.1:3109/model.obsproj';
  const reviewerContext = await browser.newContext();
  const reviewer = await reviewerContext.newPage();
  const reviewerWatch = watch(reviewer);
  try {
    // ── 4. Reviewer: the link opens the model, view-only. ─────────────
    await reviewer.goto(reviewUrl);
    await expect(reviewer.locator('#obs-review-banner')).toBeVisible({ timeout: 120_000 });
    await expect(reviewer.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => elementIds(reviewer), { timeout: 60_000, message: 'review model did not load' })
      .toEqual([wallId]);
    await expect.poll(() => sceneIds(reviewer), { timeout: 60_000, message: 'review wall not in the scene' })
      .toEqual([wallId]);
    expect(await reviewer.evaluate(() => (window as any).__OBS_CTX__.features.reviewLinks.isReviewMode()),
      'review mode is not on').toBe(true);
    await expect(reviewer.locator('#obs-review-banner')).toContainText('Reviewing');
    await expect(reviewer.locator('#obs-review-banner')).toContainText('Review Demo');

    // ── 5. View-only is enforced at both choke points. ────────────────
    await reviewer.evaluate(() => (window as any).__OBS_CTX__.features.authoring.setAuthoringTool('wall'));
    expect(await reviewer.evaluate(() => (window as any).__OBS_CTX__.features.authoring.getActiveTool()),
      'wall tool activated in review mode').toBe('select');
    const refused = await reviewer.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
      start: [0, 0, 0], end: [0, 4, 0], elevation: 0, thickness: 0.2, height: 3,
    }));
    expect(refused, 'createElementByType created an element in review mode').toBeNull();
    expect(await elementIds(reviewer), 'model changed in review mode').toEqual([wallId]);
    await expect(reviewer.getByText('Review mode is view-only', { exact: false }).first())
      .toBeVisible({ timeout: 10_000 });

    // ── 6. Reviewer: select the wall, name themselves, create an issue. ──
    await reviewer.evaluate((id) => (window as any).__OBS_CTX__.features.authoring.setSelectedAuthored([id], 'replace'), wallId);
    await reviewer.locator('#obs-review-banner input').fill('Rita Reviewer');
    await reviewer.getByRole('button', { name: '＋ Add issue' }).click();
    await expect(reviewer.locator('#obs-review-banner')).toBeVisible();
    await expect(reviewer.getByRole('button', { name: '＋ New' })).toBeVisible({ timeout: 10_000 });
    await reviewer.getByRole('button', { name: '＋ New' }).click();
    await reviewer.getByPlaceholder('Issue title…').fill('Wall clashes with door swing');
    await reviewer.getByPlaceholder('Description (optional)…').fill('The door swing crosses the corridor.');
    await reviewer.getByRole('button', { name: '📷 Capture & Create' }).click();
    await expect(reviewer.getByText('Wall clashes with door swing')).toBeVisible({ timeout: 10_000 });
    await expect(reviewer.getByText('Rita Reviewer').first()).toBeVisible({ timeout: 10_000 });

    // ── 7. Reviewer: export the review as BCF; re-parse the download. ──
    const bcfDownloadPromise = reviewer.waitForEvent('download', { timeout: 60_000 });
    await reviewer.getByRole('button', { name: '⬇ Export review as BCF' }).click();
    const bcfDownload = await bcfDownloadPromise;
    const bcfPath = await bcfDownload.path();
    expect(bcfPath, 'no .bcfzip download').toBeTruthy();
    const zip = await JSZip.loadAsync(fs.readFileSync(bcfPath!));
    const markupNames = Object.keys(zip.files).filter((n) => n.endsWith('markup.bcf'));
    expect(markupNames, 'expected exactly one BCF topic').toHaveLength(1);
    const markup = await zip.file(markupNames[0])!.async('string');
    expect(markup, 'topic title missing from BCF').toContain('Wall clashes with door swing');
    expect(markup, 'reviewer author missing from BCF').toContain('Rita Reviewer');
    const viewpointNames = Object.keys(zip.files).filter((n) => n.endsWith('viewpoint.bcfv'));
    expect(viewpointNames, 'no viewpoint.bcfv in the BCF').toHaveLength(1);
    const viewpoint = await zip.file(viewpointNames[0])!.async('string');
    expect(viewpoint, 'no camera in the BCF viewpoint').toContain('PerspectiveCamera');
    expect(Object.keys(zip.files).some((n) => n.endsWith('snapshot.png')), 'no snapshot.png in the BCF').toBe(true);

    // ── 8. Author: import the returned BCF — the issue is back, with its viewpoint. ──
    await page.evaluate(() => (window as any).__OBS_CTX__.features.issuesPanel.toggle());
    await expect(page.getByRole('button', { name: '＋ New' })).toBeVisible({ timeout: 10_000 });
    await page.locator('input[type="file"][accept=".bcfzip,.zip,.bcf"]').setInputFiles(bcfPath!);
    await expect(page.getByText('Wall clashes with door swing')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Rita Reviewer').first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await reviewerContext.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  expect(authorWatch.errors, 'page errors on the author page').toEqual([]);
  const unexplainedAuthor = authorWatch.badUrls.filter((u) => !TELEMETRY.some((re) => re.test(u)));
  expect(unexplainedAuthor, 'failed requests on the author page that are not known telemetry').toEqual([]);
  expect(reviewerWatch.errors, 'page errors on the reviewer page').toEqual([]);
  const unexplainedReviewer = reviewerWatch.badUrls.filter((u) => !TELEMETRY.some((re) => re.test(u)));
  expect(unexplainedReviewer, 'failed requests on the reviewer page that are not known telemetry').toEqual([]);
});
