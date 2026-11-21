/**
 * Plan temporary dimensions (Revit G13) — pure plan-geometry module.
 *
 * Revit behaviour: selecting an element in plan shows temporary dimensions
 * to the nearest references, editable in place; typing a new value moves or
 * resizes the element.
 *
 * This module is deliberately dependency-free (no three.js, no ctx) so it
 * can be compiled standalone and unit-tested in Node, exactly like
 * src/modules/views/plan-dim-geometry.ts. The plan panel
 * (src/features/plan-view-panel.ts) renders the dims it computes and routes
 * edits through authoring.commitTempDimEdit, which applies the geometry
 * returned by applyPlanTempDimEdit via applyElementParamChange (history +
 * constraint re-solve included, same path as the 3D editable temp dims).
 *
 * Plan coordinates are { x: east, z: north } in metres, matching the
 * authored model params (start/end/point are [x, z] pairs).
 */

export interface PlanPoint {
  x: number;
  z: number;
}

export type PlanTempDimParam =
  | "length"
  | "gapStart"
  | "gapEnd"
  | "gapPerp"
  | "gapPoint"
  | "width";

export interface PlanTempDim {
  /** Stable id, e.g. `<elementId>:plan-gap-start`. */
  id: string;
  elementId: string;
  param: PlanTempDimParam;
  /** "length" | "offset" — mirrors TempDimKind in temp-dimensions-edit.ts. */
  kind: "length" | "offset" | "width";
  /** First witness point (reference for gap dims, element end for length). */
  a: PlanPoint;
  /** Second witness point (element end / point for gap dims). */
  b: PlanPoint;
  /** Dimension value in metres. */
  value: number;
  /** Display label with explicit units, e.g. "4.000 m" / "200 mm". */
  label: string;
  editable: boolean;
  /** Id of the reference element the dim measures to (gap dims only). */
  refId?: string;
  /** Human-readable reference, e.g. "Wall". */
  refLabel?: string;
}

/** Minimal element shape the computations need (AuthoredElement subset). */
export interface PlanTempDimElement {
  id: string;
  type?: string;
  name?: string;
  params: {
    start?: [number, number];
    end?: [number, number];
    point?: [number, number];
    width?: number;
    depth?: number;
    thickness?: number;
    [key: string]: unknown;
  };
}

export interface PlanTempDimEditResult {
  start?: [number, number];
  end?: [number, number];
  point?: [number, number];
  width?: number;
}

const EPS = 1e-9;
/** A reference counts as collinear with the wall axis within this offset. */
const COLLINEAR_TOL = 0.5;
/** Parallel means the angle between centrelines is below this (radians). */
const PARALLEL_TOL = 0.09; // ~5 degrees
/** References closer than this are treated as coincident (e.g. a shared corner). */
const COINCIDENT_TOL = 0.001;

function isLinear(el: PlanTempDimElement): boolean {
  const p = el.params;
  return Array.isArray(p.start) && Array.isArray(p.end);
}

function sub(a: PlanPoint, b: PlanPoint): PlanPoint {
  return { x: a.x - b.x, z: a.z - b.z };
}

function dot(a: PlanPoint, b: PlanPoint): number {
  return a.x * b.x + a.z * b.z;
}

function len(a: PlanPoint): number {
  return Math.hypot(a.x, a.z);
}

function unit(a: PlanPoint): PlanPoint | null {
  const l = len(a);
  if (l < EPS) return null;
  return { x: a.x / l, z: a.z / l };
}

