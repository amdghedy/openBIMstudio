/**
 * Persistent 2D CAD dimension geometry.
 *
 * Dimensions are committed as ordinary DXF LINE + TEXT entities so they remain
 * visible, selectable, undoable, and exportable in DXF/DWG workflows that do
 * not preserve application-specific annotation objects.
 */
import type { DxfEntity } from "../drawings/dxf-types";

export interface DimensionPoint { x: number; y: number }
export type LinearDimensionMode = "aligned" | "linear";

const lineTagged = (
  layer: string,
  a: DimensionPoint,
  b: DimensionPoint,
  dimId: string | undefined,
  role: "ext" | "dimline" | "arrow",
): DxfEntity => ({
  type: "LINE", layer, start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
  ...(dimId ? { meta: { dimId, role } } : {}),
});

export function buildLinearDimension(args: {
  first: DimensionPoint;
  second: DimensionPoint;
  placement: DimensionPoint;
  mode: LinearDimensionMode;
  layer: string;
  text: string;
  textHeight: number;
  arrowSize?: number;
  /** Group id — when set, every emitted entity carries meta {dimId, role}. */
  dimId?: string;
}): DxfEntity[] {
  const { first: p1, second: p2, placement, mode, layer, text, textHeight, dimId } = args;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 1e-9) return [];

  let q1: DimensionPoint, q2: DimensionPoint;
  if (mode === "linear") {
    if (Math.abs(dx) >= Math.abs(dy)) {
      q1 = { x: p1.x, y: placement.y };
      q2 = { x: p2.x, y: placement.y };
    } else {
      q1 = { x: placement.x, y: p1.y };
      q2 = { x: placement.x, y: p2.y };
    }
  } else {
    const ux = dx / length, uy = dy / length;
    const nx = -uy, ny = ux;
    const offset = (placement.x - p1.x) * nx + (placement.y - p1.y) * ny;
    q1 = { x: p1.x + nx * offset, y: p1.y + ny * offset };
    q2 = { x: p2.x + nx * offset, y: p2.y + ny * offset };
  }

  const ddx = q2.x - q1.x, ddy = q2.y - q1.y;
  const dimLength = Math.hypot(ddx, ddy);
  if (dimLength < 1e-9) return [];
  const ux = ddx / dimLength, uy = ddy / dimLength;
  const nx = -uy, ny = ux;
  const offset = (placement.x - p1.x) * nx + (placement.y - p1.y) * ny;
  const sign = offset >= 0 ? 1 : -1;
  const arrow = Math.max(args.arrowSize ?? textHeight * 2.5, textHeight);
  const ext = Math.max(textHeight * 0.6, arrow * 0.18);
  const out: DxfEntity[] = [];

  const e1 = { x: q1.x + nx * sign * ext, y: q1.y + ny * sign * ext };
  const e2 = { x: q2.x + nx * sign * ext, y: q2.y + ny * sign * ext };
  if (Math.hypot(e1.x - p1.x, e1.y - p1.y) > 1e-9) out.push(lineTagged(layer, p1, e1, dimId, "ext"));
  if (Math.hypot(e2.x - p2.x, e2.y - p2.y) > 1e-9) out.push(lineTagged(layer, p2, e2, dimId, "ext"));
  out.push(lineTagged(layer, q1, q2, dimId, "dimline"));

  // Closed-looking architectural ticks: two strokes at each measured endpoint.
  for (const [tip, direction] of [[q1, 1], [q2, -1]] as Array<[DimensionPoint, number]>) {
    const bx = tip.x + ux * arrow * direction;
    const by = tip.y + uy * arrow * direction;
    const half = arrow * 0.32;
    out.push(lineTagged(layer, tip, { x: bx + nx * half, y: by + ny * half }, dimId, "arrow"));
    out.push(lineTagged(layer, tip, { x: bx - nx * half, y: by - ny * half }, dimId, "arrow"));
  }

  const mid = { x: (q1.x + q2.x) / 2 + nx * sign * textHeight * 0.8, y: (q1.y + q2.y) / 2 + ny * sign * textHeight * 0.8 };
  let rotation = Math.atan2(uy, ux) * 180 / Math.PI;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
    ...(dimId ? { meta: { dimId, role: "text" as const } } : {}),
  });
  return out;
}

/* ── Radial / diameter / angular / arc-length / center-mark dimensions ──
 * These builders mirror buildLinearDimension's entity contract: ordinary
 * DXF LINE + TEXT entities tagged with meta {dimId, role} so the dimension
 * stays selectable, undoable, exportable and rebuildable from its record. */

