import { test, expect, type Page } from '@playwright/test';

/**
 * G8 keyboard spec — Revit 2D keyboard conflicts (audit gap G8).
 *
 * Proves in the real app, with real key presses through the shortcut
 * registry (no test hooks driving the commands directly):
 *   TR trims/extends two selected crossing walls to their corner,
 *   TS starts truss placement (TR no longer does),
 *   CO/MI/AR/OF activate the copy/mirror/array/offset tools,
 *   SC switches the gizmo to scale mode,
 *   VG opens Visibility/Graphics, TL toggles thin lines,
 *   DI opens the plan view with the aligned-dimension tool armed.
 *
 * Fixture walls are created through the authoring API's own
 * history-wrapped createElementByType (the same path the draw tools use);
 * the keys under test are pressed like a user presses them.
 * Run: npx playwright test tests/e2e/g8-keyboard.spec.ts --project=chromium
 */

test('G8 keyboard: TR/TS/DI/CO/MI/AR/OF/SC/VG/TL work in the real app', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  const authoringCard = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(authoringCard).toBeVisible({ timeout: 30000 });
  await authoringCard.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });

  const authoring = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring ?? null);
  await expect.poll(async () => !!(await authoring()), { timeout: 30000 }).toBe(true);

  // The G8 keys live in bim-input-compatibility, which the critical-gaps
  // boot wires well after the authoring workspace is usable (~25 s on this
  // VM) — wait for its marker before pressing any key, or the presses land
  // before the bindings exist.
  await page.waitForFunction(() => !!(window as any).__obsBIMInput, undefined, { timeout: 180000 });

  const getActiveTool = () =>
    page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring?.getActiveTool?.() ?? null);
  const getWalls = () =>
    page.evaluate(() =>
      ((window as any).__OBS_CTX__?.features?.authoring?.getElements?.() ?? [])
        .filter((e: any) => e.type === 'wall')
        .map((e: any) => ({ id: e.id, start: e.params.start, end: e.params.end })),
    );
  const pressSeq = async (keys: string) => {
    for (const k of keys) await page.keyboard.press(k);
  };
  const backToSelect = async () => {
    if ((await getActiveTool()) && (await getActiveTool()) !== 'select') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  };

  // ── Fixture: two crossing walls (horizontal + vertical, meet at 0,0)
  const wallIds = await page.evaluate(async () => {
    const a = (window as any).__OBS_CTX__.features.authoring;
    const w1 = await a.createElementByType('wall', { start: [-4, 0], end: [4, 0] });
    const w2 = await a.createElementByType('wall', { start: [0, -3], end: [0, 3] });
    return [w1, w2];
  });
  expect(wallIds[0], 'wall 1 created').toBeTruthy();
  expect(wallIds[1], 'wall 2 created').toBeTruthy();
  const before = await getWalls();
  expect(before).toHaveLength(2);
  expect(before[0].start).toEqual([-4, 0]);
  expect(before[0].end).toEqual([4, 0]);
  expect(before[1].start).toEqual([0, -3]);
  expect(before[1].end).toEqual([0, 3]);

  // ── TR: Trim/Extend with exactly two walls selected
  await page.evaluate((ids: string[]) => {
    (window as any).__OBS_CTX__.features.authoring.setSelectedAuthored(ids);
  }, wallIds as string[]);
  const trimReady = await page.evaluate(() => {
    const cmd = (window as any).__obsBIMExperience?.commands?.get?.('modify.trimExtend');
    return cmd ? !!cmd.when?.() : false;
  });
  expect(trimReady, 'modify.trimExtend is enabled with two walls selected').toBe(true);
  await pressSeq('tr');
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.obs-toast')].some((t) =>
            (t.textContent || '').includes('Trim / Extend applied'),
          ),
        ),
      { timeout: 5000 },
    )
    .toBe(true);
  const after = await getWalls();
  expect(after).toHaveLength(2);
  // Both walls shorten so their nearer end meets at the crossing (0,0);
  // starts are untouched.
  for (const w of after) {
    expect(w.end[0]).toBeCloseTo(0, 6);
    expect(w.end[1]).toBeCloseTo(0, 6);
  }
  expect(after[0].start).toEqual([-4, 0]);
  expect(after[1].start).toEqual([0, -3]);

  // ── TS: Truss placement starts (TR no longer places a truss)
  await backToSelect();
  await pressSeq('ts');
  await expect.poll(getActiveTool, { timeout: 10000 }).toBe('truss');
  await backToSelect();

  // ── CO / MI / AR / OF: modify tools activate with a wall selected
  await page.evaluate((ids: string[]) => {
    (window as any).__OBS_CTX__.features.authoring.setSelectedAuthored([ids[0]]);
  }, wallIds as string[]);
  for (const [keys, tool] of [['co', 'copy'], ['mi', 'mirror'], ['ar', 'array'], ['of', 'offset']] as const) {
    await pressSeq(keys);
    await expect.poll(getActiveTool, { timeout: 10000 }).toBe(tool);
    await backToSelect();
  }

  // ── SC: scale gizmo mode
  await pressSeq('sc');
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window as any).__OBS_CTX__?.features?.gizmo?.getMode?.() ?? null),
      { timeout: 10000 },
    )
    .toBe('scale');

  // ── VG: Visibility/Graphics dialog opens
  await pressSeq('vg');
  const dialog = page.locator('.obs-bim-dialog');
  await expect(dialog).toBeVisible({ timeout: 10000 });
  await expect(dialog).toContainText('Visibility / Graphics');
  // The Close button carries a "×" glyph before its label, so match loosely.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toHaveCount(0);

  // ── TL: thin lines toggle on, then off again
  await pressSeq('tl');
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).__obsThinLines), { timeout: 10000 })
    .toBe(true);
  await pressSeq('tl');
  await expect
    .poll(async () => page.evaluate(() => !!(window as any).__obsThinLines), { timeout: 10000 })
    .toBe(false);

  // ── DI: plan view opens with the aligned-dimension tool armed (last:
  // the open plan captures bare letters into its command line)
  await pressSeq('di');
  await expect
    .poll(
      async () => page.evaluate(() => !!(window as any).__OBS_CTX__?.features?.planView?.isVisible?.()),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(page.getByText('Aligned: pick first model boundary')).toBeVisible({ timeout: 15000 });

  expect(errors.filter((e) => /pageerror/.test(e)), `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});
