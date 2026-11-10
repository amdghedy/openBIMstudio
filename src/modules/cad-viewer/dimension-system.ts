/**
 * Dimension system for the 2D CAD drawing editor — DIMSTYLE + associativity.
 *
 * Dimensions used to be "baked": exploded to plain LINE + TEXT at creation
 * with a hardcoded 2.5 mm text height, no style and no way to follow edited
 * geometry. This module gives dimensions three professional properties:
 *
 * 1. Styles (DIMSTYLE) — text height, arrow (tick) size, measurement
 *    precision, suffix and a linear measurement factor (DIMLFAC) live in a
 *    `DimStyle`; applying a style re-renders every dimension that references
 *    it.
 * 2. Identity — each dimension owns a stable `dimId`; its LINE/TEXT entities
 *    carry `meta: { dimId, role }` (in-memory only, never written to
 *    DXF/DWG), so a dimension can be found, restyled and rebuilt.
 * 3. Associativity — a dimension stores its definition points (`p1`, `p2`,
 *    the measured endpoints, and `placement`). After any transform commit
 *    (MOVE / ROTATE / SCALE / STRETCH / grip edit) the caller feeds the
 *    before/after entity pairs into `trackDimensionDefpoints`, which slides
 *    each definition point along with the geometry endpoint it coincides
 *    with — the AutoCAD defpoint model. The rebuilt dimension then measures
 *    the *new* geometry.
 *
 * Everything here is pure and DOM-free so it can be unit-tested headlessly.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import { buildLinearDimension, type LinearDimensionMode } from "./dimension-tools";

export interface Pt { x: number; y: number }

/** A named dimension style (subset of AutoCAD's DIMSTYLE that matters here). */
export interface DimStyle {
  name: string;
  /** Dimension text height in drawing units. */
  textHeight: number;
  /** Tick/arrow stroke length in drawing units (0 → derive from text height). */
  arrowSize: number;
  /** Decimal places of the measurement text (DIMDEC). */
  precision: number;
  /** Appended to every measurement text (DIMPOST, e.g. " mm"). */
  suffix: string;
  /** Linear measurement factor (DIMLFAC) — 1 = as drawn. */
  linearScale: number;
  /** ACI colour override for the whole dimension; undefined = BYLAYER. */
  colorAci?: number;
}

export interface DimRecord {
  id: string;
  styleName: string;
  mode: LinearDimensionMode;
  layer: string;
  /** Measured endpoints (definition points, AutoCAD's defpoints). */
  p1: Pt;
  p2: Pt;
  /** Dimension-line placement point. */
  placement: Pt;
}

/** The stock styles every drawing starts with (ISO-25 flavour). */
export function defaultDimStyles(): DimStyle[] {
  return [
    { name: "ISO-25", textHeight: 2.5, arrowSize: 2.5, precision: 2, suffix: "", linearScale: 1 },
    { name: "ISO-25 Large", textHeight: 5, arrowSize: 5, precision: 2, suffix: "", linearScale: 1 },
    { name: "Site (m)", textHeight: 3.5, arrowSize: 3.5, precision: 2, suffix: " m", linearScale: 1 },
  ];
}

export function cloneStyle(s: DimStyle): DimStyle {
  return { ...s };
}

