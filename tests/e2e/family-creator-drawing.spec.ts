/**
 * tests/e2e/family-creator-drawing.spec.ts
 *
 * "Drawing to parts" section of the Family Creator (early prototype): a picture with a side view and an
 * end view, one entered length, parts read from the line work, each part tagged read / assumed, the person
 * confirms parts, IFC download. Revit is NOT exercised.
 *
 * Real manufacturer drawings are not stored in the repo. Set FC_DRAWINGS=/dir holding canopy.png (KJDD220)
 * and canopy400.png (KJDD400) to run the second test. Set FC_SHOTS=/dir to keep screenshots and IFC files.
 */
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

test.setTimeout(240000);
const SHOTS = process.env.FC_SHOTS, DRAW = process.env.FC_DRAWINGS;
const shot = async (page: any, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };

async function enterAuthoring(page: any) {
  await page.goto("/");
  const card = page.locator('.obs-workspace-card[data-workspace="authoring"]');
  await card.waitFor({ state: "visible", timeout: 90000 });
  await card.click();
  await page.waitForFunction(() => (window as any).__obsAuthoring && document.querySelector("canvas"), undefined, { timeout: 90000 });
}
async function openCreator(page: any) {
  const tabs: string[] = await page.evaluate(() => [...document.querySelectorAll(".obs-ribbon__tab")].map((x) => (x as HTMLElement).dataset.tab ?? ""));
  for (const t of [...tabs.filter((x) => x === "manage"), ...tabs.filter((x) => x !== "manage")]) {
    await page.evaluate((id: string) => (document.querySelector(`.obs-ribbon__tab[data-tab="${id}"]`) as HTMLElement).click(), t);
    await page.waitForTimeout(400);
    const btn = page.getByRole("button", { name: "Family Creator" });
    if (await btn.first().isVisible().catch(() => false)) { await btn.first().click(); break; }
  }
  await page.getByTestId("family-creator-panel").waitFor({ state: "visible", timeout: 10000 });
}

/** Minimal PNG writer (RGBA) so the spec needs no image library. */
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** Cabinet 2000 x 1000 x 600 mm at 2 mm/px: side view with two doors, end view with two louvre grilles, red dimension lines. */
function syntheticSheet(): Buffer {
  const W = 1800, H = 520, gy = 480, img = new Uint8Array(W * H * 4).fill(255);
  const px = (x: number, y: number, c: number[]) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; img[i] = c[0]; img[i + 1] = c[1]; img[i + 2] = c[2]; };
  const K = [20, 20, 20];
  const rect = (x0: number, y0: number, x1: number, y1: number) => { for (let x = x0; x <= x1; x++) for (let k = 0; k < 2; k++) { px(x, y0 + k, K); px(x, y1 - k, K); } for (let y = y0; y <= y1; y++) for (let k = 0; k < 2; k++) { px(x0 + k, y, K); px(x1 - k, y, K); } };
  const hatch = (x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x++) { px(x, y, K); px(x, y + 1, K); } };
  const bx0 = 40, bx1 = 1039, by1 = gy - 101, by0 = by1 - 300;
  rect(bx0, by0, bx1, by1); rect(bx0 + 100, by0 + 40, bx0 + 400, by1 - 20); rect(bx0 + 450, by0 + 40, bx0 + 900, by1 - 20);
  rect(bx0 + 100, by1 + 1, bx1 - 100, gy - 20); rect(bx0 + 150, gy - 19, bx0 + 170, gy); rect(bx0 + 800 + 30, gy - 19, bx0 + 850, gy);
  const ex0 = 1200, ex1 = ex0 + 499;
  rect(ex0, by0, ex1, by1);
  for (const dy of [30, 150]) { rect(ex0 + 30, by0 + dy, ex1 - 30, by0 + dy + 60); hatch(ex0 + 31, by0 + dy + 1, ex1 - 31, by0 + dy + 59); }
  rect(ex0 + 20, by1 + 1, ex1 - 20, gy - 20);
  for (let x = 20; x < 1780; x++) px(x, 510, [230, 0, 0]);
  return png(W, H, img);
}

const panelText = (page: any) => page.getByTestId("family-creator-panel");

