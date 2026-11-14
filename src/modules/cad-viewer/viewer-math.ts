/**
 * Pure geometry for the CAD Editor: view transform, picking, snapping, measuring, units, text search.
 * No DOM, no rendering; everything works on the flattened DxfEntity vocabulary the DXF/DWG readers produce.
 */
import { findFont } from "../drawings/cad-styles";
import type { DxfEntity, DxfLayout, DxfPoint, DxfUnits, DxfViewport } from "../drawings/dxf-types";
import { pointInPolygon } from "../drawings/hatch-patterns";

export type Pt = { x: number; y: number };
export interface BBox { minX: number; minY: number; maxX: number; maxY: number }

/* ───────────────────────── view transform ───────────────────────── */

/** World point (cx, cy) sits at the canvas centre; scale = pixels per world unit; screen Y points down. */
export interface View { cx: number; cy: number; scale: number; w: number; h: number }

export const worldToScreen = (v: View, x: number, y: number): Pt => ({ x: v.w / 2 + (x - v.cx) * v.scale, y: v.h / 2 - (y - v.cy) * v.scale });
export const screenToWorld = (v: View, sx: number, sy: number): Pt => ({ x: v.cx + (sx - v.w / 2) / v.scale, y: v.cy - (sy - v.h / 2) / v.scale });

export function fitView(b: BBox, w: number, h: number, margin = 0.06): View {
  const bw = Math.max(b.maxX - b.minX, 1e-9), bh = Math.max(b.maxY - b.minY, 1e-9);
  const scale = Math.min((w * (1 - 2 * margin)) / bw, (h * (1 - 2 * margin)) / bh);
  return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Number.isFinite(scale) && scale > 0 ? scale : 1, w, h };
}

/** Zoom keeping the world point under the cursor fixed. */
export function zoomAt(v: View, sx: number, sy: number, factor: number, minScale = 1e-9, maxScale = 1e9): View {
  const before = screenToWorld(v, sx, sy);
  const scale = Math.min(maxScale, Math.max(minScale, v.scale * factor));
  const next = { ...v, scale };
  const after = screenToWorld(next, sx, sy);
  return { ...next, cx: v.cx + (before.x - after.x), cy: v.cy + (before.y - after.y) };
}

export function panBy(v: View, dxPx: number, dyPx: number): View {
  return { ...v, cx: v.cx - dxPx / v.scale, cy: v.cy + dyPx / v.scale };
}

/** Zoom so the screen rectangle (two corners) fills the view. */
export function zoomWindow(v: View, a: Pt, b: Pt): View {
  const p = screenToWorld(v, Math.min(a.x, b.x), Math.max(a.y, b.y)), q = screenToWorld(v, Math.max(a.x, b.x), Math.min(a.y, b.y));
  if (Math.abs(q.x - p.x) < 1e-12 || Math.abs(q.y - p.y) < 1e-12) return v;
  return fitView({ minX: p.x, minY: p.y, maxX: q.x, maxY: q.y }, v.w, v.h, 0);
}

export const bboxVisible = (b: BBox, v: View): boolean => {
  const tl = screenToWorld(v, 0, 0), br = screenToWorld(v, v.w, v.h);
  return !(b.maxX < tl.x || b.minX > br.x || b.maxY < br.y || b.minY > tl.y);
};

/* ───────────────────────── entity geometry ───────────────────────── */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

const norm360 = (a: number) => ((a % 360) + 360) % 360;
/** True when angle `a` (deg) lies on the CCW sweep from `s` to `e`. */
export function angleInArc(a: number, s: number, e: number): boolean {
  const sweep = norm360(e - s) || 360;
  return norm360(a - s) <= sweep + 1e-9;
}
export const arcSweepDeg = (s: number, e: number) => norm360(e - s) || 360;

/**
 * Canvas font stack for a TEXT. DWG SHX stroke fonts have no web equivalent, so they map to the
 * closest look: simplex/iso/romans/standard -> clean sans, txt/monotxt -> monospace, roman/times/serif TTFs -> serif.
 */
export function textFontCss(e: Extract<DxfEntity, { type: "TEXT" }>, px: number): string {
  const raw = String(e.font ?? "").trim();
  const known = findFont(raw);
  if (known && known.kind !== "stroke") return `${e.italic ? "italic " : ""}${e.bold ? "bold " : ""}${px}px ${known.css}`;
  const base = raw.replace(/\.(shx|ttf|otf|ttc)$/i, "").replace(/[^A-Za-z0-9 _-]/g, "");
  const k = base.toLowerCase();
  let stack = "sans-serif";
  if (/^(txt|monotxt|mono|courier|consolas|lucida console)/.test(k)) stack = base ? `"${base}", "Courier New", monospace` : "monospace";
  else if (/^(romanc|romant|romand|times|roman|georgia|garamond|palatino|cambria|serif|scriptc|scripts)/.test(k)) stack = `"${/^(roman[cdt]?|script[cs])$/.test(k) ? "Times New Roman" : base}", "Times New Roman", serif`;
  else if (base && !/^(simplex|iso|isocp|isocpeur|romans|standard|gothic[a-z]*|italic[a-z]*|complex|monotxt)/.test(k)) stack = `"${base}", sans-serif`;
  return `${e.italic ? "italic " : ""}${e.bold ? "bold " : ""}${px}px ${stack}`;
}

/** DWG default MTEXT line pitch = 5/3 of the text height. */
export const TEXT_LINE_PITCH = 5 / 3;

/** A styled slice of text inside a TEXT/MTEXT (from inline MTEXT format codes). */
export interface TextViewRun {
  text: string;
  color?: number;
  rgb?: number;
  bold?: boolean;
  italic?: boolean;
}

const estCharW = (e: Extract<DxfEntity, { type: "TEXT" }>): number =>
  Math.max(e.height * 0.6 * (e.widthFactor && e.widthFactor > 0 ? e.widthFactor : 1), 1e-9);

const linePitch = (e: Extract<DxfEntity, { type: "TEXT" }>): number =>
  e.height * Math.max(e.lineSpacing ?? 1, 0.1) * TEXT_LINE_PITCH;

/** Words and gaps of one logical line, keeping the run each token came from. */
function tokensOf(line: TextViewRun[]): Array<{ text: string; run: TextViewRun }> {
  const out: Array<{ text: string; run: TextViewRun }> = [];
  for (const run of line)
    for (const tk of run.text.split(/(\s+)/)) if (tk) out.push({ text: tk, run });
  return out;
}

/**
 * Greedy word-wrap of one logical line at `maxChars` estimated characters —
 * native CAD wraps MTEXT at its column width and hard-splits words that do not fit.
 */
function wrapLine(line: TextViewRun[], maxChars: number): TextViewRun[][] {
  if (maxChars < 1) return [line];
  const out: TextViewRun[][] = [];
  let cur: TextViewRun[] = [];
  let curLen = 0;
  const flush = () => {
    // A trailing gap at a wrap point is invisible — drop it like native CAD.
    while (cur.length && /^\s+$/.test(cur[cur.length - 1].text)) {
      curLen -= cur[cur.length - 1].text.length;
      cur.pop();
    }
    out.push(cur);
    cur = [];
    curLen = 0;
  };
  for (const tk of tokensOf(line)) {
    if (/^\s+$/.test(tk.text)) {
      // Wrapped lines never start with the leftover gap, and a trailing gap that no
      // longer fits is simply dropped — it would be invisible anyway.
      if (!curLen || curLen + tk.text.length > maxChars) continue;
      cur.push({ ...tk.run, text: tk.text });
      curLen += tk.text.length;
      continue;
    }
    if (curLen && curLen + tk.text.length > maxChars) flush();
    let rem = tk.text;
    if (rem.length > maxChars) {
      // A single word longer than the whole column is hard-split like native CAD.
      if (curLen) {
        const take = Math.max(0, maxChars - curLen);
        if (take) { cur.push({ ...tk.run, text: rem.slice(0, take) }); rem = rem.slice(take); }
        flush();
      }
      while (rem.length > maxChars) {
        cur.push({ ...tk.run, text: rem.slice(0, maxChars) });
        rem = rem.slice(maxChars);
        flush();
      }
    }
    if (rem) { cur.push({ ...tk.run, text: rem }); curLen += rem.length; }
  }
  flush();
  return out;
}

