import { test, expect, type Page } from '@playwright/test';

/**
 * Manual-open crash recovery — issue #101 follow-up (rank 4).
 *
 * The boot step only recovers the auto-reopen target. A crash whose
 * marker was never triaged by boot (boot recovery failed and kept the
 * marker) must be replayed when the user opens that project manually:
 * `openProject` checks the marker for the project being opened and
 * replays the journal BEFORE loading the primary record — after the
 * load it would be too late (`loadProjectDoc` refuses a corrupt
 * primary outright, and a missing primary reads as "not found").
 * No marker for that project, no journal read: a clean open never
 * touches the journal.
 *
 * Three scenarios:
 *   1. primary record missing (crash between the journal append and
 *      the primary write) + untriaged marker → manual open replays
 *      the journal and the saved edits are back;
 *   2. primary record corrupt (schema v99) + untriaged marker →
 *      manual open replays instead of showing the "damaged" alert;
 *   3. journal ends in `delete` + marker → manual open refuses to
 *      resurrect the deleted project.
 *
 * The "untriaged marker" state is seeded post-boot on purpose: a boot
 * with a marker always triages it, so the only way a marker survives
 * into a manual open is a failed boot recovery — the marker + the
 * seeded primary state stand in for exactly that. The marker check,
 * the replay, the restore write and the open are all real. The open
 * itself runs through the app's own `openProject` (the same function
 * the project list calls), via the feature registry.
 *
 * Run: npx playwright test tests/e2e/recovery-manual-open.spec.ts --project=chromium
 * (Chromium only: the crash-marker/replay machinery is exercised here
 * without a renderer crash — the crash itself is covered by
 * recovery.spec.ts.)
 */

const stamp = (t0: number, m: string) => console.log(`[manual-open ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

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

async function idbDeleteProjectRecord(page: Page, projectId: string): Promise<void> {
  await page.evaluate((pid) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').delete(pid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), projectId);
}

async function idbCorruptPrimaryRecord(page: Page, projectId: string): Promise<void> {
  // SEEDED corruption: the live record keeps its bytes but claims a
  // schema version the app cannot read — loadProjectDoc refuses it.
  await page.evaluate((pid) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const get = store.get(pid);
      get.onsuccess = () => { store.put({ ...get.result, schemaVersion: 99 }); };
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
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

/** Seed an untriaged crash marker for a project (as a failed boot recovery would leave behind). */
async function seedCrashMarker(page: Page, projectId: string, projectName: string): Promise<void> {
  await page.evaluate(([pid, name]) => {
    localStorage.setItem('obs.session.unsaved', JSON.stringify({ projectId: pid, projectName: name, at: Date.now() }));
  }, [projectId, projectName]);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.session.unsaved')), { timeout: 15000 }).not.toBeNull();
}

/** Open through the app's own openProject (the same function the project list calls). */
async function openProject(page: Page, projectId: string): Promise<void> {
  await page.evaluate(async (pid) => { await (window as any).__OBS_CTX__?.features?.projects?.openProject?.(pid); }, projectId);
}

async function recoveryOutcome(page: Page): Promise<any> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('obs.recovery.last');
    return raw ? JSON.parse(raw) : null;
  });
}

async function primaryProject(page: Page): Promise<any> {
  const projects = await idbGetAll(page, 'projects');
  return projects[0] ?? null;
}

async function sceneElementCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const ctx: any = (window as any).__OBS_CTX__;
    ctx?.world?.scene?.three?.traverse?.((o: any) => { if (o?.userData?.elementId) seen.add(String(o.userData.elementId)); });
    return seen.size;
  });
}

test('manual open replays a never-triaged crash: missing primary, journal has the save', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Manual open test');
  await placeWall(page);
  await saveProject(page);
  let doc = await primaryProject(page);
  expect(doc?.elements?.length, 'wall must be saved before the crash state is seeded').toBe(1);
  stamp(t0, 'wall saved');

  // SEEDED crash-window state, post-boot: the journal holds the save,
  // the primary record is gone, and the crash marker was never triaged.
  await idbDeleteProjectRecord(page, projectId);
  expect(await primaryProject(page), 'primary record must be gone before the manual open').toBeNull();
  await seedCrashMarker(page, projectId, 'Manual open test');
  stamp(t0, 'crash state seeded');

  await openProject(page, projectId);
  stamp(t0, 'manual open done');
  const outcome = await recoveryOutcome(page);
  expect(outcome?.status).toBe('full');
  expect(outcome?.restoredFrom).toBe('journal');
  expect(outcome?.restored).toBe(true);
  expect(outcome?.appliedSeqs?.length).toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(() => localStorage.getItem('obs.session.unsaved')), 'the marker must be cleared once triaged').toBeNull();
  doc = await primaryProject(page);
  expect(doc?.elements?.length, 'the saved wall must be back in the primary store').toBe(1);
  expect(doc?.id).toBe(projectId);
  expect(await sceneElementCount(page), 'the recovered wall must be in the scene').toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'teardown done');
});

test('manual open replays when the primary record is corrupt instead of refusing it', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Corrupt primary test');
  await placeWall(page);
  await saveProject(page);
  let doc = await primaryProject(page);
  expect(doc?.elements?.length).toBe(1);

  // SEEDED corruption: the live record claims an unreadable schema
  // version, so loadProjectDoc would refuse it — unless the journal
  // replay runs first.
  await idbCorruptPrimaryRecord(page, projectId);
  await seedCrashMarker(page, projectId, 'Corrupt primary test');
  stamp(t0, 'corrupt primary + marker seeded');

  await openProject(page, projectId);
  stamp(t0, 'manual open done');
  const outcome = await recoveryOutcome(page);
  expect(outcome?.status).toBe('full');
  expect(outcome?.primaryState).toBe('corrupt');
  expect(outcome?.restoredFrom).toBe('journal');
  expect(outcome?.restored).toBe(true);
  doc = await primaryProject(page);
  expect(doc?.elements?.length, 'the journal state must have replaced the corrupt record').toBe(1);
  expect(doc?.schemaVersion, 'the restored record must be a readable schema version').not.toBe(99);
  expect(await sceneElementCount(page), 'the recovered wall must be in the scene').toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'teardown done');
});

test('manual open does not resurrect a project the journal says was deleted', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Deleted project test');
  await placeWall(page);
  await saveProject(page);
  expect((await primaryProject(page))?.elements?.length).toBe(1);

  // Delete through the app: the primary record goes, the checkpoints
  // go, and the journal records an intentional `delete`.
  await page.evaluate(async (pid) => { await (window as any).__OBS_CTX__?.features?.projects?.deleteProjectById?.(pid); }, projectId);
  await expect.poll(async () => primaryProject(page), { timeout: 30000 }).toBeNull();
  await seedCrashMarker(page, projectId, 'Deleted project test');
  stamp(t0, 'project deleted, marker seeded');

  await openProject(page, projectId);
  stamp(t0, 'manual open done');
  const outcome = await recoveryOutcome(page);
  expect(outcome?.status).toBe('deleted');
  expect(outcome?.suppressReopen).toBe(true);
  expect(outcome?.restored).toBe(false);
  expect(await primaryProject(page), 'no primary record may be resurrected').toBeNull();
  const current = await page.evaluate(() => (window as any).__OBS_CTX__?.features?.projects?.getCurrentProject?.() ?? null);
  expect(current, 'no project may be open after a refused open').toBeNull();
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'teardown done');
});
