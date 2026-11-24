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
import { createRequire } from "node:module";
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

const buildImagePdf = createRequire(import.meta.url)("../helpers/image-pdf.cjs") as (j: Uint8Array, w: number, h: number) => Uint8Array;
const buildTextPdf = createRequire(import.meta.url)("../helpers/text-pdf.cjs") as (pages: string[][]) => Uint8Array;

test("family creator: PDF text intake and interactive 3D preview", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");

  // A two-page PDF: the size is on page 2.
  const pdf = buildTextPdf([["Display Cabinet DC-100", "Example Co."], ["Specifications", "Overall size: 1200 x 700 x 2000 mm", "Power: 230 V"]]);
  await panel.locator('[data-fc="file"]').setInputFiles({ name: "dc100.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Loaded dc100.pdf: 2 of 2 page(s) read.");
  await panel.locator('[data-f="name"]').fill("Display Cabinet DC-100");
  await panel.getByRole("button", { name: "Create family" }).click();
  const states = await panel.locator("[data-stage]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state));
  expect(states).toEqual(["done", "done", "done", "done"]);
  await expect(panel.locator('[data-fc="sources"]')).toContainText("page 2, line 2");
  await expect(panel.locator('[data-fc="sources"]')).toContainText("Overall size: 1200 x 700 x 2000 mm");

  // 3D: the scene holds the engine's geometry at the spec size.
  const canvas = panel.locator('canvas[data-fc3d="canvas"]');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-meshes", /^[1-9]/);
  await expect.poll(async () => Number(await canvas.getAttribute("data-frames"))).toBeGreaterThan(0);
  const num = async (a: string) => ((await canvas.getAttribute(a)) ?? "").split(",").map(Number);
  const size = await num("data-size");
  expect(size[0]).toBeCloseTo(1200, 0); expect(size[1]).toBeCloseTo(700, 0); expect(size[2]).toBeCloseTo(2000, 0);
  await shot(page, "10-3d-initial.png");
  // Panel scrolled so the whole preview is on screen.
  await panel.locator('[data-fc="preview3d"]').scrollIntoViewIfNeeded();
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await shot(page, "15-3d-scrolled.png");

  // Orbit, zoom, fit.
  const fitCam = await num("data-cam");
  const fitDist = Number(await canvas.getAttribute("data-dist"));
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 25, { steps: 8 }); await page.mouse.up();
  await expect.poll(async () => (await num("data-cam")).join()).not.toBe(fitCam.join());
  const orbitDist = Number(await canvas.getAttribute("data-dist"));
  // Orbiting changes the direction, not the distance to the target.
  expect(orbitDist).toBeCloseTo(fitDist, 1);
  await shot(page, "11-3d-orbited.png");
  await page.mouse.move(cx, cy); await page.mouse.wheel(0, -400);
  await expect.poll(async () => Number(await canvas.getAttribute("data-dist"))).toBeLessThan(orbitDist - 0.01);
  await shot(page, "12-3d-zoomed.png");
  await panel.getByRole("button", { name: "Fit" }).click();
  await expect.poll(async () => (await num("data-cam")).join()).toBe(fitCam.join());
  await shot(page, "13-3d-fit.png");

  // Editing a parameter rebuilds the geometry in the same scene.
  await panel.locator('[data-param="Width"]').fill("1500");
  await panel.locator('[data-param="Width"]').dispatchEvent("change");
  await expect.poll(async () => (await num("data-size"))[0]).toBeCloseTo(1500, 0);

  // Typing replaces the file: the run reads the typed text, not the old PDF.
  await panel.locator('[data-f="text"]').fill("Overall size: 900 x 600 x 1800 mm");
  await expect(panel.locator('[data-fc="file-note"]')).toHaveText("");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel.locator('[data-fc="sources"]')).toContainText("page 1, line 1");
  await expect.poll(async () => (await num("data-size"))[2]).toBeCloseTo(1800, 0);

  // A PDF with no text layer: honest message, no invented size.
  const scan = buildTextPdf([[]]);
  await panel.locator('[data-fc="file"]').setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(scan) });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Could not read any text", { timeout: 60000 });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Type the size");
  expect(await panel.innerText()).not.toMatch(/slice|ready for revit/i);
  await shot(page, "14-scan-message.png");

  // Narrow (phone-width) layout: the panel must stay inside the screen and the preview usable.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(500);
  await panel.locator('[data-f="text"]').fill("Overall size: 900 x 600 x 1800 mm");
  await panel.getByRole("button", { name: "Create family" }).click();
  const pb = (await panel.boundingBox())!;
  await shot(page, "16-narrow-top.png");
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  await shot(page, "17-narrow-3d.png");
  expect(pb.x).toBeGreaterThanOrEqual(0);
  expect(pb.x + pb.width).toBeLessThanOrEqual(390 + 1);

  expect(errors).toEqual([]);
});

