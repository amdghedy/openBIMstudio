/**
 * tests/e2e/family-creator-gate.spec.ts
 *
 * The Family Creator review step in the real app: "Add to family library" stays disabled
 * until the person presses "I reviewed this result", and a rerun takes the review back.
 * Also reads the read-only task state. Revit is NOT exercised.
 * Set FC_SHOTS=/some/dir to keep screenshots. Run in CI by the browser-smoke job.
 */
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

test.setTimeout(240000);
const SHOTS = process.env.FC_SHOTS;

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

test("family creator: review gate blocks adding until reviewed, and any change takes the review back", async ({ page }) => {
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");
  await panel.locator('[data-f="name"]').fill("Display Cabinet DC-100");
  await panel.locator('[data-f="text"]').fill("Display Cabinet DC-100\nOverall size: 1200 x 700 x 2000 mm");
  await panel.getByRole("button", { name: "Create family" }).click();
  const add = panel.getByRole("button", { name: "Add to family library" });
  const rev = panel.getByRole("button", { name: "I reviewed this result" });
  const gateShot = async (name: string) => {
    if (!SHOTS) return;
    const a = await panel.locator('[data-fc="review"]').boundingBox(); const b = await add.boundingBox();
    if (a && b) await page.screenshot({ path: path.join(SHOTS, name), clip: { x: a.x, y: a.y, width: a.width, height: b.y + b.height - a.y + 6 } });
  };
  await expect(add).toBeDisabled();
  await expect(rev).toBeEnabled();
  await panel.locator('[data-fc="review"]').scrollIntoViewIfNeeded();
  await add.scrollIntoViewIfNeeded(); await gateShot("gate-1-disabled.png");
  await rev.click();
  await expect(add).toBeEnabled();
  await expect(rev).toBeDisabled();
  await gateShot("gate-2-enabled.png");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(add).toBeDisabled();
  await expect(rev).toBeEnabled();
  await add.scrollIntoViewIfNeeded(); await gateShot("gate-3-reset-after-rerun.png");
  await panel.locator('[data-fc="task-state-box"] summary').click();
  const txt = await panel.locator('[data-fc="task-state"]').innerText();
  const st = JSON.parse(txt);
  expect(st.review).toEqual({ required: true, done: false });
  expect(st.revit).toBe("unverified");
  await panel.locator('[data-fc="task-state-box"]').scrollIntoViewIfNeeded();
  if (SHOTS) await panel.screenshot({ path: path.join(SHOTS, "gate-4-task-state-panel.png") });
});