/**
 * Visual runs per line of a TEXT/MTEXT: explicit "\n" breaks first, then the
 * MTEXT column width (wrapWidth) word-wrap. This is the single source of truth
 * for drawing, hit-testing and the bounding box.
 */
export function textRuns(e: Extract<DxfEntity, { type: "TEXT" }>): TextViewRun[][] {
  const raw: TextViewRun[] = e.runs?.length
    ? e.runs.map((r) => ({ text: String(r.text ?? ""), color: r.color, rgb: r.rgb, bold: r.bold, italic: r.italic }))
    : [{ text: String(e.value ?? "") }];
  const logical: TextViewRun[][] = [[]];
  for (const r of raw) {
    const parts = r.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) logical.push([]);
      if (parts[i]) logical[logical.length - 1].push({ ...r, text: parts[i] });
    }
  }
  if (!e.wrapWidth || e.wrapWidth <= 0) return logical;
  const maxChars = Math.max(1, Math.floor(e.wrapWidth / estCharW(e) + 1e-9));
  const out: TextViewRun[][] = [];
  for (const line of logical) for (const wrapped of wrapLine(line, maxChars)) out.push(wrapped);
  return out;
}

export function textBox(e: Extract<DxfEntity, { type: "TEXT" }>): { w: number; h: number } {
  const lines = textRuns(e);
  const longest = Math.max(...lines.map((l) => l.reduce((s, r) => s + r.text.length, 0)), 0);
  return {
    w: Math.max(e.height * 0.6 * longest * (e.widthFactor && e.widthFactor > 0 ? e.widthFactor : 1), e.height * 0.3),
    h: e.height + (lines.length - 1) * linePitch(e),
  };
}

/**
 * Baseline offset (world units, y up, relative to the insertion point) of every line of a TEXT/MTEXT,
 * honouring the vertical anchor. Single-line text keeps the previous behaviour.
 */
export function textLineBaselines(e: Extract<DxfEntity, { type: "TEXT" }>): number[] {
  const n = textRuns(e).length, h = e.height, H = textBox(e).h;
  const top = e.valign === "top" ? 0 : e.valign === "middle" ? H / 2 : e.valign === "bottom" ? H : h;
  return Array.from({ length: n }, (_, i) => top - h - i * linePitch(e));
}

/** Lower-left corner of the text box relative to its insertion point, in the text's own frame. */
export function textOrigin(e: Extract<DxfEntity, { type: "TEXT" }>): { dx: number; dy: number } {
  const { w, h } = textBox(e);
  return {
    dx: e.align === "center" ? -w / 2 : e.align === "right" ? -w : 0,
    dy: e.valign === "top" ? -h : e.valign === "middle" ? -h / 2 : 0,
  };
}

export function entityBBox(e: DxfEntity): BBox {
  switch (e.type) {
    case "LINE": return { minX: Math.min(e.start.x, e.end.x), minY: Math.min(e.start.y, e.end.y), maxX: Math.max(e.start.x, e.end.x), maxY: Math.max(e.start.y, e.end.y) };
    // Infinite construction lines: a degenerate box at the anchor point so
    // zoom-extents and the spatial index ignore the unbounded extent (native
    // CAD also ignores RAY/XLINE for ZOOM Extents). Drawing culls these by
    // type instead of by box.
    case "RAY":
    case "XLINE": return { minX: e.start.x, minY: e.start.y, maxX: e.start.x, maxY: e.start.y };
    case "CIRCLE": return { minX: e.center.x - e.radius, minY: e.center.y - e.radius, maxX: e.center.x + e.radius, maxY: e.center.y + e.radius };
    case "ARC": {
      const pts: Pt[] = [arcPt(e, e.startAngle), arcPt(e, e.endAngle)];
      for (const q of [0, 90, 180, 270]) if (angleInArc(q, e.startAngle, e.endAngle)) pts.push(arcPt(e, q));
      return boxOf(pts);
    }
    case "LWPOLYLINE": return boxOf(e.hatch ? e.hatch.loops.flat() : e.points);
    case "TEXT": {
      const { w, h } = textBox(e), o = textOrigin(e), r = (e.rotation ?? 0) * DEG, c = Math.cos(r), s = Math.sin(r);
      return boxOf([{ x: o.dx, y: o.dy }, { x: o.dx + w, y: o.dy }, { x: o.dx + w, y: o.dy + h }, { x: o.dx, y: o.dy + h }].map((p) => ({ x: e.position.x + p.x * c - p.y * s, y: e.position.y + p.x * s + p.y * c })));
    }
    case "POINT": return { minX: e.position.x, minY: e.position.y, maxX: e.position.x, maxY: e.position.y };
  }
}

function boxOf(pts: Array<{ x: number; y: number }>): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y; if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}
const arcPt = (e: { center: DxfPoint; radius: number }, deg: number): Pt => ({ x: e.center.x + e.radius * Math.cos(deg * DEG), y: e.center.y + e.radius * Math.sin(deg * DEG) });

export const isHatchEntity = (e: DxfEntity): boolean => e.type === "LWPOLYLINE" && !!e.hatch;

export function unionBBox(a: BBox | null, b: BBox): BBox {
  return a ? { minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) } : { ...b };
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(px - nearestOnSeg(px, py, ax, ay, bx, by).x, py - nearestOnSeg(px, py, ax, ay, bx, by).y);
}
export function nearestOnSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): Pt {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return { x: ax + t * dx, y: ay + t * dy };
}

function polySegs(e: Extract<DxfEntity, { type: "LWPOLYLINE" }>): Array<[Pt, Pt]> {
  const out: Array<[Pt, Pt]> = [];
  for (let i = 0; i + 1 < e.points.length; i++) out.push([e.points[i], e.points[i + 1]]);
  if (e.closed && e.points.length > 2) out.push([e.points[e.points.length - 1], e.points[0]]);
  return out;
}

/** Straight segments of line-like entities (used for intersections). */
export function entitySegments(e: DxfEntity): Array<[Pt, Pt]> {
  if (e.type === "LINE") return [[e.start, e.end]];
  if (e.type === "LWPOLYLINE") return polySegs(e);
  return [];
}

export function distToEntity(e: DxfEntity, x: number, y: number): number {
  switch (e.type) {
    case "LINE": return segDist(x, y, e.start.x, e.start.y, e.end.x, e.end.y);
    case "CIRCLE": return Math.abs(Math.hypot(x - e.center.x, y - e.center.y) - e.radius);
    case "ARC": {
      const a = Math.atan2(y - e.center.y, x - e.center.x) / DEG;
      if (angleInArc(a, e.startAngle, e.endAngle)) return Math.abs(Math.hypot(x - e.center.x, y - e.center.y) - e.radius);
      const p = arcPt(e, e.startAngle), q = arcPt(e, e.endAngle);
      return Math.min(Math.hypot(x - p.x, y - p.y), Math.hypot(x - q.x, y - q.y));
    }
    case "LWPOLYLINE": { let d = Infinity; for (const [a, b] of polySegs(e)) d = Math.min(d, segDist(x, y, a.x, a.y, b.x, b.y)); return e.points.length === 1 ? Math.hypot(x - e.points[0].x, y - e.points[0].y) : d; }
    case "TEXT": {
      const { w, h } = textBox(e), o = textOrigin(e), r = -(e.rotation ?? 0) * DEG, c = Math.cos(r), s = Math.sin(r);
      const lx = (x - e.position.x) * c - (y - e.position.y) * s - o.dx, ly = (x - e.position.x) * s + (y - e.position.y) * c - o.dy;
      const dx = Math.max(-lx, 0, lx - w), dy = Math.max(-ly, 0, ly - h);
      return Math.hypot(dx, dy);
    }
    case "POINT": return Math.hypot(x - e.position.x, y - e.position.y);
    case "RAY":
    case "XLINE": {
      // Perpendicular distance to the infinite line; a RAY clamps behind its start.
      const l2 = e.direction.x * e.direction.x + e.direction.y * e.direction.y;
      const t = l2 < 1e-18 ? 0 : ((x - e.start.x) * e.direction.x + (y - e.start.y) * e.direction.y) / l2;
      const tc = e.type === "RAY" && t < 0 ? 0 : t;
      return Math.hypot(x - (e.start.x + tc * e.direction.x), y - (e.start.y + tc * e.direction.y));
    }
  }
}
export function nearestOnEntity(e: DxfEntity, x: number, y: number): Pt | null {
  switch (e.type) {
    case "LINE": return nearestOnSeg(x, y, e.start.x, e.start.y, e.end.x, e.end.y);
    case "RAY":
    case "XLINE": {
      const l2 = e.direction.x * e.direction.x + e.direction.y * e.direction.y;
      let t = l2 < 1e-18 ? 0 : ((x - e.start.x) * e.direction.x + (y - e.start.y) * e.direction.y) / l2;
      if (e.type === "RAY" && t < 0) t = 0;
      return { x: e.start.x + t * e.direction.x, y: e.start.y + t * e.direction.y };
    }
    case "LWPOLYLINE": {
      let best: Pt | null = null, bd = Infinity;
      for (const [a, b] of polySegs(e)) { const p = nearestOnSeg(x, y, a.x, a.y, b.x, b.y), d = Math.hypot(x - p.x, y - p.y); if (d < bd) { bd = d; best = p; } }
      return best;
    }
    case "CIRCLE": { const a = Math.atan2(y - e.center.y, x - e.center.x); return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) }; }
    case "ARC": {
      const a = Math.atan2(y - e.center.y, x - e.center.x) / DEG;
      if (angleInArc(a, e.startAngle, e.endAngle)) return arcPt(e, a);
      const p = arcPt(e, e.startAngle), q = arcPt(e, e.endAngle);
      return Math.hypot(x - p.x, y - p.y) <= Math.hypot(x - q.x, y - q.y) ? p : q;
    }
    default: return null;
  }
}

