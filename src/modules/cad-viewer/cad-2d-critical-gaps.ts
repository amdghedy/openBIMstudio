/**
 * 2D CAD engine — critical gap utilities (AutoCAD-style helpers).
 * Pure functions; cad-viewer wires them into commands.
 */
import type { DxfDocument, DxfEntity, DxfLayer } from "../drawings/dxf-types";

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
] as const;
