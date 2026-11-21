import { test, expect } from '@playwright/test';
import { openPaletteWith } from './palette';

// Regression for user console output: "[cad] ribbon control missing: [data-r=importfile] / [data-a=bg] / [data-a=du] / [data-a=polar-angle]".
test('2D drawing editor: every ribbon control the wiring code looks up exists in the DOM', async ({ page }) => {
  test.setTimeout(120000);
  const warnings: string[] = [];
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && (e as Error).stack || e)));
  await page.goto('/');
  await page.locator('#obs-hero-3d').click({ timeout: 30000 });
  await expect.poll(() => page.evaluate(() => !!(window as any).__OBS_CTX__), { timeout: 30000 }).toBe(true);
  await openPaletteWith(page, 'Drawing Editor');
  await page.keyboard.press('Enter');
  await expect(page.locator('.obs-cad-shell, .obs-cad-viewer').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const present = await page.evaluate(() => {
    const q = (s: string) => !!document.querySelector(s);
    return {
      importfile: q('[data-r=importfile]'), svgfile: q('[data-r=svgfile]'),
      bg: q('select[data-a=bg]'), du: q('select[data-a=du]'), polar: q('select[data-a=polar-angle]'),
      groups: document.querySelectorAll('.cadrg').length,
      tabs: [...new Set([...document.querySelectorAll('.cadrg')].map((g) => (g as HTMLElement).dataset.cadtab))],
    };
  });
  const hosts = await page.evaluate(() => [...document.querySelectorAll('[data-r=tools],[data-r=tools2]')].map((h) => ({ r: (h as HTMLElement).dataset.r, kids: h.children.length, len: h.innerHTML.length, inShell: !!h.closest('.obs-cad-shell'), head: h.innerHTML.slice(0, 160) })));
  console.log('RIBBON-HOSTS', JSON.stringify(hosts));
  console.log('RIBBON-PAGEERRORS', JSON.stringify(pageErrors.slice(0, 5)));
  console.log('RIBBON-PROBE', JSON.stringify(present), JSON.stringify(warnings.filter((w) => /ribbon control missing|\[cad\]/.test(w))));
  // Every ribbon tab must show at least one visible group with visible buttons.
  for (const id of ['home', 'insert', 'annotate', 'parametric', 'view', 'manage', 'output', 'express', 'collaborate']) {
    await page.locator(`[data-ribtab="${id}"]`).first().click();
    const vis = await page.evaluate((tab) => {
      const groups = [...document.querySelectorAll(`.cadrg[data-cadtab="${tab}"]`)].filter((g) => (g as HTMLElement).offsetParent !== null);
      const btns = groups.flatMap((g) => [...g.querySelectorAll('button')]).filter((b) => (b as HTMLElement).offsetParent !== null);
      return { groups: groups.length, buttons: btns.length };
    }, id);
    console.log('RIBBON-TAB', id, JSON.stringify(vis));
    expect(vis.groups, `tab ${id} has no visible groups`).toBeGreaterThan(0);
    expect(vis.buttons, `tab ${id} has no visible buttons`).toBeGreaterThan(0);
  }
  const missing = warnings.filter((w) => /ribbon control missing/.test(w));
  expect(missing, 'ribbon controls missing: ' + missing.join(' | ')).toEqual([]);
  expect(present.importfile && present.bg && present.du && present.polar).toBe(true);
});