/* ───────────────────────── infinite lines (RAY / XLINE) ───────────────────────── */

/**
 * Visible segment of an infinite construction line clipped against the view
 * rect (plus a 5% margin), in world coordinates — null when the line never
 * crosses the view. RAY clips the half-line (t ≥ 0), XLINE the full line.
 * Native CAD draws construction lines edge-to-edge like this.
 */
export function infiniteLineSegment(
  e: { type: "RAY" | "XLINE"; start: DxfPoint; direction: DxfPoint },
  v: View,
): [Pt, Pt] | null {
  const tl = screenToWorld(v, 0, 0), br = screenToWorld(v, v.w, v.h);
  const pad = 0.05 * Math.max(Math.abs(tl.x - br.x), Math.abs(tl.y - br.y));
  const xmin = Math.min(tl.x, br.x) - pad, xmax = Math.max(tl.x, br.x) + pad;
  const ymin = Math.min(tl.y, br.y) - pad, ymax = Math.max(tl.y, br.y) + pad;
  const dx = e.direction.x, dy = e.direction.y;
  let t0 = e.type === "RAY" ? 0 : -Infinity, t1 = Infinity;
  if (Math.abs(dx) < 1e-12) { if (e.start.x < xmin || e.start.x > xmax) return null; }
  else {
    let ta = (xmin - e.start.x) / dx, tb = (xmax - e.start.x) / dx;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  if (Math.abs(dy) < 1e-12) { if (e.start.y < ymin || e.start.y > ymax) return null; }
  else {
    let ta = (ymin - e.start.y) / dy, tb = (ymax - e.start.y) / dy;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  if (!(t0 < t1)) return null;
  return [
    { x: e.start.x + t0 * dx, y: e.start.y + t0 * dy },
    { x: e.start.x + t1 * dx, y: e.start.y + t1 * dy },
  ];
}

/* ───────────────────────── measurements ───────────────────────── */

/** Direction a→b in degrees, 0..360 CCW from +X. */
export const norm360Deg = (a: Pt, b: Pt) => norm360((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
export const distance = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Constrain point B to the nearest axis-aligned direction from A (Ortho mode). */
export function orthoConstrain(a: Pt, b: Pt): Pt {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  return dx >= dy ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/**
 * Polar tracking: preserve the cursor distance while constraining its angle
 * to the nearest configured increment. Invalid increments leave B unchanged.
 */
export function polarConstrain(a: Pt, b: Pt, angleStep = 90): Pt {
  if (!Number.isFinite(angleStep) || angleStep <= 0 || angleStep > 360) return { ...b };
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-12) return { ...b };
  const increment = (angleStep * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / increment) * increment;
  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
}

/** Shortest distance from point P to segment AB, and the foot of the perpendicular. */
export function distPointToSeg(p: Pt, a: Pt, b: Pt): { dist: number; foot: Pt; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { dist: distance(p, a), foot: { ...a }, t: 0 };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const foot = { x: a.x + t * dx, y: a.y + t * dy };
  return { dist: distance(p, foot), foot, t };
}

/** Compass bearing degrees clockwise from +Y (north), 0–360. */
export function bearingDeg(a: Pt, b: Pt): number {
  const ang = Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI; // from north toward east
  return ((ang % 360) + 360) % 360;
}

/** Simple revision-cloud polyline (rounded scallops along path). */
export function revisionCloudPoints(path: Pt[], bulge = 0.35, segsPerArc = 6): Pt[] {
  if (path.length < 2) return path.slice();
  const out: Pt[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const len = distance(a, b);
    if (len < 1e-9) continue;
    const n = Math.max(2, Math.round(len / (len * 0.25 + 1e-6) * 3));
    const steps = Math.max(2, Math.min(24, n));
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps, t1 = (s + 1) / steps;
      const mx = a.x + (b.x - a.x) * ((t0 + t1) / 2);
      const my = a.y + (b.y - a.y) * ((t0 + t1) / 2);
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const amp = len / steps * bulge;
      for (let k = 0; k <= segsPerArc; k++) {
        const u = k / segsPerArc;
        const t = t0 + (t1 - t0) * u;
        const px = a.x + (b.x - a.x) * t;
        const py = a.y + (b.y - a.y) * t;
        const off = Math.sin(u * Math.PI) * amp;
        out.push({ x: px + nx * off, y: py + ny * off });
      }
    }
  }
  return out;
}


/** Angle in degrees at vertex `v` between rays to `a` and `b` (0..180). */
export function angleAt(v: Pt, a: Pt, b: Pt): number {
  const ux = a.x - v.x, uy = a.y - v.y, wx = b.x - v.x, wy = b.y - v.y;
  const l = Math.hypot(ux, uy) * Math.hypot(wx, wy);
  if (l < 1e-18) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * wx + uy * wy) / l))) * 180) / Math.PI;
}
export function polygonArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i].x * q.y - q.x * p[i].y; }
  return Math.abs(a) / 2;
}
export function pathLength(p: Pt[], closed = false): number {
  let l = 0;
  for (let i = 0; i + 1 < p.length; i++) l += distance(p[i], p[i + 1]);
  if (closed && p.length > 2) l += distance(p[p.length - 1], p[0]);
  return l;
}

export interface EntityMetrics { length?: number; area?: number; radius?: number; diameter?: number; angle?: number; sweep?: number }
export function entityMetrics(e: DxfEntity): EntityMetrics {
  switch (e.type) {
    case "LINE": return { length: distance(e.start, e.end), angle: norm360((Math.atan2(e.end.y - e.start.y, e.end.x - e.start.x) * 180) / Math.PI) };
    case "CIRCLE": return { radius: e.radius, diameter: e.radius * 2, length: TAU * e.radius, area: Math.PI * e.radius * e.radius };
    case "ARC": { const sw = arcSweepDeg(e.startAngle, e.endAngle); return { radius: e.radius, diameter: e.radius * 2, sweep: sw, length: e.radius * sw * DEG }; }
    case "LWPOLYLINE":
      if (e.hatch) {
        const [outer, ...holes] = e.hatch.loops;
        return { length: e.hatch.loops.reduce((a, l) => a + pathLength(l, true), 0), area: Math.max(0, polygonArea(outer) - holes.reduce((a, l) => a + polygonArea(l), 0)) };
      }
      return { length: pathLength(e.points, !!e.closed), ...(e.closed && e.points.length > 2 ? { area: polygonArea(e.points) } : {}) };
    default: return {};
  }
}

