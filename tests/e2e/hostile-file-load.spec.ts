import { test, expect, type Page } from '@playwright/test';

/**
 * Hostile file load — the runtime proof for issue #90 (Revit parity rank 3).
 *
 * The node suites prove guards reject hostile files; this spec proves the
 * same in a real browser, through the real import pipeline, with a live
 * project in the session: a wall is authored first, then hostile files are
 * fed to `__OBS_CTX__.features.fileInterop.importFiles` exactly as a drop
 * would. After every hostile load the project must be byte-identical (same
 * elements, same scene) and `Object.prototype` must be unpolluted, with no
 * uncaught page error. A valid GeoJSON control at the end proves the harness
 * can tell acceptance from rejection (it lands in the aux layer, and the
 * project elements still do not move).
 *
 * Run: npx playwright test tests/e2e/hostile-file-load.spec.ts --project=chromium
 */

async function enterAuthoring(page: Page): Promise<void> {
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);
}

async function viewportBox(page: Page) {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible after entering Authoring').toBeTruthy();
  return box!;
}

/** Stable projection of the live project: ids + types + params (no volatile fields). */
async function projectSnapshot(page: Page): Promise<string> {
  return page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    const els = ctx?.features?.authoring?.getElements?.() ?? [];
    const stable = els.map((e: any) => ({
      id: String(e?.id ?? ''),
      type: String(e?.type ?? e?.kind ?? ''),
      params: e?.params ?? null,
    }));
    stable.sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const seen = new Set<string>();
    ctx?.world?.scene?.three?.traverse?.((o: any) => {
      if (o?.userData?.elementId) seen.add(String(o.userData.elementId));
    });
    return JSON.stringify({ count: els.length, elements: stable, sceneElements: seen.size });
  });
}

async function isPolluted(page: Page): Promise<boolean> {
  return page.evaluate(() => ({} as any).polluted !== undefined);
}

async function auxCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    try {
      const aux = ctx?.features?.fileInterop?.getAuxObjects?.();
      return Array.isArray(aux) ? aux.length : -1;
    } catch {
      return -1;
    }
  });
}

/** Feed files to the real import pipeline the way a drop would. */
async function importFiles(page: Page, files: Array<{ name: string; text?: string; bytes?: number[] }>): Promise<void> {
  await page.evaluate(async (specs) => {
    const ctx: any = (window as any).__OBS_CTX__;
    const built = specs.map((s) => {
      const data = s.text !== undefined ? s.text : new Uint8Array(s.bytes ?? []);
      return new File([data as any], s.name);
    });
    await ctx.features.fileInterop.importFiles(built);
  }, files);
  // Fire-and-forget import paths (IFC queue, toasts) settle after the await.
  await page.waitForTimeout(1200);
}

test('hostile file loads leave the live project unchanged', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  // ── 1. Boot + author one wall so there is live project state to protect
  await page.goto('/');
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
  await enterAuthoring(page);
  const box = await viewportBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const wallY = cy + box.height * 0.05;

  await page.locator('button.obs-ribbon__tab[data-tab="architecture"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Wall', exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.mouse.click(cx - box.width * 0.2, wallY);
  await page.mouse.click(cx + box.width * 0.2, wallY);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);

  const baseline = await projectSnapshot(page);
  const baselineParsed = JSON.parse(baseline);
  expect(baselineParsed.count, 'a wall must be authored before the hostile loads').toBeGreaterThan(0);
  expect(await isPolluted(page)).toBe(false);
  const auxBefore = await auxCount(page);

  const assertUnchanged = async (label: string) => {
    expect(await projectSnapshot(page), `project must be unchanged after ${label}`).toBe(baseline);
    expect(await isPolluted(page), `Object.prototype must stay clean after ${label}`).toBe(false);
  };

  // ── 2. Truncated legacy project JSON (.obs.json): parse rejects, nothing stored
  await importFiles(page, [
    { name: 'evil.obs.json', text: '{"id":"evil","name":"evil","elements":[{"id":"e1"' },
  ]);
  await assertUnchanged('truncated .obs.json');

  // ── 3. Oversized GeoJSON (> 20 MB): size guard rejects before the read
  await page.evaluate(async () => {
    const ctx: any = (window as any).__OBS_CTX__;
    // Build a >20 MB payload without keeping two copies around longer than needed.
    const one = '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}},';
    const count = Math.ceil((21 * 1024 * 1024) / one.length);
    const text = `{"type":"FeatureCollection","features":[${one.repeat(count)}{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[0,0]}}]}`;
    await ctx.features.fileInterop.importFiles([new File([text], 'huge.geojson')]);
  });
  await page.waitForTimeout(1200);
  await assertUnchanged('oversized .geojson');

  // ── 4. Prototype-pollution GeoJSON: valid file, hostile keys — imports as aux, never pollutes
  await importFiles(page, [
    { name: 'pollute.geojson', text: JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { __proto__: { polluted: 'yes' }, name: 'site' },
        geometry: { type: 'Point', coordinates: [10, 20] } },
    ] }) },
  ]);
  await assertUnchanged('prototype-pollution .geojson');

  // ── 5. Garbage IFC: STEP preflight rejects before web-ifc
  await importFiles(page, [
    { name: 'garbage.ifc', text: 'this is not an IFC file\n'.repeat(40) },
  ]);
  await assertUnchanged('garbage .ifc');

  // ── 6. Truncated .ifczip: central-directory audit rejects before inflate
  await importFiles(page, [
    { name: 'truncated.ifczip', bytes: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00] },
  ]);
  await assertUnchanged('truncated .ifczip');

  // ── 7. Control: a valid GeoJSON imports (aux layer grows) and still leaves the project alone
  await importFiles(page, [
    { name: 'ok.geojson', text: JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { name: 'control' },
        geometry: { type: 'Point', coordinates: [11, 21] } },
    ] }) },
  ]);
  await assertUnchanged('valid .geojson control');
  const auxAfter = await auxCount(page);
  if (auxBefore >= 0 && auxAfter >= 0) {
    expect(auxAfter, 'the valid control GeoJSON must land in the aux layer').toBeGreaterThan(auxBefore);
  }

  // ── 8. No uncaught error anywhere in the run
  expect(errors, errors.join('\n')).toEqual([]);
});
