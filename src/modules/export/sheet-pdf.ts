/**
 * Sheet PDF composition - draws a titleblocked sheet with viewports.
 *
 * All strokes / fills are passed as options on each pdf-lib call.
 */

import { rgb, PDFPage, PDFFont } from "pdf-lib";
import type { SheetDef, SheetViewport } from "../projects/types";
import { getSheet, getSheetSizeMm, listTitleblocks } from "../sheets/sheets";
import {
  SCALE_BAR_HEIGHT_MM, SCALE_BAR_LABEL_GAP_MM, northArrowGeometry, northArrowPlacement,
  scaleBarLayout, sheetIdentityText, titleblockRows, viewTitleText, viewportCaptionY,
} from "../sheets/sheet-furniture";
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

  // Revit-style caption below the viewport: name · scale, with a graphic scale bar
  const sheetHMm = sizeMmH(sheet);
  const drawingBottomMm = sheetHMm - 6; // page margin
  const caption = viewportCaptionY(vp.y + vp.height, drawingBottomMm);
  const captionTitle = viewTitleText(vp, view.name);
  page.drawText(captionTitle, {
    x: vp.x * MM_TO_PT,
    y: pageH - caption.titleY * MM_TO_PT,
    size: 6,
    font: bold,
    color: rgb(0.2, 0.25, 0.3),
  });

  const layout = scaleBarLayout(scaleDenom);
  if (vp.width >= layout.barLengthMm + 2 && caption.barBaselineY < drawingBottomMm) {
    const barX = (vp.x + 2) * MM_TO_PT;
    const barBottomY = pageH - caption.barBaselineY * MM_TO_PT;
    const segW = layout.segmentMm * MM_TO_PT;
    const segH = SCALE_BAR_HEIGHT_MM * MM_TO_PT;
    for (let i = 0; i < layout.segments; i++) {
      page.drawRectangle({
        x: barX + i * segW,
        y: barBottomY,
        width: segW,
        height: segH,
        borderWidth: 0.25,
        borderColor: rgb(0.06, 0.09, 0.16),
        color: layout.filled[i] ? rgb(0.06, 0.09, 0.16) : rgb(1, 1, 1),
      });
    }
    for (const l of layout.labels) {
      const size = 4.5;
      const wPx = regular.widthOfTextAtSize(l.text, size);
      const x = barX + l.offsetMm * MM_TO_PT - (l.offsetMm > 0 ? wPx / 2 : 0);
      page.drawText(l.text, {
        x,
        y: barBottomY + segH + SCALE_BAR_LABEL_GAP_MM * MM_TO_PT,
        size,
        font: regular,
        color: rgb(0.06, 0.09, 0.16),
      });
    }
  }
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

  // The sheet's own editable titleblock is the source of truth — no more
  // hardcoded "Scale: as noted". Live overrides: sheet scales, today's date.
  const tb = listTitleblocks().find((t) => t.id === sheet.titleblockId);
  const today = new Date().toISOString().slice(0, 10);
  const rows = titleblockRows(tb, sheet, today, sheet.viewports.map((v) => v.scale));

  const pad = 3 * MM_TO_PT;
  const projectRow = rows.find((r) => r.label.trim().toLowerCase() === "project");
  if (projectRow && projectRow.value && projectRow.value !== "—") {
    page.drawText(projectRow.value, {
      x: tbX + pad,
      y: tbY + tbH - 8 * MM_TO_PT,
      size: 7.5,
      font: bold,
      color: rgb(0.06, 0.09, 0.16),
    });
  }
  page.drawText(sheetIdentityText(sheet), {
    x: tbX + pad,
    y: tbY + tbH - 15 * MM_TO_PT,
    size: 9,
    font: bold,
    color: rgb(0.06, 0.09, 0.16),
  });
  page.drawText("Open BIM Studio · Production Sheet", {
    x: tbX + pad,
    y: tbY + 5 * MM_TO_PT,
    size: 4.5,
    font: regular,
    color: rgb(0.55, 0.6, 0.66),
  });

  // Field rows in two columns to the right (Project is drawn on the left)
  const fields = rows.filter((r) => r.label.trim().toLowerCase() !== "project");
  const colW = 58 * MM_TO_PT;
  const colX0 = tbX + 62 * MM_TO_PT;
  const perCol = Math.ceil(fields.length / 2);
  const labelW = 14 * MM_TO_PT;
  fields.forEach((r, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = colX0 + col * colW;
    const y = tbY + tbH - 8 * MM_TO_PT - row * 5.5 * MM_TO_PT;
    page.drawText(r.label + ":", {
      x,
      y,
      size: 4.5,
      font: bold,
      color: rgb(0.3, 0.35, 0.42),
    });
    page.drawText(r.value, {
      x: x + labelW,
      y,
      size: 4.5,
      font: regular,
      color: rgb(0.06, 0.09, 0.16),
    });
  });
}

/** North arrow at the sheet's top-right (inside the border, skipped on viewport collision). */
function drawNorthArrow(page: PDFPage, sheet: SheetDef, sizeMm: { w: number; h: number }, bold: PDFFont): void {
  const r = 8;
  const margin = 6;
  const na = northArrowPlacement(sizeMm.w, sizeMm.h, margin, r, sheet.viewports);
  if (!na.visible) return;
  const g = northArrowGeometry(r);
  const pt = (p: [number, number]) => ({
    x: (na.cx + p[0]) * MM_TO_PT,
    y: (sizeMm.h - na.cy - p[1]) * MM_TO_PT, // geometry y-negative = north/up
  });
  page.drawCircle({
    x: na.cx * MM_TO_PT,
    y: (sizeMm.h - na.cy) * MM_TO_PT,
    size: r * MM_TO_PT,
    borderWidth: 0.5,
    borderColor: rgb(0.06, 0.09, 0.16),
  });
  const lines: Array<[[number, number], [number, number]]> = [
    [g.needleTip, g.needleLeft],
    [g.needleTip, g.needleRight],
    [g.needleLeft, g.southTip],
    [g.needleRight, g.southTip],
    [g.needleTip, g.southTip],
  ];
  for (const [a, b] of lines) {
    const pa = pt(a);
    const pb = pt(b);
    page.drawLine({ start: pa, end: pb, thickness: 0.4, color: rgb(0.06, 0.09, 0.16) });
  }
  const nText = "N";
  const nSize = 5;
  const nW = bold.widthOfTextAtSize(nText, nSize);
  page.drawText(nText, {
    x: na.cx * MM_TO_PT - nW / 2,
    y: (sizeMm.h - (na.cy - r - 1.2)) * MM_TO_PT,
    size: nSize,
    font: bold,
    color: rgb(0.06, 0.09, 0.16),
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
  drawNorthArrow(page, sheet, sizeMm, bold);

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
    drawNorthArrow(page, sheet, sizeMm, bold);
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