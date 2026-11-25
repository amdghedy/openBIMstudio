import { test, expect, type Page } from '@playwright/test';

async function enterPlatform(page: Page): Promise<void> {
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function stableCount(page: Page): Promise<number> {
  let prev = -1;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => (window as any).__obsFamily?.list?.().length ?? 0);
    if (n === prev && n > 0) return n;
    prev = n;
  }
  throw new Error('family list never settled');
}

// A browser whose storage is full of old catalog copies (an older build saved the
// whole 57-family catalog on every reload, about 100 KB each time) must still save
// the user's own families, keep other projects' saved families, and clean itself up.
test('full browser storage of old catalog copies still saves the user\'s own families', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  const base = await stableCount(page);

  const setup = await page.evaluate(async () => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('obs.families.v1.')) ?? 'obs.families.v1.global';
    const idx: any[] = await (await fetch('/families/index.json')).json();
    const defs: any[] = [];
    for (const e of idx) {
      const f = await (await fetch('/families/' + e.path)).json();
      defs.push({ id: f.id, name: f.name, category: f.category, ifcEntity: f.ifcEntity, sourceElementType: f.sourceElementType, group: f.group, parameters: f.parameters, geometry: f.geometry, types: f.types, schemaVersion: f.schemaVersion, builtIn: false });
    }
    // Old builds: every boot added the catalog again under random ids, no origin stamp.
    const stored: any[] = [];
    for (let copy = 0; copy < 12; copy++) for (const d of defs) stored.push({ ...d, id: 'legacy-' + copy + '-' + d.id });
    stored.push({ ...defs[0], id: 'user-cab-1', name: 'My own cabinet', parameters: defs[0].parameters });
    localStorage.setItem(key, JSON.stringify(stored));
    localStorage.setItem('obs.families.v1.other-project', JSON.stringify([{ ...defs[1], id: 'other-1', name: 'Other project family' }]));
    // Fill the rest of the 5 MB so a full write cannot fit.
    const chunk = 'x'.repeat(100 * 1024);
    for (let i = 0; i < 200; i++) { try { localStorage.setItem('filler-' + i, chunk); } catch { break; } }
    return { key, size: (localStorage.getItem(key) ?? '').length };
  });
  expect(setup.size).toBeGreaterThan(1_000_000);

  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await stableCount(page);

  // Make a family the user would make, while storage is still full of filler.
  await page.evaluate(() => {
    const s = (window as any).__obsFamily;
    const base = s.list().find((f: any) => f.id === 'user-cab-1');
    s.create({ name: 'Made after the reload', category: base.category, ifcEntity: base.ifcEntity, parameters: base.parameters, geometry: base.geometry, types: base.types });
  });
  await page.waitForTimeout(500);

  const after = await page.evaluate((key) => {
    const arr = JSON.parse(localStorage.getItem(key) ?? '[]');
    return {
      names: arr.map((f: any) => f.name),
      seedStored: arr.filter((f: any) => f.origin === 'seed-catalog').length,
      size: (localStorage.getItem(key) ?? '').length,
      otherKept: !!localStorage.getItem('obs.families.v1.other-project'),
    };
  }, setup.key);
  expect(after.names).toContain('My own cabinet');
  expect(after.names).toContain('Made after the reload');
  expect(after.seedStored).toBe(0);
  expect(after.size).toBeLessThan(100_000);
  expect(after.otherKept).toBe(true);

  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await stableCount(page);
  const names = await page.evaluate(() => (window as any).__obsFamily.list().map((f: any) => f.name));
  expect(names).toContain('My own cabinet');
  expect(names).toContain('Made after the reload');
  expect(names.filter((n: string) => n === 'Single Flush Door').length).toBe(1);
  expect(base).toBeGreaterThan(50);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('when browser storage is truly full the user is told, and nothing is deleted', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await stableCount(page);
  await page.evaluate(() => {
    localStorage.setItem('obs.families.v1.other-project', JSON.stringify([{ id: 'other-1', name: 'Other project family' }]));
    // Fill every last byte.
    for (const size of [512 * 1024, 64 * 1024, 4096, 256, 16, 1]) {
      for (let i = 0; i < 400; i++) { try { localStorage.setItem(`fill-${size}-${i}`, 'x'.repeat(size)); } catch { break; } }
    }
  });
  await page.evaluate(() => {
    const s = (window as any).__obsFamily;
    const f = s.list()[0];
    s.create({ name: 'Cannot be saved here', category: f.category, ifcEntity: f.ifcEntity, parameters: f.parameters, geometry: f.geometry, types: f.types });
  });
  await expect(page.getByText(/Browser storage is full/)).toBeVisible({ timeout: 10000 });
  // It stays on screen long enough to read (a zero timeout made it flash away).
  await page.waitForTimeout(4000);
  await expect(page.getByText(/Browser storage is full/)).toBeVisible();
  // The family is still in memory, and no other project's saved families were removed.
  const r = await page.evaluate(() => ({
    inMemory: (window as any).__obsFamily.list().some((f: any) => f.name === 'Cannot be saved here'),
    other: !!localStorage.getItem('obs.families.v1.other-project'),
  }));
  expect(r.inMemory).toBe(true);
  expect(r.other).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
