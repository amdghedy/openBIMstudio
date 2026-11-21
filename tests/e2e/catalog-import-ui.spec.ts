/**
 * tests/e2e/catalog-import-ui.spec.ts
 *
 * Revit parity Rank 6, item 4 — catalog-import UI wiring + shared-parameter
 * .txt import/export, through the real Parametric Families panel.
 *
 * Slice 8 delivered the sync machinery (`syncCatalogToFamily`,
 * `catalogFromFamily`, `importText`/`exportText`) but no UI called it:
 * "Import Type Catalog" parsed the file and dispatched
 * `obs:type-catalog-imported`, which nothing listened to, so an import
 * changed nothing. This spec proves the wiring end to end:
 *   1. Importing a type catalog for "Basic Wall" creates the type on
 *      the selected family (visible in the store AND in the panel's
 *      type select — the panel refreshes after the sync).
 *   2. "Export Type Catalog" downloads a .txt that round-trips the
 *      imported type.
 *   3. "Manage Shared Parameters" → "Import .txt" imports a Revit
 *      shared-parameter file into the manager (visible in the dialog),
 *      and "Export .txt" downloads it back.
 *
 * Run: `npm run build` first (vite preview serves dist/), then
 * `npx playwright test tests/e2e/catalog-import-ui.spec.ts --project=chromium`
 * with a config pointing at a free port (see playwright.revit6.config.ts).
 */
import { expect, test } from "@playwright/test";

test.setTimeout(300000); // the panel-handle wait alone takes ~124 s (120 s boot fallback)

const CATALOG_TEXT = [
  "##TYPE",
  "Basic Wall,height##length,thickness##length",
  "Catalog Wall,3.5,0.25",
  "",
].join("\r\n");

const SHARED_PARAM_TEXT = [
  "# This is a Revit shared parameter file. Do not edit manually.",
  "*META\tVERSION\tMINVERSION",
  "META\t2\t1",
  "*GROUP\tID\tNAME",
  "GROUP\t1\tGeneral",
  "*PARAM\tGUID\tNAME\tDATACATEGORY\tDATATYPE\tGROUP\tVISIBLE\tDESCRIPTION\tUSERMODIFIABLE\tHIDEWHENNOVALUE",
  "PARAM\t{11111111-2222-3333-4444-555555555555}\tFire Rating\tTEXT\tTEXT\t1\t1\t\t1\t0",
  "",
].join("\n");

async function enterAuthoring(page: any) {
  await page.goto("/");
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await card.waitFor({ state: "visible", timeout: 90000 });
  await card.click();
  await page.waitForFunction(
    () => (window as any).__obsAuthoring && document.querySelector("canvas"),
    undefined,
    { timeout: 90000 },
  );
}

async function installToastLog(page: any) {
  await page.evaluate(() => {
    (window as any).__toastLog = [];
    window.addEventListener("obs-toast", (e: any) => {
      (window as any).__toastLog.push(String(e.detail?.message ?? ""));
    });
  });
}

async function toastLog(page: any): Promise<string[]> {
  return page.evaluate(() => (window as any).__toastLog ?? []);
}

