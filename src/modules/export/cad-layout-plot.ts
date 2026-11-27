// AutoCAD 2D parity A20 — sheet-systems bridge: CAD layouts as vector PDF.
//
// A CAD `DxfLayout` (paper sheet + viewports onto the model) is plotted as
// vector PDF output through the same pdf-lib pipeline the BIM batch
// plotter uses, so a layout publishes as real lines and text — not a
// raster. The geometry is collected first as pure data
// (`collectCadLayoutGeometry`, in sheet millimetres) and only then drawn
// onto a pdf-lib page, so the transform and clipping are unit-testable
// without a PDF in the loop.
//
// Coordinate note: DXF paper space is bottom-up in millimetres, and
// pdf-lib pages are bottom-up in points, so a sheet point (x, y) mm maps
// to (x, y) * MM_TO_PT pt with no flip. (The BIM sheet path is top-down
// and flips; the CAD path must not.)
//
// What is drawn, in order:
//   1. each viewport's model content, transformed model -> sheet
//      (sheet = vp.center + (model - vp.viewCenter) * scale) and clipped
//      to the viewport rect at the segment level (Liang-Barsky), then the
//      viewport border;
//   2. the layout's own paper-space entities (its titleblock etc.), on
//      top, clipped to the page rect.
//
// Deliberately NOT drawn:
//   * DIMENSION entities themselves — they carry no geometry; the
//     dimension's lines/text live as sibling entities (meta.dimId) in
//     the same list and are drawn as ordinary LINE/TEXT. (The canvas
//     renders dimensions the same way: drawEntity has no DIMENSION case.)
//   * invisible entities (HIDEOBJECTS / ISOLATEOBJECTS state).
//   * viewport twist: the view rotation is not applied to the model
//     content (follow-up — twisted viewports are rare and the A8 raster
//     plot has the same gap).
//   * SPLINE / HATCH / other entity kinds the reader does not produce
//     as resolved geometry — skipped, never faked.
//
// Colours follow the DWG exporter convention (true colour > ACI > layer
// colour > black), except ACI 7 resolves against a black foreground:
// on white paper ACI 7 is black, not white (the exporter's white
// foreground is for dark SVG backgrounds).
import { rgb, degrees, type PDFPage, type PDFFont } from "pdf-lib";
import { createPdfDocument, MM_TO_PT } from "./pdf";
import {
  resolveLayoutSetup,
  setupPaperMm,
  viewportScaleOf,
  clipViewportRect,
  createViewport,
} from "../cad-viewer/cad-viewport-a8";
import { resolveInsert } from "../drawings/block-refs";
import { tessellatePolyline } from "../drawings/dxf-geometry";
import { aciToRgb } from "../drawings/aci";
import type {
  DxfBlockDef,
  DxfDocument,
  DxfEntity,
  DxfLayout,
  DxfPageSetup,
  DxfPoint,
  DxfViewport,
} from "../drawings/dxf-types";

export interface CadLayoutPlotInput {
  /** The layout (sheet) to plot. */
  layout: DxfLayout;
  /** Model-space entities, as the viewports see them. */
  model: DxfEntity[];
  /** Block definitions, for INSERT resolution. */
  blocks?: Record<string, DxfBlockDef>;
  /** Named page setups, for the layout's paper size. */
  setups?: Record<string, DxfPageSetup>;
  /** Layers, for ByLayer colour resolution. */
  layers?: DxfDocument["layers"];
}

export interface CadPlotSegment {
  /** Sheet millimetres, bottom-up. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** 0-1 sRGB. */
  color: { r: number; g: number; b: number };
  /** Stroke width in points. */
  width: number;
}

export interface CadPlotText {
  /** Baseline anchor, sheet millimetres, bottom-up. */
  x: number;
  y: number;
  /** Text height in points. */
  size: number;
  value: string;
  /** Counter-clockwise degrees. */
  rotation: number;
  align: "left" | "center" | "right";
  valign: "top" | "middle" | "bottom" | "baseline";
  color: { r: number; g: number; b: number };
  bold: boolean;
}

export interface CadLayoutPlotGeometry {
  /** Page width/height in points. */
  pageW: number;
  pageH: number;
  segments: CadPlotSegment[];
  texts: CadPlotText[];
}

type Pt = { x: number; y: number };
type Rect = { minX: number; minY: number; maxX: number; maxY: number };

