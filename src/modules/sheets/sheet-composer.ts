/**
 * Sheet composer — renders a production sheet as WYSIWYG SVG.
 *
 * The exported sheet must be the sheet you see: real viewport geometry
 * (same render pipeline as the live panel — generateScene → annotation
 * layer → computeViewportTransform → renderSceneToSvg), the sheet's own
 * editable titleblock fields, and the standard furniture (view title
 * captions, graphic scale bars, north arrow).
 *
 * Lives outside `sheets.ts` on purpose: `sheets.ts` is the store (no view
 * imports), while this module composes stores + view generators. The one-way
 * edge composer → store keeps the module graph cycle-free.
 */
import {
  getSheet, getSheetSizeMm, listTitleblocks,
} from "./sheets";
import { getView } from "../views/store";
import { generatePlanScene } from "../views/generators/plan";
import { generateSectionScene } from "../views/generators/section";
import { generateElevationScene } from "../views/generators/elevation";
import { generateScheduleScene } from "../views/generators/schedule";
import { renderSceneToSvg } from "../views/renderers/svg";
import { buildAnnotationLayer } from "../views/annotation-layer";
import { computeViewportTransform } from "../views/sheet-layout";
import { emptyScene, type Scene2D } from "../views/scene";
import type { SheetDef, SheetViewport } from "../projects/types";
import {
  northArrowPlacement, northArrowSvg, scaleBarLayout, scaleBarSvg, sheetIdentityText,
  titleblockRows, viewTitleText, viewportCaptionY,
} from "./sheet-furniture";

const MARGIN_MM = 10;
const TITLEBLOCK_H_MM = 40;
const NORTH_ARROW_R_MM = 8;
const BAR_INSET_MM = 2;

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sceneEntityCount(scene: Scene2D): number {
  const l = scene.layers;
  return l.cut.length + l.project.length + l.overhead.length + l.below.length +
    l.grid.length + l.annotation.length + l.symbols.length;
}

/** Same pipeline as the PDF composer and the live panel: generator + annotation layer. */
async function baseSceneForView(viewId: string): Promise<Scene2D> {
  const v = getView(viewId);
  if (!v) return emptyScene();
  let scene: Scene2D;
  if (v.kind === "plan" || v.kind === "rcp") scene = await generatePlanScene(v);
  else if (v.kind === "section") scene = await generateSectionScene(v);
  else if (v.kind === "elevation") scene = await generateElevationScene(v);
  else if (v.kind === "schedule") scene = await generateScheduleScene(v);
  else scene = emptyScene();
  return scene;
}

function missingViewportSvg(vp: SheetViewport, message: string): string {
  return (
    `<rect x="${vp.x}" y="${vp.y}" width="${vp.width}" height="${vp.height}" ` +
    `fill="#fff7ed" stroke="#9a3412" stroke-width="0.5" stroke-dasharray="2 1"/>` +
    `<text x="${vp.x + vp.width / 2}" y="${vp.y + vp.height / 2}" text-anchor="middle" ` +
    `font-size="4" fill="#9a3412" font-family="sans-serif">${escapeXml(message)}</text>`
  );
}

/** Compose one viewport: clipped scene content + border + Revit-style caption + scale bar. */
async function viewportSvg(sheet: SheetDef, vp: SheetViewport, drawingBottomMm: number): Promise<string> {
  const view = getView(vp.viewId);
  const parts: string[] = [];
  let barLengthMm = 0;
  let captionTitle = "";
  let caption: { titleY: number; barBaselineY: number; clamped: boolean } | null = null;
  let scaleDenom = 100;

  if (!view) {
    parts.push(missingViewportSvg(vp, "View missing: " + vp.viewId));
  } else {
    // Annotations must be built at the viewport's EFFECTIVE scale (the scale
    // the viewport actually shows), not the view's declared scale — a
    // content-fit viewport recomputes scaleDenom from the scene bounds.
    const base = await baseSceneForView(vp.viewId);
    const tf = computeViewportTransform(vp, sheet, view, base);
    scaleDenom = tf.scaleDenom;
    const ann = buildAnnotationLayer(view.id, scaleDenom);
    const scene: Scene2D = { ...base, layers: { ...base.layers, annotation: ann.entities } };
    if (sceneEntityCount(scene) === 0) {
      parts.push(missingViewportSvg(vp, (vp.title || view.name) + " — empty view"));
    } else {
      const clipId = "vpclip-" + vp.id.replace(/[^a-z0-9-]/gi, "_");
      const sceneSvg = renderSceneToSvg(scene, {
        scale: scaleDenom,
        padding: 0,
        widthPx: tf.widthMm,
        heightPx: tf.heightMm,
      });
      parts.push(
        `<clipPath id="${clipId}"><rect x="${tf.x}" y="${tf.y}" width="${tf.widthMm}" height="${tf.heightMm}"/></clipPath>`,
      );
      parts.push(
        `<g clip-path="url(#${clipId})">` +
        `<svg x="${tf.x}" y="${tf.y}" width="${tf.widthMm}" height="${tf.heightMm}" ` +
        `viewBox="${tf.viewBox.x} ${tf.viewBox.y} ${tf.viewBox.w} ${tf.viewBox.h}" ` +
        `preserveAspectRatio="xMidYMid slice">${sceneSvg.innerHTML}</svg>` +
        `</g>`,
      );
    }
    captionTitle = viewTitleText(vp, view.name);
  }
  if (!captionTitle) captionTitle = viewTitleText(vp, vp.viewType || "View");

  // Border + caption + scale bar (mirrors the PDF composer exactly)
  parts.push(
    `<rect x="${vp.x}" y="${vp.y}" width="${vp.width}" height="${vp.height}" ` +
    `fill="none" stroke="#334155" stroke-width="0.3"/>`,
  );
  caption = viewportCaptionY(vp.y + vp.height, drawingBottomMm);
  parts.push(
    `<text x="${vp.x}" y="${caption.titleY.toFixed(2)}" font-size="3" font-weight="600" ` +
    `fill="#334155" font-family="sans-serif">${escapeXml(captionTitle)}</text>`,
  );
  if (vp.viewType !== "schedule") {
    const layout = scaleBarLayout(scaleDenom);
    barLengthMm = layout.barLengthMm;
    if (vp.width >= barLengthMm + BAR_INSET_MM && caption.barBaselineY < drawingBottomMm) {
      parts.push(scaleBarSvg(vp.x + BAR_INSET_MM, caption.barBaselineY, layout));
    }
  }
  return parts.join("\n");
}

