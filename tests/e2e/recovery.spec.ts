import { test, expect, type Page } from '@playwright/test';

/**
 * Automatic journal replay — issue #101.
 *
 * Proves the real application flow, not a helper: a project is created
 * and edited in the UI, the renderer is genuinely crashed (CDP
 * Page.crash — no beforeunload, no visibilitychange, no cleanup), and a
 * fresh boot must replay the operation journal into the primary store
 * and say honestly what it recovered.
 *
 * Five scenarios:
 *   1. crash mid-edit (journal ahead of the primary store) → banner +
 *      the saved edits are back;
 *   2. crash with a corrupt journal tail → recovery up to the last good
 *      entry, the tail quarantined, and the banner says so;
 *   3. clean boot → no replay, no banner;
 *   4. replay is idempotent — two crash-recovery cycles, same state;
 *   5. journal absent → recovery still works from the last saved
 *      primary record, with no replay claimed.
 *
 * The "journal ahead" state in (1)/(2) is produced by deleting the
 * primary `projects` record after a real save. That is exactly the state
 * a crash leaves when it lands between the journal append and the
 * primary write: `putProject()` appends the journal entry FIRST and
 * only then writes the primary record. The window itself is
 * microseconds wide and cannot be hit by timing a real crash, so the
 * test stands in for it deterministically; the crash, the boot, the
 * replay and the banner are all real. The seeded states are labelled
 * as such in each test.
 *
 * Run: npx playwright test tests/e2e/recovery.spec.ts --project=chromium
 * (Chromium only: Page.crash is a CDP feature.)
 */

