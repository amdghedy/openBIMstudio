/**
 * Pure geometry for the CAD Viewer: view transform, picking, snapping, measuring, units, text search.
 * No DOM, no rendering; everything works on the flattened DxfEntity vocabulary the DXF/DWG readers produce.
 */
import type { DxfEntity, DxfPoint, DxfUnits } from "../drawings/dxf-types";

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

export function textBox(e: Extract<DxfEntity, { type: "TEXT" }>): { w: number; h: number } {
  return { w: Math.max(e.height * 0.6 * e.value.length, e.height * 0.3), h: e.height };
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
    case "LWPOLYLINE": return boxOf(e.points);
    case "TEXT": {
      const { w, h } = textBox(e), r = (e.rotation ?? 0) * DEG, c = Math.cos(r), s = Math.sin(r);
      return boxOf([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map((p) => ({ x: e.position.x + p.x * c - p.y * s, y: e.position.y + p.x * s + p.y * c })));
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
      const { w, h } = textBox(e), r = -(e.rotation ?? 0) * DEG, c = Math.cos(r), s = Math.sin(r);
      const lx = (x - e.position.x) * c - (y - e.position.y) * s, ly = (x - e.position.x) * s + (y - e.position.y) * c;
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
    case "LWPOLYLINE": return { length: pathLength(e.points, !!e.closed), ...(e.closed && e.points.length > 2 ? { area: polygonArea(e.points) } : {}) };
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
    const d = distToEntity(e, x, y);
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
  const ids = queryIndex(idx, x, y, tol).filter((i) => visible(entities[i]));
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