/* ───────────────────────── units ───────────────────────── */

const UNIT_M: Record<DxfUnits, number> = { unitless: 1, mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
export type DisplayUnit = "drawing" | "mm" | "cm" | "m" | "in" | "ft";

/** Convert a length in drawing units to the display unit (areas: pass the squared factor via `power`). */
export function convertLength(v: number, from: DxfUnits | undefined, to: DisplayUnit, power = 1): number {
  const src = from ?? "unitless";
  if (to === "drawing" || src === "unitless") return v;
  return v * Math.pow(UNIT_M[src] / UNIT_M[to], power);
}
export function unitLabel(from: DxfUnits | undefined, to: DisplayUnit): string {
  const u = to === "drawing" ? (from ?? "unitless") : to;
  return u === "unitless" ? "units" : u;
}
export function formatQty(v: number, from: DxfUnits | undefined, to: DisplayUnit, power = 1, digits = 3): string {
  const n = convertLength(v, from, to, power);
  const d = Math.abs(n) >= 1000 ? 1 : Math.abs(n) >= 10 ? 2 : digits;
  return `${n.toFixed(d)} ${unitLabel(from, to)}${power === 2 ? "²" : ""}`;
}

/**
 * UNITS dialog — Length Type → display unit mapping (same `du` state the
 * settings-bar selector drives, so the dialog and the toolbar cannot disagree).
 * Decimal keeps drawing units; Architectural shows feet; Engineering inches.
 */
export function displayUnitForLengthType(lengthType: string): DisplayUnit {
  const k = (lengthType || "").trim().toLowerCase();
  if (k.startsWith("arch")) return "ft";
  if (k.startsWith("eng")) return "in";
  return "drawing";
}

/** Inverse of displayUnitForLengthType — preselects the dialog's Length Type. */
export function lengthTypeForDisplayUnit(du: DisplayUnit): string {
  if (du === "ft") return "Architectural";
  if (du === "in") return "Engineering";
  return "Decimal";
}

/** "0.0000" → 4 decimals, "0.00" → 2, "0.000000" → 6; unparseable keeps the 4-digit default. */
export function coordDigitsForPrecisionLabel(precisionLabel: string): number {
  const m = /0\.(0+)/.exec(precisionLabel || "");
  return m ? Math.min(m[1].length, 8) : 4;
}

/* ───────────────────────── spatial index ───────────────────────── */

export interface SpatialIndex { cell: number; minX: number; minY: number; cols: number; rows: number; cells: Map<number, number[]>; big: number[]; infinite: number[]; boxes: BBox[] }

export function buildIndex(entities: DxfEntity[], bounds: BBox, targetCells = 256): SpatialIndex {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-9), h = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const cell = Math.max(w, h) / targetCells;
  const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  const idx: SpatialIndex = { cell, minX: bounds.minX, minY: bounds.minY, cols, rows, cells: new Map(), big: [], infinite: [], boxes: new Array(entities.length) };
  entities.forEach((e, i) => {
    const b = entityBBox(e); idx.boxes[i] = b;
    if (e.type === "RAY" || e.type === "XLINE") idx.infinite.push(i);
    const c0 = Math.floor((b.minX - bounds.minX) / cell), c1 = Math.floor((b.maxX - bounds.minX) / cell);
    const r0 = Math.floor((b.minY - bounds.minY) / cell), r1 = Math.floor((b.maxY - bounds.minY) / cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) { idx.big.push(i); return; }
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; const a = idx.cells.get(k); if (a) a.push(i); else idx.cells.set(k, [i]); }
  });
  return idx;
}

/** Entity indices whose bounding box could be within `radius` of (x, y). */
export function queryIndex(idx: SpatialIndex, x: number, y: number, radius: number): number[] {
  const infinite = new Set(idx.infinite);
  const out = new Set<number>([...idx.big, ...idx.infinite]);
  const c0 = Math.floor((x - radius - idx.minX) / idx.cell), c1 = Math.floor((x + radius - idx.minX) / idx.cell);
  const r0 = Math.floor((y - radius - idx.minY) / idx.cell), r1 = Math.floor((y + radius - idx.minY) / idx.cell);
  for (let r = Math.max(r0, 0); r <= Math.min(r1, idx.rows - 1); r++) for (let c = Math.max(c0, 0); c <= Math.min(c1, idx.cols - 1); c++) {
    const a = idx.cells.get(r * idx.cols + c); if (a) for (const i of a) out.add(i);
  }
  return [...out].filter((i) => {
    if (infinite.has(i)) return true;
    const b = idx.boxes[i];
    return !!b && x >= b.minX - radius && x <= b.maxX + radius && y >= b.minY - radius && y <= b.maxY + radius;
  });
}

/**
 * Entity indices whose bounds intersect a world-space viewport / selection box.
 * Cell lookup avoids walking the complete drawing on every repaint. Results
 * are sorted to preserve DXF draw order; long construction lines are always
 * returned because their anchor-only bounding boxes do not describe visibility.
 */
export function queryIndexBox(idx: SpatialIndex, entities: DxfEntity[], box: BBox): number[] {
  const candidates = new Set<number>(idx.big);
  const c0 = Math.floor((box.minX - idx.minX) / idx.cell);
  const c1 = Math.floor((box.maxX - idx.minX) / idx.cell);
  const r0 = Math.floor((box.minY - idx.minY) / idx.cell);
  const r1 = Math.floor((box.maxY - idx.minY) / idx.cell);
  for (let r = Math.max(0, r0); r <= Math.min(idx.rows - 1, r1); r++) {
    for (let c = Math.max(0, c0); c <= Math.min(idx.cols - 1, c1); c++) {
      const cell = idx.cells.get(r * idx.cols + c);
      if (cell) for (const i of cell) candidates.add(i);
    }
  }
  const infinite = new Set(idx.infinite);
  for (const i of infinite) candidates.add(i);
  const out = [...candidates].filter((i) => {
    if (infinite.has(i)) return true;
    const b = idx.boxes[i];
    return !!b && !(b.maxX < box.minX || b.minX > box.maxX || b.maxY < box.minY || b.minY > box.maxY);
  }).sort((a, b) => a - b);
  // Avoid a needless candidate sort in the common zoom-extents / tiny drawing case.
  if (entities.length && out.length >= entities.length * 0.8) {
    return Array.from({ length: entities.length }, (_, i) => i);
  }
  return out;
}

export interface PickCandidate { index: number; distance: number }

/**
 * Return all visible entities hit by a point, ordered by geometric distance.
 * Equal-distance hits prefer later drawing order (the visually top-most entity).
 * Kept separate from pickEntity so existing modify tools retain their behavior.
 */
/** True when (x, y) lands inside the fill of a closed hatched polyline (even-odd over its loops). */
export function hatchFillHit(e: DxfEntity, x: number, y: number): boolean {
  if (e.type !== "LWPOLYLINE" || !e.hatch || !e.closed || e.hatch.wipeout) return false;
  for (const loop of e.hatch.loops) {
    if (pointInPolygon({ x, y }, loop)) return true;
  }
  return false;
}

/**
 * Pick distance for one entity: edge distance (+ hatch penalty when it is a
 * hatch edge, so a line under the cursor beats it), or a inside-fill hit at
 * 0.75·tol — clicking inside an empty hatch area selects the hatch, but an
 * object actually under the cursor still wins.
 */
function pickDistance(e: DxfEntity, x: number, y: number, tol: number): number {
  const d0 = distToEntity(e, x, y);
  if (d0 <= tol) return d0 + (isHatchEntity(e) ? tol * 0.6 : 0);
  if (hatchFillHit(e, x, y)) return tol * 0.75;
  return d0;
}

