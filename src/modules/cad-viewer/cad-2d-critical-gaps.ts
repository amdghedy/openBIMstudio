/**
 * 2D CAD engine — critical gap utilities (AutoCAD-style helpers).
 * Pure functions; cad-viewer wires them into commands.
 */
import type { DxfDocument, DxfEntity, DxfLayer } from "../drawings/dxf-types";
import { bulgeArc, polylineArea, polylineLength } from "../drawings/dxf-geometry";
import { bulgeSegmentArc, reversePolylineEntity, withClosed } from "./cad-polyline";

type Pt = { x: number; y: number };

export function centerMarkEntities(
  circle: Extract<DxfEntity, { type: "CIRCLE" }>,
  layer: string,
  scale = 1,
): DxfEntity[] {
  const c = circle.center;
  const r = Number(circle.radius) || 0;
  if (r <= 0) return [];
  const arm = Math.max(r * 0.15, 0.05) * scale;
  const gap = arm * 0.35;
  const mk = (x1: number, y1: number, x2: number, y2: number): DxfEntity =>
    ({
      type: "LINE",
      layer: circle.layer || layer,
      color: circle.color,
      lineType: "CENTER",
      start: { x: x1, y: y1 },
      end: { x: x2, y: y2 },
    }) as DxfEntity;
  return [
    mk(c.x - r - arm, c.y, c.x - gap, c.y),
    mk(c.x + gap, c.y, c.x + r + arm, c.y),
    mk(c.x, c.y - r - arm, c.x, c.y - gap),
    mk(c.x, c.y + gap, c.x, c.y + r + arm),
  ];
}

/** Centerline between two roughly parallel lines (mid parallel segment). */
export function centerLineBetween(
  a: Extract<DxfEntity, { type: "LINE" }>,
  b: Extract<DxfEntity, { type: "LINE" }>,
  layer: string,
): DxfEntity | null {
  const mid = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  // Pair endpoints by nearest
  const ends = [a.start, a.end];
  const other = [b.start, b.end];
  let best = 0;
  let bi = 0, bj = 1;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const d =
        Math.hypot(ends[i].x - other[j].x, ends[i].y - other[j].y) +
        Math.hypot(ends[1 - i].x - other[1 - j].x, ends[1 - i].y - other[1 - j].y);
      if (i === 0 && j === 0) best = d;
      else if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  const p1 = mid(ends[bi], other[bj]);
  const p2 = mid(ends[1 - bi], other[1 - bj]);
  if (Math.hypot(p2.x - p1.x, p2.y - p1.y) < 1e-9) return null;
  return {
    type: "LINE",
    layer,
    lineType: "CENTER",
    start: p1,
    end: p2,
  } as DxfEntity;
}

export function purgeEmptyLayers(doc: DxfDocument): string[] {
  const used = new Set<string>();
  for (const e of doc.entities ?? []) {
    if (e.layer) used.add(e.layer);
  }
  const removed: string[] = [];
  const layers = (doc.layers ?? []) as DxfLayer[];
  doc.layers = layers.filter((L) => {
    const name = L.name;
    if (!name || name === "0" || used.has(name)) return true;
    removed.push(name);
    return false;
  }) as any;
  return removed;
}

export function selectIdsByLayer(entities: DxfEntity[], layer: string): number[] {
  const ids: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    if (entities[i].layer === layer) ids.push(i);
  }
  return ids;
}

export function selectIdsByType(entities: DxfEntity[], type: string): number[] {
  const t = type.toUpperCase();
  const ids: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    if (String(entities[i].type).toUpperCase() === t) ids.push(i);
  }
  return ids;
}

