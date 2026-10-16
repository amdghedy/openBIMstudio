/**
 * PDF export - converts a Scene2D to a pdf-lib PDF page.
 *
 * pdf-lib does not have canvas-style stateful setters (setStrokeColor etc).
 * Stroke / fill / dash are passed as options on every drawing call.
 */

import { PDFDocument, PDFPage, PDFFont, StandardFonts, rgb } from "pdf-lib";
import type { Scene2D, SceneEntity, StrokeStyle } from "../views/scene";

const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;
export const MM_TO_PT = PT_PER_INCH / MM_PER_INCH;   // ~= 2.8346

interface PdfPageContext {
  page: PDFPage;
  font: PDFFont;
  boldFont: PDFFont;
  worldToPt: number;
  originX: number;
  originY: number;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
  };
}

interface StrokeOpts {
  color: ReturnType<typeof rgb>;
  thickness: number;
  dashArray?: number[];
}

function strokeOptions(stroke: StrokeStyle): StrokeOpts {
  const c = hexToRgb(stroke.color);
  const opts: StrokeOpts = {
    color: rgb(c.r, c.g, c.b),
    thickness: Math.max(0.1, stroke.widthPt),
  };
  if (stroke.dash && stroke.dash.length) {
    opts.dashArray = stroke.dash.map((d) => d * MM_TO_PT);
  }
  return opts;
}

function worldToPdf(ctx: PdfPageContext, worldX: number, worldY: number): [number, number] {
  return [
    ctx.originX + worldX * ctx.worldToPt,
    ctx.originY + worldY * ctx.worldToPt,
  ];
}

export function drawScene2DToPdf(
  page: PDFPage,
  font: PDFFont,
  boldFont: PDFFont | null,
  scene: Scene2D,
  worldToPt: number,
  originX: number,
  originY: number,
): void {
  const ctx: PdfPageContext = {
    page,
    font,
    boldFont: boldFont ?? font,
    worldToPt,
    originX,
    originY,
  };

  const layers: Array<{ name: string; entities: SceneEntity[] }> = [
    { name: "below",      entities: scene.layers.below },
    { name: "grid",       entities: scene.layers.grid },
    { name: "project",    entities: scene.layers.project },
    { name: "overhead",   entities: scene.layers.overhead },
    { name: "cut",        entities: scene.layers.cut },
    { name: "symbols",    entities: scene.layers.symbols },
    { name: "annotation", entities: scene.layers.annotation },
  ];

  for (const layer of layers) {
    for (const e of layer.entities) {
      drawEntity(ctx, e);
    }
  }
}

function drawEntity(ctx: PdfPageContext, e: SceneEntity): void {
  switch (e.kind) {
    case "line": {
      const [x1, y1] = worldToPdf(ctx, e.x1, -e.z1);
      const [x2, y2] = worldToPdf(ctx, e.x2, -e.z2);
      const s = strokeOptions(e.stroke);
      ctx.page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: s.thickness,
        color: s.color,
        dashArray: s.dashArray,
      });
      break;
    }
    case "polyline": {
      const pts = e.points.map(([x, z]) => worldToPdf(ctx, x, -z));
      if (pts.length < 2) return;
      const s = strokeOptions(e.stroke);

      // Fill first (if any) - draw as a filled SVG path
      if (e.fill && pts.length >= 3) {
        const c = hexToRgb(e.fill.color);
        const d =
          pts.map((p, i) => (i === 0 ? "M " : "L ") + p[0].toFixed(3) + " " + p[1].toFixed(3)).join(" ") +
          (e.closed ? " Z" : "");
        ctx.page.drawSvgPath(d, {
          x: 0,
          y: 0,
          color: rgb(c.r, c.g, c.b),
          opacity: e.fill.opacity ?? 1,
        });
      }

      // Outline strokes
      for (let i = 0; i < pts.length - 1; i++) {
        ctx.page.drawLine({
          start: { x: pts[i][0], y: pts[i][1] },
          end: { x: pts[i + 1][0], y: pts[i + 1][1] },
          thickness: s.thickness,
          color: s.color,
          dashArray: s.dashArray,
        });
      }
      if (e.closed && pts.length >= 3) {
        ctx.page.drawLine({
          start: { x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] },
          end: { x: pts[0][0], y: pts[0][1] },
          thickness: s.thickness,
          color: s.color,
          dashArray: s.dashArray,
        });
      }
      break;
    }
    case "arc": {
      const s = strokeOptions(e.stroke);
      const steps = Math.max(8, Math.floor(Math.abs(e.a1 - e.a0) / 0.15));
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= steps; i++) {
        const a = e.a0 + (e.a1 - e.a0) * (i / steps);
        const wx = e.cx + Math.cos(a) * e.r;
        const wz = e.cz + Math.sin(a) * e.r;
        pts.push(worldToPdf(ctx, wx, -wz));
      }
      for (let i = 0; i < pts.length - 1; i++) {
        ctx.page.drawLine({
          start: { x: pts[i][0], y: pts[i][1] },
          end: { x: pts[i + 1][0], y: pts[i + 1][1] },
          thickness: s.thickness,
          color: s.color,
          dashArray: s.dashArray,
        });
      }
      break;
    }
    case "circle": {
      const [cx, cy] = worldToPdf(ctx, e.cx, -e.cz);
      const rPt = e.r * ctx.worldToPt;
      const s = strokeOptions(e.stroke);
      const opts: any = {
        x: cx,
        y: cy,
        xScale: rPt,
        yScale: rPt,
        borderWidth: s.thickness,
        borderColor: s.color,
      };
      if (e.fill) {
        const c = hexToRgb(e.fill.color);
        opts.color = rgb(c.r, c.g, c.b);
        opts.opacity = e.fill.opacity ?? 1;
      }
      if (s.dashArray) opts.borderDashArray = s.dashArray;
      ctx.page.drawEllipse(opts);
      break;
    }
    case "text": {
      const [tx, ty] = worldToPdf(ctx, e.x, -e.z);
      const fontSize = Math.max(4, e.sizePt * MM_TO_PT);
      const c = hexToRgb(e.color);
      const anchor = e.anchor ?? "start";
      const textWidth = ctx.font.widthOfTextAtSize(e.text, fontSize);
      let drawX = tx;
      if (anchor === "middle") drawX = tx - textWidth / 2;
      else if (anchor === "end") drawX = tx - textWidth;
      ctx.page.drawText(e.text, {
        x: drawX,
        y: ty - fontSize / 3,
        size: fontSize,
        font: ctx.font,
        color: rgb(c.r, c.g, c.b),
      });
      break;
    }
    default:
      break;
  }
}

export async function createPdfDocument(): Promise<{
  doc: PDFDocument;
  regular: PDFFont;
  bold: PDFFont;
}> {
  const doc = await PDFDocument.create();
  doc.setCreator("Open BIM Studio");
  doc.setProducer("Open BIM Studio PDF exporter");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, regular, bold };
}

export async function savePdfBytes(doc: PDFDocument): Promise<Uint8Array> {
  return await doc.save();
}

export async function downloadPdf(doc: PDFDocument, filename: string): Promise<void> {
  const bytes = await doc.save();
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}