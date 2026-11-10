/**
 * Filled regions & masking regions — 2D detail annotation.
 *
 * Filled regions are closed polygons drawn in 2D views (plans, sections,
 * details) with a hatch pattern fill. Masking regions hide underlying
 * geometry behind a solid mask. BIM: Annotate > Detail > Region >
 * Filled Region / Masking Region.
 *
 * Pure module: no DOM — safe to unit-test in Node and to persist through
 * the project document (serializeRegions / loadRegions).
 */

import { getPattern } from "../detail-patterns/hatch-patterns";
import {
  clipLinesToPolygon, polygonBBox, pointInPolygon,
  translatePolygon, type PolyPt, type Segment2D,
} from "./polygon";

/** Region type: filled (hatch pattern) or masking (hide geometry). */
export interface Region2D {
  id: string;
  viewId: string;
  type: "filled" | "masking";
  /** Closed polygon boundary [x, y] in the view's world units (plan: x = world X, y = -world Z). */
  boundary: Array<[number, number]>;
  /** For filled regions: hatch pattern ID (from hatch-patterns.ts). */
  pattern?: string;
  /** For filled regions: user pattern multiplier (1 = paper-true spacing). */
  patternScale?: number;
  /** For filled regions: pattern rotation in degrees. */
  patternRotation?: number;
  /** For filled regions: pattern (foreground) color. */
  color?: string;
  /** For filled regions: solid tint drawn under the pattern (null = none). */
  background?: string;
  /** For masking regions: opacity (0 = fully transparent, 1 = opaque white). */
  maskOpacity?: number;
  /** Boundary line weight (paper mm). */
  lineWeightMm: number;
  /** Boundary line color. */
  lineColor: string;
  createdAt: number;
}

export type RegionDraft = Omit<Region2D, "id" | "createdAt">;

const regionsByView = new Map<string, Region2D[]>();
let idCounter = 0;

function ensureArr(viewId: string): Region2D[] {
  let arr = regionsByView.get(viewId);
  if (!arr) {
    arr = [];
    regionsByView.set(viewId, arr);
  }
  return arr;
}

/** Add a filled or masking region to a view. */
export function addRegion(region: RegionDraft): Region2D {
  const r: Region2D = {
    ...region,
    id: `region-${++idCounter}`,
    createdAt: Date.now(),
  };
  ensureArr(r.viewId).push(r);
  return r;
}

/** Get all regions for a view. */
export function getRegions(viewId: string): Region2D[] {
  return regionsByView.get(viewId) ?? [];
}

/** Number of regions across all views (diagnostics/tests). */
export function countRegions(): number {
  let n = 0;
  for (const arr of regionsByView.values()) n += arr.length;
  return n;
}

/** Remove a region from a view. Returns true when something was removed. */
export function removeRegion(viewId: string, id: string): boolean {
  const arr = regionsByView.get(viewId);
  if (!arr) return false;
  const before = arr.length;
  regionsByView.set(viewId, arr.filter((r) => r.id !== id));
  return regionsByView.get(viewId)!.length < before;
}

/** Patch a region (pattern / colors / opacity / boundary). Returns the region or null. */
export function updateRegion(
  viewId: string, id: string, patch: Partial<RegionDraft>,
): Region2D | null {
  const r = (regionsByView.get(viewId) ?? []).find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, patch);
  return r;
}

/** Translate a region's whole boundary. Returns the region or null. */
export function moveRegion(viewId: string, id: string, dx: number, dy: number): Region2D | null {
  const r = (regionsByView.get(viewId) ?? []).find((x) => x.id === id);
  if (!r) return null;
  r.boundary = translatePolygon(r.boundary.map(([x, y]) => ({ x, y })), dx, dy)
    .map((p) => [p.x, p.y] as [number, number]);
  return r;
}

/**
 * Topmost region whose boundary segment lies within `tol` of the point, or
 * whose interior contains the point (masking beats filled at equal depth —
 * later-created wins first, matching paint order).
 */
