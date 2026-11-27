/**
 * AutoCAD 2D parity A8 — viewports, page setups and plot view math (pure, no DOM).
 *
 * The viewport model: a DxfViewport carries a settable `scale` (sheet units per
 * model unit), a `locked` flag (zoom/pan inside it is ignored) and a rectangular
 * `clip` in sheet coordinates. The scale invariant is viewHeight = height / scale
 * whenever scale is set; every function here maintains it.
 *
 * Page setups are named per-drawing records (paper, orientation, plot scale,
 * plot area); a layout references one by name. The plot-view helpers turn a
 * setup + plot area into the concrete view to render, for model plots and for
 * layout (sheet) plots.
 */
import type { DxfLayout, DxfPageSetup, DxfViewport, PlotArea } from "../drawings/dxf-types";
import { PAPER_MM, paperNameForMm } from "./viewer-math";

export type Pt = { x: number; y: number };
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

/** Re-exported for the DXF reader/writer, which resolve paper names from millimetre dimensions. */
export { paperNameForMm };

/* ───────────────────────── plot scales ───────────────────────── */

/** Named plot scales (sheet per model unit) offered by the UI, plus Fit. */
export const PLOT_SCALES: Array<{ label: string; value: number | "fit" }> = [
  { label: "Fit", value: "fit" },
  { label: "1:1", value: 1 },
  { label: "1:2", value: 1 / 2 },
  { label: "1:5", value: 1 / 5 },
  { label: "1:10", value: 1 / 10 },
  { label: "1:20", value: 1 / 20 },
  { label: "1:25", value: 1 / 25 },
  { label: "1:50", value: 1 / 50 },
  { label: "1:100", value: 1 / 100 },
  { label: "1:200", value: 1 / 200 },
  { label: "1:500", value: 1 / 500 },
  { label: "1:1000", value: 1 / 1000 },
];

/** Parse a scale the user typed: "1:50", "1/50", "0.02", "fit" (case-insensitive). Null when unparseable. */
export function parsePlotScale(raw: string): number | "fit" | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === "fit") return "fit";
  const m = /^1\s*[:/]\s*([0-9]+(?:\.[0-9]+)?)$/.exec(s);
  if (m) {
    const den = Number(m[1]);
    if (Number.isFinite(den) && den > 0) return 1 / den;
    return null;
  }
  const n = Number(s);
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return null;
}

/** "1:50" for 0.02, "Fit" for "fit", "1:1" for 1; a custom ratio prints as 1:<den>. */
export function plotScaleLabel(scale: number | "fit"): string {
  if (scale === "fit") return "Fit";
  if (!Number.isFinite(scale) || scale <= 0) return "Fit";
  const den = 1 / scale;
  const near = Math.round(den);
  if (Math.abs(den - near) < 1e-9) return `1:${near}`;
  return `1:${den.toFixed(2)}`;
}

/** DXF AcDbPlotSettings plot-type group (74) for a plot area. */
export const plotAreaGroup74 = (area: PlotArea): number =>
  area === "display" ? 0 : area === "extents" ? 1 : area === "window" ? 4 : 5;

/** Plot area for a DXF group-74 plot type; anything else reads as "layout". */
export function plotAreaFromGroup74(n: number): PlotArea {
  return n === 0 ? "display" : n === 1 ? "extents" : n === 4 ? "window" : "layout";
}

/* ───────────────────────── viewports ───────────────────────── */

/** Sheet rectangle of a viewport (unclipped). */
export const viewportSheetRect = (vp: DxfViewport): BBox => ({
  minX: vp.center.x - vp.width / 2,
  maxX: vp.center.x + vp.width / 2,
  minY: vp.center.y - vp.height / 2,
  maxY: vp.center.y + vp.height / 2,
});

/** Sheet rectangle actually painted through a viewport: the clip wins when set. */
export function clipViewportRect(vp: DxfViewport): BBox {
  const r = viewportSheetRect(vp);
  if (!vp.clip) return r;
  const c = vp.clip;
  return {
    minX: Math.max(r.minX, c.minX),
    minY: Math.max(r.minY, c.minY),
    maxX: Math.min(r.maxX, c.maxX),
    maxY: Math.min(r.maxY, c.maxY),
  };
}

/** Sheet units per model unit through this viewport (the set scale wins). */
export const viewportScaleOf = (vp: DxfViewport): number =>
  vp.scale != null && Number.isFinite(vp.scale) && vp.scale > 0 ? vp.scale : vp.height / vp.viewHeight;

