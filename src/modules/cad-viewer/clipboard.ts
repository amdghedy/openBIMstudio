/**
 * Super Copy — cross-drawing clipboard for the CAD Editor
 * (COPYCLIP / PASTECLIP / PASTEORIG · Ctrl+C / Ctrl+V / Ctrl+Shift+V).
 *
 * Pure module:
 *  - deep-copies selected DxfEntities against a base point and re-instantiates
 *    them at a target position (or verbatim for paste-to-origin);
 *  - snapshots the *style dependencies* of the copied entities (layer, dash
 *    linetype and text style definitions) so pasted geometry renders exactly
 *    like the source drawing, even in drawings that never had those tables;
 *  - serializes the whole payload for persistence, so the clipboard survives a
 *    page reload and travels between two windows of the app.
 *
 * Instances are always fresh objects so the source drawing never aliases the
 * pasted geometry.
 */
import type { DxfEntity, DxfLayer, DxfTextStyle } from "../drawings/dxf-types";
import { entityBBox } from "./viewer-math";

export interface Pt {
  x: number;
  y: number;
}

/** Style tables snapshotted from the source drawing at COPYCLIP time. */
export interface ClipDeps {
  layers?: DxfLayer[];
  /** Linetype name (upper case) -> dash pattern in drawing units. */
  linetypes?: Record<string, number[]>;
  /** Text style name (upper case) -> definition. */
  textStyles?: Record<string, DxfTextStyle>;
}

export interface CadClip extends ClipDeps {
  entities: DxfEntity[];
  /** Reference point (selection bbox center) — PASTECLIP maps it onto the drop point. */
  base: Pt;
  sourceName?: string;
  /** Clipboard payload version for forward compatibility of persisted clips. */
  version?: 2;
  /** Epoch ms of the copy — informational, shown when a persisted clip is restored. */
  savedAt?: number;
}

export const CLIP_VERSION = 2;

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
export function makeClip(
  entities: DxfEntity[],
  base?: Pt,
  sourceName?: string,
  deps?: ClipDeps,
): CadClip | null {
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
  return {
    entities: list,
    base: { x: base.x, y: base.y },
    version: CLIP_VERSION,
    savedAt: Date.now(),
    ...(sourceName ? { sourceName } : {}),
    ...(deps?.layers?.length ? { layers: clone(deps.layers) } : {}),
    ...(deps?.linetypes && Object.keys(deps.linetypes).length ? { linetypes: clone(deps.linetypes) } : {}),
    ...(deps?.textStyles && Object.keys(deps.textStyles).length ? { textStyles: clone(deps.textStyles) } : {}),
  };
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
      // Hatch fill loops are absolute coordinates: translate them with the
      // boundary or the fill lands in the wrong place after a paste.
      if (c.hatch) {
        c.hatch = {
          ...c.hatch,
          loops: c.hatch.loops.map((loop) => loop.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
        };
      }
      break;
    case "TEXT":
    case "POINT":
      c.position = { x: c.position.x + dx, y: c.position.y + dy };
      break;
  }
  return c;
}

/* ── Style dependency snapshot (Super Copy: entities render identically after the jump) ── */

/** Snapshot the layer / linetype / text style definitions the copied entities reference. */
export function collectClipDeps(entities: DxfEntity[], doc: {
  layers?: DxfLayer[];
  linetypes?: Record<string, number[]>;
  textStyles?: Record<string, DxfTextStyle>;
} | null): ClipDeps {
  if (!doc) return {};
  const layerNames = new Set<string>();
  const lineTypeNames = new Set<string>();
  const styleNames = new Set<string>();
  for (const e of entities) {
    if (!e) continue;
    if (e.layer) layerNames.add(e.layer);
    if (e.lineType) lineTypeNames.add(e.lineType.toUpperCase());
    if (e.type === "TEXT" && e.style) styleNames.add(e.style.toUpperCase());
  }
  const layers: DxfLayer[] = [];
  for (const name of layerNames) {
    const l = doc.layers?.find((d) => d.name === name);
    if (l) layers.push(clone(l));
  }
  const linetypes: Record<string, number[]> = {};
  // Dash patterns of the layers themselves travel with the layer definitions.
  for (const l of layers) if (l.lineType) lineTypeNames.add(l.lineType.toUpperCase());
  const ltSrc = doc.linetypes ?? {};
  for (const name of lineTypeNames) {
    const pat = ltSrc[name];
    if (pat) linetypes[name] = [...pat];
  }
  const textStyles: Record<string, DxfTextStyle> = {};
  const stSrc = doc.textStyles ?? {};
  for (const name of styleNames) {
    const s = stSrc[name];
    if (s) textStyles[name] = clone(s);
  }
  return {
    ...(layers.length ? { layers } : {}),
    ...(Object.keys(linetypes).length ? { linetypes } : {}),
    ...(Object.keys(textStyles).length ? { textStyles } : {}),
  };
}