test("family creator: table and shelving shapes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");
  await panel.locator('[data-f="name"]').fill("Dining table");
  await panel.locator('[data-f="text"]').fill("Overall size: 1800 x 900 x 750 mm");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel).toContainText("Table with four legs"); // chosen from the name
  await expect(panel).toContainText("5 parts");
  const canvas = panel.locator('canvas[data-fc3d="canvas"]');
  await expect.poll(async () => (await canvas.getAttribute("data-size")) ?? "").toBe("1800,900,750");
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await shot(page, "20-table.png");

  // The user picks the shape: same size, different parts.
  await panel.locator('[data-f="templateId"]').selectOption("shelf");
  await panel.locator('[data-f="text"]').fill("Overall size: 900 x 300 x 1800 mm");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel).toContainText("Open shelving");
  await expect(panel).toContainText("6 parts");
  await expect.poll(async () => (await canvas.getAttribute("data-size")) ?? "").toBe("900,300,1800");
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await shot(page, "21-shelf.png");

  // A count is real geometry: 3 middle shelves means 8 solids in the 3D scene, evenly spaced, and the size is unchanged.
  await expect(canvas).toHaveAttribute("data-meshes", "6");
  await panel.locator('[data-param="MidShelves"]').fill("3");
  await panel.locator('[data-param="MidShelves"]').dispatchEvent("change");
  await expect(canvas).toHaveAttribute("data-meshes", "8");
  await expect(panel).toContainText("8 parts");
  await expect.poll(async () => (await canvas.getAttribute("data-size")) ?? "").toBe("900,300,1800");
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await shot(page, "22-shelf-3-middle.png");
  await panel.locator('[data-param="MidShelves"]').fill("2.5");
  await panel.locator('[data-param="MidShelves"]').dispatchEvent("change");
  await expect(panel.locator('[data-stage="intake"]')).toContainText("whole number");
  expect(errors).toEqual([]);
});