/** Create a viewport from a sheet rectangle, fitting the model bounds into it. */
export function createViewport(
  rect: BBox,
  modelBounds: BBox | null,
  opts: { scale?: number | "fit"; locked?: boolean; clip?: BBox } = {},
): DxfViewport {
  const cx = (rect.minX + rect.maxX) / 2, cy = (rect.minY + rect.maxY) / 2;
  const w = Math.max(rect.maxX - rect.minX, 1e-9), h = Math.max(rect.maxY - rect.minY, 1e-9);
  const viewCenter: Pt = modelBounds
    ? { x: (modelBounds.minX + modelBounds.maxX) / 2, y: (modelBounds.minY + modelBounds.maxY) / 2 }
    : { x: 0, y: 0 };
  // Fit: the model height that fills the rect at its aspect.
  const fitHeight = modelBounds
    ? Math.max((modelBounds.maxY - modelBounds.minY), ((modelBounds.maxX - modelBounds.minX) * h) / w, 1e-9)
    : 100;
  const scale = opts.scale === "fit" || opts.scale == null ? h / fitHeight : opts.scale;
  const viewHeight = h / scale;
  return {
    center: { x: cx, y: cy, z: 0 },
    width: w,
    height: h,
    viewCenter: { x: viewCenter.x, y: viewCenter.y, z: 0 },
    viewHeight,
    scale,
    ...(opts.locked ? { locked: true } : {}),
    ...(opts.clip ? { clip: { ...opts.clip } } : {}),
  };
}

/**
 * Set a viewport's scale (a ratio, or "fit" to fit the model bounds into it).
 * Keeps viewHeight = height / scale. A locked viewport refuses the change.
 */
export function setViewportScale(
  vp: DxfViewport,
  scale: number | "fit",
  modelBounds: BBox | null,
): DxfViewport {
  if (vp.locked) return vp;
  const s =
    scale === "fit"
      ? modelBounds
        ? vp.height / Math.max((modelBounds.maxY - modelBounds.minY), ((modelBounds.maxX - modelBounds.minX) * vp.height) / vp.width, 1e-9)
        : vp.height / 100
      : scale;
  if (!Number.isFinite(s) || s <= 0) return vp;
  return { ...vp, scale: s, viewHeight: vp.height / s };
}

/** Set (or clear, with null) a viewport's rectangular clip, in sheet coordinates. A locked viewport refuses. */
export function setViewportClip(vp: DxfViewport, clip: BBox | null): DxfViewport {
  if (vp.locked) return vp;
  if (!clip) {
    const { clip: _c, ...rest } = vp;
    return rest;
  }
  const r = viewportSheetRect(vp);
  const c = {
    minX: Math.max(r.minX, Math.min(clip.minX, clip.maxX)),
    minY: Math.max(r.minY, Math.min(clip.minY, clip.maxY)),
    maxX: Math.min(r.maxX, Math.max(clip.minX, clip.maxX)),
    maxY: Math.min(r.maxY, Math.max(clip.minY, clip.maxY)),
  };
  if (c.maxX - c.minX < 1e-9 || c.maxY - c.minY < 1e-9) return vp;
  return { ...vp, clip: c };
}

/**
 * Per-viewport freeze (2D-6): set the layers hidden through this viewport
 * only. Names are trimmed, de-duplicated (first occurrence wins) and empty
 * entries dropped; an empty result clears the field. A locked viewport
 * refuses, like scale and clip. The freeze itself is purely a visibility
 * list — it never touches the layers' global frozen/off state.
 */
export function setViewportFrozenLayers(vp: DxfViewport, names: string[]): DxfViewport {
  if (vp.locked) return vp;
  const seen = new Set<string>();
  const frozen = names.map((n) => n.trim()).filter((n) => n !== "" && !seen.has(n) && (seen.add(n), true));
  if (!frozen.length) {
    const { frozenLayers: _f, ...rest } = vp;
    return rest;
  }
  return { ...vp, frozenLayers: frozen };
}

/** True when the named layer is frozen in this viewport only. */
export const isLayerFrozenInViewport = (vp: DxfViewport, layer: string): boolean =>
  (vp.frozenLayers ?? []).includes(layer);

/**
 * Zoom inside a viewport at a screen point, the way the sheet view zooms at the
 * cursor: the model point under the cursor stays under it. `sheetScale` is the
 * sheet view's px-per-sheet-unit; `screenCenter` is the viewport's screen centre
 * (its sheet centre mapped through the sheet view). Returns the new viewport
 * (scale + viewHeight + viewCenter updated); a locked viewport is returned
 * unchanged. factor > 1 zooms in.
 */
