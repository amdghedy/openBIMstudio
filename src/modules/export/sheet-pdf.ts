/**
 * Sheet PDF composition - draws a titleblocked sheet with viewports.
 *
 * All strokes / fills are passed as options on each pdf-lib call.
 */

import { rgb, PDFPage, PDFFont } from "pdf-lib";
import type { SheetDef, SheetViewport } from "../projects/types";
import { getSheet, getSheetSizeMm } from "../sheets/sheets";
import { getView } from "../views/store";
import { generatePlanScene } from "../views/generators/plan";
import { generateSectionScene } from "../views/generators/section";
import { generateElevationScene } from "../views/generators/elevation";
import { buildAnnotationLayer } from "../views/annotation-layer";
import { emptyScene, type Scene2D } from "../views/scene";
import { createPdfDocument, drawScene2DToPdf, MM_TO_PT, downloadPdf } from "./pdf";

async function sceneForView(viewId: string): Promise<Scene2D> {
  const v = getView(viewId);
  if (!v) return emptyScene();
  let scene: Scene2D;
  if (v.kind === "plan" || v.kind === "rcp") scene = await generatePlanScene(v);
  else if (v.kind === "section") scene = await generateSectionScene(v);
  else if (v.kind === "elevation") scene = await generateElevationScene(v);
  else scene = emptyScene();
  const ann = buildAnnotationLayer(v.id, v.scale);
  scene.layers.annotation = ann.entities;
  return scene;
}

function parseScale(s: string | number | undefined, fallback = 100): number {
  if (typeof s === "number" && Number.isFinite(s) && s > 0) return s;
  if (typeof s === "string") {
    const m = s.match(/1\s*:\s*(\d+(?:\.\d+)?)/);
    if (m) return parseFloat(m[1]);
    const n = parseFloat(s);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function sizeMmH(sheet: SheetDef): number {
  return getSheetSizeMm(sheet.size, sheet.orientation).h;
}

async function drawViewportOnPage(
  page: PDFPage,
  sheet: SheetDef,
  vp: SheetViewport,
  pageH: number,
  regular: PDFFont,
  bold: PDFFont,
): Promise<void> {
  const view = getView(vp.viewId);
  if (!view) {
    page.drawRectangle({
      x: vp.x * MM_TO_PT,
      y: pageH - (vp.y + vp.height) * MM_TO_PT,
      width: vp.width * MM_TO_PT,
      height: vp.height * MM_TO_PT,
      borderWidth: 0.5,
      borderColor: rgb(0.8, 0.2, 0.2),
      borderDashArray: [3, 2],
    });
    return;
  }

  const scaleDenom = parseScale(vp.scale, view.scale);
  const worldW = (vp.width * scaleDenom) / 1000;
  const worldToPt = (vp.width * MM_TO_PT) / worldW;   // points per metre

  const scene = await sceneForView(vp.viewId);
  const sceneCx = (scene.bounds.minX + scene.bounds.maxX) / 2;
  const sceneCz = (scene.bounds.minZ + scene.bounds.maxZ) / 2;

  const vpCxMm = vp.x + vp.width / 2;
  const vpCyTopDown = vp.y + vp.height / 2;
  const vpCyBottomUpPt = (sizeMmH(sheet) - vpCyTopDown) * MM_TO_PT;

  const originX = vpCxMm * MM_TO_PT - sceneCx * worldToPt;
  const originY = vpCyBottomUpPt - (-sceneCz) * worldToPt;

  drawScene2DToPdf(page, regular, bold, scene, worldToPt, originX, originY);

  // Viewport border
  page.drawRectangle({
    x: vp.x * MM_TO_PT,
    y: pageH - (vp.y + vp.height) * MM_TO_PT,
    width: vp.width * MM_TO_PT,
    height: vp.height * MM_TO_PT,
    borderWidth: 0.3,
    borderColor: rgb(0.2, 0.25, 0.3),
  });

  // Viewport label
  page.drawText((vp.title || view.name) + " - " + (vp.scale || "1:" + view.scale), {
    x: vp.x * MM_TO_PT,
    y: pageH - vp.y * MM_TO_PT + 3,
    size: 6,
    font: bold,
    color: rgb(0.2, 0.25, 0.3),
  });
}

function drawTitleblock(
  page: PDFPage,
  sheet: SheetDef,
  pageW: number,
  pageH: number,
  regular: PDFFont,
  bold: PDFFont,
): void {
  void pageH;
  const tbW = 180 * MM_TO_PT;
  const tbH = 40 * MM_TO_PT;
  const margin = 6 * MM_TO_PT;
  const tbX = pageW - margin - tbW;
  const tbY = margin;

  page.drawRectangle({
    x: tbX,
    y: tbY,
    width: tbW,
    height: tbH,
    borderWidth: 0.4,
    borderColor: rgb(0.06, 0.09, 0.16),
    color: rgb(0.97, 0.98, 0.99),
  });

  const pad = 3 * MM_TO_PT;
  page.drawText("Sheet: " + sheet.number, {
    x: tbX + pad,
    y: tbY + tbH - 8 * MM_TO_PT,
    size: 7,
    font: bold,
    color: rgb(0.06, 0.09, 0.16),
  });
  page.drawText(sheet.name, {
    x: tbX + pad,
    y: tbY + tbH - 14 * MM_TO_PT,
    size: 6,
    font: regular,
    color: rgb(0.06, 0.09, 0.16),
  });
  page.drawText("Scale: as noted", {
    x: tbX + pad,
    y: tbY + tbH - 20 * MM_TO_PT,
    size: 5,
    font: regular,
    color: rgb(0.3, 0.35, 0.42),
  });
  page.drawText("Date: " + new Date().toISOString().slice(0, 10), {
    x: tbX + pad,
    y: tbY + tbH - 25 * MM_TO_PT,
    size: 5,
    font: regular,
    color: rgb(0.3, 0.35, 0.42),
  });
  page.drawText("Open BIM Studio", {
    x: tbX + pad,
    y: tbY + tbH - 32 * MM_TO_PT,
    size: 4,
    font: regular,
    color: rgb(0.6, 0.65, 0.7),
  });
}

export async function exportSheetToPdf(sheetId: string): Promise<Uint8Array | null> {
  const sheet = getSheet(sheetId);
  if (!sheet) return null;
  const { doc, regular, bold } = await createPdfDocument();

  const sizeMm = getSheetSizeMm(sheet.size, sheet.orientation);
  const pageW = sizeMm.w * MM_TO_PT;
  const pageH = sizeMm.h * MM_TO_PT;
  const page = doc.addPage([pageW, pageH]);

  page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(1, 1, 1) });

  const margin = 6;
  page.drawRectangle({
    x: margin * MM_TO_PT,
    y: margin * MM_TO_PT,
    width: (sizeMm.w - margin * 2) * MM_TO_PT,
    height: (sizeMm.h - margin * 2) * MM_TO_PT,
    borderWidth: 0.5,
    borderColor: rgb(0.06, 0.09, 0.16),
  });

  for (const vp of sheet.viewports) {
    await drawViewportOnPage(page, sheet, vp, pageH, regular, bold);
  }
  drawTitleblock(page, sheet, pageW, pageH, regular, bold);

  return await doc.save();
}

