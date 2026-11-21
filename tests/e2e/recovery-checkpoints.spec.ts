import { test, expect, type Page } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Corrupt recovery checkpoints — quarantine + last known-good (rank 4, #91/#101).
 *
 * A checkpoint whose stored document does not validate must be
 * quarantined — moved to the quarantine store with its raw record and
 * reason kept as evidence — never listed as restorable and never
 * written over the live document. The user is offered the newest
 * verified checkpoint (the last known-good), and the Recovery UI
 * names the quarantined checkpoints instead of silently dropping them.
 *
 * Two scenarios:
 *   1. listing quarantines a corrupt checkpoint: the good checkpoint
 *      stays listed (newest first), the corrupt one is set aside with
 *      its reason, and restoring the good one works — the current
 *      state is kept as a before-restore checkpoint first;
 *   2. restoring a corrupt checkpoint directly is refused: the live
 *      document is untouched, the checkpoint is quarantined, and the
 *      good checkpoint is still offered.
 *
 * The corrupt checkpoint is seeded directly into the `projectJournal`
 * store (a torn write stands in for the corruption); the listing, the
 * quarantine move, the UI and the restore are all real. The checkpoint
 * itself is produced by real saves: wall → save → second wall → save
 * snapshots the one-wall state as a `project-save` checkpoint.
 *
 * Run: npx playwright test tests/e2e/recovery-checkpoints.spec.ts --project=chromium
 */

const stamp = (t0: number, m: string) => console.log(`[checkpoints ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

/* ── IndexedDB access from the page (the app's own database) ─────────── */
async function idbGetAll(page: Page, store: string): Promise<any[]> {
  return page.evaluate(([storeName]) => new Promise<any[]>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(storeName, 'readonly');
      const get = tx.objectStore(storeName).getAll();
      get.onsuccess = () => resolve(Array.from(get.result ?? []));
      get.onerror = () => reject(get.error);
    };
    req.onerror = () => reject(req.error);
  }), [store]);
}

/** Seed a corrupt checkpoint (torn document) and return its journal id. */
async function idbSeedCorruptCheckpoint(page: Page, projectId: string): Promise<number> {
  return page.evaluate((pid) => new Promise<number>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('projectJournal', 'readwrite');
      const add = tx.objectStore('projectJournal').add({
        projectId: pid, createdAt: Date.now(), reason: 'project-save',
        doc: null, modelVersions: [], archivedModelIds: [], missingModelIds: [],
      });
      add.onsuccess = () => resolve(Number(add.result));
      add.onerror = () => reject(add.error);
    };
    req.onerror = () => reject(req.error);
  }), projectId);
}

/* ── app interaction ─────────────────────────────────────────────────── */
async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 60000 });
}

async function createProject(page: Page, name: string): Promise<string> {
  const authoringCard = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(authoringCard).toBeVisible({ timeout: 30000 });
  await authoringCard.click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);
  await page.keyboard.press('Control+n');
  const nameInput = page.locator('.obs-form-modal input[type="text"]').first();
  await expect(nameInput).toBeVisible({ timeout: 15000 });
  await nameInput.fill(name);
  await nameInput.press('Enter');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.projects.lastId')), { timeout: 30000 }).not.toBeNull();
  return (await page.evaluate(() => localStorage.getItem('obs.projects.lastId'))) as string;
}

async function placeWall(page: Page, yFrac = 0.05): Promise<void> {
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter((c) => c.offsetWidth > 200 && c.offsetHeight > 200);
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible').toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const wallY = cy + box!.height * yFrac;
  await page.locator('button.obs-ribbon__tab[data-tab="architecture"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Wall', exact: true }).first().click();
  await page.waitForTimeout(700);
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__?.features?.authoring?.getActiveTool?.() ?? null), { timeout: 15000 }).toBe('wall');
  const authoredCount = () => page.evaluate(() => {
    const seen = new Set<string>();
    const ctx: any = (window as any).__OBS_CTX__;
    ctx?.world?.scene?.three?.traverse?.((o: any) => { if (o?.userData?.elementId) seen.add(String(o.userData.elementId)); });
    return seen.size;
  });
  const before = await authoredCount();
  await page.mouse.click(cx - box!.width * 0.2, wallY);
  await page.mouse.click(cx + box!.width * 0.2, wallY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  await expect.poll(authoredCount, { timeout: 15000 }).toBeGreaterThan(before);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
}

/** Save through the app's own feature registry (the real saveProject). */
async function saveProject(page: Page): Promise<void> {
  const before = (await idbGetAll(page, 'projectOps')).length;
  await page.evaluate(async () => { await (window as any).__OBS_CTX__?.features?.projects?.saveProject?.(); });
  await expect.poll(async () => (await idbGetAll(page, 'projectOps')).length, { timeout: 30000 }).toBeGreaterThan(before);
}

async function listSnapshots(page: Page): Promise<{ snapshots: any[]; quarantined: any[] }> {
  return page.evaluate(async () => (window as any).__OBS_CTX__?.features?.projects?.listProjectRecoverySnapshots?.());
}

async function currentElementCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__OBS_CTX__?.features?.projects?.getCurrentProject?.()?.elements?.length ?? -1);
}

async function primaryProject(page: Page): Promise<any> {
  const projects = await idbGetAll(page, 'projects');
  return projects[0] ?? null;
}

/** Two walls, two saves: the second save snapshots the one-wall state as a checkpoint. */
async function twoWallsSaved(page: Page): Promise<string> {
  const projectId = await createProject(page, 'Checkpoint test');
  await placeWall(page);
  await saveProject(page);
  await placeWall(page, 0.25);
  await saveProject(page);
  await expect.poll(async () => (await listSnapshots(page)).snapshots.length, { timeout: 30000 }).toBe(1);
  const listed = await listSnapshots(page);
  expect(listed.snapshots[0].elementCount, 'the checkpoint must hold the one-wall state').toBe(1);
  expect(listed.quarantined).toEqual([]);
  return projectId;
}

test('corrupt checkpoint is quarantined on listing; the good one is offered and restores', async ({ page }) => {
  test.setTimeout(300000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await twoWallsSaved(page);
  expect(await currentElementCount(page), 'two walls must be live before the corrupt checkpoint is seeded').toBe(2);
  stamp(t0, 'two walls saved, one good checkpoint');

  // SEEDED corruption: a checkpoint whose document is torn.
  const corruptId = await idbSeedCorruptCheckpoint(page, projectId);
  stamp(t0, `corrupt checkpoint seeded (id ${corruptId})`);

  // Listing quarantines it: the good checkpoint stays, newest first.
  let listed = await listSnapshots(page);
  expect(listed.snapshots.length, 'the good checkpoint must still be listed').toBe(1);
  expect(listed.snapshots[0].elementCount).toBe(1);
  expect(listed.quarantined.length, 'the corrupt checkpoint must be reported, not dropped').toBe(1);
  expect(listed.quarantined[0].id).toBe(corruptId);
  expect(listed.quarantined[0].reason).toMatch(/no usable project document/);
  const journal = (await idbGetAll(page, 'projectJournal')).filter((r: any) => r.projectId === projectId);
  expect(journal.some((r: any) => r.id === corruptId), 'the corrupt record must be gone from the live journal').toBe(false);
  const quarantine = (await idbGetAll(page, 'projectJournalQuarantine')).filter((q: any) => q.projectId === projectId);
  expect(quarantine.length, 'one entry must be quarantined as evidence').toBe(1);
  expect(quarantine[0].kind).toBe('checkpoint');
  expect(quarantine[0].seq).toBe(corruptId);
  expect(quarantine[0].raw, 'the raw corrupt record must be kept').toBeTruthy();
  stamp(t0, 'listing quarantined the corrupt checkpoint');

  // The Recovery UI names the quarantined checkpoint and offers the good one.
  await openPaletteWith(page, 'Recovery checkpoints');
  await page.keyboard.press('Enter');
  const notice = page.locator('[data-quarantined-notice="1"]');
  await expect(notice, 'the UI must name the quarantined checkpoint').toBeVisible({ timeout: 30000 });
  await expect(notice).toContainText('damaged');
  await expect(notice).toContainText('set aside');
  await expect(page.locator('[data-quarantined-checkpoint]')).toHaveCount(1);
  await expect(page.getByText('1 element · 0 models').first(), 'the good checkpoint must be offered').toBeVisible();
  // The quarantined row has no Restore button: only the good row does.
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(1);
  stamp(t0, 'recovery UI shows the quarantine');

  // Restore the good checkpoint: the live doc rolls back to one wall,
  // and the two-wall state is kept as a before-restore checkpoint.
  await page.getByRole('button', { name: 'Restore' }).first().click();
  await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(async () => currentElementCount(page), { timeout: 60000 }).toBe(1);
  expect((await primaryProject(page))?.elements?.length, 'the primary record must hold the restored state').toBe(1);
  listed = await listSnapshots(page);
  expect(listed.snapshots.length, 'the before-restore checkpoint must join the original one').toBe(2);
  expect(listed.snapshots[0].elementCount, 'newest checkpoint is the kept two-wall state').toBe(2);
  expect(listed.snapshots[1].elementCount, 'the restored one-wall checkpoint is still there').toBe(1);
  expect(listed.quarantined.length, 'the quarantined checkpoint is still reported').toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'teardown done');
});

test('restoring a corrupt checkpoint is refused and the live document is untouched', async ({ page }) => {
  test.setTimeout(300000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await twoWallsSaved(page);
  expect(await currentElementCount(page)).toBe(2);

  // SEEDED corruption — and this time the restore is attempted BEFORE
  // any listing, so the refusal must come from the restore path itself.
  const corruptId = await idbSeedCorruptCheckpoint(page, projectId);
  stamp(t0, `corrupt checkpoint seeded (id ${corruptId})`);

  const result = await page.evaluate(async (id) => (window as any).__OBS_CTX__?.features?.projects?.restoreProjectRecoverySnapshot?.(id), corruptId);
  expect(result?.restored, 'a corrupt checkpoint must never restore').toBe(false);
  expect(result?.quarantined, 'the refusal must quarantine it').toBe(true);
  expect(result?.refusedReason).toMatch(/no usable project document/);
  stamp(t0, 'restore refused');
  expect(await currentElementCount(page), 'the live document must be untouched').toBe(2);
  expect((await primaryProject(page))?.elements?.length, 'the primary record must be untouched').toBe(2);
  const journal = (await idbGetAll(page, 'projectJournal')).filter((r: any) => r.projectId === projectId);
  expect(journal.some((r: any) => r.id === corruptId), 'the corrupt record must be gone from the live journal').toBe(false);
  const quarantine = (await idbGetAll(page, 'projectJournalQuarantine')).filter((q: any) => q.projectId === projectId);
  expect(quarantine.length).toBe(1);
  expect(quarantine[0].kind).toBe('checkpoint');
  expect(quarantine[0].raw, 'the raw corrupt record must be kept as evidence').toBeTruthy();
  const listed = await listSnapshots(page);
  expect(listed.snapshots.length, 'the good checkpoint must still be offered').toBe(1);
  expect(listed.snapshots[0].elementCount).toBe(1);
  expect(listed.quarantined.length).toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'teardown done');
});
