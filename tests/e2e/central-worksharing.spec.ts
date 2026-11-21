import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { openPaletteWith } from './palette';

/**
 * Central worksharing E2E — two REAL browser pages (two users) against a
 * REAL spawned collaboration server and the REAL production bundle.
 *
 * Alice draws a wall in the app; both pages join the same central room
 * through the binding; the wall materialises on Bob's page; an edit on
 * Alice propagates to Bob; Bob borrows the wall and Alice's property-palette
 * edit is refused with a toast naming Bob; Bob goes offline, edits, Alice
 * lands first, Bob reconnects and replays into a genuine merge conflict
 * (server value wins, both converge); Bob resolves it from the worksharing
 * panel and both pages converge on his value.
 *
 * The API server is spawned by this spec (ephemeral port + temp data dir);
 * the app under test is the vite preview bundle (see playwright.config.ts
 * webServer). The pages point at the spawned server via
 * `window.__OPENBIM_COLLAB_API__`, set before the app boots.
 *
 * Chromium only: this is a two-user timing-sensitive flow and the other
 * projects are advisory. Run: npx playwright test tests/e2e/central-worksharing.spec.ts --project=chromium
 */

const ROOM = 'e2e-central-1';
let server: ChildProcess | null = null;
let apiBase = '';
let dataDir = '';

function spawnApiServer(): Promise<{ port: number; base: string }> {
  return new Promise((resolve, reject) => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-central-e2e-'));
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const child = spawn(process.execPath, [path.join(repoRoot, 'server', 'index.mjs')], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: '0',
        HOST: '127.0.0.1',
        OBS_DATA_DIR: dataDir,
        OBS_RATE_MAX: '10000',
        OBS_RATE_MAX_MUTATION: '10000',
        // The app page (preview, usually :3000) is a different origin from
        // this ephemeral-port API server, so the browser enforces CORS.
        // The spawned server is throwaway (ephemeral port + temp data
        // dir), so allowing the local preview origins is the test's
        // affordance, not a product default.
        OBS_ALLOWED_ORIGINS: [
          'http://127.0.0.1:3000', 'http://localhost:3000',
          'http://127.0.0.1:3001', 'http://localhost:3001',
          'http://127.0.0.1:4173', 'http://localhost:4173',
          'http://127.0.0.1:5173', 'http://localhost:5173',
        ].join(','),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => reject(new Error('API server did not print PORT in 15s; out=' + out)), 15000);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
      const m = out.match(/PORT=(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), base: `http://127.0.0.1:${m[1]}/api` });
      }
    });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', reject);
    server = child;
  });
}

async function serverState(): Promise<any> {
  const r = await fetch(`${apiBase}/central/${ROOM}/state`);
  return r.json();
}

async function enterAuthoring(page: Page): Promise<void> {
  await page.goto('/');
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  // Boot on a loaded CI/VM can take ~30 s before the shell step renders the
  // home cards; the wait is a timeout, not an assertion about boot speed.
  await expect(card).toBeVisible({ timeout: 90000 });
  // A plain click waits for the element to be "stable", which the home
  // screen's re-renders defeat on a loaded machine. A real DOM click on
  // the resolved button fires the same handler; the assertions below
  // (home closes, ribbon visible) prove the click landed.
  await card.evaluate((el: HTMLElement) => el.click());
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.obs-ribbon')).toBeVisible({ timeout: 30000 });
}