/** Measurement endpoints / anchors of any entity the editor transforms. */
export function endpointsOf(e: DxfEntity): Pt[] {
  switch (e.type) {
    case "LINE":
      return [e.start, e.end];
    case "CIRCLE":
    case "ARC":
      return [e.center];
    case "LWPOLYLINE":
      return e.points;
    case "TEXT":
      return [e.position];
    case "POINT":
      return [e.position];
    case "RAY":
    case "XLINE":
      return [e.start];
    default:
      return [];
  }
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Formats a converted measurement value with the style's precision + suffix. */
export function formatMeasurement(value: number, style: DimStyle): string {
  const v = value * (Number.isFinite(style.linearScale) && style.linearScale !== 0 ? style.linearScale : 1);
  const p = Math.max(0, Math.min(6, Math.round(style.precision)));
  const text = v.toFixed(p);
  return style.suffix ? text + style.suffix : text;
}

/** Raw measurement of a record, mirroring the DIMLINEAR/DIMALIGNED tools. */
export function measureRecord(rec: Pick<DimRecord, "mode" | "p1" | "p2">): number {
  const dx = Math.abs(rec.p2.x - rec.p1.x);
  const dy = Math.abs(rec.p2.y - rec.p1.y);
  return rec.mode === "linear" ? Math.max(dx, dy) : Math.hypot(dx, dy);
}

/** Builds the tagged LINE/TEXT entities for a record under a style. */
export function buildDimEntities(rec: DimRecord, style: DimStyle, text: string): DxfEntity[] {
  return buildLinearDimension({
    first: rec.p1,
    second: rec.p2,
    placement: rec.placement,
    mode: rec.mode,
    layer: rec.layer,
    text,
    textHeight: Math.max(1e-6, style.textHeight),
    arrowSize: style.arrowSize > 0 ? style.arrowSize : undefined,
    dimId: rec.id,
  }).map((e) => (style.colorAci !== undefined ? { ...e, color: style.colorAci } : e));
}

/** Collects the entities that belong to one dimension. */
export function entitiesOfDim(all: DxfEntity[], dimId: string): DxfEntity[] {
  return all.filter((e) => e.meta?.dimId === dimId);
}

/**
 * Associativity core: slide each record's definition points along with the
 * geometry they coincide with.
 *
 * `before[i]`/`after[i]` are the same logical entity before/after the commit
 * (the pairs the editor's modify/replace commits already have). A definition
 * point follows an endpoint when it coincided with the *before* position
 * within `tol` and that endpoint actually moved. Returns the changed records
 * (new objects — the caller replaces the map entries and rebuilds entities).
 */
export function trackDimensionDefpoints(
  records: DimRecord[],
  before: DxfEntity[],
  after: DxfEntity[],
  tol = 1e-6,
): DimRecord[] {
  if (!records.length || before.length !== after.length || !before.length) return [];

  // Endpoint correspondence table for every transformed entity pair.
  const movers: Array<{ from: Pt; to: Pt }> = [];
  for (let i = 0; i < before.length; i++) {
    const a = endpointsOf(before[i]);
    const b = endpointsOf(after[i]);
    if (a.length !== b.length) continue; // exploded/rejoined — skip the pair
    for (let j = 0; j < a.length; j++) {
      if (dist(a[j], b[j]) > 1e-12) movers.push({ from: a[j], to: b[j] });
    }
  }
  if (!movers.length) return [];

  const changed: DimRecord[] = [];
  for (const rec of records) {
    const moves: Array<{ key: "p1" | "p2" | "placement"; delta: Pt }> = [];
    const match = (p: Pt): Pt | null => {
      let best: Pt | null = null;
      let bestD = tol;
      for (const m of movers) {
        const d = dist(m.from, p);
        if (d <= bestD) {
          bestD = d;
          best = m.to;
        }
      }
      return best;
    };
    const p1 = match(rec.p1);
    const p2 = match(rec.p2);
    if (p1) moves.push({ key: "p1", delta: { x: p1.x - rec.p1.x, y: p1.y - rec.p1.y } });
    if (p2) moves.push({ key: "p2", delta: { x: p2.x - rec.p2.x, y: p2.y - rec.p2.y } });
    if (!moves.length) continue;

    const next: DimRecord = { ...rec, p1: { ...rec.p1 }, p2: { ...rec.p2 }, placement: { ...rec.placement } };
    for (const m of moves) next[m.key] = { x: next[m.key].x + m.delta.x, y: next[m.key].y + m.delta.y };
    // Both endpoints moved rigidly → carry the dimension line along by the
    // mean delta so the offset/leader relationship is preserved.
    if (p1 && p2) {
      const mx = (p1.x - rec.p1.x + p2.x - rec.p2.x) / 2;
      const my = (p1.y - rec.p1.y + p2.y - rec.p2.y) / 2;
      next.placement = { x: next.placement.x + mx, y: next.placement.y + my };
    }
    changed.push(next);
  }
  return changed;
}

/**
 * Rebuild helper for a batch restyle (DIMSTYLE › Apply). Dimensions are N→M
 * rebuilds (tick/ext counts change with shape), so the caller receives flat
 * old/new entity arrays and replaces them through the editor's N→M commit
 * (commitReplace) to keep undo coherent.
 */
export function restyleBatch(
  records: DimRecord[],
  styles: Map<string, DimStyle>,
  all: DxfEntity[],
  textFor: (rec: DimRecord, style: DimStyle) => string,
): { before: DxfEntity[]; after: DxfEntity[] } {
  const before: DxfEntity[] = [];
  const after: DxfEntity[] = [];
  for (const rec of records) {
    const style = styles.get(rec.styleName);
    if (!style) continue;
    const old = entitiesOfDim(all, rec.id);
    if (!old.length) continue;
    const fresh = buildDimEntities(rec, style, textFor(rec, style));
    before.push(...old);
    after.push(...fresh);
  }
  return { before, after };
}
