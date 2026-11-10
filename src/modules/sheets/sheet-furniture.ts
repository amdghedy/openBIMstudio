/**
 * Sheet furniture — the production-sheet chrome every deliverable carries:
 *
 *   - view title line  (name · scale, Revit-style caption below each viewport)
 *   - graphic scale bar (alternating filled segments with world-length labels)
 *   - north arrow      (circle + two-triangle needle + N)
 *   - titleblock rows  (normalized from the sheet's own TitleblockDef)
 *
 * ONE layout, MANY drawers: the SVG sheet composer (`sheet-composer.ts`) and
 * the live sheet panel build SVG from these numbers, the PDF composer
 * (`export/sheet-pdf.ts`) maps the same numbers to pdf-lib calls — so the
 * screen, the exported SVG and the printed PDF all tell the same truth.
 *
 * Pure data + geometry: no DOM, no pdf-lib, no imports beyond types — the
 * unit test compiles this file standalone in Node.
 */
import type { SheetDef, SheetViewport, TitleblockDef } from "../projects/types";

// ── scale text normalization ──────────────────────────────────────────────

/** "100" / 100 / "1:100" / "1 : 100" → "1:100"; empty/invalid → "". */
export function normalizeScaleText(scale: string | number | undefined): string {
  if (scale === undefined || scale === null || scale === "") return "";
  const raw = String(scale).trim();
  if (!raw) return "";
  if (raw.includes(":")) {
    const m = raw.match(/1\s*:\s*(\d+(?:\.\d+)?)/);
    return m ? `1:${m[1]}` : "";
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? `1:${n}` : "";
}

// ── view title caption ────────────────────────────────────────────────────

/** Revit-style viewport caption: `Name · 1:100` below the viewport. */
export function viewTitleText(vp: Pick<SheetViewport, "title" | "scale">, viewName: string): string {
  const name = (vp.title || viewName || "View").trim();
  const scale = normalizeScaleText(vp.scale);
  return scale ? `${name} · ${scale}` : name;
}

export interface ViewportCaptionLayout {
  /** Baseline (top-down mm) of the title text below the viewport. */
  titleY: number;
  /** Baseline (top-down mm) of the scale-bar bottom edge; bar grows upward. */
  barBaselineY: number;
  /** True when the caption had to be clamped to stay inside the sheet. */
  clamped: boolean;
}

/**
 * Caption position for a viewport whose bottom edge sits at `vpBottomMm`
 * (top-down mm). The caption must never cross the drawing-area bottom
 * (`drawingBottomMm`).
 */
export function viewportCaptionY(vpBottomMm: number, drawingBottomMm: number): ViewportCaptionLayout {
  let titleY = vpBottomMm + 3.2;
  let clamped = false;
  if (titleY > drawingBottomMm - 1) {
    titleY = drawingBottomMm - 1;
    clamped = true;
  }
  let barBaselineY = titleY + 4.6;
  if (barBaselineY > drawingBottomMm) {
    barBaselineY = drawingBottomMm;
    clamped = true;
  }
  return { titleY, barBaselineY, clamped };
}

// ── graphic scale bar ─────────────────────────────────────────────────────

export interface ScaleBarLayout {
  /** Paper mm per alternating segment. */
  segmentMm: number;
  /** Number of segments (default 4). */
  segments: number;
  /** World metres represented by one segment. */
  worldPerSegmentM: number;
  /** World metres represented by the whole bar. */
  totalWorldM: number;
  /** Paper mm the full bar spans. */
  barLengthMm: number;
  /** Tick labels: paper offset from bar start + text (world length). */
  labels: Array<{ offsetMm: number; text: string }>;
  /** Fill pattern per segment, starting filled (even indices filled). */
  filled: boolean[];
}

const NICE_SEGMENTS_M = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];

function trimNum(n: number): string {
  return String(+n.toFixed(2));
}

/** Format a world length for scale-bar labels (m / cm / mm / km). */
export function formatWorldLength(m: number): string {
  if (m >= 1000) return `${trimNum(m / 1000)} km`;
  if (m >= 1) return `${trimNum(m)} m`;
  if (m >= 0.01) return `${trimNum(m * 100)} cm`;
  return `${trimNum(m * 1000)} mm`;
}

