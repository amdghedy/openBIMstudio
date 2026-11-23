/**
 * 2D CAD engine — extra editing tools (Express-Tools style). Pure functions that
 * mutate or build entities; cad-viewer wires them to typed commands and ribbon buttons.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import { selectionBounds, moveEntitiesBy } from "./cad-2d-critical-gaps";

type AnyEnt = any;
const isText = (e: AnyEnt): boolean => !!e && (e.type === "TEXT" || e.type === "MTEXT");

export type TextCase = "upper" | "lower" | "title" | "sentence";

function applyCase(s: string, mode: TextCase): string {
  switch (mode) {
    case "upper": return s.toUpperCase();
    case "lower": return s.toLowerCase();
    case "title": return s.toLowerCase().replace(/(^|[\s\-_/(])([a-zà-ɏ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
    case "sentence": return s.toLowerCase().replace(/(^|[.!?]\s+)([a-zà-ɏ])/g, (_m, a: string, b: string) => a + b.toUpperCase());
  }
}

/** TCASE: change the case of selected TEXT/MTEXT (inline runs follow). Returns the count changed. */
export function changeTextCase(entities: DxfEntity[], indices: number[], mode: TextCase): number {
  let n = 0;
  for (const i of indices) {
    const e: AnyEnt = entities[i];
    if (!isText(e) || typeof e.value !== "string") continue;
    e.value = applyCase(e.value, mode);
    if (Array.isArray(e.runs)) for (const r of e.runs) r.text = applyCase(r.text, mode);
    n++;
  }
  return n;
}

/** TREPLACE: literal find/replace inside selected text. Returns the number of text objects changed. */
export function replaceInText(entities: DxfEntity[], indices: number[], find: string, repl: string, matchCase = false): number {
  if (!find) return 0;
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "g" : "gi");
  const sub = (s: string) => s.replace(re, () => repl);
  let n = 0;
  for (const i of indices) {
    const e: AnyEnt = entities[i];
    if (!isText(e) || typeof e.value !== "string") continue;
    const next = sub(e.value);
    if (next === e.value) continue;
    e.value = next;
    if (Array.isArray(e.runs)) for (const r of e.runs) r.text = sub(r.text);
    n++;
  }
  return n;
}

/**
 * TCOUNT: number the selected text objects in reading order (top-to-bottom, then
 * left-to-right) as prefix + (start + k*step) + suffix. Returns the count numbered.
 */
export function numberTexts(
  entities: DxfEntity[], indices: number[], start = 1, step = 1, prefix = "", suffix = "",
): number {
  const items = indices
    .map((i) => ({ e: entities[i] as AnyEnt }))
    .filter((o) => isText(o.e) && o.e.position)
    .sort((a, b) => (Math.abs(b.e.position.y - a.e.position.y) > 1e-9 ? b.e.position.y - a.e.position.y : a.e.position.x - b.e.position.x));
  items.forEach((o, k) => {
    o.e.value = `${prefix}${start + k * step}${suffix}`;
    delete o.e.runs;
  });
  return items.length;
}

/** SNAPSEL: round every defining coordinate of the selection to the nearest grid step. */
export function snapToGrid(entities: DxfEntity[], indices: number[], grid: number): number {
  if (!(grid > 0)) return 0;
  const r = (v: number) => Math.round(v / grid) * grid;
  const fix = (p: { x: number; y: number } | undefined) => { if (p) { p.x = r(p.x); p.y = r(p.y); } };
  let n = 0;
  for (const i of indices) {
    const e: AnyEnt = entities[i];
    if (!e) continue;
    fix(e.start); fix(e.end); fix(e.center); fix(e.position);
    if (Array.isArray(e.points)) e.points.forEach(fix);
    n++;
  }
  return n;
}

/** ALIGNCX / ALIGNCY: centre every selected object on the selection's overall centre line. */
export function alignCenters(entities: DxfEntity[], indices: number[], axis: "x" | "y"): number {
  const all = selectionBounds(entities, indices);
  if (!all || indices.length < 2) return 0;
  const target = axis === "x" ? (all.minX + all.maxX) / 2 : (all.minY + all.maxY) / 2;
  let n = 0;
  for (const i of indices) {
    const b = selectionBounds(entities, [i]);
    if (!b) continue;
    const c = axis === "x" ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2;
    if (axis === "x") moveEntitiesBy(entities, [i], target - c, 0);
    else moveEntitiesBy(entities, [i], 0, target - c);
    n++;
  }
  return n;
}

/** CIRCLE2PL: closed polygonal polylines approximating the selected circles (segments >= 3). */
export function circlesToPolylines(entities: DxfEntity[], indices: number[], segments = 36): DxfEntity[] {
  const seg = Math.max(3, Math.floor(segments));
  const out: DxfEntity[] = [];
  for (const i of indices) {
    const e: AnyEnt = entities[i];
    if (!e || e.type !== "CIRCLE" || !(e.radius > 0)) continue;
    const points = Array.from({ length: seg }, (_v, k) => ({
      x: e.center.x + e.radius * Math.cos((2 * Math.PI * k) / seg),
      y: e.center.y + e.radius * Math.sin((2 * Math.PI * k) / seg),
    }));
    out.push({ type: "LWPOLYLINE", layer: e.layer, color: e.color, lineType: e.lineType, points, closed: true } as DxfEntity);
  }
  return out;
}

/** PL2POINTS: POINT objects at every vertex of the selected polylines and line ends. */
export function verticesToPoints(entities: DxfEntity[], indices: number[], layer: string): DxfEntity[] {
  const out: DxfEntity[] = [];
  const seen = new Set<string>();
  const add = (p: { x: number; y: number }, lyr: string) => {
    const k = `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ type: "POINT", layer: lyr || layer, position: { x: p.x, y: p.y } } as DxfEntity);
  };
  for (const i of indices) {
    const e: AnyEnt = entities[i];
    if (!e) continue;
    if (e.type === "LWPOLYLINE" && Array.isArray(e.points)) e.points.forEach((p: any) => add(p, e.layer));
    else if (e.type === "LINE") { add(e.start, e.layer); add(e.end, e.layer); }
  }
  return out;
}

/**
 * Entities the reader could not model (DXF/DWG types outside the supported set). They are NOT written back, so a
 * save drops them; this describes that loss ("3 MLINE, 2 3DSOLID") or returns "" when nothing was dropped.
 */
export function describeUnsavedSkipped(skipped: Record<string, number> | undefined): string {
  const parts = Object.entries(skipped ?? {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([t, n]) => `${n} ${t}`);
  return parts.join(", ");
}
