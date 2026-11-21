import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo is ESM ("type": "module"), so __dirname does not exist in specs.
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Browser IFC import timeout (Revit parity rank 2, #231 follow-up).
 *
 * Before this change the browser import raced the web-ifc conversion only
 * against user cancel: a conversion that ran past any legitimate time left
 * the import queue wedged on "converting…" forever. The watchdog
 * (src/modules/ifc-semantics/import-timeout.ts) now bounds every
 * conversion — stall (no progress) and total (size-scaled) — and the
 * timeout fails the task, frees the queue, and disposes the importer so
 * the next import starts fresh.
 *
 * The proof uses the real settings path and a real file: localStorage
 * `toc.ifc.settings.v1` sets a 3 s total bound, then the 17.9 MB
 * Duplex_MEP fixture is dropped in. At the measured ~1 s/MB conversion
 * rate that file needs far more than 3 s, so the timeout must fire — and
 * the queue must then accept the next file (a small one, which converts
 * inside the same 3 s bound). No mocks: the conversion, the timer, the
 * failure classification and the recovery are all production behaviour.
 *
 * Wall-clock note: the MEP file's pre-conversion STEP passes (interop
 * inventory + per-entity fidelity over 311k records) run before the
 * conversion and take a while on software GL, so the test allows 300 s.
 * The watchdog only arms at the conversion races — the synchronous
 * pre-passes cannot be interrupted by a timer (same single-threaded
 * limit as a WASM hang) — so the poll budget has to cover them.
 */

const MEP_POLL_MS = 240000;

const MEP_B64 = readFileSync(
  join(__dirname, '..', 'fixtures', 'ifc-corpus', 'third-party', 'duplex-mep.ifc'),
).toString('base64');
const SMALL_IFC = readFileSync(
  join(__dirname, '..', 'fixtures', 'ifc-corpus', 'generated-small.ifc'),
  'utf8',
);

async function enterPlatform(page: Page): Promise<void> {
  // The hero click can time out when the renderer is starved (loaded VM,
  // software GL): the element is visible and stable but the click cannot
  // be processed in 30 s — and a click that lands as the overlay unmounts
  // can time out in Playwright even though entry succeeded. So: try the
  // click (60 s), and on failure proceed if the overlay is already gone;
  // otherwise wait, retry once, then fail honestly.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.locator('#obs-hero-3d').click({ timeout: 60000 });
      break;
    } catch (e) {
      if ((await page.locator('.obs-home.is-open').count()) === 0) break;
      if (attempt === 1) throw e;
      await page.waitForTimeout(5000);
    }
  }
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0, { timeout: 15000 });
}

async function dropFile(page: Page, name: string, bytes: Uint8Array, type = 'application/octet-stream'): Promise<void> {
  await page.evaluate(
    ({ name, b64, type }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const host = (window as any).__OBS_CTX__.rightHost as HTMLElement;
      const dt = new DataTransfer();
      dt.items.add(new File([arr], name, { type }));
      host.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    { name, b64: Buffer.from(bytes).toString('base64'), type },
  );
}

const phases = (page: Page) =>
  page.evaluate(() => (window as any).__OBS_CTX__?.features?.importer?.lastImportPhases?.() ?? []);

/** Poll for a phase record for `file`; false after `budgetMs` with no record. */
async function waitForPhase(page: Page, file: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const rs: any[] = await phases(page);
    if (rs.some((r) => r.file === file)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(2000);
  }
}

/** Poll until at least `minCount` phase records exist for `file`. */
async function waitForPhaseCount(page: Page, file: string, minCount: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const rs: any[] = await phases(page);
    if (rs.filter((r) => r.file === file).length >= minCount) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(2000);
  }
}

/** Failure diagnostic: what the import log shows, so a timeout says where it stuck. */
async function phaseDump(page: Page, file: string): Promise<string> {
  const dump = await page.evaluate(() => {
    const ctx = (window as any).__OBS_CTX__;
    return {
      phases: ctx?.features?.importer?.lastImportPhases?.() ?? [],
      fragments: ctx?.fragments?.list?.size ?? null,
    };
  });
  return (
    `no phase record for ${file} — import log: ` +
    JSON.stringify(dump.phases) +
    `, fragments: ${dump.fragments}`
  );
}

