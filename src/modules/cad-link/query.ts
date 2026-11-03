/**
 * Query linked CAD (DXF/DWG) entities by layer, type, name/text, colour, linetype.
 * Pure helpers — no DOM.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import type { CadLink } from "./index";
import { mapPoint } from "./core";

export interface CadQueryFilter {
  /** Link id, or null/empty = all links. */
  linkId?: string | null;
  /** Exact layer name, or empty = any. */
  layer?: string;
  /** Substring match on layer (case-insensitive). */
  layerContains?: string;
  /** Entity type e.g. LINE, TEXT — empty = any. */
  entityType?: string;
  /** Substring on TEXT value / entity "name". */
  nameContains?: string;
  /** ACI colour index, or undefined = any. */
  color?: number | null;
  /** Substring on lineType. */
  lineTypeContains?: string;
  /** Only currently visible layers (per link layerVisible + link.visible). */
  visibleLayersOnly?: boolean;
}

export interface CadQueryHit {
  linkId: string;
  linkName: string;
  format: string;
  layer: string;
  entityType: string;
  /** TEXT value or short description. */
  name: string;
  color?: number;
  lineType?: string;
  /** World-space sample point (metres), if computable. */
  world?: { x: number; y: number; z: number };
  entityIndex: number;
}

function entityName(e: DxfEntity): string {
  if (e.type === "TEXT") return String((e as any).value ?? "").trim();
  if (e.type === "LINE") {
    const a = (e as any).start, b = (e as any).end;
    if (a && b) return `LINE ${a.x.toFixed(2)},${a.y.toFixed(2)} → ${b.x.toFixed(2)},${b.y.toFixed(2)}`;
  }
  if (e.type === "CIRCLE") {
    const c = (e as any).center, r = (e as any).radius;
    if (c) return `⌀${Number(r).toFixed(3)} @ ${c.x.toFixed(2)},${c.y.toFixed(2)}`;
  }
  if (e.type === "ARC") {
    const c = (e as any).center;
    return c ? `ARC @ ${c.x.toFixed(2)},${c.y.toFixed(2)}` : "ARC";
  }
  if (e.type === "LWPOLYLINE") {
    const n = Array.isArray((e as any).points) ? (e as any).points.length : 0;
    return `POLY ${n} pts${(e as any).closed ? " closed" : ""}`;
  }
  if (e.type === "POINT") {
    const p = (e as any).position;
    return p ? `PT ${p.x.toFixed(2)},${p.y.toFixed(2)}` : "POINT";
  }
  return e.type;
}

function entitySamplePoint(e: DxfEntity): { x: number; y: number; z?: number } | null {
  switch (e.type) {
    case "LINE":
      return (e as any).start ?? null;
    case "CIRCLE":
    case "ARC":
      return (e as any).center ?? null;
    case "TEXT":
    case "POINT":
      return (e as any).position ?? null;
    case "LWPOLYLINE": {
      const pts = (e as any).points as Array<{ x: number; y: number; z?: number }> | undefined;
      return pts?.[0] ?? null;
    }
    default:
      return null;
  }
}

export function listEntityTypesInLinks(links: CadLink[]): string[] {
  const set = new Set<string>();
  for (const l of links) {
    for (const e of l.doc.entities) set.add(e.type);
  }
  return [...set].sort();
}

export function listLayersInLinks(links: CadLink[], linkId?: string | null): string[] {
  const set = new Set<string>();
  for (const l of links) {
    if (linkId && l.id !== linkId) continue;
    for (const ly of l.doc.layers) set.add(ly.name);
    for (const e of l.doc.entities) if (e.layer) set.add(e.layer);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function queryCadLinks(links: CadLink[], filter: CadQueryFilter): CadQueryHit[] {
  const out: CadQueryHit[] = [];
  const layerEq = (filter.layer ?? "").trim();
  const layerSub = (filter.layerContains ?? "").trim().toLowerCase();
  const typeEq = (filter.entityType ?? "").trim().toUpperCase();
  const nameSub = (filter.nameContains ?? "").trim().toLowerCase();
  const ltSub = (filter.lineTypeContains ?? "").trim().toLowerCase();
  const color = filter.color;

  for (const link of links) {
    if (filter.linkId && link.id !== filter.linkId) continue;
    if (!link.visible && filter.visibleLayersOnly) continue;

    link.doc.entities.forEach((e, entityIndex) => {
      if (layerEq && e.layer !== layerEq) return;
      if (layerSub && !e.layer.toLowerCase().includes(layerSub)) return;
      if (typeEq && e.type.toUpperCase() !== typeEq) return;
      if (color != null && Number.isFinite(color) && e.color !== color) return;
      if (ltSub) {
        const lt = (e.lineType ?? "").toLowerCase();
        if (!lt.includes(ltSub)) return;
      }
      if (filter.visibleLayersOnly) {
        if (link.layerVisible[e.layer] === false) return;
      }
      const name = entityName(e);
      if (nameSub && !name.toLowerCase().includes(nameSub) && !e.layer.toLowerCase().includes(nameSub)) {
        return;
      }

      let world: CadQueryHit["world"];
      try {
        const p = entitySamplePoint(e);
        if (p) {
          const [x, y, z] = mapPoint(link.placement, p.x, p.y, p.z ?? 0);
          world = { x, y, z };
        }
      } catch { /* */ }

      out.push({
        linkId: link.id,
        linkName: link.name,
        format: link.format,
        layer: e.layer,
        entityType: e.type,
        name,
        color: e.color,
        lineType: e.lineType,
        world,
        entityIndex,
      });
    });
  }
  return out;
}

/** Unique layers represented in a hit list. */
export function layersFromHits(hits: CadQueryHit[]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const h of hits) {
    if (!m.has(h.linkId)) m.set(h.linkId, new Set());
    m.get(h.linkId)!.add(h.layer);
  }
  return m;
}