/** Bounds of selected entity indices. */
export function selectionBounds(
  entities: DxfEntity[],
  indices: number[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let any = false;
  const touch = (x: number, y: number) => {
    any = true;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const i of indices) {
    const e: AnyEnt = entities[i] as AnyEnt;
    if (!e) continue;
    if (e.start && e.end) {
      touch(e.start.x, e.start.y); touch(e.end.x, e.end.y);
    }
    if (e.center && e.radius != null) {
      touch(e.center.x - e.radius, e.center.y - e.radius);
      touch(e.center.x + e.radius, e.center.y + e.radius);
    }
    if (Array.isArray(e.points)) {
      for (const p of e.points) touch(p.x, p.y);
    }
    if (e.position) touch(e.position.x, e.position.y);
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

type AnyEnt = {
  start?: Pt; end?: Pt; center?: Pt; radius?: number;
  points?: Pt[]; position?: Pt;
};

export function countByType(entities: DxfEntity[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entities) {
    const t = String(e.type || "?");
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

/** Simple drawing properties bag for DWGPROPS-like command. */
export function drawingPropsSummary(doc: DxfDocument, fileName?: string): string {
  const ents = doc.entities ?? [];
  const by = countByType(ents);
  const layers = (doc.layers ?? []).length;
  const lines = [
    `Drawing: ${fileName || "Untitled"}`,
    `Entities: ${ents.length}`,
    `Layers: ${layers}`,
    `LTSCALE: ${doc.ltscale ?? 1}`,
    `Types: ${Object.entries(by).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`,
  ];
  return lines.join("\n");
}


export function totalLinearLength(entities: DxfEntity[], indices: number[]): number {
  let sum = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.type === "LINE" && e.start && e.end) {
      sum += Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y);
    } else if (e.type === "LWPOLYLINE" && Array.isArray(e.points) && e.points.length >= 2) {
      // A7: bulged segments count as arcs, not chords.
      sum += polylineLength(e.points, e.bulges, !!e.closed);
    } else if (e.type === "ARC" && e.center != null && e.radius != null) {
      const a0 = ((e.startAngle ?? 0) * Math.PI) / 180;
      const a1 = ((e.endAngle ?? 360) * Math.PI) / 180;
      let d = a1 - a0;
      while (d < 0) d += Math.PI * 2;
      while (d > Math.PI * 2) d -= Math.PI * 2;
      sum += Math.abs(e.radius) * d;
    } else if (e.type === "CIRCLE" && e.radius != null) {
      sum += 2 * Math.PI * Math.abs(e.radius);
    }
  }
  return sum;
}

export function solidFillEntity(
  pts: Array<{ x: number; y: number }>,
  layer: string,
): DxfEntity | null {
  if (pts.length < 3) return null;
  const poly = pts.length >= 4 ? pts.slice(0, 4) : [...pts, pts[0]];
  return {
    type: "LWPOLYLINE",
    layer,
    closed: true,
    points: poly,
    hatch: { pattern: "SOLID", scale: 1, angle: 0 } as any,
  } as DxfEntity;
}

/** Axis-aligned bounding rectangle as closed LWPOLYLINE. */
export function bboxPolyline(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  layer: string,
): DxfEntity {
  const { minX, minY, maxX, maxY } = bounds;
  return {
    type: "LWPOLYLINE",
    layer,
    closed: true,
    points: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  } as DxfEntity;
}

export function applyByLayer(entities: DxfEntity[], indices: number[]): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    e.color = undefined;
    e.rgb = undefined;
    e.lineType = undefined;
    e.lineweight = undefined;
    n++;
  }
  return n;
}

export function setTextRotation(entities: DxfEntity[], indices: number[], deg: number): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || (e.type !== "TEXT" && e.type !== "MTEXT")) continue;
    e.rotation = deg;
    n++;
  }
  return n;
}

export function chpropSelection(
  entities: DxfEntity[],
  indices: number[],
  patch: { layer?: string; color?: number; lineType?: string },
): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (patch.layer != null) e.layer = patch.layer;
    if (patch.color != null) e.color = patch.color;
    if (patch.lineType != null) e.lineType = patch.lineType;
    n++;
  }
  return n;
}