test("catalog import creates a type on the selected family and exports it back", async ({ page }) => {
  // FU6/FU7 pattern: uncaught exceptions only. Console "error" in this
  // sandbox is network noise — the visits telemetry ping to
  // openbimstudio.amdghedy.workers.dev is CSP-blocked here and the VM
  // has no route to the internet — not an app failure.
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  await enterAuthoring(page);
  await installToastLog(page);

  // Open the Parametric Families panel and wait for the catalog controls.
  // The panel service registers asynchronously at boot: calling open()
  // before it exists is a silent no-op, so wait for the handle first
  // (the sketch-constraints spec does the same).
  await page.waitForFunction(
    () => !!(window as any).__obsParamFamilyPanel,
    undefined,
    { timeout: 150000 },
  );
  await page.evaluate(() => (window as any).__obsParamFamilyPanel?.open());
  const panel = page.locator("#obs-param-family-panel.is-open");
  await panel.waitFor({ state: "visible", timeout: 30000 });
  const importButton = page.locator('[data-catalog-action="import-type-catalog"]');
  await importButton.waitFor({ state: "visible", timeout: 30000 });
  const exportButton = page.locator('[data-catalog-action="export-type-catalog"]');
  await expect(exportButton).toBeVisible();

  // Select the built-in Basic Wall family.
  const wallId: string | null = await page.evaluate(() => {
    const list = (window as any).__obsFamilyParametric?.list?.() ?? [];
    return list.find((f: any) => f.name === "Basic Wall")?.id ?? null;
  });
  expect(wallId, "Basic Wall family exists").toBeTruthy();
  await page.locator("#obs-param-family-panel [data-family]").selectOption(wallId!);
  await expect(page.locator("#obs-param-family-panel [data-type] option", { hasText: "Generic 200 mm" })).toHaveCount(1);

  // 1. Import the catalog (hidden file input inside the panel controls).
  const catalogInput = page.locator('#obs-param-family-panel input[type="file"]');
  await catalogInput.setInputFiles({
    name: "Basic Wall.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(CATALOG_TEXT, "utf-8"),
  });
  await page.waitForFunction(
    () => (window as any).__toastLog?.some((m: string) => m.includes("Catalog applied to Basic Wall")),
    undefined,
    { timeout: 30000 },
  );
  const status = await page.locator("#obs-param-family-panel [data-status]").textContent();
  expect(status ?? "").toContain("1 type(s) created");

  // The type exists in the store with the catalog's values…
  const created = await page.evaluate(() => {
    const list = (window as any).__obsFamilyParametric?.list?.() ?? [];
    const wall = list.find((f: any) => f.name === "Basic Wall");
    return wall?.types?.find((t: any) => t.name === "Catalog Wall") ?? null;
  });
  expect(created, "Catalog Wall type created on Basic Wall").toBeTruthy();
  expect(created.values).toMatchObject({ height: 3.5, thickness: 0.25 });
  // …and the panel refreshed its type select to include it.
  await expect(page.locator("#obs-param-family-panel [data-type] option", { hasText: "Catalog Wall" })).toHaveCount(1);

  // 2. Export the family back to a catalog file.
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await exportButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Basic Wall.txt");
  const exportPath = await download.path();
  const { readFile } = await import("node:fs/promises");
  const exportText = exportPath ? await readFile(exportPath, "utf-8") : "";
  expect(exportText).toContain("Catalog Wall");
  expect(exportText).toContain("3.5");

  // 3. Shared parameters: import a Revit .txt, then export it back.
  await page.locator('[data-catalog-action="manage-shared-parameters"]').click();
  const dialog = page.locator("dialog");
  await dialog.waitFor({ state: "visible", timeout: 30000 });
  await expect(dialog.locator("h2", { hasText: "Shared Parameters" })).toBeVisible();
  const spInput = dialog.locator('input[type="file"]');
  await spInput.setInputFiles({
    name: "shared-parameters.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(SHARED_PARAM_TEXT, "utf-8"),
  });
  await expect(dialog.locator("span", { hasText: "Fire Rating" })).toBeVisible({ timeout: 30000 });
  const spDownloadPromise = page.waitForEvent("download", { timeout: 30000 });
  await dialog.locator("button", { hasText: "Export .txt" }).click();
  const spDownload = await spDownloadPromise;
  expect(spDownload.suggestedFilename()).toBe("shared-parameters.txt");
  const spPath = await spDownload.path();
  const spExport = spPath ? await readFile(spPath, "utf-8") : "";
  expect(spExport).toContain("Fire Rating");

  await dialog.locator("button", { hasText: "Close" }).click();

  expect(errors, `page errors: ${errors.join(" | ")}`).toEqual([]);
});
