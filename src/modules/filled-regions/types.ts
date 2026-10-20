/**
 * Filled regions & masking regions — 2D detail annotation.
 *
 * Filled regions are closed polygons drawn in 2D views (plans, sections,
 * details) with a hatch pattern fill. Masking regions hide underlying
 * geometry behind a solid or transparent mask.
 *
 * BIM: Annotate > Detail > Region > Filled Region / Masking Region.
 */

/** Region type: filled (hatch pattern) or masking (hide geometry). */
export interface Region2D {
  id: string;
  viewId: string;
  type: "filled" | "masking";
  /** Closed polygon boundary [x, z] in world metres. */
  boundary: Array<[number, number]>;
  /** For filled regions: hatch pattern ID (from hatch-patterns.ts). */
  pattern?: string;
  /** For filled regions: foreground color. */
  color?: string;
  /** For filled regions: background color (null = transparent). */
  background?: string;
  /** For masking regions: opacity (0 = fully transparent, 1 = opaque white). */
  maskOpacity?: number;
  /** Line weight (mm). */
  lineWeightMm: number;
  /** Line color. */
  lineColor: string;
  createdAt: number;
}

const regionsByView = new Map<string, Region2D[]>();
let idCounter = 0;

/** Add a filled or masking region to a view. */
export function addRegion(region: Omit<Region2D, "id" | "createdAt">): Region2D {
  const r: Region2D = {
    ...region,
    id: `region-${++idCounter}`,
    createdAt: Date.now(),
  };
  const arr = regionsByView.get(r.viewId) ?? [];
  arr.push(r);
  regionsByView.set(r.viewId, arr);
  return r;
}

/** Get all regions for a view. */
export function getRegions(viewId: string): Region2D[] {
  return regionsByView.get(viewId) ?? [];
}

/** Remove a region. */
export function removeRegion(viewId: string, id: string): void {
  const arr = regionsByView.get(viewId);
  if (!arr) return;
  regionsByView.set(viewId, arr.filter((r) => r.id !== id));
}

/** Convert regions to SceneEntity[] for the annotation layer. */
export function regionsToEntities(viewId: string): Array<{
  points: Array<[number, number]>;
  closed: boolean;
  color: string;
  fillColor?: string;
  fillOpacity?: number;
  lineColor: string;
  lineWeight: number;
}> {
  return getRegions(viewId).map((r) => ({
    points: r.boundary,
    closed: true,
    color: r.lineColor,
    fillColor: r.type === "masking" ? "#ffffff" : r.color ?? "#475569",
    fillOpacity: r.type === "masking" ? (r.maskOpacity ?? 1) : 0.5,
    lineColor: r.lineColor,
    lineWeight: r.lineWeightMm,
  }));
}
