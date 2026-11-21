import { test, expect, type Page } from '@playwright/test';

/**
 * Model history / time-travel (differentiation item 7):
 *   author wall A → save → author wall B → save → save a named manual
 *   version → the timeline shows the versions with diffs → restore the
 *   wall-A-only version and the model is EXACTLY wall A (same id, scene
 *   included) → restore the newest version and both walls are back with
 *   their exact ids (restore is reversible) → an autosave tick on its own
 *   records a further version.
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

async function openTimeline(page: Page): Promise<void> {
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
  await palette.locator('input').fill('history');
  await expect(palette.getByText('History: model timeline', { exact: false }).first())
    .toBeVisible({ timeout: 10_000 });
  await palette.getByText('History: model timeline', { exact: false }).first().click();
  await expect(page.locator('#obs-model-timeline')).toBeVisible({ timeout: 10_000 });
}

test('model history: timeline, exact restore, reversible restore, autosave versions', async ({ page }) => {
  test.setTimeout(600_000);
  const w = watch(page);

  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.modelTimeline),
    { timeout: 60_000, message: 'model-timeline feature not wired' }).toBe(true);
  await page.evaluate(async () => {
    await (window as any).__OBS_CTX__.features.projects.createProject('History Demo');
  });

  // 1. Wall A, then save: the journal now holds the pre-save (empty) state.
  const wallA = await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [0, 0, 0], end: [4, 0, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  expect(wallA, 'authoring refused wall A').toBeTruthy();
  await save(page);

  // 2. Wall B, then save: the journal now holds the wall-A-only state too.
  const wallB = await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [0, 0, 0], end: [0, 4, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  expect(wallB, 'authoring refused wall B').toBeTruthy();
  await save(page);

  // 3. A named manual version of the two-wall state.
  await page.evaluate(() => (window as any).__OBS_CTX__.features.modelTimeline.saveVersion('Before the roof'));
  await expect.poll(() => page.evaluate(async () => {
    const s = await (window as any).__OBS_CTX__.features.modelTimeline.getTimelineState();
    return s?.versions?.filter((v: any) => v.label === 'Before the roof').length ?? 0;
  }), { timeout: 30_000, message: 'manual version did not appear' }).toBe(1);

  // 4. The timeline shows the versions with diffs.
  await openTimeline(page);
  const panel = page.locator('#obs-model-timeline');
  await expect(panel).toContainText('Current — live state');
  await expect(panel).toContainText('Before the roof');
  await expect(panel).toContainText('+1 element');
  const state = await page.evaluate(() => (window as any).__OBS_CTX__.features.modelTimeline.getTimelineState());
  console.log('TIMELINE ' + JSON.stringify(state.versions.map((v: any) => `${v.id}:${v.reason}:${v.elementCount}els:${v.diffFromPrevious}`)));
  expect(state.current.elementCount, 'current row should count both walls').toBe(2);
  const wallAVersion = state.versions.find((v: any) => v.elementCount === 1);
  expect(wallAVersion, 'no 1-element version (wall A only) in the timeline').toBeTruthy();

  // 5. Restore the wall-A-only version: the model must be EXACTLY wall A.
  await panel.locator(`[data-restore="${wallAVersion.id}"]`).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => elementIds(page), { timeout: 60_000, message: 'restore did not return wall A only' })
    .toEqual([wallA]);
  await expect.poll(() => sceneIds(page), { timeout: 60_000, message: 'scene after restore' }).toEqual([wallA]);

  // 6. Restore back: the newest version is the before-restore checkpoint
  //    (both walls) — restoring it proves a restore is itself reversible.
  const stateAfter = await page.evaluate(() => (window as any).__OBS_CTX__.features.modelTimeline.getTimelineState());
  const bothVersion = stateAfter.versions.find((v: any) => v.elementCount === 2);
  expect(bothVersion, 'no 2-element version after the first restore').toBeTruthy();
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.locator(`[data-restore="${bothVersion.id}"]`).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => elementIds(page), { timeout: 60_000, message: 're-restore did not return both walls' })
    .toEqual([wallA, wallB].sort());
  await expect.poll(() => sceneIds(page), { timeout: 60_000, message: 'scene after re-restore' })
    .toEqual([wallA, wallB].sort());

  // 7. Autosave records a version on its own: author wall C, save nothing,
  //    and a new version appears within two autosave ticks.
  const beforeCount = (await page.evaluate(() => (window as any).__OBS_CTX__.features.modelTimeline.getTimelineState())).versions.length;
  await page.evaluate(() => (window as any).__OBS_CTX__.features.authoring.createElementByType('wall', {
    start: [4, 0, 0], end: [4, 4, 0], elevation: 0, thickness: 0.2, height: 3,
  }));
  await expect.poll(async () => (await page.evaluate(() => (window as any).__OBS_CTX__.features.modelTimeline.getTimelineState())).versions.length,
    { timeout: 90_000, message: 'no autosave version appeared' }).toBeGreaterThan(beforeCount);

  expect(w.errors, 'page errors during the history run').toEqual([]);
  const unexplained = w.badUrls.filter((u) => !TELEMETRY.some((re) => re.test(u)));
  expect(unexplained, 'failed requests that are not known telemetry').toEqual([]);
});