export function pickEntities(
  idx: SpatialIndex, entities: DxfEntity[], x: number, y: number, tol: number,
  visible: (e: DxfEntity) => boolean = () => true, maxResults = 32,
): PickCandidate[] {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(tol) || tol < 0) return [];
  const hits: PickCandidate[] = [];
  for (const index of queryIndex(idx, x, y, tol)) {
    const entity = entities[index];
    if (!entity || !visible(entity)) continue;
    const d = pickDistance(entity, x, y, tol);
    if (Number.isFinite(d) && d <= tol + 1e-12) hits.push({ index, distance: d });
  }
  hits.sort((a, b) => {
    const delta = a.distance - b.distance;
    return Math.abs(delta) <= 1e-12 ? b.index - a.index : delta;
  });
  const limit = Number.isFinite(maxResults) ? Math.max(1, Math.min(256, Math.floor(maxResults))) : 32;
  return hits.slice(0, limit);
}
/** Index of the entity nearest the point within `tol` (world units), preferring smaller entities on ties. */
export function pickEntity(idx: SpatialIndex, entities: DxfEntity[], x: number, y: number, tol: number, visible: (e: DxfEntity) => boolean = () => true): number {
  let best = -1, bd = tol;
  for (const i of queryIndex(idx, x, y, tol)) {
    const e = entities[i];
    if (!visible(e)) continue;
    const d = pickDistance(e, x, y, tol); // a line near the cursor beats a hatch edge; inside a hatch fill selects the hatch
    if (d < bd - 1e-12) { bd = d; best = i; }
  }
  return best;
}

/* ───────────────────────── snapping ───────────────────────── */

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "intersection" | "perpendicular" | "tangent" | "parallel" | "nearest";
export interface Snap { x: number; y: number; kind: SnapKind }
export const ALL_SNAPS: SnapKind[] = ["endpoint", "midpoint", "center", "quadrant", "intersection", "perpendicular", "tangent", "parallel", "nearest"];

function keyPoints(e: DxfEntity): Snap[] {
  switch (e.type) {
    case "LINE": return [{ ...e.start, kind: "endpoint" }, { ...e.end, kind: "endpoint" }, { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2, kind: "midpoint" }];
    case "CIRCLE": return [{ x: e.center.x, y: e.center.y, kind: "center" }, ...[0, 90, 180, 270].map((q) => ({ ...arcPt(e, q), kind: "quadrant" as const }))];
    case "ARC": {
      const mid = e.startAngle + arcSweepDeg(e.startAngle, e.endAngle) / 2;
      return [{ x: e.center.x, y: e.center.y, kind: "center" }, { ...arcPt(e, e.startAngle), kind: "endpoint" }, { ...arcPt(e, e.endAngle), kind: "endpoint" }, { ...arcPt(e, mid), kind: "midpoint" }];
    }
    case "LWPOLYLINE": {
      const out: Snap[] = e.points.map((p) => ({ x: p.x, y: p.y, kind: "endpoint" as const }));
      for (const [a, b] of polySegs(e)) out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, kind: "midpoint" });
      return out;
    }
    case "TEXT": return [{ x: e.position.x, y: e.position.y, kind: "endpoint" }];
    case "POINT": return [{ x: e.position.x, y: e.position.y, kind: "endpoint" }];
    case "RAY":
    case "XLINE": return [{ x: e.start.x, y: e.start.y, kind: "endpoint" }];
  }
}

export function segSegIntersection(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-14) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

const TIER: Record<SnapKind, number> = { endpoint: 0, midpoint: 0, center: 0, quadrant: 0, intersection: 1, perpendicular: 1, tangent: 1, parallel: 1, nearest: 2 };

/**
 * Object snap. Optional `fromPt` enables DWG-style PERPENDICULAR: the foot
 * of the perpendicular from `fromPt` onto nearby segments, when that foot is
 * within `tol` of the cursor (so the user is aiming near the true foot).
 */

/** Closest point on segment AB to point P (clamped to the segment). */
export function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-24) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export function findSnap(
  idx: SpatialIndex,
  entities: DxfEntity[],
  x: number,
  y: number,
  tol: number,
  modes: SnapKind[] = ALL_SNAPS,
  visible: (e: DxfEntity) => boolean = () => true,
  fromPt?: Pt | null,
): Snap | null {
  const on = new Set(modes);
  const ids = queryIndex(idx, x, y, tol).filter((i) => visible(entities[i]) && !isHatchEntity(entities[i]));
  let best: Snap | null = null, bd = tol;
  const consider = (s: Snap) => {
    if (!on.has(s.kind)) return;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > tol) return;
    if (!best || TIER[s.kind] < TIER[best.kind] || (TIER[s.kind] === TIER[best.kind] && d < bd)) { best = s; bd = d; }
  };
  for (const i of ids) for (const k of keyPoints(entities[i])) consider(k);
  if (on.has("intersection")) {
    const segs: Array<[Pt, Pt]> = [];
    for (const i of ids) segs.push(...entitySegments(entities[i]));
    for (let i = 0; i < segs.length && i < 60; i++) for (let j = i + 1; j < segs.length && j < 60; j++) {
      const p = segSegIntersection(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (p) consider({ ...p, kind: "intersection" });
    }
  }
  // Reference-dependent snaps use a wider search around the previous point.
  const referenceIds = fromPt
    ? queryIndex(idx, fromPt.x, fromPt.y, Math.max(tol * 40, 1)).filter((i) => visible(entities[i]) && !isHatchEntity(entities[i]))
    : [];
  const referenceSegments: Array<[Pt, Pt]> = [];
  for (const i of [...new Set([...ids, ...referenceIds])]) referenceSegments.push(...entitySegments(entities[i]));

  // PERPENDICULAR (DWG PERP): foot from the previous point to a segment.
  if (on.has("perpendicular") && fromPt) {
    const seen = new Set<string>();
    for (const [a, b] of referenceSegments) {
      const key = `${a.x},${a.y},${b.x},${b.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const foot = nearestOnSegment(fromPt, a, b);
      consider({ x: foot.x, y: foot.y, kind: "perpendicular" });
    }
  }

  // PARALLEL: project the cursor onto a line through the previous point,
  // parallel to each nearby LINE / polyline segment.
  if (on.has("parallel") && fromPt) {
    const seen = new Set<string>();
    for (const [a, b] of referenceSegments) {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      if (l2 < 1e-18) continue;
      const key = `${dx / Math.sqrt(l2)},${dy / Math.sqrt(l2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = ((x - fromPt.x) * dx + (y - fromPt.y) * dy) / l2;
      consider({ x: fromPt.x + t * dx, y: fromPt.y + t * dy, kind: "parallel" });
    }
  }

  // TANGENT: from the previous point, calculate both tangent points to each
  // visible circle/arc and offer the one the cursor is aiming at.
  if (on.has("tangent") && fromPt) {
    for (const i of referenceIds) {
      const e = entities[i];
      if (e.type !== "CIRCLE" && e.type !== "ARC") continue;
      const dx = fromPt.x - e.center.x, dy = fromPt.y - e.center.y;
      const d2 = dx * dx + dy * dy, r2 = e.radius * e.radius;
      if (d2 <= r2 + 1e-12 || e.radius <= 0) continue;
      const base = Math.atan2(dy, dx), alpha = Math.acos(Math.min(1, e.radius / Math.sqrt(d2)));
      for (const angle of [base + alpha, base - alpha]) {
        const deg = ((angle / DEG) % 360 + 360) % 360;
        if (e.type === "ARC" && !angleInArc(deg, e.startAngle, e.endAngle)) continue;
        consider({ x: e.center.x + e.radius * Math.cos(angle), y: e.center.y + e.radius * Math.sin(angle), kind: "tangent" });
      }
    }
  }
  if (!best && on.has("nearest")) {
    let nd = tol;
    for (const i of ids) { const p = nearestOnEntity(entities[i], x, y); if (!p) continue; const d = Math.hypot(p.x - x, p.y - y); if (d < nd) { nd = d; best = { ...p, kind: "nearest" }; } }
  }
  return best;
}

/** Snap only to what is under the cursor, then fall back to the raw point. */
export function snapOrRaw(idx: SpatialIndex, entities: DxfEntity[], x: number, y: number, tol: number, modes: SnapKind[], visible?: (e: DxfEntity) => boolean): Snap {
  return findSnap(idx, entities, x, y, tol, modes, visible) ?? { x, y, kind: "nearest" as SnapKind } as Snap;
}

/* ───────────────────────── text search ───────────────────────── */

export interface TextHit { index: number; text: string; x: number; y: number }
export function searchText(entities: DxfEntity[], query: string, visible: (e: DxfEntity) => boolean = () => true): TextHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: TextHit[] = [];
  entities.forEach((e, index) => { if (e.type === "TEXT" && visible(e) && e.value.toLowerCase().includes(q)) out.push({ index, text: e.value, x: e.position.x, y: e.position.y }); });
  return out;
}

/* ───────────────────────── layer statistics ───────────────────────── */

export function countByLayer(entities: DxfEntity[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entities) m.set(e.layer, (m.get(e.layer) ?? 0) + 1);
  return m;
}
export function countByType(entities: DxfEntity[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entities) m.set(e.type, (m.get(e.type) ?? 0) + 1);
  return m;
}

/* ───────────────────────── rectangle selection ───────────────────────── */

export const boxContains = (outer: BBox, b: BBox) => b.minX >= outer.minX && b.maxX <= outer.maxX && b.minY >= outer.minY && b.maxY <= outer.maxY;
export const boxesIntersect = (a: BBox, b: BBox) => !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);

