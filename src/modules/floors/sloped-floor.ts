/**
 * Sloped floors — a floor slab whose top surface falls at a percentage
 * toward a drain edge/direction (common slope-arrow / define-slope workflow).
 *
 * Pure math: per-corner elevations, fall checks and validation. The 3D
 * builder consumes the returned vertex elevations; the checker consumes
 * the validation. No DOM — unit-testable in Node.
 */

export interface SlopedFloorSpec {
  /** Plan polygon (CCW or CW, closed implicitly), [x, z] metres. */
  polygon: Array<[number, number]>;
  /** Slab thickness (m). */
  thickness: number;
  /** Slope in percent (2 = 2%). */
  slopePct: number;
  /** Fall direction in plan degrees (0 = +X, 90 = +Z). */
  directionDeg: number;
  /** Elevation of the LOWEST drain edge (m). */
  baseElevation: number;
}

export interface SlopedFloorGeometry {
  /** Per-vertex top-surface elevation (same order as the polygon). */
  elevations: number[];
  /** Lowest top elevation (== baseElevation after normalisation). */
  minElevation: number;
  /** Highest top elevation. */
  maxElevation: number;
  /** Total fall across the slab (m). */
  fall: number;
  /** Unit fall direction in plan. */
  direction: [number, number];
}

export type SlopedFloorIssue =
  | { kind: "degenerate-polygon"; message: string }
  | { kind: "slope-out-of-range"; message: string }
  | { kind: "thickness-too-thin"; message: string };

/** Typical floor slope range (drainage 1–5%, accessibility ≤ 8.33%, hard cap 15%). */
export const MIN_SLOPE_PCT = 0.5;
export const MAX_SLOPE_PCT = 15;

/**
 * Per-corner top-surface elevations for a uniformly sloped slab.
 * The projection of each vertex onto the fall direction determines its
 * rise; the set is normalised so the LOWEST vertex sits at baseElevation
 * (the slope-arrow tail defines the low point).
 */
export function slopedFloorGeometry(spec: SlopedFloorSpec): SlopedFloorGeometry & { issues: SlopedFloorIssue[] } {
  const issues = validateSlopedFloor(spec);
  const rad = (spec.directionDeg * Math.PI) / 180;
  const dir: [number, number] = [Math.cos(rad), Math.sin(rad)];

  const projections = spec.polygon.map(([x, z]) => x * dir[0] + z * dir[1]);
  const minProj = Math.min(...projections);
  // slopePct% means rise/run = slopePct/100 (2% = 0.02 m rise per m run;
  // same convention as the MEP slope module)
  const rise = spec.slopePct / 100;
  const elevations = projections.map((p) => spec.baseElevation + (p - minProj) * rise);
  const minElevation = Math.min(...elevations);
  const maxElevation = Math.max(...elevations);
  return {
    elevations,
    minElevation,
    maxElevation,
    fall: +(maxElevation - minElevation).toFixed(6),
    direction: dir,
    issues,
  };
}

export function validateSlopedFloor(spec: SlopedFloorSpec): SlopedFloorIssue[] {
  const issues: SlopedFloorIssue[] = [];
  if (!spec.polygon || spec.polygon.length < 3) {
    issues.push({ kind: "degenerate-polygon", message: `floor polygon needs ≥ 3 vertices (got ${spec.polygon?.length ?? 0})` });
    // No early return: report every independent problem in one pass.
  } else {
    // Zero-area check (shoelace)
    let area2 = 0;
    for (let i = 0; i < spec.polygon.length; i++) {
      const [x1, z1] = spec.polygon[i];
      const [x2, z2] = spec.polygon[(i + 1) % spec.polygon.length];
      area2 += x1 * z2 - x2 * z1;
    }
    if (Math.abs(area2) < 1e-6) {
      issues.push({ kind: "degenerate-polygon", message: "floor polygon has (near) zero area" });
    }
  }
  if (!(spec.slopePct >= MIN_SLOPE_PCT && spec.slopePct <= MAX_SLOPE_PCT)) {
    issues.push({
      kind: "slope-out-of-range",
      message: `slope ${spec.slopePct}% outside the supported range ${MIN_SLOPE_PCT}–${MAX_SLOPE_PCT}%`,
    });
  }
  if (!(spec.thickness > 0.02)) {
    issues.push({ kind: "thickness-too-thin", message: `slab thickness ${spec.thickness} m is below the 0.02 m structural minimum` });
  }
  return issues;
}

/**
 * Bottom-surface elevations: the slab keeps CONSTANT thickness measured
 * perpendicular to the top surface (Revit variable-thickness slabs are
 * rare; constant perpendicular thickness keeps quantities honest).
 */
export function slabBottomElevation(spec: SlopedFloorSpec): number {
  const g = slopedFloorGeometry(spec);
  const rise = spec.slopePct / 100;
  const cosTheta = 1 / Math.sqrt(1 + rise * rise);
  return g.minElevation - spec.thickness * cosTheta;
}

/** Area-weighted average top elevation (quantity take-off friendly). */
export function averageTopElevation(spec: SlopedFloorSpec): number {
  const g = slopedFloorGeometry(spec);
  if (spec.polygon.length < 3) return g.minElevation;
  let areaSum = 0;
  let elevSum = 0;
  // Fan triangulation from vertex 0
  for (let i = 1; i < spec.polygon.length - 1; i++) {
    const a = spec.polygon[0];
    const b = spec.polygon[i];
    const c = spec.polygon[i + 1];
    const area = Math.abs(
      (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]),
    ) / 2;
    const e = (g.elevations[0] + g.elevations[i] + g.elevations[i + 1]) / 3;
    areaSum += area;
    elevSum += area * e;
  }
  return areaSum > 0 ? elevSum / areaSum : g.minElevation;
}