export async function exportAllSheetsToPdf(
  sheets: SheetDef[],
  filename = "open-bim-studio-sheets.pdf",
): Promise<void> {
  const { doc, regular, bold } = await createPdfDocument();

  for (const sheet of sheets) {
    const sizeMm = getSheetSizeMm(sheet.size, sheet.orientation);
    const pageW = sizeMm.w * MM_TO_PT;
    const pageH = sizeMm.h * MM_TO_PT;
    const page = doc.addPage([pageW, pageH]);

    page.drawRectangle({ x: 0, y: 0, width: pageW, height: pageH, color: rgb(1, 1, 1) });

    const margin = 6;
    page.drawRectangle({
      x: margin * MM_TO_PT,
      y: margin * MM_TO_PT,
      width: (sizeMm.w - margin * 2) * MM_TO_PT,
      height: (sizeMm.h - margin * 2) * MM_TO_PT,
      borderWidth: 0.5,
      borderColor: rgb(0.06, 0.09, 0.16),
    });

    for (const vp of sheet.viewports) {
      await drawViewportOnPage(page, sheet, vp, pageH, regular, bold);
    }
    drawTitleblock(page, sheet, pageW, pageH, regular, bold);
  }

  await downloadPdf(doc, filename);
}

export async function downloadSingleSheetPdf(sheetId: string): Promise<void> {
  const sheet = getSheet(sheetId);
  if (!sheet) return;
  const bytes = await exportSheetToPdf(sheetId);
  if (!bytes) return;
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sheet.number.replace(/[^a-z0-9-]/gi, "_") + ".pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}