function dist(a: PlanPoint, b: PlanPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Closest point on segment [s, e] to q. */
function closestOnSegment(q: PlanPoint, s: PlanPoint, e: PlanPoint): PlanPoint {
  const d = sub(e, s);
  const l2 = d.x * d.x + d.z * d.z;
  if (l2 < EPS) return { ...s };
  let t = dot(sub(q, s), d) / l2;
  t = Math.max(0, Math.min(1, t));
  return { x: s.x + d.x * t, z: s.z + d.z * t };
}

/** Reference points an element offers: endpoints for linear elements, the point for point elements. */
function referencePoints(el: PlanTempDimElement): PlanPoint[] {
  const p = el.params;
  const out: PlanPoint[] = [];
  if (Array.isArray(p.start) && Array.isArray(p.end)) {
    out.push({ x: p.start[0], z: p.start[1] }, { x: p.end[0], z: p.end[1] });
  } else if (Array.isArray(p.point)) {
    out.push({ x: p.point[0], z: p.point[1] });
  }
  return out;
}

function refLabelOf(el: PlanTempDimElement): string {
  return el.name ?? el.type ?? "element";
}

/**
 * Format a dimension value the way the 3D editable temp dims do
 * (temp-dimensions-edit.ts dimFmt): explicit units, so the label round-trips
 * through parsePlanTempDimInput. The permanent plan dims use the plan
 * dimension style (mm by default, no unit suffix); a bare "4000" cannot be
 * typed back unambiguously, so temp dims always carry their unit.
 */
export function formatPlanTempDim(value: number): string {
  return Math.abs(value) >= 1 ? `${value.toFixed(3)} m` : `${Math.round(value * 1000)} mm`;
}

/**
 * Parse a user-typed dimension value. Accepts the formatted unit the label
 * itself displays ("4.000 m", "200 mm", "35 cm") plus plain numbers (metres,
 * the internal unit). Returns null for anything unparseable or negative.
 */
export function parsePlanTempDimInput(raw: string): number | null {
  const t = String(raw ?? "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m)?$/);
  if (!m) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  if (m[2] === "mm") return n / 1000;
  if (m[2] === "cm") return n / 100;
  return n; // metres (internal unit)
}

function makeDim(
  elementId: string,
  param: PlanTempDimParam,
  kind: PlanTempDim["kind"],
  a: PlanPoint,
  b: PlanPoint,
  ref?: PlanTempDimElement,
): PlanTempDim {
  const value = dist(a, b);
  return {
    id: `${elementId}:plan-${param}`,
    elementId,
    param,
    kind,
    a,
    b,
    value,
    label: formatPlanTempDim(value),
    editable: true,
    refId: ref?.id,
    refLabel: ref ? refLabelOf(ref) : undefined,
  };
}

/**
 * Compute the temporary dimensions for a selected element in plan:
 * its own length (linear) or width (point), plus one dimension to the
 * nearest reference for each side that has one — the start end, the end
 * end, and (for linear elements) the nearest parallel element.
 *
 * "Nearest reference" follows Revit: the closest other element's endpoint
 * roughly on the element's axis (for the end gaps), and the closest
 * parallel centreline (for the perpendicular gap). Coincident references
 * (shared corners) are skipped — a 0 mm gap to the wall the element
 * already touches is not a dimension.
 */
export function computePlanTempDims(
  selected: PlanTempDimElement,
  others: PlanTempDimElement[],
): PlanTempDim[] {
  const out: PlanTempDim[] = [];
  const refs = others.filter((o) => o.id !== selected.id);
  const p = selected.params;

  if (isLinear(selected)) {
    const start: PlanPoint = { x: p.start![0], z: p.start![1] };
    const end: PlanPoint = { x: p.end![0], z: p.end![1] };
    const axis = unit(sub(end, start));
    if (!axis) return out;
    const length = dist(start, end);
    if (length < EPS) return out;
    const normal: PlanPoint = { x: -axis.z, z: axis.x };

    // Own length.
    out.push(makeDim(selected.id, "length", "length", start, end));

    // Nearest collinear reference beyond each end (axial gap).
    for (const [which, anchor] of [["gapStart", start], ["gapEnd", end]] as const) {
      const sign = which === "gapStart" ? -1 : 1;
      let best: { q: PlanPoint; axial: number; el: PlanTempDimElement } | null = null;
      for (const o of refs) {
        for (const q of referencePoints(o)) {
          const rel = sub(q, anchor);
          const axial = dot(rel, axis) * sign;
          if (axial <= COINCIDENT_TOL) continue; // not beyond this end
          const perp = Math.abs(dot(rel, normal));
          if (perp > COLLINEAR_TOL) continue; // not on this axis
          if (!best || axial < best.axial) best = { q, axial, el: o };
        }
      }
      if (best) {
        // Project the reference onto the wall axis so the dim line runs
        // along the axis (a diagonal to an off-axis point is not a dim).
        const refProj: PlanPoint = {
          x: anchor.x + axis.x * best.axial * sign,
          z: anchor.z + axis.z * best.axial * sign,
        };
        out.push(makeDim(selected.id, which, "offset", refProj, anchor, best.el));
      }
    }

    // Nearest parallel linear element (perpendicular centreline gap).
    const mid: PlanPoint = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 };
    let bestPerp: { a: PlanPoint; b: PlanPoint; d: number; el: PlanTempDimElement } | null = null;
    for (const o of refs) {
      if (!isLinear(o)) continue;
      const os: PlanPoint = { x: o.params.start![0], z: o.params.start![1] };
      const oe: PlanPoint = { x: o.params.end![0], z: o.params.end![1] };
      const oAxis = unit(sub(oe, os));
      if (!oAxis) continue;
      // Parallel: |cross| ~ 0. (Collinear walls have d ~ 0 and are skipped below.)
      if (Math.abs(oAxis.x * axis.z - oAxis.z * axis.x) > PARALLEL_TOL) continue;
      const cp = closestOnSegment(mid, os, oe);
      const d = Math.abs(dot(sub(cp, mid), normal));
      if (d <= COINCIDENT_TOL) continue;
      // The reference must actually run alongside this element, not far
      // past either end.
      const t = dot(sub(cp, start), axis);
      if (t < -1 || t > length + 1) continue;
      if (!bestPerp || d < bestPerp.d) {
        const b: PlanPoint = { x: cp.x - normal.x * dot(sub(cp, mid), normal), z: cp.z - normal.z * dot(sub(cp, mid), normal) };
        bestPerp = { a: cp, b, d, el: o };
      }
    }
    if (bestPerp) {
      out.push(makeDim(selected.id, "gapPerp", "offset", bestPerp.a, bestPerp.b, bestPerp.el));
    }
    return out;
  }

  if (Array.isArray(p.point)) {
    const point: PlanPoint = { x: p.point[0], z: p.point[1] };
    const w = Number(p.width ?? p.thickness ?? 0.3);
    if (w > EPS) {
      out.push(
        makeDim(selected.id, "width", "width", { x: point.x - w / 2, z: point.z }, { x: point.x + w / 2, z: point.z }),
      );
    }
    // Nearest other reference point, any direction.
    let best: { q: PlanPoint; d: number; el: PlanTempDimElement } | null = null;
    for (const o of refs) {
      for (const q of referencePoints(o)) {
        const d = dist(q, point);
        if (d <= COINCIDENT_TOL) continue;
        if (!best || d < best.d) best = { q, d, el: o };
      }
    }
    if (best) out.push(makeDim(selected.id, "gapPoint", "offset", best.q, point, best.el));
    return out;
  }

  return out;
}

/**
 * Pure geometry for committing an edited plan temp dim: given the selected
 * element, the dim as computed, and the typed value (metres), return the
 * new start/end/point/width that realises it, or null when the edit cannot
 * be realised (e.g. non-positive length).
 *
 * Semantics (same anchor rules as src/modules/native-bim/dimension-edit.ts):
 * - length: the right/bottom end stays fixed, the other end moves
 *   (lengthKeepRight).
 * - gapStart / gapEnd: the named end moves along the wall axis until its
 *   axial distance to the reference is the typed value; the other end
 *   stays fixed (the wall resizes).
 * - gapPerp: the whole element translates perpendicular to its axis until
 *   the centreline distance to the reference is the typed value.
 * - gapPoint: the whole point element moves along the reference-to-point
 *   direction until the distance is the typed value.
 * - width: the point element's width becomes the typed value.
 */
export function applyPlanTempDimEdit(
  selected: PlanTempDimElement,
  spec: Pick<PlanTempDim, "param" | "a" | "b" | "value">,
  value: number,
): PlanTempDimEditResult | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const p = selected.params;

  if (spec.param === "length") {
    if (!isLinear(selected) || !(value > 0)) return null;
    const start: [number, number] = [p.start![0], p.start![1]];
    const end: [number, number] = [p.end![0], p.end![1]];
    const dx = end[0] - start[0];
    const dz = end[1] - start[1];
    const length = Math.hypot(dx, dz);
    if (length < EPS) return null;
    const ux = dx / length;
    const uz = dz / length;
    // Right end fixed (larger x; tie -> lower z, i.e. nearer the bottom),
    // mirroring lengthKeepRight / isRightOf.
    const endIsRight = Math.abs(end[0] - start[0]) > 1e-6 ? end[0] > start[0] : end[1] < start[1];
    if (endIsRight) {
      return { start: [end[0] - ux * value, end[1] - uz * value], end };
    }
    return { start, end: [start[0] + ux * value, start[1] + uz * value] };
  }

  if (spec.param === "gapStart" || spec.param === "gapEnd") {
    if (!isLinear(selected)) return null;
    const start: PlanPoint = { x: p.start![0], z: p.start![1] };
    const end: PlanPoint = { x: p.end![0], z: p.end![1] };
    const axis = unit(sub(end, start));
    if (!axis) return null;
    const anchor = spec.param === "gapStart" ? start : end;
    // Direction from the reference toward the anchor along the axis.
    const dir = sub(anchor, spec.a);
    const s = Math.sign(dot(dir, axis)) || 1;
    const delta = (value - spec.value) * s;
    const moved: PlanPoint = { x: anchor.x + axis.x * delta, z: anchor.z + axis.z * delta };
    // The move must not collapse or invert the wall.
    const other = spec.param === "gapStart" ? end : start;
    if (dist(moved, other) < 0.05) return null;
    if (spec.param === "gapStart") return { start: [moved.x, moved.z], end: [end.x, end.z] };
    return { start: [start.x, start.z], end: [moved.x, moved.z] };
  }

  if (spec.param === "gapPerp") {
    if (!isLinear(selected)) return null;
    const start: PlanPoint = { x: p.start![0], z: p.start![1] };
    const end: PlanPoint = { x: p.end![0], z: p.end![1] };
    const dir = unit(sub(spec.b, spec.a));
    if (!dir) return null;
    const delta = value - spec.value;
    return {
      start: [start.x + dir.x * delta, start.z + dir.z * delta],
      end: [end.x + dir.x * delta, end.z + dir.z * delta],
    };
  }

  if (spec.param === "gapPoint") {
    if (!Array.isArray(p.point)) return null;
    const point: PlanPoint = { x: p.point[0], z: p.point[1] };
    const dir = unit(sub(spec.b, spec.a));
    if (!dir) return null;
    const delta = value - spec.value;
    return { point: [point.x + dir.x * delta, point.z + dir.z * delta] };
  }

  if (spec.param === "width") {
    if (!Array.isArray(p.point) || !(value > 0)) return null;
    return { width: value };
  }

  return null;
}