export function scaleTextHeight(entities: DxfEntity[], indices: number[], factor: number): number {
  if (!(factor > 0)) return 0;
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || (e.type !== "TEXT" && e.type !== "MTEXT")) continue;
    e.height = (Number(e.height) || 2.5) * factor;
    n++;
  }
  return n;
}

export function justifyText(
  entities: DxfEntity[],
  indices: number[],
  align: "left" | "center" | "right",
): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || (e.type !== "TEXT" && e.type !== "MTEXT")) continue;
    e.align = align;
    n++;
  }
  return n;
}

export function setEntitiesLayer(entities: DxfEntity[], indices: number[], layer: string): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    e.layer = layer;
    n++;
  }
  return n;
}

export function cloneEntitiesToLayer(entities: DxfEntity[], indices: number[], layer: string): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const i of indices) {
    const e = entities[i];
    if (!e) continue;
    const c = JSON.parse(JSON.stringify(e)) as any;
    c.layer = layer;
    delete c.handle;
    out.push(c);
  }
  return out;
}

export function selectionArea(entities: DxfEntity[], indices: number[]): number {
  let area = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.type === "CIRCLE" && e.radius != null) {
      area += Math.PI * e.radius * e.radius;
    } else if (e.type === "LWPOLYLINE" && Array.isArray(e.points) && e.points.length >= 3 && e.closed) {
      // A7: bulged edges add their circular-segment correction — a
      // semicircle edge encloses more than its chord polygon.
      area += polylineArea(e.points, e.bulges, true);
    }
  }
  return area;
}

export function reversePolyline(entities: DxfEntity[], indices: number[]): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || e.type !== "LWPOLYLINE" || !Array.isArray(e.points)) continue;
    // A7: reversing points alone leaves the bulge/width arrays aligned
    // to the old direction — a bulged segment would arc the wrong way.
    // Replace the fields in place (the viewer holds this object by
    // reference and the command has no undo step — same as before).
    const rev = reversePolylineEntity(e);
    e.points = rev.points;
    if (rev.bulges) e.bulges = rev.bulges; else delete e.bulges;
    if (rev.width != null) e.width = rev.width; else delete e.width;
    if (rev.startWidths) e.startWidths = rev.startWidths; else delete e.startWidths;
    if (rev.endWidths) e.endWidths = rev.endWidths; else delete e.endWidths;
    n++;
  }
  return n;
}

export function setPolylineClosed(entities: DxfEntity[], indices: number[], closed: boolean): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || e.type !== "LWPOLYLINE") continue;
    // A7: closing is bookkeeping, not just a flag — the closing edge's
    // bulge is forced to 0 and its widths continue last→first.
    const next = withClosed(e, closed);
    e.closed = next.closed;
    if (next.bulges) e.bulges = next.bulges; else delete e.bulges;
    if (next.startWidths) e.startWidths = next.startWidths; else delete e.startWidths;
    if (next.endWidths) e.endWidths = next.endWidths; else delete e.endWidths;
    n++;
  }
  return n;
}

export function midpointMarkers(entities: DxfEntity[], indices: number[], layer: string): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.type === "LINE" && e.start && e.end) {
      out.push({
        type: "POINT",
        layer,
        position: { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 },
      } as DxfEntity);
    } else if (e.type === "LWPOLYLINE" && Array.isArray(e.points)) {
      // A7: a bulged segment's midpoint is the arc's own midpoint, not
      // the chord's — and the closing edge of a closed polyline gets a
      // marker too (the old code skipped it).
      const segCount = e.closed ? e.points.length : e.points.length - 1;
      for (let k = 0; k < segCount; k++) {
        const a = e.points[k], b = e.points[(k + 1) % e.points.length];
        const arc = bulgeArc(a, b, e.bulges?.[k] ?? 0);
        const mid = arc ? ((arc.startAngleDeg + arc.sweepDeg / 2) * Math.PI) / 180 : 0;
        const position = arc
          ? { x: arc.center.x + arc.radius * Math.cos(mid), y: arc.center.y + arc.radius * Math.sin(mid) }
          : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        out.push({ type: "POINT", layer, position } as DxfEntity);
      }
    }
  }
  return out;
}