/** Printable paper size in millimetres for the layout's resolved setup. */
export function cadLayoutPageMm(input: CadLayoutPlotInput): { w: number; h: number } {
  return setupPaperMm(resolveLayoutSetup(input.layout, input.setups ?? {}));
}

/** Human label for a layout's paper, e.g. "A3 landscape" — sheets-panel rows. */
export function cadLayoutPaperLabel(
  layout: DxfLayout,
  setups?: Record<string, DxfPageSetup>,
): string {
  const setup = resolveLayoutSetup(layout, setups ?? {});
  return `${setup.paper} ${setup.orient}`;
}

function rgb01(v: number): { r: number; g: number; b: number } {
  return { r: ((v >> 16) & 0xff) / 255, g: ((v >> 8) & 0xff) / 255, b: (v & 0xff) / 255 };
}

/** True colour > ACI > layer colour > black (ACI 7 = black on white paper). */
function plotColor(e: DxfEntity, layers?: DxfDocument["layers"]): { r: number; g: number; b: number } {
  if (typeof e.rgb === "number") return rgb01(e.rgb);
  if (typeof e.color === "number" && e.color > 0) return rgb01(aciToRgb(e.color, 0x000000));
  const layer = layers?.find((l) => l.name === e.layer);
  if (layer) {
    if (typeof layer.rgb === "number") return rgb01(layer.rgb);
    if (typeof layer.color === "number" && layer.color > 0) return rgb01(aciToRgb(layer.color, 0x000000));
  }
  return { r: 0, g: 0, b: 0 };
}

function plotWidth(e: DxfEntity): number {
  if (typeof e.lineweight === "number" && e.lineweight > 0) {
    return Math.min(3, Math.max(0.25, e.lineweight * MM_TO_PT));
  }
  return 0.7;
}

/** Liang-Barsky segment clip against a rect; null when fully outside. */
export function clipSegment(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  r: Rect,
): [Pt, Pt] | null {
  const dx = x2 - x1, dy = y2 - y1;
  let t0 = 0, t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.minX, r.maxX - x1, y1 - r.minY, r.maxY - y1];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  // A segment that only touches the rect at a single point (t0 == t1)
  // has no visible length — it draws nothing, so report it as outside
  // rather than polluting the segment list with a zero-length line.
  if (t0 >= t1) return null;
  return [
    { x: x1 + t0 * dx, y: y1 + t0 * dy },
    { x: x1 + t1 * dx, y: y1 + t1 * dy },
  ];
}

/** Tessellate a circular arc to segments (<=5 deg steps); a full circle is 72. */
function arcSegments(
  center: DxfPoint,
  radius: number,
  startDeg: number,
  endDeg: number,
): Array<[Pt, Pt]> {
  let span = ((endDeg - startDeg) % 360 + 360) % 360;
  if (span === 0) span = 360;
  const steps = Math.max(1, Math.ceil(span / 5));
  const pts: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((startDeg + (span * i) / steps) * Math.PI) / 180;
    pts.push({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
  }
  const out: Array<[Pt, Pt]> = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
  return out;
}

/** Raw (unclipped, untransformed) segments of one entity, in its own space. */
function entityRawSegments(e: DxfEntity): Array<[Pt, Pt]> {
  switch (e.type) {
    case "LINE":
      return [[e.start, e.end]];
    case "LWPOLYLINE": {
      const pts = tessellatePolyline(e.points, e.bulges, !!e.closed);
      const out: Array<[Pt, Pt]> = [];
      for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]]);
      if (e.closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]]);
      return out;
    }
    case "CIRCLE":
      return arcSegments(e.center, e.radius, 0, 360);
    case "ARC":
      return arcSegments(e.center, e.radius, e.startAngle, e.endAngle);
    default:
      return [];
  }
}

interface Collector {
  segs: CadPlotSegment[];
  texts: CadPlotText[];
  layers?: DxfDocument["layers"];
  blocks?: Record<string, DxfBlockDef>;
}

/**
 * Collect one entity's geometry into sheet millimetres.
 * `toSheet` maps the entity's own space to sheet space (identity for
 * paper entities, the viewport transform for model entities); `clip`
 * is the rect the segments are clipped against (the viewport rect, or
 * the page rect for paper entities).
 */
