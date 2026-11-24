import { test, expect, type Page } from '@playwright/test';

/** Leave the welcome screen the way a user does (the 3D BIM Platform card); it covers the ribbon on first load. */
async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function familyCounts(page: Page): Promise<{ total: number; seed: number }> {
  return page.evaluate(() => {
    const list = (window as any).__obsFamily?.list?.() ?? [];
    return {
      total: list.length,
      seed: list.filter((f: any) => f.origin === 'seed-catalog').length,
    };
  });
}

/**
 * Poll the family list until its size is stable across two reads 1.5 s
 * apart (the seed catalog loads asynchronously after boot, one fetch per
 * family — a bare "> 60" wait can catch it mid-load).
 */
async function waitForStableCounts(page: Page): Promise<{ total: number; seed: number }> {
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

async function openGallery(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__obsFamilyGallery?.open());
  await expect(page.locator('#obs-family-gallery')).toBeVisible({ timeout: 15000 });
}

function cardNames(page: Page) {
  return page.locator('#obs-family-gallery [data-family-id]');
}

// new.family parity Phase 1, Item 1 — Family Gallery.
//
// The Gallery is a card grid over the REAL family store (seed catalog +
// built-ins + user families): search, group/category/hosting filters,
// sort, Show-more pagination, a Ready/Draft status badge and a
// local-only upvote per card. Cards open the family in the Family
// Browser. This spec proves it in the real browser: the grid shows the
// whole store (11 built-ins + 57 seed families on a fresh profile),
// filters narrow it, Show more pages it, an upvote toggles 0→1→0 and
// persists in localStorage, and opening a card lands in the Browser
// on that exact family.
//
// Run: npx playwright test tests/e2e/family-gallery.spec.ts --project=chromium

test('family gallery browses, filters, pages, upvotes and opens a family', async ({ page }) => {
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
  const { total, seed: seedTotal } = await waitForStableCounts(page);
  expect(seedTotal).toBe(57);
  expect(total).toBeGreaterThan(60);

  await openGallery(page);
  const gallery = page.locator('#obs-family-gallery');
  await expect(gallery.locator('text=Showing 12 of ' + total + ' families')).toBeVisible();
  await expect(cardNames(page)).toHaveCount(12);
  await expect(gallery.locator('text=from the seed catalog')).toBeVisible();

  // Search narrows to one family.
  await gallery.locator('input[aria-label="Search gallery"]').fill('Single Flush Door');
  await expect(cardNames(page)).toHaveCount(1);
  await expect(cardNames(page).first()).toContainText('Single Flush Door');
  await expect(gallery.locator('text=Showing 1 of 1 families')).toBeVisible();
  await gallery.locator('input[aria-label="Search gallery"]').fill('');

  // Group filter: Doors is 8 seed families.
  await gallery.locator('select[title="Filter by group"]').selectOption('Doors');
  await expect(cardNames(page)).toHaveCount(8);
  await expect(gallery.locator('text=Showing 8 of 8 families')).toBeVisible();

  // Hosting filter inside the group: doors are wall-hosted.
  await gallery.locator('select[title="Filter by hosting"]').selectOption('Unhosted');
  await expect(cardNames(page)).toHaveCount(0);
  await expect(gallery.locator('text=No families match these filters.')).toBeVisible();
  await gallery.locator('select[title="Filter by hosting"]').selectOption('all');
  await expect(cardNames(page)).toHaveCount(8);

  // Ready-only keeps the Doors (all Ready); sort by most types reorders.
  await gallery.locator('text=Ready only').click();
  await expect(cardNames(page)).toHaveCount(8);
  await gallery.locator('select[title="Sort gallery"]').selectOption('types');
  await expect(cardNames(page)).toHaveCount(8);

  // Back to the full store, Show more pages 12 → 24.
  await gallery.locator('select[title="Filter by group"]').selectOption('all');
  await gallery.locator('text=Ready only').click();
  await expect(cardNames(page)).toHaveCount(12);
  await gallery.locator('button', { hasText: 'Show more' }).click();
  await expect(cardNames(page)).toHaveCount(24);
  await expect(gallery.locator('text=Showing 24 of ' + total + ' families')).toBeVisible();

  // Upvote is local-only: 0 → 1 → 0, persisted under the gallery key.
  const firstCard = cardNames(page).first();
  const firstId = await firstCard.getAttribute('data-family-id');
  const upBtn = firstCard.locator('button', { hasText: '↑' });
  await expect(upBtn).toHaveText('↑ 0');
  await upBtn.click();
  await expect(upBtn).toHaveText('↑ 1');
  const stored = await page.evaluate(
    () => JSON.parse(window.localStorage.getItem('obs.gallery.upvotes.v1') ?? '[]'),
  );
  expect(stored).toContain(firstId);
  await upBtn.click();
  await expect(upBtn).toHaveText('↑ 0');

  // Opening a card lands in the Family Browser on that exact family.
  const firstName = await page.evaluate(
    (id) => (window as any).__obsFamily.get(id)?.name as string,
    firstId,
  );
  await firstCard.locator('button', { hasText: 'Open' }).click();
  await expect(page.locator('#obs-family-browser')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#obs-family-browser')).toContainText(firstName);

  expect(errors, errors.join('\n')).toEqual([]);
});
