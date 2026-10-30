/**
 * Pure geometry for the CAD Viewer: view transform, picking, snapping, measuring, units, text search.
 * No DOM, no rendering; everything works on the flattened DxfEntity vocabulary the DXF/DWG readers produce.
 */
import type { DxfEntity, DxfLayout, DxfPoint, DxfUnits, DxfViewport } from "../drawings/dxf-types";

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

/** AutoCAD default MTEXT line pitch = 5/3 of the text height. */
export const TEXT_LINE_PITCH = 5 / 3;

function linesOf(e: Extract<DxfEntity, { type: "TEXT" }>): string[] {
  return String(e.value ?? "").split("\n");
}

export function textBox(e: Extract<DxfEntity, { type: "TEXT" }>): { w: number; h: number } {
  const lines = linesOf(e);
  const longest = Math.max(...lines.map((l) => l.length), 0);
  return {
    w: Math.max(e.height * 0.6 * longest, e.height * 0.3),
    h: e.height + (lines.length - 1) * e.height * TEXT_LINE_PITCH,
  };
}

/**
 * Baseline offset (world units, y up, relative to the insertion point) of every line of a TEXT/MTEXT,
 * honouring the vertical anchor. Single-line text keeps the previous behaviour.
 */
export function textLineBaselines(e: Extract<DxfEntity, { type: "TEXT" }>): number[] {
  const n = linesOf(e).length, h = e.height, H = textBox(e).h;
  const top = e.valign === "top" ? 0 : e.valign === "middle" ? H / 2 : e.valign === "bottom" ? H : h;
  return Array.from({ length: n }, (_, i) => top - h - i * h * TEXT_LINE_PITCH);
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
  }
}

/** Closest point on the entity's outline to (x, y), or null for text / points. */
export function nearestOnEntity(e: DxfEntity, x: number, y: number): Pt | null {
  switch (e.type) {
    case "LINE": return nearestOnSeg(x, y, e.start.x, e.start.y, e.end.x, e.end.y);
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

/* ───────────────────────── measurements ───────────────────────── */

/** Direction a→b in degrees, 0..360 CCW from +X. */
export const norm360Deg = (a: Pt, b: Pt) => norm360((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
export const distance = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Constrain point B to the nearest axis-aligned direction from A (Ortho mode). */
export function orthoConstrain(a: Pt, b: Pt): Pt {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  return dx >= dy ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
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

/* ───────────────────────── spatial index ───────────────────────── */

export interface SpatialIndex { cell: number; minX: number; minY: number; cols: number; rows: number; cells: Map<number, number[]>; big: number[]; boxes: BBox[] }

export function buildIndex(entities: DxfEntity[], bounds: BBox, targetCells = 256): SpatialIndex {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-9), h = Math.max(bounds.maxY - bounds.minY, 1e-9);
  const cell = Math.max(w, h) / targetCells;
  const cols = Math.ceil(w / cell) + 1, rows = Math.ceil(h / cell) + 1;
  const idx: SpatialIndex = { cell, minX: bounds.minX, minY: bounds.minY, cols, rows, cells: new Map(), big: [], boxes: new Array(entities.length) };
  entities.forEach((e, i) => {
    const b = entityBBox(e); idx.boxes[i] = b;
    const c0 = Math.floor((b.minX - bounds.minX) / cell), c1 = Math.floor((b.maxX - bounds.minX) / cell);
    const r0 = Math.floor((b.minY - bounds.minY) / cell), r1 = Math.floor((b.maxY - bounds.minY) / cell);
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 64) { idx.big.push(i); return; }
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; const a = idx.cells.get(k); if (a) a.push(i); else idx.cells.set(k, [i]); }
  });
  return idx;
}

/** Entity indices whose bounding box could be within `radius` of (x, y). */
export function queryIndex(idx: SpatialIndex, x: number, y: number, radius: number): number[] {
  const out = new Set<number>(idx.big);
  const c0 = Math.floor((x - radius - idx.minX) / idx.cell), c1 = Math.floor((x + radius - idx.minX) / idx.cell);
  const r0 = Math.floor((y - radius - idx.minY) / idx.cell), r1 = Math.floor((y + radius - idx.minY) / idx.cell);
  for (let r = Math.max(r0, 0); r <= Math.min(r1, idx.rows - 1); r++) for (let c = Math.max(c0, 0); c <= Math.min(c1, idx.cols - 1); c++) {
    const a = idx.cells.get(r * idx.cols + c); if (a) for (const i of a) out.add(i);
  }
  return [...out].filter((i) => { const b = idx.boxes[i]; return x >= b.minX - radius && x <= b.maxX + radius && y >= b.minY - radius && y <= b.maxY + radius; });
}

/** Index of the entity nearest the point within `tol` (world units), preferring smaller entities on ties. */
export function pickEntity(idx: SpatialIndex, entities: DxfEntity[], x: number, y: number, tol: number, visible: (e: DxfEntity) => boolean = () => true): number {
  let best = -1, bd = tol;
  for (const i of queryIndex(idx, x, y, tol)) {
    const e = entities[i];
    if (!visible(e)) continue;
    const d = distToEntity(e, x, y) + (isHatchEntity(e) ? tol * 0.6 : 0); // a line near the cursor beats a hatch edge
    if (d < bd - 1e-12) { bd = d; best = i; }
  }
  return best;
}

/* ───────────────────────── snapping ───────────────────────── */

export type SnapKind = "endpoint" | "midpoint" | "center" | "quadrant" | "intersection" | "nearest";
export interface Snap { x: number; y: number; kind: SnapKind }
export const ALL_SNAPS: SnapKind[] = ["endpoint", "midpoint", "center", "quadrant", "intersection", "nearest"];

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

const TIER: Record<SnapKind, number> = { endpoint: 0, midpoint: 0, center: 0, quadrant: 0, intersection: 1, nearest: 2 };

export function findSnap(idx: SpatialIndex, entities: DxfEntity[], x: number, y: number, tol: number, modes: SnapKind[] = ALL_SNAPS, visible: (e: DxfEntity) => boolean = () => true): Snap | null {
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
 * Entities picked by a world-space rectangle.
 * "window": entity must lie fully inside. "crossing": entity only has to touch the rectangle.
 */
export function selectInRect(idx: SpatialIndex, entities: DxfEntity[], rect: BBox, mode: "window" | "crossing", visible: (e: DxfEntity) => boolean = () => true): number[] {
  const out: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    const b = idx.boxes[i], e = entities[i];
    if (!visible(e)) continue;
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

/** Lines of one hatch family covering `box`, anchored at the drawing origin like AutoCAD. Segment = [x1,y1,x2,y2]. */
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