function segIntersect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): { x: number; y: number } | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function entitySegments(e: any): Array<[{ x: number; y: number }, { x: number; y: number }]> {
  if (e.type === "LINE" && e.start && e.end) return [[e.start, e.end]];
  if (e.type === "LWPOLYLINE" && Array.isArray(e.points) && e.points.length >= 2) {
    const segs: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
    for (let k = 1; k < e.points.length; k++) segs.push([e.points[k - 1], e.points[k]]);
    if (e.closed && e.points.length > 2) segs.push([e.points[e.points.length - 1], e.points[0]]);
    return segs;
  }
  return [];
}

export function intersectionMarkers(entities: DxfEntity[], indices: number[], layer: string): DxfEntity[] {
  const segs: Array<[{ x: number; y: number }, { x: number; y: number }]> = [];
  for (const i of indices) {
    const e = entities[i];
    if (e) segs.push(...entitySegments(e));
  }
  const out: DxfEntity[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segIntersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]);
      if (!p) continue;
      const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: "POINT", layer, position: p } as DxfEntity);
    }
  }
  return out;
}


export function moveEntitiesBy(entities: DxfEntity[], indices: number[], dx: number, dy: number): number {
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.start) { e.start.x += dx; e.start.y += dy; }
    if (e.end) { e.end.x += dx; e.end.y += dy; }
    if (e.center) { e.center.x += dx; e.center.y += dy; }
    if (e.position) { e.position.x += dx; e.position.y += dy; }
    if (Array.isArray(e.points)) {
      for (const p of e.points) { p.x += dx; p.y += dy; }
    }
    n++;
  }
  return n;
}

export function scaleEntitiesAbout(
  entities: DxfEntity[],
  indices: number[],
  ox: number,
  oy: number,
  factor: number,
): number {
  if (!(factor > 0)) return 0;
  const sc = (p: { x: number; y: number }) => {
    p.x = ox + (p.x - ox) * factor;
    p.y = oy + (p.y - oy) * factor;
  };
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.start) sc(e.start);
    if (e.end) sc(e.end);
    if (e.center) sc(e.center);
    if (e.position) sc(e.position);
    if (e.radius != null) e.radius *= factor;
    if (e.height != null) e.height *= factor;
    if (Array.isArray(e.points)) for (const p of e.points) sc(p);
    n++;
  }
  return n;
}

export function rotateEntitiesAbout(
  entities: DxfEntity[],
  indices: number[],
  ox: number,
  oy: number,
  deg: number,
): number {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const rt = (p: { x: number; y: number }) => {
    const x = p.x - ox, y = p.y - oy;
    p.x = ox + x * c - y * s;
    p.y = oy + x * s + y * c;
  };
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.start) rt(e.start);
    if (e.end) rt(e.end);
    if (e.center) rt(e.center);
    if (e.position) rt(e.position);
    if (Array.isArray(e.points)) for (const p of e.points) rt(p);
    if (e.rotation != null) e.rotation = (Number(e.rotation) || 0) + deg;
    if (e.startAngle != null) e.startAngle = (Number(e.startAngle) || 0) + deg;
    if (e.endAngle != null) e.endAngle = (Number(e.endAngle) || 0) + deg;
    n++;
  }
  return n;
}

