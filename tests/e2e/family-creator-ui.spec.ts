/**
 * tests/e2e/family-creator-ui.spec.ts
 *
 * Family Creator panel (slice 2, partial) in the real app: paste a spec,
 * watch real stage status, edit a parameter, add to the library, download
 * the IFC2X3, and see an honest failure. Revit itself is NOT exercised.
 *
 * Run: `npm run build`, then `npx playwright test tests/e2e/family-creator-ui.spec.ts --project=chromium`
 * Set FC_SHOTS=/some/dir to keep screenshots.
 */
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

test.setTimeout(240000);
const SHOTS = process.env.FC_SHOTS;
const shot = async (page: any, name: string) => {
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); }
};

async function enterAuthoring(page: any) {
  await page.goto("/");
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await card.waitFor({ state: "visible", timeout: 90000 });
  await card.click();
  await page.waitForFunction(() => (window as any).__obsAuthoring && document.querySelector("canvas"), undefined, { timeout: 90000 });
}

async function openCreator(page: any) {
  const tabs: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".obs-ribbon__tab")].map((x) => (x as HTMLElement).dataset.tab ?? ""));
  // The button lives on the Manage tab; walk the tabs so the spec does not depend on ribbon order.
  for (const t of [...tabs.filter((x) => x === "manage"), ...tabs.filter((x) => x !== "manage")]) {
    await page.evaluate((id: string) => (document.querySelector(`.obs-ribbon__tab[data-tab="${id}"]`) as HTMLElement).click(), t);
    await page.waitForTimeout(400);
    const btn = page.getByRole("button", { name: "Family Creator" });
    if (await btn.first().isVisible().catch(() => false)) { await btn.first().click(); break; }
  }
  await page.getByTestId("family-creator-panel").waitFor({ state: "visible", timeout: 10000 });
}

test("family creator: real status, editable parameters, library, IFC2X3 download, honest failure", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");

  // Before anything runs: nothing claims to be done.
  await expect(panel.locator("[data-stage]")).toHaveCount(0);

  await panel.locator('[data-f="name"]').fill("Display Cabinet DC-100");
  await panel.locator('[data-f="manufacturer"]').fill("Example");
  await panel.locator('[data-f="model"]').fill("DC-100");
  await panel.locator('[data-f="text"]').fill("Display Cabinet DC-100\nOverall size: 1200 x 700 x 2000 mm\nPower: 230 V");
  await panel.getByRole("button", { name: "Create family" }).click();

  const states = await panel.locator("[data-stage]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state));
  expect(states).toEqual(["done", "done", "done", "done"]);
  await expect(panel.locator('[data-fc="progress"]')).toHaveText("4 of 4 steps finished");
  await expect(panel.locator('[data-stage="intake"]')).toContainText("1200 x 700 x 2000 mm (W x D x H)");
  await expect(panel.locator('[data-stage="engine"]')).toContainText("1200 x 700 x 2000 mm (W x D x H)");
  await expect(panel.locator('[data-fc="targets"]')).toContainText("Revit 2020: not verified");
  await expect(panel.locator('[data-fc="targets"]')).toContainText("written, structure checked");
  expect(await panel.innerText()).not.toMatch(/ready for revit/i);
  await expect(panel.locator('[data-fc="sources"]')).toContainText("page 1, line 2");
  await expect(panel.locator('[data-fc="views"] svg rect')).toHaveCount(12); // 4 parts x 3 views
  await expect(panel).toContainText("1900 mm"); // derived Body height = Height - Plinth height, resolved by the engine
  await expect(panel).toContainText("760 mm"); // derived Handle length = 40% of body height
  await shot(page, "01-created.png");
  if (SHOTS) await panel.locator('[data-fc="views"]').screenshot({ path: path.join(SHOTS, "01-views.png") });
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, "01-panel.png") });

  // Edit a parameter: the whole pipeline runs again, the family follows.
  // The front-view body rect (second rect) is Width x BodyHeight, so its width to height ratio tracks Width.
  const ratio = async () => panel.locator('[data-fc="views"] svg rect').nth(1).evaluate((e) => Number(e.getAttribute("width")) / Number(e.getAttribute("height")));
  const before = await ratio();
  await panel.locator('[data-param="Width"]').fill("1500");
  await panel.locator('[data-param="Width"]').dispatchEvent("change");
  await expect(panel.locator('[data-param="Width"]')).toHaveValue("1500");
  await expect(panel.locator("[data-stage][data-state=done]")).toHaveCount(4);
  const after = await ratio();
  expect(after / before).toBeCloseTo(1500 / 1200, 2);
  await shot(page, "02-width-1500.png");

  // Library and IFC download.
  await panel.getByRole("button", { name: "Add to family library" }).click();
  await expect(panel.locator('[data-fc="notice"]')).toContainText("Added");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    panel.getByRole("button", { name: "Download IFC2X3" }).click(),
  ]);
  const file = await download.path();
  const text = fs.readFileSync(file as string, "utf8");
  expect(text).toContain("FILE_SCHEMA(('IFC2X3'))");
  expect(text).toContain("IFCLENGTHMEASURE(1.5)");
  expect(download.suggestedFilename()).toBe("Display_Cabinet_DC-100.ifc");
  await expect(panel.locator('[data-fc="notice"]')).toContainText("Not yet checked in Revit");

  // Honest failure: no clear size, nothing after the first stage claims progress.
  await panel.locator('[data-f="text"]').fill("nothing useful here");
  for (const f of ["wMm", "dMm", "hMm"]) await panel.locator(`[data-f="${f}"]`).fill("");
  await panel.getByRole("button", { name: "Create family" }).click();
  const bad = await panel.locator("[data-stage]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state));
  expect(bad).toEqual(["failed", "pending", "pending", "pending"]);
  await expect(panel.locator('[data-fc="progress"]')).toHaveText("0 of 4 steps finished");
  await expect(panel.locator('[data-stage="intake"]')).toContainText("Enter the size yourself");
  await expect(panel.locator('[data-stage="intake"]')).not.toContainText(/ask the user/i);
  expect(await panel.innerText()).not.toMatch(/slice/i);
  await expect(panel.getByRole("button", { name: "Download IFC2X3" })).toHaveCount(0);
  await shot(page, "03-failure.png");

  expect(errors).toEqual([]);
});