const stamp = (t0: number, m: string) => console.log(`[recovery ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

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

async function idbClearJournal(page: Page, projectId: string): Promise<void> {
  await page.evaluate((pid) => new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['projectOps', 'projectOperationSnapshots'], 'readwrite');
      for (const store of ['projectOps', 'projectOperationSnapshots'] as const) {
        const keys = tx.objectStore(store).index('projectId').getAllKeys(pid);
        keys.onsuccess = () => { for (const k of keys.result) tx.objectStore(store).delete(k); };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), projectId);
}

async function idbCorruptLastOp(page: Page, projectId: string): Promise<number> {
  return page.evaluate((pid) => new Promise<number>((resolve, reject) => {
    const req = indexedDB.open('open-bim-studio');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('projectOps', 'readwrite');
      const store = tx.objectStore('projectOps');
      const all = store.index('projectId').getAll(pid);
      let lastSeq = -1;
      all.onsuccess = () => {
        const ops = [...(all.result as any[])].sort((a, b) => a.seq - b.seq);
        const last = ops[ops.length - 1];
        lastSeq = last.seq;
        store.put({ ...last, payload: null }); // torn entry: replace-state with no document
      };
      all.onerror = () => reject(all.error);
      tx.oncomplete = () => resolve(lastSeq); // resolve only after the corrupt write commits
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

/** Mark the open document dirty through the app's own API (what any edit
 *  does) and wait for the eager crash marker. Used instead of placing a
 *  second wall for dirtiness: a wall placement takes seconds, and the
 *  25 s autosave tick can save it and clear the marker before the crash. */
async function makeDirty(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__OBS_CTX__?.features?.projects?.markDirty?.(); });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.session.unsaved')), { timeout: 15000 }).not.toBeNull();
}

/** Genuine renderer crash: no beforeunload, no cleanup handlers run. */
async function crashRenderer(page: Page): Promise<void> {
  const crashed = new Promise<void>((resolve) => page.once('crash', () => resolve()));
  const cdp = await page.context().newCDPSession(page);
  void cdp.send('Page.crash').catch(() => { /* target died mid-send: expected */ });
  await Promise.race([crashed, page.waitForTimeout(10000)]);
}

/**
 * Reboot after a genuine crash, the way a user relaunches the browser:
 * a NEW page in the SAME browser context, so the same profile (and its
 * IndexedDB) is read back. A fresh context from storageState does NOT
 * carry IndexedDB in this Playwright setup — a reboot there sees an
 * empty journal and an empty project list, which is a test artefact,
 * not a recovery result. (Verified by probe: same-context reboot keeps
 * the journal; storageState reboot does not.)
 */
async function rebootAfterCrash(crashedPage: Page): Promise<Page> {
  const page = await crashedPage.context().newPage();
  // The outcome key survives across reboots in the same context, so a
  // previous cycle's outcome would make the poll below return
  // immediately — before THIS boot's recovery step has run — and the
  // banner would still say "Checking…" (the idempotency scenario's
  // second cycle failed exactly this way). Clear the stale value on
  // navigation so the poll waits for the fresh outcome. The try/catch
  // covers about:blank, which has no storage.
  await page.addInitScript(() => { try { localStorage.removeItem('obs.recovery.last'); } catch { /* no storage on about:blank */ } });
  await boot(page);
  // The crash-recovery step runs near the END of boot (after every setup
  // step), long after the canvas is visible — wait for it to record its
  // outcome before reading any state.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('obs.recovery.last')), { timeout: 60000 }).not.toBeNull();
  return page;
}

/** Bounded teardown for a crashed context (closing it can hang the runner). */
async function closeCrashedContext(crashedPage: Page): Promise<void> {
  await Promise.race([
    crashedPage.context().close().catch(() => {}),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
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

test('crash mid-edit: banner appears and the saved edits are back', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Recovery test');
  stamp(t0, 'project created');
  await placeWall(page);
  await saveProject(page);
  let doc = await primaryProject(page);
  expect(doc?.elements?.length, 'wall must be saved before the crash').toBe(1);
  stamp(t0, 'wall saved');

  // SEEDED crash-window state: the journal holds the save, the primary
  // record is gone — exactly what a crash between the journal append
  // and the primary write leaves behind.
  await idbDeleteProjectRecord(page, projectId);
  expect(await primaryProject(page), 'primary record must be gone before the crash').toBeNull();
  // A real crash in that window leaves the crash marker behind: the
  // marker is written when the document first goes dirty and cleared
  // only when the save completes. The clean save above cleared it, so
  // go dirty again before crashing.
  await makeDirty(page);
  await crashRenderer(page);
  stamp(t0, 'renderer crashed');

  const page2 = await rebootAfterCrash(page);
  stamp(t0, 'fresh boot, canvas visible');
  const banner = page2.locator('#obs-recovery-banner');
  await expect(banner).toBeVisible({ timeout: 60000 });
  await expect(banner).toContainText('Previous session ended without a clean save');
  await expect(banner).toContainText('Journal replay recovered');
  expect(await banner.getAttribute('data-recovery-status'), 'banner must report full recovery').toBe('full');
  stamp(t0, 'banner visible, full recovery reported');
  const outcome = await recoveryOutcome(page2);
  expect(outcome?.status).toBe('full');
  expect(outcome?.restoredFrom).toBe('journal');
  expect(outcome?.restored).toBe(true);
  expect(outcome?.appliedSeqs?.length).toBeGreaterThanOrEqual(1);
  doc = await primaryProject(page2);
  expect(doc?.elements?.length, 'the saved wall must be back in the primary store').toBe(1);
  expect(doc?.id).toBe(projectId);
  // The project was auto-reopened through the normal pipeline.
  await expect(page2.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 30000 });
  expect(errors, errors.join('\n')).toEqual([]);
  await closeCrashedContext(page);
  stamp(t0, 'teardown done');
});

test('crash with a corrupt journal tail: recovers up to the last good entry and says so', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Corrupt tail test');
  await placeWall(page);
  await saveProject(page); // op 1: 1 wall
  await placeWall(page, 0.25); // a different row — the same coordinates twice would overlap the first wall
  await saveProject(page); // op 2: 2 walls
  let doc = await primaryProject(page);
  expect(doc?.elements?.length, 'two walls must be saved before the crash').toBe(2);
  const ops = await idbGetAll(page, 'projectOps');
  expect(ops.length).toBeGreaterThanOrEqual(2);
  stamp(t0, 'two walls saved');

  // SEEDED corruption: the last journal entry is torn (no document
  // payload), and the primary record is gone so recovery must come from
  // the journal alone.
  const corruptSeq = await idbCorruptLastOp(page, projectId);
  await idbDeleteProjectRecord(page, projectId);
  // Go dirty again so the crash leaves its marker (see test 1).
  await makeDirty(page);
  await crashRenderer(page);
  stamp(t0, 'renderer crashed');

  const page2 = await rebootAfterCrash(page);
  const banner = page2.locator('#obs-recovery-banner');
  await expect(banner).toBeVisible({ timeout: 60000 });
  // Text first: toContainText polls until the replay outcome has landed;
  // the data attributes below are only set by that same update.
  await expect(banner).toContainText('damaged');
  await expect(banner).toContainText('set aside');
  expect(await banner.getAttribute('data-recovery-status'), 'banner must NOT claim full recovery').toBe('partial');
  expect(await banner.getAttribute('data-quarantined-count')).toBe('1');
  stamp(t0, 'banner visible, partial recovery reported');
  const outcome = await recoveryOutcome(page2);
  expect(outcome?.status).toBe('partial');
  expect(outcome?.stoppedAtSeq).toBe(corruptSeq);
  expect(outcome?.stoppedReason).toMatch(/not a usable project document|no document payload/);
  expect(outcome?.quarantined?.map((q: any) => q.seq)).toEqual([corruptSeq]);
  expect(outcome?.restored).toBe(true);
  doc = await primaryProject(page2);
  expect(doc?.elements?.length, 'only the last good entry (1 wall) may be recovered').toBe(1);
  // The corrupt tail is quarantined as evidence — and gone from the live op store.
  const quarantine = (await idbGetAll(page2, 'projectJournalQuarantine')).filter((q: any) => q.projectId === projectId);
  expect(quarantine.length, 'one entry must be quarantined').toBe(1);
  expect(quarantine[0].seq).toBe(corruptSeq);
  const opsAfter = (await idbGetAll(page2, 'projectOps')).filter((o: any) => o.projectId === projectId);
  // The quarantined seq may be reused by recovery's own re-append (the
  // live max drops when the tail is removed), so what must hold is that
  // no TORN entry remains: every op at that seq now carries a valid doc.
  const atCorruptSeq = opsAfter.filter((o: any) => o.seq === corruptSeq);
  expect(atCorruptSeq.length, 'at most the recovery re-append may hold the freed seq').toBeLessThanOrEqual(1);
  for (const o of atCorruptSeq) {
    expect(o.payload && typeof o.payload === 'object' && Array.isArray(o.payload.elements), 'no torn entry may remain in the live op store').toBe(true);
  }
  expect(errors, errors.join('\n')).toEqual([]);
  await closeCrashedContext(page);
  stamp(t0, 'teardown done');
});

test('clean boot does not replay and shows no banner', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Clean boot test');
  await placeWall(page);
  await saveProject(page);
  let doc = await primaryProject(page);
  expect(doc?.elements?.length).toBe(1);
  // SEEDED journal-ahead state, but NO crash: the save is journaled and
  // the primary record is gone. A clean boot must leave this exactly
  // alone — replay runs only after a crash marker.
  await idbDeleteProjectRecord(page, projectId);
  expect(await page.evaluate(() => localStorage.getItem('obs.session.unsaved')), 'no crash marker on a clean boot').toBeNull();
  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#obs-recovery-banner')).toHaveCount(0);
  expect(await recoveryOutcome(page), 'no recovery outcome may be recorded on a clean boot').toBeNull();
  expect(await primaryProject(page), 'the primary record must still be absent — clean boot does not replay').toBeNull();
  expect(errors, errors.join('\n')).toEqual([]);
  stamp(t0, 'clean boot left the journal alone');
});

test('replay is idempotent: two crash-recovery cycles, same state', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'Idempotency test');
  await placeWall(page);
  await saveProject(page);
  await idbDeleteProjectRecord(page, projectId);
  // Go dirty again so the crash leaves its marker (see test 1).
  await makeDirty(page);
  await crashRenderer(page);
  const page2 = await rebootAfterCrash(page);
  const banner1 = page2.locator('#obs-recovery-banner');
  await expect(banner1).toBeVisible({ timeout: 60000 });
  await expect(banner1).toContainText('Journal replay recovered');
  expect(await banner1.getAttribute('data-recovery-status')).toBe('full');
  const docAfterFirst = await primaryProject(page2);
  expect(docAfterFirst?.elements?.length).toBe(1);
  const outcome1 = await recoveryOutcome(page2);
  expect(outcome1?.status).toBe('full');
  stamp(t0, 'first recovery done');

  // Second crash, with no new save in between: the doc is clean, so make
  // it dirty (an in-memory-only wall — it is NOT journaled and must be
  // lost) to leave a fresh crash marker, then crash again.
  page2.on('pageerror', (e) => errors.push(e.message));
  await placeWall(page2);
  await expect.poll(() => page2.evaluate(() => localStorage.getItem('obs.session.unsaved')), { timeout: 15000 }).not.toBeNull();
  await crashRenderer(page2);
  stamp(t0, 'second renderer crash');
  const page3 = await rebootAfterCrash(page2);
  const banner2 = page3.locator('#obs-recovery-banner');
  await expect(banner2).toBeVisible({ timeout: 60000 });
  await expect(banner2).toContainText('Journal replay recovered');
  expect(await banner2.getAttribute('data-recovery-status')).toBe('full');
  const docAfterSecond = await primaryProject(page3);
  expect(docAfterSecond?.elements?.length, 'the unsaved second wall must be lost; the recovered wall stays').toBe(1);
  expect(JSON.stringify(docAfterSecond), 'second replay must yield the identical document').toBe(JSON.stringify(docAfterFirst));
  const outcome2 = await recoveryOutcome(page3);
  expect(outcome2?.status).toBe('full');
  expect(errors, errors.join('\n')).toEqual([]);
  await closeCrashedContext(page);
  stamp(t0, 'teardown done');
});

test('recovery from the last saved record when the journal is absent still works', async ({ page }) => {
  test.setTimeout(600000);
  const t0 = Date.now();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);
  const projectId = await createProject(page, 'No journal test');
  await placeWall(page);
  await saveProject(page);
  let doc = await primaryProject(page);
  expect(doc?.elements?.length).toBe(1);
  // SEEDED journal-absent state: every journal entry for this project is
  // gone, but the last saved primary record remains.
  await idbClearJournal(page, projectId);
  expect((await idbGetAll(page, 'projectOps')).filter((o: any) => o.projectId === projectId)).toEqual([]);
  // Make it dirty (no new save) so the crash leaves a marker.
  await makeDirty(page);
  await crashRenderer(page);
  stamp(t0, 'renderer crashed');

  const page2 = await rebootAfterCrash(page);
  const banner = page2.locator('#obs-recovery-banner');
  await expect(banner).toBeVisible({ timeout: 60000 });
  await expect(banner).toContainText('No journal entries to replay');
  expect(await banner.getAttribute('data-recovery-status')).toBe('empty');
  const outcome = await recoveryOutcome(page2);
  expect(outcome?.status).toBe('empty');
  expect(outcome?.journalAbsent).toBe(true);
  expect(outcome?.restoredFrom).toBe('primary');
  expect(outcome?.restored).toBe(false);
  doc = await primaryProject(page2);
  expect(doc?.elements?.length, 'the last saved wall comes back from the primary record').toBe(1);
  expect(doc?.id).toBe(projectId);
  await expect(page2.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 30000 });
  expect(errors, errors.join('\n')).toEqual([]);
  await closeCrashedContext(page);
  stamp(t0, 'teardown done');
});