async function drawWall(page: Page): Promise<void> {
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
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const wallY = cy + box!.height * 0.05;
  await page.locator('button.obs-ribbon__tab[data-tab="architecture"]').click();
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Wall', exact: true }).first().click();
  await page.waitForTimeout(700);
  await page.mouse.click(cx - box!.width * 0.2, wallY);
  await page.mouse.click(cx + box!.width * 0.2, wallY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
}

async function joinRoom(page: Page, name: string): Promise<void> {
  const ok = await page.evaluate(
    ({ room, user }) => (window as any).__OBS_CTX__.features.centralSync.join(room, user),
    { room: ROOM, user: name },
  );
  expect(ok, `${name} joins ${ROOM}`).toBe(true);
  await page.waitForFunction(
    (roomId) => (window as any).__OBS_CTX__?.features?.centralSync?.getStatus?.().roomId === roomId,
    ROOM,
    { timeout: 15000 },
  );
}

async function listWalls(page: Page): Promise<Array<{ id: string; type: string; name: string; params: any }>> {
  return page.evaluate(() =>
    (window as any).__OBS_CTX__.features.centralSync
      .listLocalElements()
      .filter((e: any) => e.type === 'wall'),
  );
}

async function wallHeight(page: Page): Promise<number | null> {
  const walls = await listWalls(page);
  return walls.length ? Number(walls[0].params.height) : null;
}

async function openWorksharingPanel(page: Page): Promise<void> {
  await openPaletteWith(page, 'Worksets');
  await page.getByText('Collaboration: Worksets & Central Model').first().click();
  await expect(page.locator('#obs-worksharing-modal')).toBeVisible({ timeout: 10000 });
}

test.describe('central worksharing (two users)', () => {
  // Two full app boots on one loaded VM can take minutes; the timeout is a
  // budget, not an assertion about speed.
  test.setTimeout(600000);

  test.beforeAll(async () => {
    const s = await spawnApiServer();
    apiBase = s.base;
    console.log('[central-e2e] API server on', apiBase, 'data dir', dataDir);
  });

  test.afterAll(async () => {
    try { server?.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('wall propagates, borrow refuses with a named reason, offline edit conflicts and resolves', async ({ browser }) => {
    const errorsA: string[] = [];
    const errorsB: string[] = [];
    const aliceCtx: BrowserContext = await browser.newContext();
    const bobCtx: BrowserContext = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();
    alice.on('pageerror', (e) => errorsA.push(e.message));
    bob.on('pageerror', (e) => errorsB.push(e.message));
    for (const p of [alice, bob]) {
      await p.addInitScript((base: string) => {
        (window as any).__OPENBIM_COLLAB_API__ = base;
      }, apiBase);
    }

    try {
      // ── 1. Alice draws a wall; both join the same central room ──
      await enterAuthoring(alice);
      await enterAuthoring(bob);
      await drawWall(alice);
      const aliceWalls = await listWalls(alice);
      expect(aliceWalls.length, 'Alice authored exactly one wall').toBe(1);
      const wallId = aliceWalls[0].id;
      const height0 = Number(aliceWalls[0].params.height);
      expect(height0, 'wall has a positive height').toBeGreaterThan(0);

      await joinRoom(alice, 'Alice');
      await joinRoom(bob, 'Bob');

      // ── 2. The wall materialises on Bob's page ──
      await bob.waitForFunction(
        () => (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.().some((e: any) => e.type === 'wall'),
        null,
        { timeout: 30000 },
      );
      const bobWalls = await listWalls(bob);
      expect(bobWalls.length, 'Bob materialised exactly one wall').toBe(1);
      expect(Number(bobWalls[0].params.height)).toBe(height0);
      expect(bobWalls[0].id, 'Bob minted a fresh local id for the remote wall').not.toBe(wallId);
      const st1 = await serverState();
      expect(st1.elements[wallId].fields.height).toBe(height0);

      // The worksharing panel shows the joined room on Bob's page.
      await openWorksharingPanel(bob);
      await expect(bob.locator('#obs-worksharing-modal', { hasText: ROOM })).toBeVisible();
      await expect(bob.locator('#obs-worksharing-modal', { hasText: 'Alice' })).toBeVisible();
      await bob.locator('#obs-ws-close-btn').click();

      // ── 3. Alice edits the height; Bob converges ──
      const editRes = await alice.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.authoring.applyElementParamChange(id, 'height', 3.3),
        { id: wallId },
      );
      expect(editRes.ok, 'Alice height edit applies: ' + JSON.stringify(editRes)).toBe(true);
      await bob.waitForFunction(
        (expected) => {
          const els = (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.() ?? [];
          const w = els.find((e: any) => e.type === 'wall');
          return w ? Number(w.params.height) === expected : false;
        },
        3.3,
        { timeout: 30000 },
      );
      expect(await wallHeight(bob)).toBe(3.3);

      // ── 4. Bob borrows the wall; Alice's palette edit is refused, naming Bob ──
      const bobWallId = (await listWalls(bob))[0].id;
      const borrowRes = await bob.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.centralSync.borrow(id),
        { id: bobWallId },
      );
      expect(borrowRes.ok, 'Bob borrows the wall: ' + JSON.stringify(borrowRes)).toBe(true);
      // Alice sees the borrow before editing.
      await alice.waitForFunction(
        () => Object.keys((window as any).__OBS_CTX__?.features?.centralSync?.getStatus?.().borrows ?? {}).length > 0,
        null,
        { timeout: 15000 },
      );
      // Drive the refusal through the real property-palette UI: select the
      // wall, edit its Height field, and the palette toasts the reason.
      await alice.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.authoring.selectAllAuthored([id]),
        { id: wallId },
      );
      await expect(alice.locator('#obs-property-palette')).toBeVisible({ timeout: 15000 });
      const heightInput = alice.locator('#obs-property-palette label', { hasText: /^Height/i }).locator('xpath=../div/input');
      await expect(heightInput.first()).toBeVisible({ timeout: 10000 });
      await heightInput.first().fill('3.9');
      await heightInput.first().press('Tab');
      await expect(
        alice.locator('.obs-toast-host .obs-toast', { hasText: 'Bob' }),
        'refusal toast names the borrower',
      ).toBeVisible({ timeout: 10000 });
      expect(await wallHeight(alice), 'refused edit leaves the height at 3.3').toBe(3.3);

      // Bob relinquishes; Alice's edit now succeeds.
      const relRes = await bob.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.centralSync.relinquish(id),
        { id: bobWallId },
      );
      expect(relRes.ok, 'Bob relinquishes: ' + JSON.stringify(relRes)).toBe(true);
      const editRes2 = await alice.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.authoring.applyElementParamChange(id, 'height', 3.4),
        { id: wallId },
      );
      expect(editRes2.ok, 'edit succeeds after relinquish: ' + JSON.stringify(editRes2)).toBe(true);
      await bob.waitForFunction(
        (expected) => {
          const els = (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.() ?? [];
          const w = els.find((e: any) => e.type === 'wall');
          return w ? Number(w.params.height) === expected : false;
        },
        3.4,
        { timeout: 30000 },
      );

      // ── 5. Genuine conflict: Bob edits offline, Alice lands first, Bob replays ──
      await bobCtx.setOffline(true);
      await bob.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.authoring.applyElementParamChange(id, 'height', 3.9),
        { id: bobWallId },
      );
      await bob.waitForTimeout(1500); // debounce + failed push -> queued offline op
      await alice.evaluate(
        ({ id }) => (window as any).__OBS_CTX__.features.authoring.applyElementParamChange(id, 'height', 3.3),
        { id: wallId },
      );
      await alice.waitForFunction(
        async ({ base, room }) => {
          const r = await fetch(`${base}/central/${room}/state`);
          const s = await r.json();
          return Object.values(s.elements).some((e: any) => e.fields?.height === 3.3);
        },
        { base: apiBase, room: ROOM },
        { timeout: 30000 },
      );
      await bobCtx.setOffline(false);
      await bob.evaluate(() => (window as any).__OBS_CTX__.features.centralSync.syncNow());
      // The server kept Alice's 3.3; the conflict is open and both converge.
      await bob.waitForFunction(
        () => (window as any).__OBS_CTX__?.features?.centralSync?.getStatus?.().openConflictCount >= 1,
        null,
        { timeout: 30000 },
      );
      await bob.waitForFunction(
        (expected) => {
          const els = (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.() ?? [];
          const w = els.find((e: any) => e.type === 'wall');
          return w ? Number(w.params.height) === expected : false;
        },
        3.3,
        { timeout: 30000 },
      );
      expect(await wallHeight(alice)).toBe(3.3);
      const st2 = await serverState();
      expect(st2.openConflictCount).toBe(1);
      expect(st2.elements[wallId].fields.height).toBe(3.3);

      // ── 6. Bob resolves from the worksharing panel; both converge on 3.9 ──
      await openWorksharingPanel(bob);
      await expect(bob.locator('#obs-worksharing-modal', { hasText: 'Open merge conflicts' })).toBeVisible();
      await expect(bob.locator('#obs-worksharing-modal', { hasText: '3.9' })).toBeVisible();
      await bob.locator('.obs-central-resolve-btn[data-choice="mine"]').first().click();
      await bob.waitForFunction(
        (expected) => {
          const els = (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.() ?? [];
          const w = els.find((e: any) => e.type === 'wall');
          return w ? Number(w.params.height) === expected : false;
        },
        3.9,
        { timeout: 30000 },
      );
      await alice.waitForFunction(
        (expected) => {
          const els = (window as any).__OBS_CTX__?.features?.centralSync?.listLocalElements?.() ?? [];
          const w = els.find((e: any) => e.type === 'wall');
          return w ? Number(w.params.height) === expected : false;
        },
        3.9,
        { timeout: 30000 },
      );
      const st3 = await serverState();
      expect(st3.openConflictCount).toBe(0);
      expect(st3.elements[wallId].fields.height).toBe(3.9);

      expect(errorsA, 'Alice page errors: ' + errorsA.join('\n')).toEqual([]);
      expect(errorsB, 'Bob page errors: ' + errorsB.join('\n')).toEqual([]);
    } finally {
      await aliceCtx.close().catch(() => {});
      await bobCtx.close().catch(() => {});
    }
  });
});