export function zoomViewportAt(
  vp: DxfViewport,
  sheetScale: number,
  screenCenter: Pt,
  cursorScreen: Pt,
  factor: number,
): DxfViewport {
  if (vp.locked) return vp;
  const sc = viewportScaleOf(vp);
  const sc2 = sc * factor;
  if (!Number.isFinite(sc2) || sc2 <= 0) return vp;
  // Model point under the cursor before the zoom, via the derived view
  // (scale sheetScale*sc, centred on screenCenter).
  const before = {
    x: vp.viewCenter.x + (cursorScreen.x - screenCenter.x) / (sheetScale * sc),
    y: vp.viewCenter.y - (cursorScreen.y - screenCenter.y) / (sheetScale * sc),
  };
  // After the zoom the same screen point must map to the same model point.
  const viewCenter = {
    x: before.x - (cursorScreen.x - screenCenter.x) / (sheetScale * sc2),
    y: before.y + (cursorScreen.y - screenCenter.y) / (sheetScale * sc2),
    z: 0,
  };
  return { ...vp, scale: sc2, viewHeight: vp.height / sc2, viewCenter };
}

/**
 * Pan inside a viewport by a screen drag (dx, dy in px, screen Y down).
 * A locked viewport is returned unchanged.
 */
export function panViewportBy(vp: DxfViewport, sheetScale: number, dxPx: number, dyPx: number): DxfViewport {
  if (vp.locked) return vp;
  const k = sheetScale * viewportScaleOf(vp);
  if (!Number.isFinite(k) || k <= 0) return vp;
  return {
    ...vp,
    viewCenter: { x: vp.viewCenter.x - dxPx / k, y: vp.viewCenter.y + dyPx / k, z: 0 },
  };
}

/** Index of the viewport whose (clipped) sheet rect contains a sheet point, or -1. */
export function viewportAtSheetPoint(viewports: DxfViewport[], p: Pt): number {
  for (let i = viewports.length - 1; i >= 0; i--) {
    const r = clipViewportRect(viewports[i]);
    if (p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY) return i;
  }
  return -1;
}

/** Fit a viewport's view to the model bounds at the viewport's aspect (scale + viewHeight). */
export function fitViewportToModel(vp: DxfViewport, modelBounds: BBox | null): DxfViewport {
  if (vp.locked || !modelBounds) return vp;
  return setViewportScale(vp, "fit", modelBounds);
}

/* ───────────────────────── page setups ───────────────────────── */

export function validatePageSetupName(name: string): string | null {
  const n = name.trim();
  if (!n) return "A page setup needs a name.";
  if (n.length > 64) return "A page setup name is at most 64 characters.";
  // A8/A19: ":" is allowed — setup names are storage keys and DXF group-1
  // values, not filenames, and "A3-1:50" is the natural name for a setup.
  if (/[<>"/\\|?*]/.test(n)) return "A page setup name cannot contain <>\"/\\|?*.";
  return null;
}

/** A fresh setup with the viewer's defaults (A3 landscape, fit, layout area). */
export function defaultPageSetup(name: string): DxfPageSetup {
  return { name: name.trim(), paper: "A3", orient: "landscape", scale: "fit", area: "layout" };
}

/** Validate + normalise one setup; null when it is not a setup at all. */
export function sanitizePageSetup(raw: unknown): DxfPageSetup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || validatePageSetupName(name)) return null;
  const paper = typeof r.paper === "string" && PAPER_MM[r.paper] ? r.paper : "A3";
  const orient = r.orient === "portrait" ? "portrait" : "landscape";
  let scale: number | "fit" = "fit";
  if (r.scale === "fit") scale = "fit";
  else if (typeof r.scale === "number" && Number.isFinite(r.scale) && r.scale > 0 && r.scale <= 1) scale = r.scale;
  const area: PlotArea =
    r.area === "display" || r.area === "extents" || r.area === "window" || r.area === "layout" ? r.area : "layout";
  let window: DxfPageSetup["window"];
  if (area === "window" && r.window && typeof r.window === "object") {
    const w = r.window as Record<string, unknown>;
    const nums = [w.minX, w.minY, w.maxX, w.maxY].map(Number);
    if (nums.every(Number.isFinite) && nums[2] > nums[0] && nums[3] > nums[1]) {
      window = { minX: nums[0], minY: nums[1], maxX: nums[2], maxY: nums[3] };
    }
  }
  return { name, paper, orient, scale, area, ...(window ? { window } : {}) };
}

/** Validate a whole setup registry; a malformed entry is dropped, never applied. */
export function sanitizePageSetups(raw: unknown): Record<string, DxfPageSetup> {
  const out: Record<string, DxfPageSetup> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const s = sanitizePageSetup(v);
    if (s) out[k] = s;
  }
  return out;
}