/**
 * Graphic scale bar for a viewport scale. Segment world lengths snap to
 * "nice" numbers (1, 2, 5 × 10^k) so labels read naturally; the bar lands
 * between minBarMm and maxBarMm (target ~30 mm). Falls back to an exact
 * 30 mm bar with unrounded world length for extreme scales.
 */
export function scaleBarLayout(
  scaleDenom: number,
  opts?: { targetBarMm?: number; minBarMm?: number; maxBarMm?: number; segmentCount?: number },
): ScaleBarLayout {
  const target = opts?.targetBarMm ?? 30;
  const min = opts?.minBarMm ?? 16;
  const max = opts?.maxBarMm ?? 44;
  const segments = Math.max(2, opts?.segmentCount ?? 4);
  const metersPerMm = scaleDenom / 1000;

  let best: { segmentMm: number; worldM: number } | null = null;
  for (const worldM of NICE_SEGMENTS_M) {
    const segmentMm = worldM / metersPerMm;
    if (!Number.isFinite(segmentMm) || segmentMm <= 0) continue;
    const barMm = segmentMm * segments;
    if (barMm < min || barMm > max) continue;
    const dist = Math.abs(barMm - target);
    if (!best || dist < Math.abs(best.segmentMm * segments - target) - 1e-9) {
      best = { segmentMm, worldM };
    }
  }
  if (!best) {
    const segmentMm = target / segments;
    best = { segmentMm, worldM: segmentMm * metersPerMm };
  }

  const barLengthMm = best.segmentMm * segments;
  const totalWorldM = best.worldM * segments;
  return {
    segmentMm: best.segmentMm,
    segments,
    worldPerSegmentM: best.worldM,
    totalWorldM,
    barLengthMm,
    labels: [
      { offsetMm: 0, text: "0" },
      { offsetMm: barLengthMm / 2, text: formatWorldLength(totalWorldM / 2) },
      { offsetMm: barLengthMm, text: formatWorldLength(totalWorldM) },
    ],
    filled: Array.from({ length: segments }, (_, i) => i % 2 === 0),
  };
}

export const SCALE_BAR_HEIGHT_MM = 1.6;
export const SCALE_BAR_LABEL_GAP_MM = 0.6;

/** SVG fragment for the scale bar; origin = bar start x, bar bottom baseline y (top-down mm). */
export function scaleBarSvg(xMm: number, baselineYMm: number, layout: ScaleBarLayout, stroke = "#0f172a"): string {
  const h = SCALE_BAR_HEIGHT_MM;
  let rects = "";
  for (let i = 0; i < layout.segments; i++) {
    const x = xMm + i * layout.segmentMm;
    rects +=
      `<rect x="${x.toFixed(3)}" y="${(baselineYMm - h).toFixed(3)}" ` +
      `width="${layout.segmentMm.toFixed(3)}" height="${h}" ` +
      `fill="${layout.filled[i] ? stroke : "#ffffff"}" stroke="${stroke}" stroke-width="0.25"/>`;
  }
  const labels = layout.labels
    .map((l) => {
      const anchor = l.offsetMm === 0 ? "start" : "middle";
      return (
        `<text x="${(xMm + l.offsetMm).toFixed(3)}" y="${(baselineYMm - h - SCALE_BAR_LABEL_GAP_MM).toFixed(3)}" ` +
        `text-anchor="${anchor}" font-size="1.8" fill="${stroke}" font-family="sans-serif">${l.text}</text>`
      );
    })
    .join("");
  return `<g class="scale-bar" pointer-events="none">${rects}${labels}</g>`;
}

// ── north arrow ───────────────────────────────────────────────────────────

export interface NorthArrowGeometry {
  r: number;
  /** All points centered on (0,0), y negative = north/up. */
  needleTip: [number, number];
  needleLeft: [number, number];
  needleRight: [number, number];
  southTip: [number, number];
}

/** Classic two-triangle needle inside a circle of radius r. */
export function northArrowGeometry(r: number): NorthArrowGeometry {
  return {
    r,
    needleTip: [0, -r * 0.92],
    needleLeft: [-r * 0.28, r * 0.3],
    needleRight: [r * 0.28, r * 0.3],
    southTip: [0, r * 0.62],
  };
}