export interface MissingDeps {
  layers: DxfLayer[];
  linetypes: Array<[string, number[]]>;
  textStyles: Array<[string, DxfTextStyle]>;
}

/**
 * Which of the clip's style definitions are absent from the target drawing?
 * Pure — the caller applies the result so it stays inside one undo-friendly step.
 */
export function missingClipDeps(
  target: { layers?: DxfLayer[]; linetypes?: Record<string, number[]>; textStyles?: Record<string, DxfTextStyle> } | null,
  deps: ClipDeps | null | undefined,
): MissingDeps {
  const out: MissingDeps = { layers: [], linetypes: [], textStyles: [] };
  if (!deps || !target) return out;
  if (deps.layers?.length) {
    const have = new Set((target.layers ?? []).map((l) => l.name.toUpperCase()));
    for (const l of deps.layers) if (!have.has(l.name.toUpperCase())) out.layers.push(clone(l));
  }
  if (deps.linetypes) {
    const have = new Set(Object.keys(target.linetypes ?? {}).map((k) => k.toUpperCase()));
    for (const [name, pat] of Object.entries(deps.linetypes)) {
      if (!have.has(name.toUpperCase())) out.linetypes.push([name, [...pat]]);
    }
  }
  if (deps.textStyles) {
    const have = new Set(Object.keys(target.textStyles ?? {}).map((k) => k.toUpperCase()));
    for (const [name, s] of Object.entries(deps.textStyles)) {
      if (!have.has(name.toUpperCase())) out.textStyles.push([name, clone(s)]);
    }
  }
  return out;
}

/* ── Persistence: the clipboard survives reloads and travels between windows ── */

/** Serialize a clip for localStorage. Returns null when the payload is not persistable. */
export function serializeClip(clip: CadClip | null): string | null {
  if (!clip || !clip.entities?.length || !clip.base) return null;
  try {
    return JSON.stringify({ ...clip, version: CLIP_VERSION, savedAt: clip.savedAt ?? Date.now() });
  } catch {
    return null;
  }
}

/** Parse a persisted clip; returns null for garbage, truncated or foreign payloads. */
export function parseClip(json: string | null | undefined): CadClip | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== "object") return null;
    const c = v as Partial<CadClip>;
    if (!Array.isArray(c.entities) || !c.entities.length) return null;
    if (!c.base || typeof c.base.x !== "number" || typeof c.base.y !== "number") return null;
    if (!Number.isFinite(c.base.x) || !Number.isFinite(c.base.y)) return null;
    const entities = c.entities.filter(
      (e): e is DxfEntity => !!e && typeof e === "object" && typeof (e as DxfEntity).type === "string" && typeof (e as DxfEntity).layer === "string",
    );
    if (!entities.length) return null;
    return {
      entities,
      base: { x: c.base.x, y: c.base.y },
      version: CLIP_VERSION,
      ...(typeof c.savedAt === "number" ? { savedAt: c.savedAt } : {}),
      ...(typeof c.sourceName === "string" ? { sourceName: c.sourceName } : {}),
      ...(Array.isArray(c.layers) ? { layers: c.layers } : {}),
      ...(c.linetypes && typeof c.linetypes === "object" ? { linetypes: c.linetypes } : {}),
      ...(c.textStyles && typeof c.textStyles === "object" ? { textStyles: c.textStyles } : {}),
    };
  } catch {
    return null;
  }
}
