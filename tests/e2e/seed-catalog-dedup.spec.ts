import { test, expect, type Page } from '@playwright/test';

/** Leave the welcome screen the way a user does (the 3D BIM Platform card); it covers the ribbon on first load. */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function familyCounts(page: Page): Promise<{ total: number; seed: number; seedNames: string[] }> {
  return page.evaluate(() => {
    const list = (window as any).__obsFamily?.list?.() ?? [];
    const seed = list.filter((f: any) => f.origin === 'seed-catalog');
    return { total: list.length, seed: seed.length, seedNames: seed.map((f: any) => f.name) };
  });
}

/**
 * Poll the family list until its size is stable across two reads 1.5 s
 * apart (the seed catalog loads asynchronously after boot). Returns the
 * stable counts.
 */
async function waitForStableCounts(page: Page): Promise<{ total: number; seed: number; seedNames: string[] }> {
  let prev = await familyCounts(page);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const cur = await familyCounts(page);
    if (cur.total === prev.total && cur.seed === prev.seed) return cur;
    prev = cur;
  }
  throw new Error(`family list never stabilised (last: ${JSON.stringify(prev)})`);
}

// new.family parity Item 1 — seed-catalog dedup.
//
// The loader used to re-add the whole seed catalog on every reload:
// `familyStore.create()` discards the catalog id, so the "already
// present" check could never match, and seed families are persisted —
// the service list grew 50 → 111 across one reload (found by the
// family-store-bridge spec run). This spec proves the fix in the real
// browser: load, count, reload, count again — the count must be
// identical, and the seed catalog must contain each family exactly once.
//
// Run: npx playwright test tests/e2e/seed-catalog-dedup.spec.ts --project=chromium

test('seed catalog does not grow across a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(
    () => (window as any).__obsFamily?.list?.().length > 60,
    undefined,
    { timeout: 30000 },
  );

  const first = await waitForStableCounts(page);
  // 57 catalog families (public/families/index.json) — each exactly once.
  expect(first.seed).toBe(57);
  expect(new Set(first.seedNames).size).toBe(57);
  expect(first.total).toBeGreaterThan(60);

  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await page.waitForFunction(
    () => (window as any).__obsFamily?.list?.().length > 60,
    undefined,
    { timeout: 30000 },
  );

  const second = await waitForStableCounts(page);
  expect(second.seed).toBe(57);
  expect(new Set(second.seedNames).size).toBe(57);
  // The regression: without the fix the second load was 50 → 111.
  expect(second.total).toBe(first.total);

  expect(errors, errors.join('\n')).toEqual([]);
});