test("drawing to parts: enter one length, read, confirm parts, honest labels, IFC download", async ({ page }, info) => {
  await enterAuthoring(page); await openCreator(page);
  const dir = fs.mkdtempSync(path.join(info.outputDir.replace(/[^/]*$/, ""), "fc-draw-")); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cabinet.png"); fs.writeFileSync(file, syntheticSheet());
  const drawing = page.locator('[data-fc="drawing"]');
  await drawing.scrollIntoViewIfNeeded();
  // No picture and no length: a plain message, no fake result.
  await drawing.locator('[data-dact="read"]').click();
  await expect(drawing.locator('[data-fc="drawing-error"]')).toContainText("Choose a drawing picture");
  await drawing.locator("[data-dfile]").setInputFiles(file);
  await expect(drawing.locator('[data-fc="drawing-file"]')).toContainText("cabinet.png");
  await drawing.locator('[data-dact="read"]').click();
  await expect(drawing.locator('[data-fc="drawing-error"]')).toContainText("overall length");
  await drawing.locator('[data-dfield="length"]').fill("2000");
  await drawing.locator('[data-dfield="width"]').fill("1000");
  await drawing.locator('[data-dfield="height"]').fill("1300");
  await drawing.locator('[data-dact="read"]').click();
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toBeVisible({ timeout: 60000 });
  // Dimensions: length entered, width and height only checked, never called read from the picture.
  const dims = drawing.locator('[data-fc="drawing-dims"]');
  await expect(dims).toContainText("entered"); await expect(dims).toContainText("checked: about");
  // Parts say what was read and what was assumed; the unknowns are listed, the far side is not claimed empty.
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toContainText("estimated from the picture");
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toContainText("thickness: assumed");
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toContainText("placed on");
  await expect(drawing.locator('[data-fc="drawing-unknown"]')).toContainText("opposite");
  await expect(drawing.locator('[data-fc="drawing-unknown"]')).toContainText("Which end");
  const n = await drawing.locator("[data-dpart-use]").count();
  expect(n).toBeGreaterThanOrEqual(6);
  const grilles = await drawing.locator('[data-fc-drow]', { hasText: "End grille" }).count();
  expect(grilles).toBe(2);
  await shot(page, "drawing-synthetic-read.png");
  // Leave one part out by clicking its list box; the count and the export follow.
  await drawing.locator("[data-dpart-use]").first().uncheck();
  await expect(drawing.locator('[data-fc="drawing-parts"] .obs-fc-h')).toContainText(`${n - 1} of ${n} selected, not confirmed yet`);
  await expect(drawing.locator('[data-dact="ifc"]')).toBeDisabled();
  // Changing a setting marks the shown parts stale instead of silently keeping them.
  await drawing.locator('[data-dfield="endFace"]').selectOption("end");
  await expect(drawing.locator('[data-fc="drawing-stale"]')).toBeVisible();
  await drawing.locator('[data-dact="read"]').click();
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toContainText("the far end", { timeout: 60000 });
  // Export needs an explicit confirmation; changing the selection takes it back.
  await expect(drawing.locator('[data-dact="ifc"]')).toBeDisabled();
  await drawing.locator('[data-dact="confirm"]').click();
  await expect(drawing.locator('[data-fc="drawing-parts"] .obs-fc-h')).toContainText("confirmed");
  await expect(drawing.locator('[data-fc="drawing-parts"] .obs-fc-h')).not.toContainText("not confirmed");
  await drawing.locator("[data-dpart-use]").nth(1).uncheck();
  await expect(drawing.locator('[data-fc="drawing-parts"] .obs-fc-h')).toContainText("not confirmed yet");
  await expect(drawing.locator('[data-dact="ifc"]')).toBeDisabled();
  await drawing.locator("[data-dpart-use]").nth(1).check();
  await drawing.locator('[data-dact="confirm"]').click();
  await expect(drawing.locator('[data-fc="drawing-views-pick"]')).toContainText("views found in the picture");
  await expect(drawing.locator('[data-fc="drawing-dims-why"]')).toContainText("hinges");
  const dl = page.waitForEvent("download");
  await drawing.locator('[data-dact="ifc"]').click();
  const d = await dl; const out = path.join(dir, "out.ifc"); await d.saveAs(out);
  const txt = fs.readFileSync(out, "utf8");
  expect(txt).toContain("FILE_SCHEMA(('IFC2X3'))");
  expect(txt.match(/IFCBUILDINGELEMENTPROXY\(/g)?.length ?? 0).toBe(1);
  await expect(drawing.locator('[data-fc="drawing-notice"]')).toContainText("confirmed parts");
  await expect(drawing.locator('[data-fc="drawing-export-note"]')).toContainText("Revit has not been tested");
  if (SHOTS) fs.copyFileSync(out, path.join(SHOTS, "synthetic-cabinet.ifc"));
});

test("drawing to parts: two real manufacturer drawings through the same code", async ({ page }) => {
  test.skip(!DRAW || !fs.existsSync(path.join(DRAW, "canopy.png")), "set FC_DRAWINGS to a folder with canopy.png and canopy400.png");
  await enterAuthoring(page); await openCreator(page);
  const cases = [
    { file: "canopy.png", len: "3525", wid: "1150", hei: "1980", pipe: "101", grilles: 4, bad: false, shot: "drawing-kjdd220" },
    { file: "canopy400.png", len: "4150", wid: "1600", hei: "2310", pipe: "127", grilles: 12, bad: false, shot: "drawing-kjdd400" },
    { file: "open.png", len: "2880", wid: "1150", hei: "1615", pipe: "", grilles: -1, bad: true, shot: "drawing-open" },
    { file: "cummins.png", len: "5093", wid: "", hei: "2375", pipe: "", grilles: -1, bad: true, shot: "drawing-cummins" },
    { file: "cummins-clean.png", len: "5093", wid: "", hei: "2375", pipe: "", grilles: -1, bad: true, shot: "drawing-cummins-clean" },
  ].filter((c) => !process.env.FC_ONLY || c.shot.endsWith(process.env.FC_ONLY));
  for (const c of cases) {
    const drawing = page.locator('[data-fc="drawing"]');
    await expect(drawing).toBeVisible(); await page.waitForTimeout(1500); // the panel re-renders once after opening
    await drawing.scrollIntoViewIfNeeded();
    await drawing.locator("[data-dfile]").setInputFiles(path.join(DRAW!, c.file));
    await expect(drawing.locator('[data-fc="drawing-file"]')).toContainText(c.file);
    // Switching files clears the numbers of the previous drawing: nothing is carried over silently.
    await expect(drawing.locator('[data-dfield="length"]')).toHaveValue("");
    await expect(drawing.locator('[data-dfield="height"]')).toHaveValue("");
    if (c.crop) for (const [k, v] of Object.entries(c.crop)) await drawing.locator(`[data-dcrop="${k}"]`).fill(v);
    await drawing.locator('[data-dfield="length"]').fill(c.len);
    await drawing.locator('[data-dfield="width"]').fill(c.wid);
    await drawing.locator('[data-dfield="height"]').fill(c.hei);
    await drawing.locator('[data-dfield="pipe"]').fill(c.pipe);
    if (!c.wid) await drawing.locator('[data-dfield="width"]').fill("");
    await drawing.locator('[data-dact="read"]').click();
    await expect(drawing.locator('[data-fc="drawing-parts"]')).toBeVisible({ timeout: 120000 });
    await expect(drawing.locator('[data-fc="drawing-dims"]')).toContainText(`${c.len} mm`);
    await expect(drawing.locator('[data-fc="drawing-dims"] tr', { hasText: "Height" })).toContainText(`${c.hei} mm`);
    // A reading that disagrees with the entered size must say so, and must not count as a success.
    expect(await drawing.locator('[data-fc="drawing-quality"]').count()).toBe(c.bad ? 1 : 0);
    if (c.grilles >= 0) {
      expect(await drawing.locator('[data-fc-drow]', { hasText: "grille" }).count()).toBe(c.grilles);
      expect(await drawing.locator('[data-fc-drow]', { hasText: "Pipe above" }).count()).toBe(1);
    }
    await drawing.locator('[data-fc="drawing-3d"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1200);
    await shot(page, `${c.shot}-3d.png`);
    await page.waitForTimeout(1500);
    for (const [loc, nm] of [['[data-fc="drawing-overlay"]', "a-overlay"], ['[data-fc="drawing-parts"] .obs-fc-h', "b-parts-header"], ['[data-fc="drawing-3d"]', "c-3d"]] as const) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await drawing.locator(loc).first().screenshot({ path: path.join(SHOTS, `${c.shot}-preview-${nm}.png`) }); } }
    await drawing.locator('[data-dact="confirm"]').click();
    await drawing.locator('[data-fc="drawing-overlay"]').scrollIntoViewIfNeeded();
    await shot(page, `${c.shot}-overlay.png`);
    await drawing.locator('[data-fc="drawing-views"]').scrollIntoViewIfNeeded();
    await shot(page, `${c.shot}-views.png`);
    const dl = page.waitForEvent("download");
    await drawing.locator('[data-dact="ifc"]').click();
    const d = await dl; if (SHOTS) await d.saveAs(path.join(SHOTS, `${c.shot}.ifc`));
  }
});