export interface NorthArrowPlacement {
  cx: number;
  cy: number;
  /** False when any viewport collides with the symbol — drawer skips it. */
  visible: boolean;
}

/** Top-right corner placement, inside the drawing border; skipped on collision. */
export function northArrowPlacement(
  sheetW: number,
  sheetH: number,
  margin: number,
  r: number,
  viewports: SheetViewport[],
): NorthArrowPlacement {
  const cx = sheetW - margin - r - 2;
  const cy = margin + r + 3;
  const pad = 2;
  const top = cy - r - 4; // includes the N label above the circle
  const bottom = cy + r + pad;
  const left = cx - r - pad;
  const right = cx + r + pad;
  const overlaps = viewports.some(
    (v) => v.x < right && v.x + v.width > left && v.y < bottom && v.y + v.height > top,
  );
  void sheetH;
  return { cx, cy, visible: !overlaps };
}

export function northArrowSvg(cxMm: number, cyMm: number, rMm: number, stroke = "#0f172a"): string {
  const g = northArrowGeometry(rMm);
  const P = (p: [number, number]) => `${(cxMm + p[0]).toFixed(3)},${(cyMm + p[1]).toFixed(3)}`;
  return (
    `<g class="north-arrow" pointer-events="none">` +
    `<circle cx="${cxMm.toFixed(3)}" cy="${cyMm.toFixed(3)}" r="${rMm.toFixed(3)}" fill="none" stroke="${stroke}" stroke-width="0.5"/>` +
    `<polygon points="${P(g.needleTip)} ${P(g.needleLeft)} ${P(g.southTip)}" fill="${stroke}"/>` +
    `<polygon points="${P(g.needleTip)} ${P(g.needleRight)} ${P(g.southTip)}" fill="#ffffff" stroke="${stroke}" stroke-width="0.4"/>` +
    `<text x="${cxMm.toFixed(3)}" y="${(cyMm - rMm - 1.2).toFixed(3)}" text-anchor="middle" ` +
    `font-size="${(rMm * 0.62).toFixed(2)}" font-weight="700" fill="${stroke}" font-family="sans-serif">N</text>` +
    `</g>`
  );
}

// ── titleblock rows ───────────────────────────────────────────────────────

export interface TitleblockRow {
  label: string;
  value: string;
}

const DEFAULT_TITLEBLOCK_FIELDS: TitleblockRow[] = [
  { label: "Project", value: "—" },
  { label: "Drawn", value: "—" },
  { label: "Checked", value: "—" },
  { label: "Date", value: "" },
  { label: "Scale", value: "As noted" },
  { label: "Rev", value: "0" },
];

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Titleblock rows for a sheet — the sheet's own TitleblockDef is the source
 * of truth (its editable fields), with live overrides:
 *   - sheet number / name fields are dropped (drawn prominently elsewhere)
 *   - the Scale row reflects the scales actually placed on the sheet
 *   - an empty Date falls back to today
 */
export function titleblockRows(
  tb: TitleblockDef | undefined,
  sheet: SheetDef,
  fallbackDate: string,
  viewportScales: string[],
): TitleblockRow[] {
  const fields = tb?.fields?.length
    ? tb.fields.map((f) => ({ label: f.label, value: f.value }))
    : DEFAULT_TITLEBLOCK_FIELDS.map((r) => ({ ...r }));

  const rows = fields
    .filter((f) => {
      const key = (f.label || "").trim().toLowerCase();
      return key !== "sheet no." && key !== "sheet no" && key !== "sheet name";
    })
    .map((f) => {
      const key = (f.label || "").trim().toLowerCase();
      if (key === "scale") {
        const live = dedupe(viewportScales.map(normalizeScaleText));
        return { label: f.label, value: live.length ? live.join(", ") : f.value || "As noted" };
      }
      if (key === "date") return { label: f.label, value: f.value || fallbackDate };
      return { label: f.label, value: f.value || "—" };
    });

  void sheet;
  return rows;
}

/** Sheet identity line drawn prominently in the titleblock: "A-101 — Level 1 Plan". */
export function sheetIdentityText(sheet: Pick<SheetDef, "number" | "name">): string {
  return `${sheet.number || "—"} — ${sheet.name || "—"}`;
}