/**
 * One architectural tick at `tip` matching buildLinearDimension's idiom: two
 * strokes from the tip running `dir` along the dimension line (inward) plus a
 * perpendicular half-stroke, forming the closed arrowhead look.
 * `dir` = -1 when the line runs outward from the tip toward the geometry.
 */
function tickAt(
  layer: string,
  tip: DimensionPoint,
  ux: number,
  uy: number,
  arrow: number,
  dimId: string | undefined,
  dir = 1,
): DxfEntity[] {
  const half = arrow * 0.32;
  const nx = -uy, ny = ux;
  const bx = tip.x + ux * arrow * dir;
  const by = tip.y + uy * arrow * dir;
  return [
    lineTagged(layer, tip, { x: bx + nx * half, y: by + ny * half }, dimId, "arrow"),
    lineTagged(layer, tip, { x: bx - nx * half, y: by - ny * half }, dimId, "arrow"),
  ];
}

/** DIMRADIUS — dimension line from the centre to the picked edge, tick at the edge. */
export function buildRadialDimension(args: {
  center: DimensionPoint;
  edge: DimensionPoint;
  layer: string;
  text: string;
  textHeight: number;
  arrowSize?: number;
  dimId?: string;
}): DxfEntity[] {
  const { center, edge, layer, text, textHeight, dimId } = args;
  const r = Math.hypot(edge.x - center.x, edge.y - center.y);
  if (!Number.isFinite(r) || r < 1e-9) return [];
  const ux = (edge.x - center.x) / r, uy = (edge.y - center.y) / r;
  const nx = -uy, ny = ux;
  const arrow = Math.max(args.arrowSize ?? textHeight * 2.5, textHeight);
  const out: DxfEntity[] = [lineTagged(layer, center, edge, dimId, "dimline")];
  out.push(...tickAt(layer, edge, ux, uy, arrow, dimId, -1));
  const mid = { x: (center.x + edge.x) / 2 + nx * textHeight * 0.8, y: (center.y + edge.y) / 2 + ny * textHeight * 0.8 };
  let rotation = Math.atan2(uy, ux) * 180 / Math.PI;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
    ...(dimId ? { meta: { dimId, role: "text" as const } } : {}),
  });
  return out;
}

/** DIMDIAMETER — dimension line through the centre between two opposite edges. */
export function buildDiameterDimension(args: {
  center: DimensionPoint;
  edge: DimensionPoint;
  layer: string;
  text: string;
  textHeight: number;
  arrowSize?: number;
  dimId?: string;
}): DxfEntity[] {
  const { center, edge, layer, text, textHeight, dimId } = args;
  const r = Math.hypot(edge.x - center.x, edge.y - center.y);
  if (!Number.isFinite(r) || r < 1e-9) return [];
  const ux = (edge.x - center.x) / r, uy = (edge.y - center.y) / r;
  const nx = -uy, ny = ux;
  const far = { x: center.x - ux * r, y: center.y - uy * r };
  const arrow = Math.max(args.arrowSize ?? textHeight * 2.5, textHeight);
  const out: DxfEntity[] = [lineTagged(layer, edge, far, dimId, "dimline")];
  out.push(...tickAt(layer, edge, ux, uy, arrow, dimId, -1));
  out.push(...tickAt(layer, far, ux, uy, arrow, dimId, 1));
  const mid = { x: center.x + nx * textHeight * 0.8, y: center.y + ny * textHeight * 0.8 };
  let rotation = Math.atan2(ux, uy) * 180 / Math.PI;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
    ...(dimId ? { meta: { dimId, role: "text" as const } } : {}),
  });
  return out;
}

/**
 * DIMANGULAR — the dimension arc between two rays from a common vertex,
 * drawn as short LINE chords (DXF-faithful: dimensions stay LINE + TEXT).
 * The sweep runs counter-clockwise from ray `a` to ray `b` (0–360°).
 */
