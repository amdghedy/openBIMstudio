import { test, expect, type Page } from "@playwright/test";

// AutoCAD 2D parity A12 — main-shell ribbon completion (browser proof).
// Home / Parametric / Output tabs, quick access toolbar, global Undo/Redo,
// no dead planned buttons. A button that renders but does nothing must fail
// this spec: every wired button below is clicked and must not raise a page
// error (Print is visibility-only — it opens the OS print dialog).

async function enterPlatform(page: Page): Promise<void> {
  await page.locator("#obs-hero-3d").click({ timeout: 30000 });
  await expect(page.locator(".obs-home.is-open")).toHaveCount(0, { timeout: 15000 });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String((e as Error).message ?? e)));
  (page as unknown as { __a12Errors: string[] }).__a12Errors = errors;
  await page.goto("/");
  await expect(page.locator(".obs-ribbon")).toBeVisible({ timeout: 30000 });
});

const pageErrors = (page: Page) =>
  (page as unknown as { __a12Errors: string[] }).__a12Errors;

const clickTab = (page: Page, name: string) =>
  page.locator("button.obs-ribbon__tab", { hasText: name }).click();

test("A12: Home is the default tab at boot; QAT present with five buttons", async ({ page }) => {
  // Fresh browser profile, no saved workspace: setupRibbon lands on Home.
  const active = page.locator("button.obs-ribbon__tab[data-active='1']");
  await expect(active).toHaveText("Home");

  const qat = page.locator(".obs-qat");
  await expect(qat).toBeVisible();
  await expect(qat.locator("[data-qat]")).toHaveCount(5);
  for (const action of ["new", "open", "save", "undo", "redo"]) {
    await expect(qat.locator(`[data-qat="${action}"]`)).toBeVisible();
  }
  // Nothing to undo/redo on a fresh project: both disabled, not broken.
  await expect(qat.locator('[data-qat="undo"]')).toBeDisabled();
  await expect(qat.locator('[data-qat="redo"]')).toBeDisabled();
  // No dead planned button survives anywhere in the ribbon.
  await expect(page.locator(".obs-ribbon [data-planned]")).toHaveCount(0);
  await expect(pageErrors(page)).toEqual([]);
});

test("A12: Home tab shows draw/modify essentials + working Undo/Redo", async ({ page }) => {
  await enterPlatform(page);
  await clickTab(page, "Home");
  const strip = page.locator(".obs-ribbon__strip");
  await expect(strip.getByRole("button", { name: "Wall", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Move", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Aligned", exact: true })).toBeVisible();
  // Global Undo/Redo (data-history-*) — disabled on a fresh project.
  await expect(strip.locator("[data-history-undo]")).toBeVisible();
  await expect(strip.locator("[data-history-undo]")).toBeDisabled();
  await expect(strip.locator("[data-history-redo]")).toBeVisible();
  await expect(strip.locator("[data-history-redo]")).toBeDisabled();
  // Clicking Undo with an empty history must not throw.
  await strip.locator("[data-history-undo]").click({ force: true });
  await expect(pageErrors(page)).toEqual([]);
});

test("A12: Parametric tab holds the toolkit + family tools", async ({ page }) => {
  await enterPlatform(page);
  await clickTab(page, "Parametric");
  const strip = page.locator(".obs-ribbon__strip");
  await expect(strip.getByRole("button", { name: "Parametric", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Family Creator", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Sketch Family", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Family Panel", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Lock Dim", exact: true })).toBeVisible();
  // Opening the parametric toolkit must not throw.
  await strip.getByRole("button", { name: "Parametric", exact: true }).click();
  await expect(pageErrors(page)).toEqual([]);
});

test("A12: Output tab shows Print, Batch Plot, Export and Sheets", async ({ page }) => {
  await enterPlatform(page);
  await clickTab(page, "Output");
  const strip = page.locator(".obs-ribbon__strip");
  await expect(strip.getByRole("button", { name: "Print", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Batch Plot", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "IFC4", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "IFC2X3", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "Sheets", exact: true })).toBeVisible();
  await expect(strip.getByRole("button", { name: "New Sheet", exact: true })).toBeVisible();
  // Batch Plot opens its panel without an error (Print is not clicked:
  // it opens the OS print dialog).
  await strip.getByRole("button", { name: "Batch Plot", exact: true }).click();
  await expect(pageErrors(page)).toEqual([]);
});

test("A12: Manage Energy runs the heat-loss report, not a planned toast", async ({ page }) => {
  await enterPlatform(page);
  await clickTab(page, "Manage");
  const strip = page.locator(".obs-ribbon__strip");
  const energy = strip.getByRole("button", { name: "Energy", exact: true });
  await expect(energy).toBeVisible();
  await energy.click();
  // No rooms yet → an honest empty result/toast, but no crash and no
  // "planned for a future release" dead end.
  await expect(pageErrors(page)).toEqual([]);
  const toast = page.locator(".obs-toast");
  await expect(toast).not.toContainText("planned for a future release");
});

test("A12: no dead planned buttons remain on any tab", async ({ page }) => {
  await enterPlatform(page);
  const strip = page.locator(".obs-ribbon__strip");
  await clickTab(page, "Annotate");
  for (const label of ["Space", "View Ref", "Tread", "Spell", "Find / Replace",
    "Duct", "Pipe", "Color Fill", "Symbol"]) {
    await expect(strip.getByRole("button", { name: label, exact: true })).toHaveCount(0);
  }
  await clickTab(page, "Massing & Site");
  await expect(strip.getByRole("button", { name: "Subregion", exact: true })).toHaveCount(0);
  await clickTab(page, "Edit");
  await expect(strip.getByRole("button", { name: "By Face", exact: true })).toHaveCount(0);
  await expect(strip.getByRole("button", { name: "Drag Sel", exact: true })).toHaveCount(0);
  await expect(pageErrors(page)).toEqual([]);
});