/** Serialise a setup registry for the drawing session store. */
export function serializePageSetups(setups: Map<string, DxfPageSetup> | Record<string, DxfPageSetup>): Record<string, DxfPageSetup> {
  const entries = setups instanceof Map ? [...setups.entries()] : Object.entries(setups);
  const out: Record<string, DxfPageSetup> = {};
  for (const [k, v] of entries) {
    const s = sanitizePageSetup(v);
    if (s) out[k] = s;
  }
  return out;
}

/** The effective setup for a layout: its named setup when it resolves, else its own stamped values. */
export function resolveLayoutSetup(
  layout: DxfLayout,
  setups: Record<string, DxfPageSetup> | Map<string, DxfPageSetup>,
): DxfPageSetup {
  const get = (n: string | undefined): DxfPageSetup | undefined =>
    n ? (setups instanceof Map ? setups.get(n) : setups[n]) : undefined;
  const named = get(layout.pageSetup);
  if (named) return named;
  return {
    name: layout.pageSetup ?? "",
    paper: layout.paper ?? "A3",
    orient: "landscape",
    scale: layout.plotScale ?? "fit",
    area: layout.plotArea ?? "layout",
  };
}

/** Apply a named setup to a layout: stamp the name + its resolved values onto the layout. */
export function applyPageSetupToLayout(layout: DxfLayout, setup: DxfPageSetup): DxfLayout {
  return {
    ...layout,
    pageSetup: setup.name,
    paper: setup.paper,
    plotScale: setup.scale,
    plotArea: setup.area,
  };
}

/* ───────────────────────── plot view math ───────────────────────── */

/** Printable paper size in mm for a setup (orientation applied). */
export function setupPaperMm(setup: DxfPageSetup): { w: number; h: number } {
  const [s, l] = PAPER_MM[setup.paper] ?? PAPER_MM.A3;
  return setup.orient === "landscape" ? { w: l, h: s } : { w: s, h: l };
}

export interface PlotView {
  /** Model-space point at the centre of the plotted image. */
  cx: number;
  cy: number;
  /** Model-space height shown through the plotted image. */
  viewHeight: number;
}

/**
 * The view to render for a MODEL plot: the plot area's box, at the setup's
 * scale (or fitted when the scale is "fit"). `marginMm` is the unprintable
 * margin on each side (the plot dialog uses 8 mm). Returns the centre +
 * view height; the caller fits the width from the image aspect.
 */
export function plotViewForModel(
  setup: DxfPageSetup,
  areaBox: BBox,
  marginMm = 8,
): PlotView {
  const pg = setupPaperMm(setup);
  const cx = (areaBox.minX + areaBox.maxX) / 2, cy = (areaBox.minY + areaBox.maxY) / 2;
  if (setup.scale === "fit") {
    // Fit the box into the printable paper at the paper's aspect.
    const pw = Math.max(pg.w - 2 * marginMm, 10), ph = Math.max(pg.h - 2 * marginMm, 10);
    const bw = Math.max(areaBox.maxX - areaBox.minX, 1e-9), bh = Math.max(areaBox.maxY - areaBox.minY, 1e-9);
    const viewHeight = Math.max(bh, (bw * ph) / pw);
    return { cx, cy, viewHeight };
  }
  // Scale 1:50 means 1 mm on paper = 50 model units: the printable paper
  // height shows (paperH - margins) / scale model units.
  const viewHeight = Math.max(pg.h - 2 * marginMm, 10) / setup.scale;
  return { cx, cy, viewHeight };
}

/**
 * The view to render for a LAYOUT (sheet) plot: the sheet itself, at Fit or
 * a paper scale. At 1:1 the sheet renders at true paper size (paper height =
 * sheet height in mm); at 1:2 it prints at half size. The viewport scales
 * inside the layout are untouched — they already scale the model.
 */
export function plotViewForLayout(
  setup: DxfPageSetup,
  sheetRect: BBox,
  marginMm = 8,
): PlotView {
  const pg = setupPaperMm(setup);
  const cx = (sheetRect.minX + sheetRect.maxX) / 2, cy = (sheetRect.minY + sheetRect.maxY) / 2;
  if (setup.scale === "fit") {
    const pw = Math.max(pg.w - 2 * marginMm, 10), ph = Math.max(pg.h - 2 * marginMm, 10);
    const bw = Math.max(sheetRect.maxX - sheetRect.minX, 1e-9), bh = Math.max(sheetRect.maxY - sheetRect.minY, 1e-9);
    return { cx, cy, viewHeight: Math.max(bh, (bw * ph) / pw) };
  }
  return { cx, cy, viewHeight: Math.max(pg.h - 2 * marginMm, 10) / setup.scale };
}