export function hitTestRegion(
  viewId: string, x: number, y: number, tol = 0,
): Region2D | null {
  const arr = regionsByView.get(viewId) ?? [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (r.boundary.length < 3) continue;
    const poly: PolyPt[] = r.boundary.map(([px, py]) => ({ x: px, y: py }));
    if (pointInPolygon(x, y, poly)) return r;
    for (let a = 0, b = r.boundary.length - 1; a < r.boundary.length; b = a++) {
      const p1 = r.boundary[b], p2 = r.boundary[a];
      const d = distToSeg(x, y, p1[0], p1[1], p2[0], p2[1]);
      if (d <= tol) return r;
    }
  }
  return null;
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

export interface RegionEntity {
  region: Region2D;
  /** Closed boundary polygon (same frame as the boundary). */
  points: Array<[number, number]>;
  /** Mask fill: solid white at the given opacity. */
  maskOpacity?: number;
  /** Filled region solid tint under the pattern (if any). */
  fillColor?: string;
  /** Clipped hatch pattern lines (same frame as the boundary). */
  patternLines?: Segment2D[];
  lineColor: string;
  lineWeightMm: number;
}

/** Line-count safety valve for pathological bounding boxes. */
const MAX_PATTERN_LINES = 6000;

/**
 * Build render entities for a view: boundary polygon, mask/tint fill and
 * hatch pattern lines clipped to the region boundary. Pattern generation
 * happens in the caller's coordinate frame — supply `unitPerMm` to scale the
 * paper-true pattern spacing (1 unit = unitPerMm millimetres of paper);
 * omit it to treat coordinates as paper millimetres directly.
 */
export function regionsToEntities(viewId: string, unitPerMm = 1): RegionEntity[] {
  const out: RegionEntity[] = [];
  for (const r of getRegions(viewId)) {
    if (r.boundary.length < 3) continue;
    const poly: PolyPt[] = r.boundary.map(([px, py]) => ({ x: px, y: py }));
    const entity: RegionEntity = {
      region: r,
      points: r.boundary,
      lineColor: r.lineColor,
      lineWeightMm: r.lineWeightMm,
    };
    if (r.type === "masking") {
      entity.maskOpacity = r.maskOpacity ?? 1;
    } else {
      const pat = getPattern(r.pattern ?? "ANSI31");
      if (r.background) entity.fillColor = r.background;
      if (pat) {
        // Pattern generators work in paper millimetres (spacing 3 = 3 mm at 1:1).
        // Scale the boundary into that frame, generate, then map back.
        const inv = 1 / Math.max(1e-9, unitPerMm);
        const paperPoly: PolyPt[] = poly.map((p) => ({ x: p.x * inv, y: p.y * inv }));
        const bb = polygonBBox(paperPoly);
        const scale = Math.max(0.1, r.patternScale ?? 1);
        const spacingGuess = 3 * scale;
        const diag = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY);
        if (diag / spacingGuess <= MAX_PATTERN_LINES) {
          const lines = pat.generate(bb, scale, r.patternRotation ?? 0);
          const clipped = clipLinesToPolygon(lines, paperPoly);
          entity.patternLines = clipped.map((l) => ({
            x1: l.x1 * unitPerMm, y1: l.y1 * unitPerMm,
            x2: l.x2 * unitPerMm, y2: l.y2 * unitPerMm,
          }));
        }
      }
    }
    out.push(entity);
  }
  return out;
}

/** Serialize every region of every view for project persistence. */
export function serializeRegions(): Region2D[] {
  const all: Region2D[] = [];
  for (const arr of regionsByView.values()) all.push(...arr);
  return JSON.parse(JSON.stringify(all)) as Region2D[];
}

/** Replace the whole store from persisted data. */
export function loadRegions(data: unknown): void {
  regionsByView.clear();
  if (!Array.isArray(data)) return;
  for (const raw of data) {
    try {
      const r = raw as Region2D;
      if (!r || typeof r.viewId !== "string" || !Array.isArray(r.boundary)) continue;
      ensureArr(r.viewId).push({ ...r });
      // keep the id counter ahead of restored ids
      const m = /^region-(\d+)$/.exec(r.id ?? "");
      if (m) idCounter = Math.max(idCounter, Number(m[1]));
    } catch {
      /* skip malformed entries */
    }
  }
}

/** Drop every region of one view. */
export function clearRegionsFor(viewId: string): void {
  regionsByView.delete(viewId);
}

/** Back-compat shape used by older callers (flat entity list with fill info). */
export function regionsToFlatEntities(viewId: string): Array<{
  points: Array<[number, number]>;
  closed: boolean;
  color: string;
  fillColor?: string;
  fillOpacity?: number;
  lineColor: string;
  lineWeight: number;
}> {
  return regionsToEntities(viewId).map((e) => ({
    points: e.points,
    closed: true,
    color: e.lineColor,
    fillColor: e.region.type === "masking" ? "#ffffff" : e.fillColor,
    fillOpacity: e.maskOpacity ?? (e.fillColor ? 1 : 0),
    lineColor: e.lineColor,
    lineWeight: e.lineWeightMm,
  }));
}