export function buildAngularDimension(args: {
  vertex: DimensionPoint;
  a: DimensionPoint;
  b: DimensionPoint;
  layer: string;
  text: string;
  textHeight: number;
  arrowSize?: number;
  dimId?: string;
  segments?: number;
}): DxfEntity[] {
  const { vertex, a, b, layer, text, textHeight, dimId } = args;
  const rA = Math.hypot(a.x - vertex.x, a.y - vertex.y);
  const rB = Math.hypot(b.x - vertex.x, b.y - vertex.y);
  if (rA < 1e-9 || rB < 1e-9) return [];
  const r = Math.min(rA, rB);
  const startAng = Math.atan2(a.y - vertex.y, a.x - vertex.x);
  const endAng = Math.atan2(b.y - vertex.y, b.x - vertex.x);
  let sweep = endAng - startAng;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep >= Math.PI * 2 - 1e-9) return [];
  const arrow = Math.max(args.arrowSize ?? textHeight * 2.5, textHeight);
  const steps = Math.max(6, Math.min(48, args.segments ?? 24));
  const out: DxfEntity[] = [];
  let prev = { x: vertex.x + r * Math.cos(startAng), y: vertex.y + r * Math.sin(startAng) };
  for (let i = 1; i <= steps; i++) {
    const ang = startAng + (sweep * i) / steps;
    const next = { x: vertex.x + r * Math.cos(ang), y: vertex.y + r * Math.sin(ang) };
    out.push(lineTagged(layer, prev, next, dimId, "dimline"));
    prev = next;
  }
  // Ticks at both arc ends, oriented along the local arc tangent.
  for (const [ang, dir] of [[startAng, 1], [startAng + sweep, -1]] as Array<[number, number]>) {
    const tip = { x: vertex.x + r * Math.cos(ang), y: vertex.y + r * Math.sin(ang) };
    const tx = -Math.sin(ang), ty = Math.cos(ang);
    out.push(...tickAt(layer, tip, tx, ty, arrow, dimId, dir));
  }
  const midAng = startAng + sweep / 2;
  const mid = {
    x: vertex.x + (r + textHeight * 0.8) * Math.cos(midAng),
    y: vertex.y + (r + textHeight * 0.8) * Math.sin(midAng),
  };
  let rotation = (midAng * 180) / Math.PI + 90;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
    ...(dimId ? { meta: { dimId, role: "text" as const } } : {}),
  });
  return out;
}

/** DIMARC — arc-length dimension along the picked arc (LINE chords + ticks). */
export function buildArcLengthDimension(args: {
  center: DimensionPoint;
  start: DimensionPoint;
  end: DimensionPoint;
  layer: string;
  text: string;
  textHeight: number;
  arrowSize?: number;
  dimId?: string;
  segments?: number;
}): DxfEntity[] {
  const { center, start, end, layer, text, textHeight, dimId } = args;
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  if (!Number.isFinite(r) || r < 1e-9) return [];
  const startAng = Math.atan2(start.y - center.y, start.x - center.x);
  const endAng = Math.atan2(end.y - center.y, end.x - center.x);
  let sweep = endAng - startAng;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep >= Math.PI * 2 - 1e-9) return [];
  const arrow = Math.max(args.arrowSize ?? textHeight * 2.5, textHeight);
  const steps = Math.max(6, Math.min(48, args.segments ?? 24));
  const out: DxfEntity[] = [];
  let prev = { x: center.x + r * Math.cos(startAng), y: center.y + r * Math.sin(startAng) };
  for (let i = 1; i <= steps; i++) {
    const ang = startAng + (sweep * i) / steps;
    const next = { x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) };
    out.push(lineTagged(layer, prev, next, dimId, "dimline"));
    prev = next;
  }
  for (const [ang, dir] of [[startAng, 1], [startAng + sweep, -1]] as Array<[number, number]>) {
    const tip = { x: center.x + r * Math.cos(ang), y: center.y + r * Math.sin(ang) };
    const tx = -Math.sin(ang), ty = Math.cos(ang);
    out.push(...tickAt(layer, tip, tx, ty, arrow, dimId, dir));
  }
  const midAng = startAng + sweep / 2;
  const mid = {
    x: center.x + (r + textHeight * 0.8) * Math.cos(midAng),
    y: center.y + (r + textHeight * 0.8) * Math.sin(midAng),
  };
  let rotation = (midAng * 180) / Math.PI + 90;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
    ...(dimId ? { meta: { dimId, role: "text" as const } } : {}),
  });
  return out;
}

/** DIMCENTER — centre mark: a crosshair of two LINE strokes on the circle/arc centre. */
export function buildCenterMark(args: {
  center: DimensionPoint;
  layer: string;
  size: number;
  dimId?: string;
}): DxfEntity[] {
  const { center, layer, dimId } = args;
  const s = Math.max(1e-9, args.size);
  return [
    lineTagged(layer, { x: center.x - s, y: center.y }, { x: center.x + s, y: center.y }, dimId, "dimline"),
    lineTagged(layer, { x: center.x, y: center.y - s }, { x: center.x, y: center.y + s }, dimId, "dimline"),
  ];
}
