// Snap race — two INSTANT canvas clicks must land at distinct snapped points.
//
// Regression test for the async snap race: the snap system updates its last
// result asynchronously on pointermove (updateSnapAsync in authoring.ts),
// while hover dispatch is throttled to one dispatch per frame
// (requestAnimationFrame in input-router.ts) and the click gesture is
// dispatched synchronously on pointerup. A second click that lands within
// the same frame as its preceding pointermove therefore reads the PREVIOUS
// hover's snap result and commits it — two instances co-locate at the
// first click's point. Observed in follow-up 7 (type-propagation.spec.ts):
// two instant clicks at different screen-x placed both instances at the
// same world point (-29.14, 29.14); the spec worked around it with a
// mouse.move + 700 ms settle before each placement click.
//
// This spec places two Generic Equipment instances with NO settle between
// the Place-button click and the canvas click, and asserts the two points
// are > 1 m apart — so a silent co-location fails loudly instead of
// passing vacuously. Pre-fix this fails (both instances share one point);
// post-fix it passes.
//
// Run: npx playwright test tests/e2e/snap-race.spec.ts --project=chromium

import { test, expect, type Page } from '@playwright/test';

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  // 90 s, not 30 s: on this VM (1.5 shared CPUs, SwiftShader software GL)
  // the app bundle can take 45 s+ before the home screen renders, so a
  // 30 s wait flakes on boot, not on the race. This wait is only about
  // boot; the race assertion below is unchanged.
  await expect(card).toBeVisible({ timeout: 90000 });
  await card.click();
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
}

/** Largest visible canvas = the 3D viewport (document-chain pattern). */
async function viewportBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible').toBeTruthy();
  return box!;
}

type Placed = { id: string; point: [number, number] | null };

/**
 * Place one Generic Equipment instance with an INSTANT canvas click: the
 * Place button is clicked and the canvas is clicked immediately, with no
 * mouse.move + settle in between. This is the fast-clicking-user path the
 * race bites on.
 */
async function placeInstant(
  page: Page,
  at: { x: number; y: number },
  excludeIds: string[],
): Promise<Placed> {
  await page.locator('#obs-param-family-panel [data-act="place"]').click();
  // Deliberately no settle here: the click must commit the point under
  // THIS pointer position, not the previous hover's snap.
  await page.mouse.click(at.x, at.y);
  const placed = await page.waitForFunction(
    (args: { exclude: string[] }) => {
      const els = (window as any).__obsAuthoring?.getElements?.() ?? [];
      return els.find((e: any) =>
        e.type === 'equipment' && e.familyId && e.params?.point && !args.exclude.includes(String(e.id)),
      ) ?? null;
    },
    { exclude: excludeIds },
    { timeout: 20000 },
  ).then((h) => h.evaluate((e: any) => ({
    id: String(e.id),
    point: [...e.params.point] as [number, number],
  } as Placed)));
  return placed;
}

test('two instant clicks place two instances at distinct points', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await enterAuthoring(page);
  const box = await viewportBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Open the Parametric Families panel and pick Generic Equipment
  // (freestanding / point-placed, the same family follow-up 7 used).
  await page.waitForFunction(
    () => !!(window as any).__obsParamFamilyPanel,
    undefined,
    { timeout: 90000 },
  );
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.open?.());
  await expect(page.locator('#obs-param-family-panel.is-open')).toBeVisible({ timeout: 15000 });
  const famId = await page.evaluate(() => {
    const sel = document.querySelector('#obs-param-family-panel [data-family]') as HTMLSelectElement | null;
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.textContent === 'Generic Equipment (equipment)');
    return opt ? opt.value : null;
  });
  expect(famId, 'Generic Equipment must be listed in the panel').toBeTruthy();
  await page.locator('#obs-param-family-panel [data-family]').selectOption(famId!);
  await page.waitForTimeout(400);

  // Two instant placements at points far apart in BOTH screen axes.
  const a = { x: cx - box.width * 0.20, y: cy - box.height * 0.10 };
  const b = { x: cx + box.width * 0.20, y: cy + box.height * 0.10 };
  const eq1 = await placeInstant(page, a, []);
  console.log('[snap-race] instance 1:', eq1.id, 'at', eq1.point);
  const eq2 = await placeInstant(page, b, [eq1.id]);
  console.log('[snap-race] instance 2:', eq2.id, 'at', eq2.point);

  expect(eq1.point, 'first instance must have a point').toBeTruthy();
  expect(eq2.point, 'second instance must have a point').toBeTruthy();
  expect(
    Math.hypot(eq1.point![0] - eq2.point![0], eq1.point![1] - eq2.point![1]),
    `the two instances must land at different points (got ${eq1.point} and ${eq2.point})`,
  ).toBeGreaterThan(1);

  expect(errors, errors.join('\n')).toEqual([]);
});