test("family creator: OCR of a picture and a scanned PDF, same-origin only, with LTR and RTL panel placement", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");

  // A synthetic sheet picture, drawn in the page: text lines on white.
  const sheet = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 900; c.height = 170;
    const x = c.getContext("2d")!; x.fillStyle = "#fff"; x.fillRect(0, 0, 900, 170);
    x.fillStyle = "#000"; x.font = "44px sans-serif";
    x.fillText("Cabinet DC-100", 30, 65); x.fillText("Overall size: 1200 x 700 x 2000 mm", 30, 130);
    return { png: c.toDataURL("image/png").split(",")[1], jpg: c.toDataURL("image/jpeg", 0.95).split(",")[1] };
  });
  const before = requests.length;
  await panel.locator('[data-fc="file"]').setInputFiles({ name: "sheet.png", mimeType: "image/png", buffer: Buffer.from(sheet.png, "base64") });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Read sheet.png from the picture", { timeout: 90000 });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Check the numbers");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel.locator("[data-stage][data-state=done]")).toHaveCount(4);
  await expect(panel.locator('[data-fc="sources"]')).toContainText("page 1, line 2");
  await expect(panel.locator('[data-fc="sources"]')).toContainText("1200 x 700 x 2000 mm");
  await expect(panel.locator('[data-fc="ocr-warning"]')).toContainText("Digits can be misread");
  await expect.poll(async () => (await panel.locator('canvas[data-fc3d="canvas"]').getAttribute("data-size")) ?? "").toBe("1200,700,2000");

  // Offline / same-origin proof: every request since the upload went to this site, and the OCR files came from /ocr.
  const during = requests.slice(before);
  const origin = new URL(page.url()).origin;
  const foreign = during.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:"));
  expect(foreign).toEqual([]);
  for (const f of ["/ocr/worker.min.js", "/ocr/eng.traineddata.gz"]) expect(during.some((u) => u.includes(f)), f).toBe(true);
  expect(during.some((u) => /\/ocr\/tesseract-core[^/]*lstm\.wasm\.js/.test(u))).toBe(true);
  await panel.evaluate((el) => { el.scrollTop = 0; });
  await shot(page, "30-ocr-image.png");

  // Scanned PDF: a PDF that only holds the picture, no text layer.
  const scan = buildImagePdf(Buffer.from(sheet.jpg, "base64"), 900, 170);
  await panel.locator('[data-f="text"]').fill("");
  await panel.locator('[data-fc="file"]').setInputFiles({ name: "scan.pdf", mimeType: "application/pdf", buffer: Buffer.from(scan) });
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("Read scan.pdf from the picture: 1 of 1", { timeout: 90000 });
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel.locator('[data-fc="sources"]')).toContainText("1200 x 700 x 2000 mm");
  await expect(panel.locator('[data-fc="ocr-warning"]')).toBeVisible();

  // Full-panel placement in LTR and RTL: panel inside the screen, Fit on the opposite side of the title.
  const place = async () => {
    const pb = (await panel.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(pb.x).toBeGreaterThanOrEqual(0); expect(pb.x + pb.width).toBeLessThanOrEqual(vp.width + 1);
    const title = (await panel.locator('.obs-fc-h:has([data-act="fit"]) > span').boundingBox())!;
    const fit = (await panel.locator('[data-act="fit"]').boundingBox())!;
    return { titleX: title.x, fitX: fit.x, panelRight: pb.x + pb.width };
  };
  await panel.locator('[data-fc="preview3d"]').scrollIntoViewIfNeeded();
  const ltr = await place();
  expect(ltr.fitX).toBeGreaterThan(ltr.titleX);
  await shot(page, "31-panel-ltr.png");
  await page.evaluate(() => { document.documentElement.dir = "rtl"; document.body.dir = "rtl"; });
  await page.waitForTimeout(400);
  const rtl = await place();
  expect(rtl.fitX).toBeLessThan(rtl.titleX);
  await shot(page, "32-panel-rtl.png");
  await page.evaluate(() => { document.documentElement.dir = "ltr"; document.body.dir = "ltr"; });

  expect(errors).toEqual([]);
});

