/**
 * Cross-drawing clipboard for the CAD Editor (COPYCLIP / PASTECLIP / PASTEORIG).
 *
 * Pure module: deep-copies selected DxfEntities against a base point and
 * re-instantiates them at a target position (or verbatim for paste-to-origin).
 * Instances are always fresh objects so the source drawing never aliases the
 * pasted geometry.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import { entityBBox } from "./viewer-math";

export interface Pt {
  x: number;
  y: number;
}

export interface CadClip {
  entities: DxfEntity[];
  /** Reference point (selection bbox center) — PASTECLIP maps it onto the drop point. */
  base: Pt;
  sourceName?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function entityPoints(e: DxfEntity): Pt[] {
  switch (e.type) {
    case "LINE":
      return [e.start, e.end];
    case "CIRCLE":
    case "ARC":
      return [e.center];
    case "LWPOLYLINE":
      return e.points;
    case "TEXT":
    case "POINT":
      return [e.position];
    default:
      return [];
  }
}

/** Deep-copy `entities` into a clipboard payload. Returns null for an empty selection. */
export function makeClip(entities: DxfEntity[], base?: Pt, sourceName?: string): CadClip | null {
  const list = entities.filter(Boolean).map(clone);
  if (!list.length) return null;
  if (!base) {
    let bb: ReturnType<typeof entityBBox> | null = null;
    for (const e of list) {
      const eb = entityBBox(e);
      if (!Number.isFinite(eb.minX + eb.maxX + eb.minY + eb.maxY)) continue;
      bb = bb
        ? {
            minX: Math.min(bb.minX, eb.minX),
            minY: Math.min(bb.minY, eb.minY),
            maxX: Math.max(bb.maxX, eb.maxX),
            maxY: Math.max(bb.maxY, eb.maxY),
          }
        : eb;
    }
    base = bb ? { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 } : { x: 0, y: 0 };
  }
  return { entities: list, base: { x: base.x, y: base.y }, ...(sourceName ? { sourceName } : {}) };
}

/** Re-instantiate the clipboard: verbatim copies when `at` is omitted, or translated so the base point lands on `at`. */
export function clipInstances(clip: CadClip, at?: Pt): DxfEntity[] {
  const dx = at ? at.x - clip.base.x : 0;
  const dy = at ? at.y - clip.base.y : 0;
  return clip.entities.map((e) => translateEntity(e, dx, dy));
}

/** Shift an entity by (dx, dy), returning a fresh object (never mutates the input). */
export function translateEntity(e: DxfEntity, dx: number, dy: number): DxfEntity {
  const c = clone(e);
  switch (c.type) {
    case "LINE":
      c.start = { x: c.start.x + dx, y: c.start.y + dy };
      c.end = { x: c.end.x + dx, y: c.end.y + dy };
      break;
    case "CIRCLE":
    case "ARC":
      c.center = { x: c.center.x + dx, y: c.center.y + dy };
      break;
    case "LWPOLYLINE":
      c.points = c.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      break;
    case "TEXT":
    case "POINT":
      c.position = { x: c.position.x + dx, y: c.position.y + dy };
      break;
  }
  return c;
}