function segHitsRect(a: Pt, b: Pt, r: BBox): boolean {
  const inside = (p: Pt) => p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;
  if (inside(a) || inside(b)) return true;
  const c: Pt[] = [{ x: r.minX, y: r.minY }, { x: r.maxX, y: r.minY }, { x: r.maxX, y: r.maxY }, { x: r.minX, y: r.maxY }];
  for (let i = 0; i < 4; i++) if (segSegIntersection(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/**
 * True when an infinite construction line (or forward-only ray) intersects a
 * selection rectangle. The start point may be far outside the selection box.
 */
function infiniteLineHitsRect(e: Extract<DxfEntity, { type: "RAY" | "XLINE" }>, rect: BBox): boolean {
  const dx = e.direction.x, dy = e.direction.y;
  if (Math.hypot(dx, dy) < 1e-18) return false;
  let tMin = e.type === "RAY" ? 0 : -Infinity;
  let tMax = Infinity;
  const clipAxis = (origin: number, direction: number, min: number, max: number): boolean => {
    if (Math.abs(direction) < 1e-18) return origin >= min && origin <= max;
    const a = (min - origin) / direction;
    const b = (max - origin) / direction;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
    return tMin <= tMax;
  };
  return clipAxis(e.start.x, dx, rect.minX, rect.maxX) &&
    clipAxis(e.start.y, dy, rect.minY, rect.maxY) &&
    tMin <= tMax;
}

/**
 * Entities picked by a world-space rectangle.
 * "window": entity must lie fully inside. "crossing": entity only has to touch the rectangle.
 */
export function selectInRect(idx: SpatialIndex, entities: DxfEntity[], rect: BBox, mode: "window" | "crossing", visible: (e: DxfEntity) => boolean = () => true): number[] {
  const out: number[] = [];
  for (const i of queryIndexBox(idx, entities, rect)) {
    const b = idx.boxes[i], e = entities[i];
    if (!visible(e)) continue;
    if (e.type === "RAY" || e.type === "XLINE") {
      // Infinite construction lines cannot be fully enclosed by a window
      // selection, but must participate in crossing selection along their path.
      if (mode === "crossing" && infiniteLineHitsRect(e, rect)) out.push(i);
      continue;
    }
    if (mode === "window") { if (boxContains(rect, b)) out.push(i); continue; }
    if (!boxesIntersect(b, rect)) continue;
    const segs = entitySegments(e);
    if (segs.length) { if (segs.some(([p, q]) => segHitsRect(p, q, rect))) out.push(i); }
    else if (e.type === "CIRCLE" || e.type === "ARC") {
      const cx = Math.max(rect.minX, Math.min(e.center.x, rect.maxX)), cy = Math.max(rect.minY, Math.min(e.center.y, rect.maxY));
      const dNear = Math.hypot(cx - e.center.x, cy - e.center.y);
      const dFar = Math.max(...[[rect.minX, rect.minY], [rect.maxX, rect.minY], [rect.maxX, rect.maxY], [rect.minX, rect.maxY]].map(([x, y]) => Math.hypot(x - e.center.x, y - e.center.y)));
      if (dNear <= e.radius && dFar >= e.radius) { if (e.type === "CIRCLE" || boxesIntersect(b, rect)) out.push(i); }
    } else out.push(i);
  }
  return out;
}

export const rectOf = (a: Pt, b: Pt): BBox => ({ minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) });

/** Bounding box of a set of entities, or null when empty. */
export function bboxOfSet(idx: SpatialIndex, ids: Iterable<number>): BBox | null {
  let r: BBox | null = null;
  for (const i of ids) r = unionBBox(r, idx.boxes[i]);
  return r;
}

/** Round scale-bar length (world units) whose on-screen width is close to `targetPx`. */
export function niceScaleBar(scale: number, targetPx = 120): { length: number; px: number } {
  const raw = targetPx / scale, pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow, step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
  const length = step * pow;
  return { length, px: length * scale };
}

/** Grid spacing (world units) so lines stay roughly `minPx` apart. */
export function gridStep(scale: number, minPx = 18): number {
  const raw = minPx / scale, pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/** CSV text for a list of measurement result lines. */
export function resultsToCsv(lines: string[]): string {
  return "No,Measurement\n" + lines.map((l, i) => `${i + 1},"${l.replace(/"/g, '""')}"`).join("\n");
}


/* ───────────────────────── hatch patterns ───────────────────────── */

export interface HatchFamily { angle: number; spacing: number }

const PAT: Array<[RegExp, Array<[number, number]>]> = [
  [/^ANSI3[7-8]$|^NET$|^GRID$|^SQUARE$|^AR-B816$|^BRICK$|^AR-B88$/i, [[45, 3.175], [135, 3.175]]],
  [/^NET3$/i, [[0, 3.175], [60, 3.175], [120, 3.175]]],
  [/^ANSI32$|^STEEL$/i, [[45, 9.525], [45, 11.1]]],
  [/^ANSI33$/i, [[45, 6.35], [45, 8]]],
  [/^ANSI34$|^ANSI35$|^ANSI36$/i, [[45, 4.5]]],
  [/^LINE$|^AR-CONC$|^EARTH$|^ESCHER$/i, [[0, 3.175]]],
  [/^DOTS$|^DOT$|^GRAVEL$|^AR-SAND$|^AR-HBONE$|^HONEY$|^HEX$|^CROSS$/i, [[0, 3.175], [90, 3.175]]],
  [/^ANSI31$|^ANSI3\d$|^ANGLE$|^ZIGZAG$|^SOLID$/i, [[45, 3.175]]],
];

/** Parallel-line families for a (non-solid) CAD hatch pattern. Spacing is in drawing units. */
export function hatchFamilies(pattern: string | undefined, angle = 0, scale = 1): HatchFamily[] {
  const name = (pattern ?? "ANSI31").trim();
  const row = PAT.find(([re]) => re.test(name))?.[1] ?? [[45, 3.175]];
  const sc = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return row.map(([a, sp]) => ({ angle: a + angle, spacing: sp * sc }));
}

/** Lines of one hatch family covering `box`, anchored at the drawing origin like DWG. Segment = [x1,y1,x2,y2]. */
export function hatchLineSegments(box: BBox, angleDeg: number, spacing: number, maxLines = 4000): Array<[number, number, number, number]> {
  if (!(spacing > 0)) return [];
  const a = angleDeg * DEG, dx = Math.cos(a), dy = Math.sin(a), nx = -dy, ny = dx;
  const cs = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
  let nMin = Infinity, nMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (const [x, y] of cs) { const n = x * nx + y * ny, t = x * dx + y * dy; nMin = Math.min(nMin, n); nMax = Math.max(nMax, n); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
  const k0 = Math.ceil(nMin / spacing), k1 = Math.floor(nMax / spacing);
  if (k1 - k0 + 1 > maxLines) return [];
  const out: Array<[number, number, number, number]> = [];
  for (let k = k0; k <= k1; k++) { const o = k * spacing; out.push([o * nx + tMin * dx, o * ny + tMin * dy, o * nx + tMax * dx, o * ny + tMax * dy]); }
  return out;
}

/**
 * Exact DXF hatch pattern definition → clipped dashed segments.
 *
 * Each family is one pattern-line definition straight from the file (already
 * transformed into drawing space by the mapper): `angle` in radians, `base`
 * the line's anchor point, `offset` the vector to the next parallel line
 * (perpendicular spacing plus the along-line shift DWG uses) and `dashes`
 * the alternating dash(+)/gap(−) lengths anchored at each line origin.
 * Segment = [x1,y1,x2,y2] in world coordinates.
 */
export function hatchPatternLineSegments(
  box: BBox,
  fams: Array<{ angle: number; base: [number, number]; offset: [number, number]; dashes: number[] }>,
  maxLines = 4000,
): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  const cs = [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.maxX, box.maxY],
    [box.minX, box.maxY],
  ];
  for (const f of fams) {
    const a = Number.isFinite(f.angle) ? f.angle : 0;
    const ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
    const step = f.offset[0] * nx + f.offset[1] * ny;
    if (!(Math.abs(step) > 1e-9)) continue; // degenerate: lines coincide
    const shift = f.offset[0] * ux + f.offset[1] * uy;
    const baseN = f.base[0] * nx + f.base[1] * ny;
    let nMin = Infinity, nMax = -Infinity, uMin = Infinity, uMax = -Infinity;
    for (const [x, y] of cs) {
      const n = x * nx + y * ny, u = x * ux + y * uy;
      if (n < nMin) nMin = n;
      if (n > nMax) nMax = n;
      if (u < uMin) uMin = u;
      if (u > uMax) uMax = u;
    }
    // Lines exist where nMin <= baseN + k*step <= nMax; when step is negative
    // the k range inverts, so normalise the interval first.
    let lo = (nMin - baseN) / step, hi = (nMax - baseN) / step;
    if (step < 0) { const tmp = lo; lo = hi; hi = tmp; }
    const k0 = Math.ceil(lo), k1 = Math.floor(hi);
    const count = k1 - k0 + 1;
    if (count < 1 || count > maxLines) continue;
    const patternLen = f.dashes.reduce((s, d) => s + Math.abs(d), 0);
    const hasDashes = f.dashes.length > 0 && patternLen > 1e-9;
    for (let k = k0; k <= k1; k++) {
      const ox = f.base[0] + k * f.offset[0], oy = f.base[1] + k * f.offset[1];
      const originU = ox * ux + oy * uy;
      const wMin = uMin - originU, wMax = uMax - originU;
      if (!hasDashes) {
        // Continuous family line.
        out.push([
          ox + wMin * ux, oy + wMin * uy,
          ox + wMax * ux, oy + wMax * uy,
        ]);
        continue;
      }
      // Dashed family line: dash pattern repeats with period patternLen,
      // anchored at the line origin (w = 0) like DWG.
      const first = Math.floor(wMin / patternLen);
      const last = Math.ceil(wMax / patternLen);
      for (let rep = first; rep <= last; rep++) {
        let w = rep * patternLen;
        for (const d of f.dashes) {
          const len = Math.abs(d);
          if (d > 0) {
            const s0 = Math.max(w, wMin), s1 = Math.min(w + len, wMax);
            if (s1 > s0) {
              out.push([ox + s0 * ux, oy + s0 * uy, ox + s1 * ux, oy + s1 * uy]);
            }
          }
          w += len;
        }
        if (out.length > maxLines * 64) return out; // hard safety valve
      }
    }
  }
  return out;
}

/* ───────────────────────── linetypes ───────────────────────── */

/** On-screen dash patterns (px) used when the file does not define a linetype. */
const FALLBACK_DASH: Array<[RegExp, number[]]> = [
  [/PHANTOM/i, [20, 4, 4, 4, 4, 4]],
  [/CENTER|ISO04|ISO08|ISO10/i, [20, 4, 5, 4]],
  [/DASHDOT|DASHDOT2|ISO03|ISO05|ISO09|ISO12|ISO13|ISO14|ISO15/i, [10, 4, 2, 4]],
  [/HIDDEN|ISO02|ISO06/i, [6, 4]],
  [/DASHED|DASH|BORDER|ISO01/i, [10, 6]],
  [/DOT|DIVIDE|ISO07|ISO11/i, [1.5, 4]],
];

export function isContinuousLinetype(name: string | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toUpperCase();
  return n === "" || n === "CONTINUOUS" || n === "BYLAYER" || n === "BYBLOCK";
}

/**
 * Canvas dash array (px) for a linetype, or [] for a continuous line.
 * Defined patterns scale with the drawing (world units * ltscale); undefined names fall back to a fixed screen pattern.
 */
export function resolveDash(name: string | undefined, defs: Record<string, number[]> | undefined, ltscale: number | undefined, viewScale: number): number[] {
  if (isContinuousLinetype(name)) return [];
  const key = name!.trim().toUpperCase();
  const def = defs?.[key];
  if (def && def.length >= 2) {
    const k = (ltscale && ltscale > 0 ? ltscale : 1) * viewScale;
    const px = def.map((v) => (Math.abs(v) < 1e-12 ? 1 : Math.max(Math.abs(v) * k, 0.6)));
    const total = px.reduce((a, b) => a + b, 0);
    if (total < 3.5) return [];        // too dense to read at this zoom: draw solid
    if (total > 4000) return [];       // absurdly long: draw solid
    return px;
  }
  return FALLBACK_DASH.find(([re]) => re.test(key))?.[1] ?? [];
}

/* ───────────────────────── paper-space layouts ───────────────────────── */

export const viewportRect = (vp: DxfViewport): BBox => ({ minX: vp.center.x - vp.width / 2, maxX: vp.center.x + vp.width / 2, minY: vp.center.y - vp.height / 2, maxY: vp.center.y + vp.height / 2 });
/** Sheet units per model unit through this viewport. */
export const viewportScale = (vp: DxfViewport): number => vp.height / vp.viewHeight;

/** Model point -> sheet point through a viewport (view twist rotates the model by -twist). */
export function modelToSheet(vp: DxfViewport, p: Pt): Pt {
  const s = viewportScale(vp), a = -(vp.twist ?? 0) * DEG, c = Math.cos(a), sn = Math.sin(a);
  const dx = (p.x - vp.viewCenter.x) * s, dy = (p.y - vp.viewCenter.y) * s;
  return { x: vp.center.x + dx * c - dy * sn, y: vp.center.y + dx * sn + dy * c };
}

export function layoutBounds(l: DxfLayout): BBox | null {
  let b: BBox | null = null;
  for (const e of l.entities) { const eb = entityBBox(e); if (Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) b = unionBBox(b, eb); }
  for (const vp of l.viewports) b = unionBBox(b, viewportRect(vp));
  return b;
}

/* ───────────────────────── drawing compare ───────────────────────── */

function sigNum(v: number, q: number): number { return Math.round(v / q); }
function pointSig(p: Pt, q: number): string { return `${sigNum(p.x, q)},${sigNum(p.y, q)}`; }

/** Geometry-only signature of an entity (layer ignored), quantised to `tol`. Polylines match in either direction. */
export function entitySignature(e: DxfEntity, tol: number): string {
  const q = Math.max(tol, 1e-9);
  switch (e.type) {
    case "LINE": { const a = pointSig(e.start, q), b = pointSig(e.end, q); return "L" + (a < b ? `${a}|${b}` : `${b}|${a}`); }
    case "CIRCLE": return `C${pointSig(e.center, q)}r${sigNum(e.radius, q)}`;
    case "ARC": return `A${pointSig(e.center, q)}r${sigNum(e.radius, q)}a${Math.round(norm360(e.startAngle) * 100)}-${Math.round(norm360(e.endAngle) * 100)}`;
    case "LWPOLYLINE": { const f = e.points.map((p) => pointSig(p, q)).join(";"), r = [...e.points].reverse().map((p) => pointSig(p, q)).join(";"); return "P" + (e.closed ? "c" : "o") + (f < r ? f : r) + (e.hatch ? "h" : ""); }
    case "TEXT": return `T${pointSig(e.position, q)}${e.value}`;
    case "POINT": return `O${pointSig(e.position, q)}`;
    case "RAY": return `R${pointSig(e.start, q)}${pointSig(e.direction, q)}`;
    case "XLINE": return `X${pointSig(e.start, q)}${pointSig(e.direction, q)}`;
  }
}

/** Multiset diff of two entity lists. Returns indices in `a` that vanished and in `b` that are new. */
export function diffEntities(a: DxfEntity[], b: DxfEntity[], tol: number): { removed: number[]; added: number[]; same: number } {
  const bag = new Map<string, number>();
  for (const e of b) { const k = entitySignature(e, tol); bag.set(k, (bag.get(k) ?? 0) + 1); }
  const removed: number[] = []; let same = 0;
  const seen = new Map<string, number>();
  a.forEach((e, i) => { const k = entitySignature(e, tol); const left = bag.get(k) ?? 0; if (left > 0) { bag.set(k, left - 1); same++; seen.set(k, (seen.get(k) ?? 0) + 1); } else removed.push(i); });
  const added: number[] = [];
  const used = new Map<string, number>(); 
  b.forEach((e, i) => { const k = entitySignature(e, tol); const matched = seen.get(k) ?? 0; const u = used.get(k) ?? 0; if (u < matched) used.set(k, u + 1); else added.push(i); });
  return { removed, added, same };
}

/** Compare tolerance: a small fraction of the drawing size. */
export const compareTolerance = (b: BBox): number => Math.max(Math.max(b.maxX - b.minX, b.maxY - b.minY) * 1e-5, 1e-9);

/* ───────────────────────── plotting ───────────────────────── */

export const PAPER_MM: Record<string, [number, number]> = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841], A0: [841, 1189], Letter: [215.9, 279.4], Tabloid: [279.4, 431.8] };

