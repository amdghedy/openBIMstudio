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
import {
  buildLinearDimension,
  buildRadialDimension,
  buildDiameterDimension,
  buildAngularDimension,
  buildArcLengthDimension,
  buildCenterMark,
  type LinearDimensionMode,
} from "./dimension-tools";

export interface Pt { x: number; y: number }

/** Every dimension kind the editor can place (DIMMODE union). */
export type DimMode = LinearDimensionMode | "radial" | "diameter" | "angular" | "arclen" | "center";

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
  mode: DimMode;
  layer: string;
  /** Definition points — meaning per mode:
   *  linear/aligned: p1, p2 measured endpoints, placement = dim-line location.
   *  radial/diameter: p1 = centre, p2 = picked edge point, placement = same edge.
   *  angular: p1 = vertex, p2 = point on first ray, placement = point on second ray.
   *  arclen: p1 = arc centre, p2 = arc start point, placement = arc end point.
   *  center: p1 = centre (p2/placement mirror it). */
  p1: Pt;
  p2: Pt;
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

const norm360 = (d: number): number => ((d % 360) + 360) % 360;

/** Text prefix for a dimension mode (AutoCAD DIMPOST R / ⌀ equivalents). */
export function dimPrefix(mode: DimMode): string {
  if (mode === "radial") return "R";
  if (mode === "diameter") return "\u2300";
  return "";
}

/** Formats an angular measurement (DIMDEC precision + degree sign). */
export function formatAngleMeasurement(deg: number, style: DimStyle): string {
  const p = Math.max(0, Math.min(6, Math.round(style.precision)));
  const text = norm360(deg).toFixed(p);
  return text + "\u00B0";
}

/** Formats a converted measurement value with the style's precision + suffix. */
export function formatMeasurement(value: number, style: DimStyle): string {
  const v = value * (Number.isFinite(style.linearScale) && style.linearScale !== 0 ? style.linearScale : 1);
  const p = Math.max(0, Math.min(6, Math.round(style.precision)));
  const text = v.toFixed(p);
  return style.suffix ? text + style.suffix : text;
}

