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

const line = (layer: string, a: DimensionPoint, b: DimensionPoint): DxfEntity => ({
  type: "LINE", layer, start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y },
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
}): DxfEntity[] {
  const { first: p1, second: p2, placement, mode, layer, text, textHeight } = args;
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
  if (Math.hypot(e1.x - p1.x, e1.y - p1.y) > 1e-9) out.push(line(layer, p1, e1));
  if (Math.hypot(e2.x - p2.x, e2.y - p2.y) > 1e-9) out.push(line(layer, p2, e2));
  out.push(line(layer, q1, q2));

  // Closed-looking architectural ticks: two strokes at each measured endpoint.
  for (const [tip, direction] of [[q1, 1], [q2, -1]] as Array<[DimensionPoint, number]>) {
    const bx = tip.x + ux * arrow * direction;
    const by = tip.y + uy * arrow * direction;
    const half = arrow * 0.32;
    out.push(line(layer, tip, { x: bx + nx * half, y: by + ny * half }));
    out.push(line(layer, tip, { x: bx - nx * half, y: by - ny * half }));
  }

  const mid = { x: (q1.x + q2.x) / 2 + nx * sign * textHeight * 0.8, y: (q1.y + q2.y) / 2 + ny * sign * textHeight * 0.8 };
  let rotation = Math.atan2(uy, ux) * 180 / Math.PI;
  if (rotation > 90) rotation -= 180;
  if (rotation < -90) rotation += 180;
  out.push({
    type: "TEXT", layer, position: mid, height: textHeight, value: text,
    rotation, align: "center", valign: "middle",
  });
  return out;
}
