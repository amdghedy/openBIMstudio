import fs from 'node:fs';
import { test, expect } from '@playwright/test';

/**
 * Document chain E2E — the "most critical check".
 *
 * Runs against the PRODUCTION bundle (vite preview, see playwright.config.ts
 * webServer): boot → Authoring workspace → Wall → Schedules baseline →
 * Door → Window → Schedules re-take → Section → Sheets. Authored steps are
 * real UI clicks (ribbon buttons, canvas clicks, keyboard); state is asserted
 * via window.__OBS_CTX__ feature registries and panel DOM.
 *
 * This spec exists because CI had no browser-level test of the authoring
 * chain: the dev-mode TDZ white screen (authoring↔drawing import cycle) and
 * the home-overlay ribbon blocker were both invisible to unit tests.
 */

test('document chain: wall → openings → schedules → section → sheets', async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  const getActiveTool = () =>
    page.evaluate(() => {
      const ctx: any = (window as any).__OBS_CTX__;
      return (ctx?.features?.authoring?.getActiveTool?.() ?? null) as string | null;
    });

  /** Click a ribbon tab by id, then a strip button by its visible label. */
  const gotoTab = async (tabId: string) => {
    await page.locator(`button.obs-ribbon__tab[data-tab="${tabId}"]`).click();
    await page.waitForTimeout(350);
  };
  const clickStripButton = async (label: string) => {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    await page.waitForTimeout(700);
  };
  /** Deactivate whatever modeling tool is active (Escape → Select). */
  const backToSelect = async () => {
    const t = await getActiveTool();
    if (t && t !== 'select') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  };

  const closeSchedules = () =>
    page.evaluate(() => {
      const ctx: any = (window as any).__OBS_CTX__;
      if (ctx?.features?.schedules?.isVisible?.()) ctx.features.schedules.toggle();
      return !ctx?.features?.schedules?.isVisible?.();
    });

  // ── 1. Boot: home screen renders with zero page errors (TDZ regression guard)
  await page.goto('/');
  const authoringCard = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await expect(authoringCard).toBeVisible({ timeout: 30000 });
  const bootFatal = errors.filter((e) => /before initialization|Cannot access/.test(e));
  expect(bootFatal, `boot TDZ errors: ${bootFatal.join('\n')}`).toEqual([]);
  await page.screenshot({ path: '/tmp/e2e-art/01-boot.png' });

  // ── 2. Enter Authoring workspace like a user; the home overlay must close
  await authoringCard.click();
  await page.waitForTimeout(1500);
  await expect(page.locator('.obs-home.is-open')).toHaveCount(0);

  // Largest visible canvas = the 3D viewport
  const box = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(
      (c) => c.offsetWidth > 200 && c.offsetHeight > 200,
    );
    cs.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight);
    if (!cs[0]) return null;
    const r = cs[0].getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(box, 'a large viewport canvas must be visible after entering Authoring').toBeTruthy();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  const wallY = cy + box!.height * 0.05;

  const authoredCount = () =>
    page.evaluate(() => {
      const seen = new Set<string>();
      const ctx: any = (window as any).__OBS_CTX__;
      ctx?.world?.scene?.three?.traverse?.((o: any) => {
        if (o?.userData?.elementId) seen.add(String(o.userData.elementId));
      });
      return seen.size;
    });

  /** Volume of the WALL row from the schedules table (type cell matches /wall/i). */
  const wallVolume = async (): Promise<{ value: number | null; headers: string[]; rows: string[] }> =>
    page.evaluate(() => {
      const t = document.querySelector('.obs-schedules-overlay table');
      if (!t) return { value: null, headers: [], rows: [] };
      const ths = [...t.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
      const ti = ths.findIndex((h) => /type/i.test(h));
      const vi = ths.findIndex((h) => /volume/i.test(h));
      const rows: string[] = [];
      for (const tr of [...t.querySelectorAll('tbody tr')]) {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
        rows.push(cells.join(' | '));
      }
      if (vi === -1) return { value: null, headers: ths, rows };
      for (const tr of [...t.querySelectorAll('tbody tr')]) {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
        // Group-header rows also carry the type word but no values — skip them.
        if (ti >= 0 && /wall/i.test(cells[ti] ?? '')) {
          const m = (cells[vi] ?? '').replace(/,/g, '').match(/-?[\d.]+/);
          if (m) return { value: parseFloat(m[0]), headers: ths, rows };
        }
      }
      return { value: null, headers: ths, rows };
    });

  /** Wait until the schedules table shows the given row-type names. */
  const waitForScheduleRows = (names: string[], timeout = 20000) =>
    page.waitForFunction(
      (ns: string[]) => {
        const t = document.querySelector('.obs-schedules-overlay table');
        if (!t) return false;
        const txt = (t as HTMLElement).innerText;
        return ns.every((n) => new RegExp(n, 'i').test(txt));
      },
      names,
      { timeout },
    );

  // ── 3. Wall: ribbon click → two canvas points → Enter ends chain → Esc
  await gotoTab('architecture');
  await clickStripButton('Wall');
  expect(await getActiveTool(), 'Wall tool becomes active from the ribbon click').toBe('wall');
  await expect(page.locator('button.obs-rb[data-active="1"]').first()).toHaveCount(1);

  const beforeWall = await authoredCount();
  await page.mouse.click(cx - box!.width * 0.2, wallY);
  await page.mouse.click(cx + box!.width * 0.2, wallY);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  const afterWall = await authoredCount();
  console.log('[chain] authored elements before/after wall:', beforeWall, '→', afterWall);
  expect(afterWall, 'a wall must be authored by two canvas clicks').toBeGreaterThan(beforeWall);
  await backToSelect();
  await page.screenshot({ path: '/tmp/e2e-art/02-wall.png' });

  // ── 4. Schedules baseline: the wall must produce real quantity rows
  await gotoTab('insert');
  await clickStripButton('Schedules');
  const schedOpen = await page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    return !!ctx?.features?.schedules?.isVisible?.();
  });
  expect(schedOpen, 'schedules panel opens from the ribbon').toBe(true);
  // First open must show the all-elements Quantity Takeoff with a Volume column
  await page.waitForFunction(
    () =>
      !!document.querySelector('.obs-schedules-overlay table') &&
      [...document.querySelectorAll('.obs-schedules-overlay thead th')].some(
        (th) => /volume/i.test(th.textContent || ''),
      ),
    undefined,
    { timeout: 20000 },
  );
  const v1 = await wallVolume();
  const volume1 = v1.value;
  console.log('[chain] schedules baseline wall volume:', volume1, '| headers:', v1.headers.join(', '), '| rows:', JSON.stringify(v1.rows));
  expect(volume1, 'wall volume must be computed in the default schedule').toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/e2e-art/03-schedules-baseline.png' });
  expect(await closeSchedules(), 'schedules closes via feature registry').toBe(true);
  await page.waitForTimeout(400);

  // ── 5. Door on the wall (midpoint)
  await gotoTab('architecture');
  await clickStripButton('Door');
  expect(await getActiveTool(), 'Door tool becomes active').toBe('door');
  await page.mouse.click(cx, wallY);
  await page.waitForTimeout(900);
  expect(errors.filter((e) => /pageerror/.test(e)), `door errors: ${errors.join('\n')}`).toEqual([]);
  await backToSelect();
  await page.screenshot({ path: '/tmp/e2e-art/04-door.png' });

  // ── 6. Window on the wall (quarter point)
  await clickStripButton('Window');
  expect(await getActiveTool(), 'Window tool becomes active').toBe('window');
  await page.mouse.click(cx - box!.width * 0.12, wallY);
  await page.waitForTimeout(900);
  expect(errors.filter((e) => /pageerror/.test(e)), `window errors: ${errors.join('\n')}`).toEqual([]);
  await backToSelect();
  await page.screenshot({ path: '/tmp/e2e-art/05-window.png' });

  // ── 7. Schedules after openings: regeneration must show the new rows and
  //       the wall volume must shrink (openings recut the host geometry)
  await gotoTab('insert');
  await clickStripButton('Schedules');
  await waitForScheduleRows(['door', 'window']);
  const v2 = await wallVolume();
  const volume2 = v2.value;
  console.log('[chain] schedules wall volume after openings:', volume2, '(baseline', volume1 + ')', '| rows:', JSON.stringify(v2.rows));
  await page.screenshot({ path: '/tmp/e2e-art/06-schedules-after.png' });
  expect(volume2, `openings must reduce wall volume (${volume1} → ${volume2})`).toBeLessThan(volume1!);
  expect(await closeSchedules(), 'schedules closes again').toBe(true);
  await page.waitForTimeout(400);

  // ── 8. Section: turn the section feature on (no page errors)
  const sectionOn = await page.evaluate(() => {
    const ctx: any = (window as any).__OBS_CTX__;
    ctx?.features?.section?.toggle?.();
    return !!ctx?.features?.section?.isEnabled?.();
  });
  expect(sectionOn, 'section feature toggles on').toBe(true);
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/e2e-art/07-section.png' });

  // ── 9. Sheets: open the Sheets panel and create a sheet (+ Sheet inside the panel)
  await gotoTab('file');
  await clickStripButton('Sheets');
  await page.locator('button[data-act="new"]').first().click();
  await page.waitForTimeout(700);
  const sheetRows = await page.locator('.obs-sheets__row').count();
  console.log('[chain] sheet rows:', sheetRows);
  expect(sheetRows, 'a sheet must be created from the panel').toBeGreaterThan(0);
  await page.screenshot({ path: '/tmp/e2e-art/08-sheet.png' });
  await page.locator('button[data-act="close"]').first().click();
  await page.waitForTimeout(400);

  // ── 10. Export IFC4: the authored model must download as a real STEP file
  const downloadPromise = page.waitForEvent('download', { timeout: 45000 }).catch(() => null);
  await page.getByRole('button', { name: 'IFC4', exact: true }).first().click();
  const download = await downloadPromise;
  expect(download, 'IFC4 export produces a download').toBeTruthy();
  const ifcPath = '/tmp/e2e-art/export.ifc';
  await download!.saveAs(ifcPath);
  const ifcHead = fs.readFileSync(ifcPath, 'utf8').slice(0, 400);
  console.log('[chain] IFC4 export size:', fs.statSync(ifcPath).size, 'bytes');
  expect(ifcHead, 'IFC file must be a STEP file').toContain('ISO-10303-21');
  await page.screenshot({ path: '/tmp/e2e-art/09-export.png' });

  // ── Final: no uncaught page errors anywhere in the chain
  const fatal = errors.filter((e) => /pageerror/.test(e));
  expect(fatal, `uncaught page errors: ${fatal.join('\n')}`).toEqual([]);
});
