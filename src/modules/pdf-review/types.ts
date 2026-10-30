// Shared types + geometry for the PDF review module.
// All points are NORMALISED to the displayed page: x,y in 0..1, origin top-left.
// That keeps markups independent of zoom, DPI and the PDF's own coordinate system.

export type Tool = 'select' | 'pen' | 'highlight' | 'rect' | 'cloud' | 'arrow' | 'text' | 'note';
export type MarkupKind = Exclude<Tool, 'select'>;
export type MarkupStatus = 'open' | 'resolved';

export interface Pt {
  x: number;
  y: number;
}

export interface ReviewComment {
  id: string;
  author: string;
  text: string;
  at: number; // epoch ms
}

export interface Markup {
  id: string;
  page: number; // 1-based
  kind: MarkupKind;
  /** pen: many points | rect/highlight/cloud/arrow: [from, to] | text/note: [anchor] */
  pts: Pt[];
  color: string;
  /** stroke width in CSS px at zoom 1 (pen/rect/cloud/arrow) */
  width: number;
  /** on-page text (kind === 'text') */
  text?: string;
  comments: ReviewComment[];
  status: MarkupStatus;
  author: string;
  createdAt: number;
}

export interface ReviewFile {
  version: 1;
  pdfName: string;
  markups: Markup[];
}

export const uid = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const KIND_LABEL: Record<MarkupKind, string> = {
  pen: 'Pen',
  highlight: 'Highlight',
  rect: 'Rectangle',
  cloud: 'Revision cloud',
  arrow: 'Arrow',
  text: 'Text',
  note: 'Note',
};

/** Font size for on-page text, as a fraction of page width. */
export const TEXT_SIZE = 0.016;

/** Axis-aligned box of a markup in normalised coordinates. */
export function bbox(
  m: Markup,
  aspect: number,
): { x0: number; y0: number; x1: number; y1: number } {
  const xs = m.pts.map((p) => p.x);
  const ys = m.pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  let x1 = Math.max(...xs);
  let y1 = Math.max(...ys);
  if (m.kind === 'text') {
    const lines = (m.text ?? '').split('\n');
    const longest = Math.max(1, ...lines.map((l) => l.length));
    x1 = x0 + longest * TEXT_SIZE * 0.55;
    y1 = y0 + (lines.length * TEXT_SIZE * 1.25) / aspect;
  }
  if (m.kind === 'note') {
    x1 = x0 + 0.02;
    y1 = y0 + 0.02 / aspect;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Scalloped "revision cloud" outline for the rectangle a to b.
 * `aspect` = page height / page width, so the scallops come out round on screen.
 * Returns a closed polyline in normalised coordinates (used for both SVG and PDF export).
 */
export function cloudPoints(a: Pt, b: Pt, aspect: number): Pt[] {
  // work in a space where 1 unit is the same distance in x and y
  const X0 = Math.min(a.x, b.x);
  const X1 = Math.max(a.x, b.x);
  const Y0 = Math.min(a.y, b.y) * aspect;
  const Y1 = Math.max(a.y, b.y) * aspect;
  const w = X1 - X0;
  const h = Y1 - Y0;
  if (w < 1e-4 || h < 1e-4) return [a, b];

  const target = 0.028; // scallop width
  const corners: Pt[] = [
    { x: X0, y: Y0 },
    { x: X1, y: Y0 },
    { x: X1, y: Y1 },
    { x: X0, y: Y1 },
  ];
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(2, Math.round(len / target));
    const dx = (q.x - p.x) / len;
    const dy = (q.y - p.y) / len;
    // outward normal for a clockwise walk (screen coordinates, y down)
    const nx = dy;
    const ny = -dx;
    const bulge = (len / n) * 0.42;
    for (let k = 0; k < n; k++) {
      for (let s = 0; s < 8; s++) {
        const t = (k + s / 8) / n;
        const arc = Math.sin(((k + s / 8) % 1) * Math.PI) * bulge;
        out.push({
          x: p.x + (q.x - p.x) * t + nx * arc,
          y: p.y + (q.y - p.y) * t + ny * arc,
        });
      }
    }
  }
  out.push(out[0]);
  return out.map((pt) => ({ x: pt.x, y: pt.y / aspect }));
}

/** Arrow head end-points for a to b (normalised, aspect-corrected). */
export function arrowHead(a: Pt, b: Pt, aspect: number): [Pt, Pt] {
  const ang = Math.atan2((b.y - a.y) * aspect, b.x - a.x);
  const len = 0.022;
  const spread = Math.PI / 7;
  const mk = (s: number): Pt => ({
    x: b.x - Math.cos(ang + s) * len,
    y: b.y - (Math.sin(ang + s) * len) / aspect,
  });
  return [mk(spread), mk(-spread)];
}