test("family creator: labelled extras from a sheet become parameters with their source line", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");
  await panel.locator('[data-f="name"]').fill("Wall shelving WS-9");
  await panel.locator('[data-f="text"]').fill("Overall size: 900 x 300 x 1800 mm\nMiddle shelves: 3\nPanel thickness: 25 mm");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel.locator('[data-param="MidShelves"]')).toHaveValue("3");
  await expect(panel.locator('[data-param="PanelThickness"]')).toHaveValue("25");
  await expect(panel.locator('[data-fc="sources"]')).toContainText("Middle shelves 3");
  await expect(panel.locator('[data-fc="sources"]')).toContainText("page 1, line 2: Middle shelves: 3");
  await expect(panel.locator('[data-fc="sources"]')).toContainText("Panel thickness 25 mm");
  await expect(panel.locator('canvas[data-fc3d="canvas"]')).toHaveAttribute("data-meshes", "8");
  await panel.locator('[data-fc="sources"]').scrollIntoViewIfNeeded();
  await shot(page, "23-extras-sources.png");
  await expect(panel.locator('[data-fc="warnings"]')).toHaveCount(0);
  await expect(panel.locator('[data-param="MidShelves"] + [data-tag]')).toHaveText("(from sheet)");
  await expect(panel.locator('[data-param="PanelThickness"] ~ [data-tag]')).toHaveText("(from sheet)");

  // A conflicting value and a value the shape does not allow are reported, and the default is tagged as a default.
  await panel.locator('[data-f="text"]').fill("Overall size: 900 x 300 x 1800 mm\nMiddle shelves: 3\nMiddle shelves: 4\nPanel thickness: 900 mm\nShelves: 5");
  await panel.getByRole("button", { name: "Create family" }).click();
  const warn = panel.locator('[data-fc="warnings"]');
  await expect(warn).toContainText("appears with different values");
  await expect(warn).toContainText("outside what this shape allows");
  await expect(warn).toContainText("could include or exclude");
  await expect(panel.locator('[data-param="MidShelves"] ~ [data-tag]')).toHaveText("(default)");
  await panel.locator('[data-param="MidShelves"]').fill("2");
  await panel.locator('[data-param="MidShelves"]').dispatchEvent("change");
  await expect(panel.locator('[data-param="MidShelves"] ~ [data-tag]')).toHaveText("(edited by you)");
  await expect(warn).toBeVisible();
  await warn.scrollIntoViewIfNeeded();
  await shot(page, "24-warnings.png");
  expect(errors).toEqual([]);
});

test("family creator: link fetch needs per-use consent, says plainly when the site has it off, and loads a sheet when on", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  const calls: string[] = [];
  let mode: "off" | "on" = "off";
  await page.route("**/api/fetch-sheet", async (route: any) => {
    calls.push(route.request().postData() || "");
    if (mode === "off") return route.fulfill({ status: 404, body: "Not found" });
    return route.fulfill({ status: 200, headers: { "content-type": "text/plain", "x-fetched-host": "vendor.example" }, body: "Wall shelving WS-9\nOverall size: 900 x 300 x 1800 mm\nMiddle shelves: 2" });
  });
  await enterAuthoring(page);
  await openCreator(page);
  const panel = page.getByTestId("family-creator-panel");
  const btn = panel.locator('[data-act="fetch-url"]');
  const url = panel.locator('[data-f="url"]');
  await url.fill("https://vendor.example/sheet.txt");
  // No consent: the button is disabled and nothing is sent.
  await expect(btn).toBeDisabled();
  await expect(panel.locator('[data-fc="url-box"]')).toContainText("The site's operator can see the link");
  await panel.locator('[data-fc="url-consent"]').check();
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(panel.locator('[data-fc="url-note"]')).toContainText("not switched on for this site");
  expect(calls.length).toBe(1);
  expect(JSON.parse(calls[0])).toEqual({ url: "https://vendor.example/sheet.txt", consent: true });
  // Consent is per use: it is cleared after the attempt.
  await expect(panel.locator('[data-fc="url-consent"]')).not.toBeChecked();
  await expect(btn).toBeDisabled();
  await shot(page, "40-url-off.png");
  mode = "on";
  await panel.locator('[data-fc="url-consent"]').check();
  await btn.click();
  await expect(panel.locator('[data-fc="file-note"]')).toContainText("sheet.txt");
  await expect(panel.locator('[data-fc="url-note"]')).toContainText("Fetched from vendor.example");
  await panel.locator('[data-f="name"]').fill("Wall shelving WS-9");
  await panel.getByRole("button", { name: "Create family" }).click();
  await expect(panel.locator('[data-param="MidShelves"] ~ [data-tag]')).toHaveText("(from sheet)");
  expect(calls.length).toBe(2);
  await expect(panel.locator('[data-fc="url-consent"]')).not.toBeChecked();
  await shot(page, "41-url-on.png");
  expect(errors).toEqual([]);
});