export function paperMm(name: string, landscape: boolean): { w: number; h: number } {
  const [s, l] = PAPER_MM[name] ?? PAPER_MM.A4;
  return landscape ? { w: l, h: s } : { w: s, h: l };
}

/** Pixel size of the printable area for a raster plot (longest side capped). */
export function plotPixels(paperW: number, paperH: number, marginMm: number, dpi = 150, maxSide = 6000): { w: number; h: number } {
  const pw = Math.max(paperW - 2 * marginMm, 10), ph = Math.max(paperH - 2 * marginMm, 10);
  let k = dpi / 25.4; const longest = Math.max(pw, ph) * k;
  if (longest > maxSide) k *= maxSide / longest;
  return { w: Math.max(1, Math.round(pw * k)), h: Math.max(1, Math.round(ph * k)) };
}

/* ───────────────────────── quick measure text ───────────────────────── */

/** One-line summary for the quick-measure tooltip (values in drawing units; caller formats). */
export function quickMeasureParts(e: DxfEntity): Array<{ label: string; value: number; power: 1 | 2 | 0 }> {
  const m = entityMetrics(e), out: Array<{ label: string; value: number; power: 1 | 2 | 0 }> = [];
  if (m.radius != null) out.push({ label: "R", value: m.radius, power: 1 });
  if (m.length != null) out.push({ label: e.type === "CIRCLE" ? "Circumference" : "Length", value: m.length, power: 1 });
  if (m.area != null) out.push({ label: "Area", value: m.area, power: 2 });
  if (m.sweep != null) out.push({ label: "Sweep°", value: m.sweep, power: 0 });
  return out;
}

