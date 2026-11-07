/**
 * FIELD text for the CAD editor. A field is evaluated when it is inserted and
 * the result is ordinary text: it does NOT update by itself afterwards
 * (re-run FIELD to refresh). Pure.
 */
import type { DxfEntity, DxfPoint } from "./dxf-types";

export type FieldKind = "date" | "time" | "filename" | "entityCount" | "layerCount" | "length" | "area";
export const FIELD_KINDS: Array<{ kind: FieldKind; label: string; needsSelection?: boolean }> = [
  { kind: "date", label: "Date" },
  { kind: "time", label: "Time" },
  { kind: "filename", label: "Drawing name" },
  { kind: "entityCount", label: "Number of objects in drawing" },
  { kind: "layerCount", label: "Number of layers" },
  { kind: "length", label: "Length of selected object(s)", needsSelection: true },
  { kind: "area", label: "Area of selected closed polyline / circle", needsSelection: true },
];

export function polygonArea(pts: DxfPoint[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a.x * b.y - b.x * a.y; }
  return Math.abs(s) / 2;
}
const d2 = (a: DxfPoint, b: DxfPoint) => Math.hypot(b.x - a.x, b.y - a.y);

/** Length of LINE, ARC, CIRCLE and polylines (bulges are not modelled, so segments are straight). */
export function entityLength(e: DxfEntity): number | null {
  const a = e as any;
  switch (e.type) {
    case "LINE": return d2(a.start, a.end);
    case "CIRCLE": return 2 * Math.PI * a.radius;
    case "ARC": { let s = a.endAngle - a.startAngle; while (s <= 0) s += 360; return (a.radius * s * Math.PI) / 180; }
    case "LWPOLYLINE": {
      const p: DxfPoint[] = a.points ?? [];
      let L = 0;
      for (let i = 1; i < p.length; i++) L += d2(p[i - 1], p[i]);
      if (a.closed && p.length > 2) L += d2(p[p.length - 1], p[0]);
      return L;
    }
    default: return null;
  }
}
export function entityArea(e: DxfEntity): number | null {
  const a = e as any;
  if (e.type === "CIRCLE") return Math.PI * a.radius * a.radius;
  if (e.type === "LWPOLYLINE" && (a.closed || a.hatch) && (a.points?.length ?? 0) >= 3) return polygonArea(a.points);
  return null;
}

export interface FieldContext {
  now: Date;
  drawingName: string;
  entityCount: number;
  layerCount: number;
  selected: DxfEntity[];
  /** Number of decimals for lengths and areas. */
  precision?: number;
}

export function evaluateField(kind: FieldKind, c: FieldContext): string {
  const p = c.precision ?? 3;
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (kind) {
    case "date": return `${c.now.getFullYear()}-${pad(c.now.getMonth() + 1)}-${pad(c.now.getDate())}`;
    case "time": return `${pad(c.now.getHours())}:${pad(c.now.getMinutes())}`;
    case "filename": return c.drawingName || "Untitled";
    case "entityCount": return String(c.entityCount);
    case "layerCount": return String(c.layerCount);
    case "length": {
      const v = c.selected.map(entityLength).filter((x): x is number => x != null);
      if (!v.length) throw new Error("Select a line, arc, circle or polyline first.");
      return v.reduce((s, x) => s + x, 0).toFixed(p);
    }
    case "area": {
      const v = c.selected.map(entityArea).filter((x): x is number => x != null);
      if (!v.length) throw new Error("Select a closed polyline or circle first.");
      return v.reduce((s, x) => s + x, 0).toFixed(p);
    }
  }
}