function collectEntity(
  c: Collector,
  e: DxfEntity,
  toSheet: (p: Pt) => Pt,
  clip: Rect,
  depth: number,
): void {
  if (e.invisible) return;
  if (e.type === "DIMENSION") return; // geometry siblings draw; the entity itself is empty
  if (e.type === "INSERT") {
    if (depth > 8) return;
    for (const child of resolveInsert(c.blocks, e)) collectEntity(c, child, toSheet, clip, depth + 1);
    return;
  }
  if (e.type === "TEXT") {
    const p = toSheet(e.position);
    // The anchor must be inside (or just outside) the clip rect; the
    // text itself may overhang the edge, as in AutoCAD.
    if (p.x < clip.minX - 50 || p.x > clip.maxX + 50 || p.y < clip.minY - 50 || p.y > clip.maxY + 50) return;
    const scaleX = toSheet({ x: 1, y: 0 }).x - toSheet({ x: 0, y: 0 }).x;
    const size = Math.max(0.5, Math.abs(e.height * scaleX) * MM_TO_PT);
    c.texts.push({
      x: p.x,
      y: p.y,
      size,
      value: e.value,
      rotation: e.rotation ?? 0,
      align: e.align ?? "left",
      valign: e.valign ?? "baseline",
      color: plotColor(e, c.layers),
      bold: !!e.bold,
    });
    return;
  }
  if (e.type === "POINT") {
    const p = toSheet(e.position);
    const d = 0.75;
    const color = plotColor(e, c.layers);
    const width = plotWidth(e);
    for (const [a, b] of [
      [{ x: p.x - d, y: p.y }, { x: p.x + d, y: p.y }],
      [{ x: p.x, y: p.y - d }, { x: p.x, y: p.y + d }],
    ] as Array<[Pt, Pt]>) {
      const s = clipSegment(a.x, a.y, b.x, b.y, clip);
      if (s) c.segs.push({ x1: s[0].x, y1: s[0].y, x2: s[1].x, y2: s[1].y, color, width });
    }
    return;
  }
  if (e.type === "RAY" || e.type === "XLINE") {
    // Construction lines are infinite; the visible piece is the part
    // inside the clip rect, found by clipping a long segment across it.
    const L = Math.hypot(clip.maxX - clip.minX, clip.maxY - clip.minY) + 1;
    const ux = e.direction.x, uy = e.direction.y;
    const len = Math.hypot(ux, uy) || 1;
    const dx = ux / len, dy = uy / len;
    const a = e.type === "RAY" ? e.start : { x: e.start.x - dx * L, y: e.start.y - dy * L };
    const b = { x: e.start.x + dx * L, y: e.start.y + dy * L };
    const s = clipSegment(a.x, a.y, b.x, b.y, clip);
    if (s) {
      c.segs.push({
        x1: s[0].x, y1: s[0].y, x2: s[1].x, y2: s[1].y,
        color: plotColor(e, c.layers), width: plotWidth(e),
      });
    }
    return;
  }
  const color = plotColor(e, c.layers);
  const width = plotWidth(e);
  for (const [a, b] of entityRawSegments(e)) {
    const pa = toSheet(a), pb = toSheet(b);
    const s = clipSegment(pa.x, pa.y, pb.x, pb.y, clip);
    if (s) c.segs.push({ x1: s[0].x, y1: s[0].y, x2: s[1].x, y2: s[1].y, color, width });
  }
}

/**
 * Pure geometry collection for one layout: page size (points), vector
 * segments and texts (sheet millimetres). No PDF is touched, so the
 * transform and clipping are directly assertable in a node test.
 */
export function collectCadLayoutGeometry(input: CadLayoutPlotInput): CadLayoutPlotGeometry {
  const { w, h } = cadLayoutPageMm(input);
  const pageW = w * MM_TO_PT;
  const pageH = h * MM_TO_PT;
  const pageRect: Rect = { minX: 0, minY: 0, maxX: w, maxY: h };
  const c: Collector = { segs: [], texts: [], layers: input.layers, blocks: input.blocks };
  const identity = (p: Pt): Pt => p;

  // 1. Viewport content: model -> sheet, clipped to each viewport.
  for (const vp of input.layout.viewports ?? []) {
    if (!vp.viewCenter) continue;
    const rect = clipViewportRect(vp);
    const scale = viewportScaleOf(vp);
    const toSheet = (p: Pt): Pt => ({
      x: vp.center.x + (p.x - vp.viewCenter.x) * scale,
      y: vp.center.y + (p.y - vp.viewCenter.y) * scale,
    });
  for (const e of input.model) collectEntity(c, e, toSheet, rect, 0);
    // Viewport border, as the canvas draws it — except on a synthetic
    // Model viewport (2D-25), which is a pipeline artifact, not a sheet
    // viewport: a Model plot carries no border.
    if (!vp.hideBorder) {
      const border = { r: 0, g: 0, b: 0 };
      const bw = 0.35;
      const corners: Pt[] = [
        { x: rect.minX, y: rect.minY },
        { x: rect.maxX, y: rect.minY },
        { x: rect.maxX, y: rect.maxY },
        { x: rect.minX, y: rect.maxY },
      ];
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        c.segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: border, width: bw });
      }
    }
  }

  // 2. Paper-space entities (the sheet's own titleblock etc.), on top.
  for (const e of input.layout.entities ?? []) collectEntity(c, e, identity, pageRect, 0);

  return { pageW, pageH, segments: c.segs, texts: c.texts };
}

