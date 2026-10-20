/**
 * Plan Region — view-specific cropped plan at a different cut plane.
 *
 * BIM-equivalent of Revit's "Plan Region" tool. A plan region is a closed
 * 2D outline within a plan view that overrides the view's default cut plane
 * elevation for elements contained within.
 *
 * Example: a kitchen counter at +0.85 m with a low soffit — the plan region
 * cuts at +1.20 m inside its outline so the soffit shows dashed.
 */

export interface PlanRegionParams {
  /** Closed outline (XZ, plan view). */
  outline: Array<{ x: number; z: number }>;
  /** View's default cut plane elevation (m). */
  viewCutPlane: number;
  /** Override cut plane elevation inside this region (m). */
  regionCutPlane: number;
  /** View's default top clip (m). */
  viewTopClip?: number;
  /** Override top clip inside region (m). */
  regionTopClip?: number;
  /** View's default bottom clip (m). */
  viewBottomClip?: number;
  /** Override bottom clip inside region (m). */
  regionBottomClip?: number;
  /** Region label. */
  label?: string;
}

export interface PlanRegionResult {
  area: number;
  cutPlaneDelta: number;
  topClipDelta: number;
  bottomClipDelta: number;
  region: PlanRegionParams & { id: string };
}

function polygonArea(outline: Array<{ x: number; z: number }>): number {
  let a = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    a += (outline[j].x + outline[i].x) * (outline[j].z - outline[i].z);
  }
  return Math.abs(a) * 0.5;
}

let counter = 0;

/** Build a plan region. */
export function buildPlanRegion(input: PlanRegionParams): PlanRegionResult {
  if (input.outline.length < 3) throw new Error("Plan region needs ≥3 outline points");
  const region = {
    ...input,
    id: `pr-${++counter}`,
  };
  return {
    area: polygonArea(input.outline),
    cutPlaneDelta: input.regionCutPlane - input.viewCutPlane,
    topClipDelta: (input.regionTopClip ?? input.viewTopClip ?? 0) - (input.viewTopClip ?? 0),
    bottomClipDelta: (input.regionBottomClip ?? input.viewBottomClip ?? 0) - (input.viewBottomClip ?? 0),
    region,
  };
}

/** Check if a point is inside a plan region. */
export function pointInRegion(region: PlanRegionParams, x: number, z: number): boolean {
  const poly = region.outline;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = (zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Resolve the cut plane elevation at a given point in a view with plan regions. */
export function resolveCutPlane(regions: PlanRegionParams[], x: number, z: number, defaultCutPlane: number): number {
  for (const r of regions) {
    if (pointInRegion(r, x, z)) return r.regionCutPlane;
  }
  return defaultCutPlane;
}