export function mirrorEntities(
  entities: DxfEntity[],
  indices: number[],
  axis: "x" | "y",
  at: number,
): number {
  const mir = (p: { x: number; y: number }) => {
    if (axis === "x") p.y = at - (p.y - at);
    else p.x = at - (p.x - at);
  };
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    if (e.start) mir(e.start);
    if (e.end) mir(e.end);
    if (e.center) mir(e.center);
    if (e.position) mir(e.position);
    if (Array.isArray(e.points)) {
      for (const p of e.points) mir(p);
      e.points.reverse();
    }
    n++;
  }
  return n;
}

export function selectionCentroid(entities: DxfEntity[], indices: number[]): { x: number; y: number } | null {
  const b = selectionBounds(entities, indices);
  if (!b) return null;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

export function alignSelection(
  entities: DxfEntity[],
  indices: number[],
  mode: "left" | "right" | "top" | "bottom" | "centerx" | "centery",
): number {
  const b = selectionBounds(entities, indices);
  if (!b) return 0;
  let n = 0;
  for (const i of indices) {
    const e: any = entities[i];
    if (!e) continue;
    const eb = selectionBounds(entities, [i]);
    if (!eb) continue;
    let dx = 0, dy = 0;
    if (mode === "left") dx = b.minX - eb.minX;
    else if (mode === "right") dx = b.maxX - eb.maxX;
    else if (mode === "bottom") dy = b.minY - eb.minY;
    else if (mode === "top") dy = b.maxY - eb.maxY;
    else if (mode === "centerx") dx = (b.minX + b.maxX) / 2 - (eb.minX + eb.maxX) / 2;
    else if (mode === "centery") dy = (b.minY + b.maxY) / 2 - (eb.minY + eb.maxY) / 2;
    if (dx || dy) {
      moveEntitiesBy(entities, [i], dx, dy);
      n++;
    }
  }
  return n;
}

export function distributeSelection(
  entities: DxfEntity[],
  indices: number[],
  axis: "x" | "y",
): number {
  if (indices.length < 3) return 0;
  const items = indices.map((i) => {
    const b = selectionBounds(entities, [i]);
    return { i, b, c: b ? (axis === "x" ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2) : 0 };
  }).filter((x) => x.b);
  items.sort((a, b) => a.c - b.c);
  if (items.length < 3) return 0;
  const first = items[0].c, last = items[items.length - 1].c;
  const step = (last - first) / (items.length - 1);
  let n = 0;
  for (let k = 1; k < items.length - 1; k++) {
    const target = first + step * k;
    const delta = target - items[k].c;
    if (Math.abs(delta) < 1e-12) continue;
    if (axis === "x") moveEntitiesBy(entities, [items[k].i], delta, 0);
    else moveEntitiesBy(entities, [items[k].i], 0, delta);
    n++;
  }
  return n;
}


/** Layer names used by the selection. */
export function layersOfSelection(entities: DxfEntity[], indices: number[]): string[] {
  const s = new Set<string>();
  for (const i of indices) {
    const e = entities[i];
    if (e?.layer) s.add(e.layer);
  }
  return [...s];
}

export function hideLayersOfSelection(
  entities: DxfEntity[],
  indices: number[],
  hidden: Set<string>,
): string[] {
  const names = layersOfSelection(entities, indices);
  for (const n of names) hidden.add(n);
  return names;
}

export function showLayersOfSelection(
  entities: DxfEntity[],
  indices: number[],
  hidden: Set<string>,
): string[] {
  const names = layersOfSelection(entities, indices);
  for (const n of names) hidden.delete(n);
  return names;
}

export function invertLayerVisibility(allLayers: string[], hidden: Set<string>): void {
  const next = new Set<string>();
  for (const n of allLayers) {
    if (!hidden.has(n)) next.add(n);
  }
  hidden.clear();
  for (const n of next) hidden.add(n);
}

export function hideLayersByPattern(allLayers: string[], pattern: string, hidden: Set<string>): string[] {
  const raw = pattern.trim();
  if (!raw) return [];
  let re: RegExp;
  try {
    // support * wildcards
    const esc = raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    re = new RegExp(`^${esc}$`, "i");
  } catch {
    return [];
  }
  const hit: string[] = [];
  for (const n of allLayers) {
    if (re.test(n)) {
      hidden.add(n);
      hit.push(n);
    }
  }
  return hit;
}


/** Delete entities fully outside the selection bounding box (crop helper). */
export function eraseOutsideBounds(
  entities: DxfEntity[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): number[] {
  const remove: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    const b = selectionBounds(entities, [i]);
    if (!b) continue;
    if (b.maxX < bounds.minX || b.minX > bounds.maxX || b.maxY < bounds.minY || b.minY > bounds.maxY) {
      remove.push(i);
    }
  }
  return remove;
}

export function duplicateSelection(entities: DxfEntity[], indices: number[], dx: number, dy: number): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const i of indices) {
    const e = entities[i];
    if (!e) continue;
    const c = JSON.parse(JSON.stringify(e)) as any;
    delete c.handle;
    if (c.start) { c.start.x += dx; c.start.y += dy; }
    if (c.end) { c.end.x += dx; c.end.y += dy; }
    if (c.center) { c.center.x += dx; c.center.y += dy; }
    if (c.position) { c.position.x += dx; c.position.y += dy; }
    if (Array.isArray(c.points)) for (const p of c.points) { p.x += dx; p.y += dy; }
    out.push(c);
  }
  return out;
}