test('IFC import times out instead of wedging the queue, then the queue recovers', async ({ page }) => {
  // Budgets are generous because this VM is slow (SwiftShader, shared
  // CPUs, sibling workers): the polls return as soon as the condition is
  // true, so a longer budget costs nothing on a fast machine. The 600 s
  // test budget fits entry + the MEP poll (240 s) + two small attempts.
  test.setTimeout(600000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Tiny total bound through the real settings path, applied before the
  // app module reads its settings (importTotalTimeoutMs: 3000 ms).
  await page.addInitScript(() => {
    localStorage.setItem('toc.ifc.settings.v1', JSON.stringify({ importTotalTimeoutMs: 3000 }));
  });
  await page.goto('/');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30000 });
  await enterPlatform(page);
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__?.fragments), { timeout: 30000 }).toBe(true);

  // 1. Drop the 17.9 MB real-world MEP file: conversion must time out.
  // The poll budget has to cover the synchronous pre-conversion STEP
  // passes (311k records) before the conversion race arms the watchdog.
  await dropFile(page, 'duplex-mep.ifc', Buffer.from(MEP_B64, 'base64'));
  const mepDone = await waitForPhase(page, 'duplex-mep.ifc', MEP_POLL_MS);
  expect(mepDone, await phaseDump(page, 'duplex-mep.ifc')).toBeTruthy();
  const timedOut = (await phases(page)).find((r: any) => r.file === 'duplex-mep.ifc');
  expect(timedOut).toBeTruthy();
  expect(timedOut.timedOut).toBe(true);
  expect(timedOut.convertMs).toBeGreaterThanOrEqual(2000);
  // Nothing was loaded: the timed-out conversion left no model behind.
  await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 10000 }).toBe(0);

  // 2. The queue is not wedged: a small file imports fine under the same 3 s bound.
  // After a timed-out 17.9 MB import the renderer is still cleaning up
  // (WASM re-init after disposeImporter, GC of the 311k-record passes),
  // so the first small attempt can itself hit the 3 s bound on a loaded
  // VM even though the file converts in under a second when warm — the
  // queue still processed it (terminal phase record, queue drained), it
  // was just slow. Retry once: the assertion stays strong (the file must
  // actually load), the retry only tolerates that transient slowness.
  // The second attempt waits for a SECOND phase record for the file,
  // because the first attempt's record is already in the log.
  let smallLoaded = false;
  for (let attempt = 1; attempt <= 2 && !smallLoaded; attempt++) {
    const before = (await phases(page)).filter((r: any) => r.file === 'generated-small.ifc').length;
    await dropFile(page, 'generated-small.ifc', new TextEncoder().encode(SMALL_IFC));
    const gotRecord = await waitForPhaseCount(page, 'generated-small.ifc', before + 1, 120000);
    expect(gotRecord, await phaseDump(page, 'generated-small.ifc')).toBeTruthy();
    const rec = (await phases(page)).filter((r: any) => r.file === 'generated-small.ifc').at(-1);
    expect(rec).toBeTruthy();
    if (rec.timedOut) {
      console.log(`small attempt ${attempt} timed out (convertMs ${rec.convertMs}) — retrying`);
      continue;
    }
    await expect.poll(() => page.evaluate(() => (window as any).__OBS_CTX__.fragments.list.size), { timeout: 60000 }).toBeGreaterThanOrEqual(1);
    smallLoaded = true;
  }
  expect(smallLoaded, 'small IFC never loaded after the timeout (2 attempts)').toBe(true);
  const small = (await phases(page)).filter((r: any) => r.file === 'generated-small.ifc').at(-1);
  expect(small).toBeTruthy();
  expect(small.timedOut).toBeFalsy();
  expect(small).toBeTruthy();
  expect(small.timedOut).toBeFalsy();

  expect(errors, errors.join('\n')).toEqual([]);
});