test("drawing to parts: drag a rectangle on the picture to crop, fields follow, reset restores", async ({ page }, info) => {
  await enterAuthoring(page); await openCreator(page);
  const dir = fs.mkdtempSync(path.join(info.outputDir.replace(/[^/]*$/, ""), "fc-crop-")); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cabinet.png"); fs.writeFileSync(file, syntheticSheet());
  const drawing = page.locator('[data-fc="drawing"]');
  await drawing.scrollIntoViewIfNeeded();
  await drawing.locator("[data-dfile]").setInputFiles(file);
  const pick = drawing.locator('[data-fc="drawing-crop-pick"]');
  await expect(pick).toBeVisible();
  await pick.scrollIntoViewIfNeeded();
  const bb = (await pick.boundingBox())!;
  // Drag from 10% / 5% to 90% / 95% of the picture.
  await page.mouse.move(bb.x + bb.width * 0.1, bb.y + bb.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height * 0.5, { steps: 5 });
  await page.mouse.move(bb.x + bb.width * 0.9, bb.y + bb.height * 0.95, { steps: 5 });
  await page.mouse.up();
  const v = async (k: string) => Number(await drawing.locator(`[data-dcrop="${k}"]`).inputValue());
  expect(Math.abs((await v("l")) - 10)).toBeLessThan(1.5); expect(Math.abs((await v("r")) - 10)).toBeLessThan(1.5);
  expect(Math.abs((await v("t")) - 5)).toBeLessThan(1.5); expect(Math.abs((await v("b")) - 5)).toBeLessThan(1.5);
  await shot(page, "drawing-crop-dragged.png");
  // A click without a drag keeps the crop; the reset button clears all four fields.
  await pick.click({ position: { x: 20, y: 20 } });
  expect(Math.abs((await v("l")) - 10)).toBeLessThan(1.5);
  await drawing.locator("[data-dcrop-reset]").click();
  for (const k of ["l", "r", "t", "b"]) await expect(drawing.locator(`[data-dcrop="${k}"]`)).toHaveValue("");
});