export function setFilletRadiusStore(r: number): void {
  try { localStorage.setItem("obs.cad.filletR", String(r)); } catch { /* */ }
}
export function getFilletRadiusStore(def = 0): number {
  try {
    // A missing key is "never set", not "radius 0": return the caller's
    // default so the viewer can tell an unset radius from a deliberate 0
    // (radius 0 is a real AutoCAD fillet — trim square, no arc).
    if (localStorage.getItem("obs.cad.filletR") === null) return def;
    const v = Number(localStorage.getItem("obs.cad.filletR"));
    return Number.isFinite(v) && v >= 0 ? v : def;
  } catch { return def; }
}
/** PLINEWID — the default width for newly drawn polylines (A7), following
 *  the FILLETRAD pattern above: one localStorage key, 0 = hairline. */
export function setPlineWidthStore(w: number): void {
  try { localStorage.setItem("obs.cad.plinewid", String(w)); } catch { /* */ }
}
export function getPlineWidthStore(def = 0): number {
  try {
    if (localStorage.getItem("obs.cad.plinewid") === null) return def;
    const v = Number(localStorage.getItem("obs.cad.plinewid"));
    return Number.isFinite(v) && v >= 0 ? v : def;
  } catch { return def; }
}
export function setChamferDistStore(d1: number, d2?: number): void {
  try { localStorage.setItem("obs.cad.chamferD", JSON.stringify([d1, d2 ?? d1])); } catch { /* */ }
}
export function getChamferDistStore(): [number, number] {
  try {
    const v = JSON.parse(localStorage.getItem("obs.cad.chamferD") || "null");
    if (Array.isArray(v) && v.length >= 1) return [Number(v[0]) || 0, Number(v[1] ?? v[0]) || 0];
  } catch { /* */ }
  return [0, 0];
}

export function explodePolylines(entities: DxfEntity[], indices: number[]): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const i of indices) {
    const e: any = entities[i];
    if (!e || e.type !== "LWPOLYLINE" || !Array.isArray(e.points) || e.points.length < 2) continue;
    // A7: a bulged segment explodes to a real ARC, not its chord — the
    // old code straightened every arc. (Width is dropped, like AutoCAD:
    // width is a polyline property, not a line's.)
    const segCount = e.closed ? e.points.length : e.points.length - 1;
    for (let k = 0; k < segCount; k++) {
      const a = e.points[k], b = e.points[(k + 1) % e.points.length];
      const arc = bulgeSegmentArc(a, b, e.bulges?.[k] ?? 0, e.layer);
      out.push(
        arc ??
          ({
            type: "LINE",
            layer: e.layer,
            color: e.color,
            lineType: e.lineType,
            lineweight: e.lineweight,
            start: { ...a },
            end: { ...b },
          } as DxfEntity),
      );
    }
  }
  return out;
}