/* ───────────────────────── grip editing ───────────────────────── */

/** One DWG grip hotspot on an entity (unselected: blue, hover: green, hot: red). */
export interface Grip {
  x: number;
  y: number;
  /** What dragging this grip does. */
  role: "move" | "start" | "end" | "vertex" | "center" | "radius";
  /** LWPOLYLINE: vertex index for "vertex" grips. ARC: 0 = start angle, 1 = end angle. */
  vi?: number;
}

const gripCircle = (e: Extract<DxfEntity, { type: "CIRCLE" }>): Grip[] => [
  { x: e.center.x, y: e.center.y, role: "move" },
  ...[0, 90, 180, 270].map((q) => ({ ...arcPt(e, q), role: "radius" as const })),
];

/**
 * DWG grip hotspots for an entity: blue squares that can be dragged to
 * stretch (LINE ends, polyline vertices), move (center / insertion), or
 * resize (circle/arc radius, arc angles). Grip count is naturally bounded —
 * callers may cap it for huge selections.
 */
export function entityGrips(e: DxfEntity): Grip[] {
  switch (e.type) {
    case "LINE":
      return [
        { x: e.start.x, y: e.start.y, role: "start" },
        { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2, role: "move" },
        { x: e.end.x, y: e.end.y, role: "end" },
      ];
    case "CIRCLE":
      return gripCircle(e);
    case "ARC":
      return [
        { x: e.center.x, y: e.center.y, role: "move" },
        { ...arcPt(e, e.startAngle), role: "vertex" as const, vi: 0 },
        { ...arcPt(e, e.endAngle), role: "vertex" as const, vi: 1 },
        { ...arcPt(e, e.startAngle + arcSweepDeg(e.startAngle, e.endAngle) / 2), role: "radius" as const },
      ];
    case "LWPOLYLINE": {
      if (e.hatch) return []; // hatched boundaries edit through HATCHEDIT-style flows, not grips
      const out: Grip[] = e.points.map((p, i) => ({ x: p.x, y: p.y, role: "vertex" as const, vi: i }));
      return out;
    }
    case "TEXT":
      return [{ x: e.position.x, y: e.position.y, role: "move" }];
    case "POINT":
      return [{ x: e.position.x, y: e.position.y, role: "move" }];
    case "RAY":
    case "XLINE":
      return [{ x: e.start.x, y: e.start.y, role: "move" }];
    default:
      return [];
  }
}

/**
 * GRIP DRAG: return a NEW entity with the grip `gi` of `entityGrips(e)` moved
 * to `to`. Immutable like every modify helper — returns null when the grip
 * does not apply (index stale, wrong role).
 */
export function applyGripDrag(e: DxfEntity, gi: number, to: Pt): DxfEntity | null {
  const grips = entityGrips(e);
  const g = grips[gi];
  if (!g) return null;
  switch (e.type) {
    case "LINE": {
      if (g.role === "start") return { ...e, start: { x: to.x, y: to.y } };
      if (g.role === "end") return { ...e, end: { x: to.x, y: to.y } };
      // Midpoint grip: move the whole line.
      const d = { x: to.x - g.x, y: to.y - g.y };
      return { ...e, start: { x: e.start.x + d.x, y: e.start.y + d.y }, end: { x: e.end.x + d.x, y: e.end.y + d.y } };
    }
    case "CIRCLE": {
      if (g.role === "move") return { ...e, center: { x: to.x, y: to.y } };
      if (g.role === "radius") {
        const r = Math.hypot(to.x - e.center.x, to.y - e.center.y);
        return r > 1e-12 ? { ...e, radius: r } : null;
      }
      return null;
    }
    case "ARC": {
      if (g.role === "move") return { ...e, center: { x: to.x, y: to.y } };
      if (g.role === "vertex") {
        const a = (Math.atan2(to.y - e.center.y, to.x - e.center.x) * 180) / Math.PI;
        return g.vi === 0 ? { ...e, startAngle: norm360(a) } : { ...e, endAngle: norm360(a) };
      }
      if (g.role === "radius") {
        const r = Math.hypot(to.x - e.center.x, to.y - e.center.y);
        return r > 1e-12 ? { ...e, radius: r } : null;
      }
      return null;
    }
    case "LWPOLYLINE": {
      if (g.role === "vertex" && g.vi != null && g.vi >= 0 && g.vi < e.points.length) {
        const pts = e.points.map((q) => ({ ...q }));
        pts[g.vi] = { x: to.x, y: to.y };
        return { ...e, points: pts, hatch: e.hatch ? { ...e.hatch, loops: [pts, ...e.hatch.loops.slice(1)] } : undefined };
      }
      return null;
    }
    case "TEXT":
    case "POINT":
      return { ...e, position: { x: to.x, y: to.y } };
    case "RAY":
    case "XLINE":
      return { ...e, start: { x: to.x, y: to.y } };
    default:
      return null;
  }
}