test("drawing to parts: draw the side view and end view boxes by hand; both are needed; the read uses them", async ({ page }, info) => {
  await enterAuthoring(page); await openCreator(page);
  const dir = fs.mkdtempSync(path.join(info.outputDir.replace(/[^/]*$/, ""), "fc-vb-")); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "cabinet.png"); fs.writeFileSync(file, syntheticSheet());
  const drawing = page.locator('[data-fc="drawing"]');
  await expect(drawing).toBeVisible(); await page.waitForTimeout(1500); await drawing.scrollIntoViewIfNeeded();
  await drawing.locator("[data-dfile]").setInputFiles(file);
  const pick = drawing.locator('[data-fc="drawing-crop-pick"]'); await pick.scrollIntoViewIfNeeded();
  const bb = (await pick.boundingBox())!;
  const drag = async (a: number[], b: number[]) => { await page.mouse.move(bb.x + bb.width * a[0], bb.y + bb.height * a[1]); await page.mouse.down(); await page.mouse.move(bb.x + bb.width * b[0], bb.y + bb.height * b[1], { steps: 4 }); await page.mouse.up(); };
  await drawing.locator('[data-dfield="length"]').fill("2000");
  // Side view only: not enough, the automatic views stay.
  await drawing.locator('[data-dfield="mode"]').selectOption("side");
  await drag([0.01, 0.02], [0.6, 0.98]);
  await expect(drawing.locator('[data-fc="drawing-vbox-side"]')).toBeVisible();
  await expect(drawing.locator('[data-fc="drawing-vb-state"]')).toContainText("One view box");
  await drawing.locator('[data-dfield="mode"]').selectOption("end");
  await drag([0.62, 0.02], [0.99, 0.98]);
  await expect(drawing.locator('[data-fc="drawing-vb-state"]')).toContainText("Both view boxes");
  await drawing.locator('[data-dact="read"]').click();
  await expect(drawing.locator('[data-fc="drawing-parts"]')).toBeVisible({ timeout: 60000 });
  await expect(drawing.locator('[data-fc="drawing-warnings"]')).toContainText("boxes drawn by the person");
  await shot(page, "drawing-view-boxes.png");
  await drawing.locator("[data-dvb-reset]").click();
  await expect(drawing.locator('[data-fc="drawing-vb-state"]')).toContainText("found automatically");
});