export function countZeroLength(entities: DxfEntity[]): number {
  let n = 0;
  for (const e of entities as any[]) {
    if (e.type === "LINE" && e.start && e.end) {
      if (Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) < 1e-9) n++;
    }
  }
  return n;
}

export function removeZeroLength(entities: DxfEntity[]): number[] {
  const rm: number[] = [];
  for (let i = 0; i < entities.length; i++) {
    const e: any = entities[i];
    if (e?.type === "LINE" && e.start && e.end) {
      if (Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) < 1e-9) rm.push(i);
    }
  }
  return rm;
}

export const CAD_2D_GAP_COMMANDS = [
  { name: "CENTERMARK", aliases: ["CMARK"], description: "Center mark on selected circles" },
  { name: "CENTERLINE", aliases: ["CLINE"], description: "Centerline between two selected parallel lines" },
  { name: "PURGELAYERS", aliases: ["PURLAY"], description: "Purge unused (empty) layers" },
  { name: "LAYSEL", aliases: ["SELLAYER"], description: "Select all objects on the current or given layer" },
  { name: "TYPESEL", aliases: ["SELTYPE"], description: "Select all objects of a given type (e.g. TYPESEL CIRCLE)" },
  { name: "EXPORTSEL", aliases: ["WBLOCKSEL"], description: "Export selection bounds summary (clipboard JSON)" },
  { name: "DWGPROPS", aliases: ["DRAWINGPROPS"], description: "Show drawing properties summary" },
  { name: "CENSUS", aliases: ["ENTCOUNT"], description: "Entity counts by type" },
  { name: "REGENALL", aliases: ["REA"], description: "Force full redraw / regen" },
  { name: "CLRSEL", aliases: ["SELCLR"], description: "Clear the selection set" },
  { name: "SELECTALL", aliases: ["SELALL"], description: "Select every visible object" },
  { name: "LAYCUR", aliases: ["SETCURLAYER"], description: "Set current layer from selection" },
  { name: "CHPROP", aliases: ["CHANGEPROP"], description: "CHPROP LA <layer> | C <aci> | LT <linetype>" },
  { name: "SOLID", aliases: ["SO"], description: "Solid fill from 3–4 picked corners (or selection bbox)" },
  { name: "LENGTH", aliases: ["TOTALLEN"], description: "Total length of selected linear objects" },
  { name: "COUNT", aliases: ["SELCOUNT"], description: "Count selected objects by type" },
  { name: "BBOX", aliases: ["BOUNDINGBOX"], description: "Draw bounding box of selection" },
  { name: "TORIENT", aliases: ["TEXTROT"], description: "Set rotation of selected TEXT/MTEXT (degrees)" },
  { name: "SETBYLAYER", aliases: ["BYLAYER"], description: "Reset color/linetype/lineweight of selection to ByLayer" },
  { name: "MULTIPLE", aliases: ["MULTI"], description: "Repeat the previous command continuously until Esc" },
  { name: "SCALETEXT", aliases: ["STEXT"], description: "Scale height of selected TEXT/MTEXT" },
  { name: "JUSTIFYTEXT", aliases: ["JTEXT"], description: "JUSTIFYTEXT L|C|R" },
  { name: "COPYTOLAYER", aliases: ["COPY2LAY"], description: "Copy selection onto another layer" },
  { name: "LAYMOV", aliases: ["MOVETOLAYER"], description: "Move selection to a layer" },
  { name: "AREASEL", aliases: ["AREASEL"], description: "Area of selected closed polylines/circles" },
  { name: "REVERSEPL", aliases: ["REVPL"], description: "Reverse selected polyline vertex order" },
  { name: "CLOSEPL", aliases: ["PLCLOSE"], description: "Close selected polylines" },
  { name: "OPENPL", aliases: ["PLOPEN"], description: "Open selected polylines" },
  { name: "MARKMID", aliases: ["MIDPTS"], description: "Place POINT at midpoints of selected segments" },
  { name: "MARKINT", aliases: ["INTPTS"], description: "Place POINT at intersections of selected segments" },
  { name: "MOVEBY", aliases: ["MVD"], description: "MOVEBY <dx> <dy> — nudge selection" },
  { name: "SCALEBY", aliases: ["SCBY"], description: "SCALEBY <factor> — scale about selection center" },
  { name: "ROTATEBY", aliases: ["ROBY"], description: "ROTATEBY <degrees> — rotate about selection center" },
  { name: "MIRRORX", aliases: ["MX"], description: "Mirror selection about horizontal axis through center" },
  { name: "MIRRORY", aliases: ["MY"], description: "Mirror selection about vertical axis through center" },
  { name: "ALIGNL", aliases: ["ALLEFT"], description: "Align selection left edges" },
  { name: "ALIGNR", aliases: ["ALRIGHT"], description: "Align selection right edges" },
  { name: "ALIGNT", aliases: ["ALTOP"], description: "Align selection top edges" },
  { name: "ALIGNB", aliases: ["ALBOTTOM"], description: "Align selection bottom edges" },
  { name: "DISTRIBUTE", aliases: ["DISTR"], description: "DISTRIBUTE X|Y — even spacing" },
  { name: "LAYHIDEM", aliases: ["LAYHIDEMULTI", "HM"], description: "Hide all layers of the selection at once" },
  { name: "LAYSHOWM", aliases: ["LAYSHOWMULTI", "SM"], description: "Show all layers of the selection" },
  { name: "LAYINV", aliases: ["LAYINVERT"], description: "Invert on/off visibility of every layer" },
  { name: "LAYFILTER", aliases: ["LAYHIDEPAT"], description: "Hide layers matching a name pattern (e.g. LAYFILTER A-*)" },
  { name: "LAYLIST", aliases: ["LAYLS"], description: "List layers and on/off state" },
  { name: "COLOR", aliases: ["COL"], description: "Set current drawing colour ACI (COLOR 1)" },
  { name: "LWEIGHT", aliases: ["LW"], description: "Set current lineweight mm (LWEIGHT 0.25)" },
  { name: "CELTYPE", aliases: ["CELLT"], description: "Set current linetype name" },
  { name: "QSAVEAS", aliases: ["SAVEDXF"], description: "Quick save DXF under a new name prompt" },
  { name: "SELBYLAYER", aliases: ["SBL"], description: "Select every object on layers of the current selection" },
  { name: "COPYBY", aliases: ["COBY"], description: "COPYBY <dx> <dy> — duplicate selection offset" },
  { name: "ERASEOUT", aliases: ["CROPDEL"], description: "Erase objects outside selection bounds" },
  { name: "FILLETRAD", aliases: ["FILLETR"], description: "Set default fillet radius" },
  { name: "CHAMFERD", aliases: ["CHAMFERDIST"], description: "Set default chamfer distances" },
  { name: "XPLODEPL", aliases: ["XPL"], description: "Explode selected polylines to lines" },
  { name: "AUDITZL", aliases: ["PURGEZL"], description: "Remove zero-length lines" },
  { name: "SNAPUNIT", aliases: ["SNAPU"], description: "Set snap grid spacing" },
  { name: "GRIDUNIT", aliases: ["GRIDU"], description: "Set display grid spacing" },
  { name: "DWGHELP", aliases: ["DWGTIP"], description: "DWG open troubleshooting tip" },
  { name: "LAYERSTATS", aliases: ["LAYSTAT"], description: "Per-layer entity counts" },
] as const;