/**
 * Draw collected layout geometry onto an existing pdf-lib page sized to
 * the layout's paper. Text alignment is applied in the text's rotated
 * frame before the point is converted to PDF points.
 */
export function drawCadLayoutOnPage(
  page: PDFPage,
  geom: CadLayoutPlotGeometry,
  regular: PDFFont,
  bold: PDFFont,
): void {
  for (const s of geom.segments) {
    page.drawLine({
      start: { x: s.x1 * MM_TO_PT, y: s.y1 * MM_TO_PT },
      end: { x: s.x2 * MM_TO_PT, y: s.y2 * MM_TO_PT },
      thickness: s.width,
      color: rgb(s.color.r, s.color.g, s.color.b),
    });
  }
  for (const t of geom.texts) {
    const font = t.bold ? bold : regular;
    const w = font.widthOfTextAtSize(t.value, t.size);
    // Anchor shift in the text's local frame (x along the text, y up
    // from the baseline). Cap height ~0.7 * size; descender ~0.25 * size.
    let dx = 0;
    if (t.align === "center") dx = -w / 2;
    else if (t.align === "right") dx = -w;
    let dy = 0;
    if (t.valign === "bottom") dy = t.size * 0.25;
    else if (t.valign === "middle") dy = t.size * 0.35;
    else if (t.valign === "top") dy = t.size * 0.7;
    const a = (t.rotation * Math.PI) / 180;
    const x = t.x * MM_TO_PT + dx * Math.cos(a) - dy * Math.sin(a);
    const y = t.y * MM_TO_PT + dx * Math.sin(a) + dy * Math.cos(a);
    page.drawText(t.value, {
      x,
      y,
      size: t.size,
      font,
      rotate: degrees(t.rotation),
      color: rgb(t.color.r, t.color.g, t.color.b),
    });
  }
}

/**
 * 2D-25: a synthetic layout that plots Model space through the same
 * layout pipeline — one full-page viewport over the chosen Model area
 * (`area`, in model units), at the dialog's plot scale ("fit" or sheet
 * per model unit), on the dialog's paper/orientation (`setup`). No
 * paper-space entities, and no viewport border: the viewport is a
 * pipeline artifact, not a sheet viewport. The caller passes `setup`
 * through as a named setup (under setup.name) so the paper/orientation
 * resolve through the usual layout-setup path.
 */
export function modelVectorLayout(
  area: Rect,
  scale: number | "fit",
  setup: DxfPageSetup,
): DxfLayout {
  const { w, h } = setupPaperMm(setup);
  const vp = createViewport({ minX: 0, minY: 0, maxX: w, maxY: h }, area, { scale });
  return {
    name: "Model",
    entities: [],
    viewports: [{ ...vp, hideBorder: true }],
    pageSetup: setup.name,
    paper: setup.paper,
    plotScale: setup.scale,
    plotArea: setup.area,
  };
}

/** One layout as its own vector PDF file (the single-layout PLOT path). */
export async function downloadCadLayoutPdf(
  input: CadLayoutPlotInput,
  filename: string,
): Promise<void> {
  const geom = collectCadLayoutGeometry(input);
  const { doc, regular, bold } = await createPdfDocument();
  const page = doc.addPage([geom.pageW, geom.pageH]);
  page.drawRectangle({ x: 0, y: 0, width: geom.pageW, height: geom.pageH, color: rgb(1, 1, 1) });
  drawCadLayoutOnPage(page, geom, regular, bold);
  const bytes = await doc.save();
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