/**
 * Render the full sheet as a standalone SVG document (mm units, 1mm = 1user
 * unit). WYSIWYG: viewport scenes, editable titleblock fields, view-title
 * captions, graphic scale bars, north arrow.
 */
export async function renderSheetSvg(sheetId: string): Promise<string> {
  const sheet = getSheet(sheetId);
  if (!sheet) return "";
  const { w, h } = getSheetSizeMm(sheet.size, sheet.orientation);
  const tb = listTitleblocks().find((t) => t.id === sheet.titleblockId);
  const drawingBottomMm = h - MARGIN_MM - TITLEBLOCK_H_MM;
  const today = new Date().toISOString().slice(0, 10);

  const vpParts: string[] = [];
  for (const vp of sheet.viewports) {
    vpParts.push(await viewportSvg(sheet, vp, drawingBottomMm));
  }

  const rows = titleblockRows(tb, sheet, today, sheet.viewports.map((v) => v.scale));
  const na = northArrowPlacement(w, h, MARGIN_MM, NORTH_ARROW_R_MM, sheet.viewports);
  const naSvg = na.visible ? northArrowSvg(na.cx, na.cy, NORTH_ARROW_R_MM) : "";
  const fields = rows
    .map(
      (r, i) =>
        `<text x="${w - 96}" y="${h - TITLEBLOCK_H_MM - MARGIN_MM + 8 + i * 5}" font-size="3.5" fill="#0f172a" font-family="sans-serif">` +
        `<tspan font-weight="600">${escapeXml(r.label)}:</tspan> ${escapeXml(r.value)}</text>`,
    )
    .join("");

  // Sheet-level notes (general notes / key labels placed outside viewports).
  const noteSvg = (sheet.annotations ?? [])
    .map(
      (a) =>
        `<text x="${escapeXml(String(a.x))}" y="${escapeXml(String(a.y))}" font-size="3.2" fill="#0f172a" font-family="sans-serif">${escapeXml(a.text)}</text>`,
    )
    .join("\n  ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">
  <defs>${vpParts.filter((p) => p.startsWith("<clipPath")).join("")}</defs>
  <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>
  <rect x="${MARGIN_MM}" y="${MARGIN_MM}" width="${w - MARGIN_MM * 2}" height="${h - MARGIN_MM * 2 - TITLEBLOCK_H_MM}"
        fill="none" stroke="#0f172a" stroke-width="0.8"/>
  ${naSvg}
  ${vpParts.filter((p) => !p.startsWith("<clipPath")).join("\n")}
  ${noteSvg}
  <!-- Titleblock -->
  <rect x="${MARGIN_MM}" y="${h - MARGIN_MM - TITLEBLOCK_H_MM}" width="${w - MARGIN_MM * 2}" height="${TITLEBLOCK_H_MM}"
        fill="#f1f5f9" stroke="#0f172a" stroke-width="0.6"/>
  <text x="${MARGIN_MM + 4}" y="${h - MARGIN_MM - TITLEBLOCK_H_MM + 10}" font-size="6" font-weight="700" fill="#0f172a" font-family="sans-serif">
    ${escapeXml(sheetIdentityText(sheet))}
  </text>
  <text x="${MARGIN_MM + 4}" y="${h - MARGIN_MM - TITLEBLOCK_H_MM + 18}" font-size="3.5" fill="#475569" font-family="sans-serif">
    Open BIM Studio · Production Sheet
  </text>
  ${fields}
</svg>`;
}

/** Export the composed sheet as an .svg download. */
export async function exportSheetSvg(sheetId: string, filename?: string): Promise<void> {
  const svg = await renderSheetSvg(sheetId);
  if (!svg) return;
  const sheet = getSheet(sheetId);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename ?? `${sheet?.number ?? "sheet"}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