/** Raw measurement of a record, mirroring the DIM* tool maths. */
export function measureRecord(rec: Pick<DimRecord, "mode" | "p1" | "p2" | "placement">): number {
  const dx = Math.abs(rec.p2.x - rec.p1.x);
  const dy = Math.abs(rec.p2.y - rec.p1.y);
  switch (rec.mode) {
    case "linear":
      return Math.max(dx, dy);
    case "radial":
      return dist(rec.p1, rec.p2);
    case "diameter":
      return 2 * dist(rec.p1, rec.p2);
    case "angular": {
      // Counter-clockwise sweep from ray p1→p2 to ray p1→placement (0–360°).
      const a1 = Math.atan2(rec.p2.y - rec.p1.y, rec.p2.x - rec.p1.x);
      const a2 = Math.atan2(rec.placement.y - rec.p1.y, rec.placement.x - rec.p1.x);
      const sweep = ((a2 - a1) * 180) / Math.PI;
      return norm360(sweep);
    }
    case "arclen": {
      // Radius × counter-clockwise sweep between the two arc defpoints.
      const r = dist(rec.p1, rec.p2);
      const a1 = Math.atan2(rec.p2.y - rec.p1.y, rec.p2.x - rec.p1.x);
      const a2 = Math.atan2(rec.placement.y - rec.p1.y, rec.placement.x - rec.p1.x);
      const sweep = ((a2 - a1) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      return r * sweep;
    }
    case "center":
      return 0;
    default:
      return Math.hypot(dx, dy);
  }
}

/** Builds the tagged LINE/TEXT entities for a record under a style. */
export function buildDimEntities(rec: DimRecord, style: DimStyle, text: string): DxfEntity[] {
  const common = {
    layer: rec.layer,
    text,
    textHeight: Math.max(1e-6, style.textHeight),
    arrowSize: style.arrowSize > 0 ? style.arrowSize : undefined,
    dimId: rec.id,
  };
  let built: DxfEntity[];
  switch (rec.mode) {
    case "radial":
      built = buildRadialDimension({ ...common, center: rec.p1, edge: rec.p2 });
      break;
    case "diameter":
      built = buildDiameterDimension({ ...common, center: rec.p1, edge: rec.p2 });
      break;
    case "angular":
      built = buildAngularDimension({ ...common, vertex: rec.p1, a: rec.p2, b: rec.placement });
      break;
    case "arclen":
      built = buildArcLengthDimension({ ...common, center: rec.p1, start: rec.p2, end: rec.placement });
      break;
    case "center":
      built = buildCenterMark({ center: rec.p1, layer: rec.layer, size: style.arrowSize > 0 ? style.arrowSize : style.textHeight * 2.5, dimId: rec.id });
      break;
    default:
      built = buildLinearDimension({
        first: rec.p1,
        second: rec.p2,
        placement: rec.placement,
        mode: rec.mode,
        ...common,
      });
  }
  return built.map((e) => (style.colorAci !== undefined ? { ...e, color: style.colorAci } : e));
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
    // Centre-anchored kinds ride rigidly with their circle/arc: the measured
    // edge point is not an entity endpoint, so when the centre moved it must
    // translate along (AutoCAD's defpoint model cannot see radius changes —
    // documented limitation: scaling a circle does not update radial dims).
    const centerAnchored = rec.mode === "radial" || rec.mode === "diameter" || rec.mode === "arclen" || rec.mode === "center";
    const isAngular = rec.mode === "angular";
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
    // Angular: the second ray point is a geometry defpoint — it rides too.
    if (isAngular) {
      const p3 = match(rec.placement);
      if (p3) moves.push({ key: "placement", delta: { x: p3.x - rec.placement.x, y: p3.y - rec.placement.y } });
    }
    if (!moves.length) continue;

    const next: DimRecord = { ...rec, p1: { ...rec.p1 }, p2: { ...rec.p2 }, placement: { ...rec.placement } };
    for (const m of moves) next[m.key] = { x: next[m.key].x + m.delta.x, y: next[m.key].y + m.delta.y };
    // Rigid follow for centre-anchored dimensions: translate the edge and
    // placement by the centre's delta when they did not match movers of their own.
    if (centerAnchored && p1) {
      const d = { x: p1.x - rec.p1.x, y: p1.y - rec.p1.y };
      if (!p2) next.p2 = { x: next.p2.x + d.x, y: next.p2.y + d.y };
      if (!isAngular && !p2) next.placement = { x: next.placement.x + d.x, y: next.placement.y + d.y };
    }
    // Both endpoints moved rigidly → carry the dimension line along by the
    // mean delta so the offset/leader relationship is preserved.
    if (!centerAnchored && !isAngular && p1 && p2) {
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

/**
 * DIMCONTINUE — next dimension in a chain: it measures from the previous
 * dimension's second endpoint to a new point, keeping the same style, mode
 * and dimension-line offset (translated along the chain, AutoCAD-style).
 * Only meaningful for linear/aligned records.
 */
export function continuedDimRecord(
  prev: DimRecord,
  id: string,
  newPoint: Pt,
  styleName: string,
  layer: string,
): DimRecord {
  const dx = prev.p2.x - prev.p1.x, dy = prev.p2.y - prev.p1.y;
  return {
    id, styleName, mode: prev.mode, layer,
    p1: { ...prev.p2 },
    p2: { ...newPoint },
    placement: { x: prev.placement.x + dx, y: prev.placement.y + dy },
  };
}

/**
 * DIMBASELINE — dimension measured from the first dimension's origin to a
 * new point, staggered outward by `spacing` drawing units along the same
 * side of the dimension line as the previous baseline placement.
 * Only meaningful for linear/aligned records.
 */
export function baselineDimRecord(
  root: DimRecord,
  prev: DimRecord,
  id: string,
  newPoint: Pt,
  styleName: string,
  layer: string,
  spacing: number,
): DimRecord {
  const dx = prev.p2.x - prev.p1.x, dy = prev.p2.y - prev.p1.y;
  const len = Math.hypot(dx, dy) || 1;
  // Which side of the dimension line the previous placement sat on decides
  // the stagger direction, so successive baselines keep stacking outward.
  const cross = dx * (prev.placement.y - prev.p1.y) - dy * (prev.placement.x - prev.p1.x);
  const sgn = cross >= 0 ? 1 : -1;
  const nx = (-dy / len) * sgn, ny = (dx / len) * sgn;
  return {
    id, styleName, mode: root.mode, layer,
    p1: { ...root.p1 },
    p2: { ...newPoint },
    placement: { x: prev.placement.x + nx * spacing, y: prev.placement.y + ny * spacing },
  };
}
