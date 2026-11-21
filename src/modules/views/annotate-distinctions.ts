/**
 * Annotate distinctions — Revit 2D environment audit gap G7.
 *
 * Pure module (no DOM): what makes each Annotate variant distinct from the
 * others, so the plan view, the ribbon and the node tests all share one
 * definition instead of re-implementing it in three places.
 *
 * Revit behaviour [knowledge]: each tag type tags its own category with its
 * own tag family; Continuous and Baseline are distinct dimension chains;
 * Diameter / Slope are distinct dimension types; Detail Line vs Insulation
 * are distinct line styles.
 *
 * Honest limits (also recorded in the ribbon as planned() stubs — do not
 * fake these):
 * - Space tags: there is no space model anywhere in the repo (no
 *   SpacesStore, no "space" element type; MEP zones are rooms). The Space
 *   tag mode accepts nothing.
 * - View Reference / Tread Number / Check Spelling / Find-Replace and the
 *   Duct / Pipe / Color-Fill / Symbol legends are out of reach in this
 *   workstream (no view-reference model, no spell engine, no
 *   legend/schedule pipeline) and stay honest planned() stubs.
 */

import { tagLabel, TAG_CATEGORY_NAMES } from "./plan-tags";
import { slopePercent } from "../mep/slope";

/** Tag modes the plan tag tool understands. "space" accepts nothing (see above). */
export type AnnotateTagMode = "category" | "material" | "room" | "space" | "multi" | "area";

/** What a tag mode accepts: any authored element, rooms, areas, or nothing. */
export type TagAccepts = "any-element" | "rooms" | "areas" | "none";

export interface TagModeDef {
  mode: AnnotateTagMode;
  accepts: TagAccepts;
  /** Short label for the mode, as shown in the plan footer. */
  label: string;
  /** Why the mode accepts nothing, when it does. */
  notDoneReason?: string;
}

export const TAG_MODE_DEFS: Record<AnnotateTagMode, TagModeDef> = {
  category: { mode: "category", accepts: "any-element", label: "Tag" },
  material: { mode: "material", accepts: "any-element", label: "Material tag" },
  multi: { mode: "multi", accepts: "any-element", label: "Multi-Category tag" },
  room: { mode: "room", accepts: "rooms", label: "Room tag" },
  area: { mode: "area", accepts: "areas", label: "Area tag" },
  space: {
    mode: "space",
    accepts: "none",
    label: "Space tag",
    notDoneReason: "No space model exists in the repo (no SpacesStore, no \"space\" element type); rooms and areas are tagged separately.",
  },
};

/** Does this tag mode accept an authored element of this type? Room/Area/Space never do — they tag the rooms/areas store, or nothing. */
export function tagModeAcceptsElement(mode: AnnotateTagMode, _elementType: string): boolean {
  return TAG_MODE_DEFS[mode]?.accepts === "any-element";
}

/** Label a tag places on an authored element in this mode. Room/Area labels come from roomTagLabel / areaTagLabel (store records, not elements). */
export function tagModeLabel(mode: AnnotateTagMode, el: any): string {
  switch (mode) {
    case "material": return tagLabel(el, "material");
    case "multi": {
      const mark = el?.properties?.Mark ?? el?.properties?.mark ?? el?.name ?? el?.id ?? "";
      const cat = TAG_CATEGORY_NAMES[el?.type] ?? el?.type ?? "Element";
      return `${cat}: ${mark}`;
    }
    case "room": return tagLabel(el, "room");
    default: return tagLabel(el, "category");
  }
}

/** Ray-casting point-in-polygon over a room/area boundary (world XZ metres). */
export function pointInBoundary(x: number, z: number, boundary: ReadonlyArray<{ x: number; z: number }>): boolean {
  let inside = false;
  for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
    const xi = boundary[i].x, zi = boundary[i].z;
    const xj = boundary[j].x, zj = boundary[j].z;
    if (((zi > z) !== (zj > z)) && (x < ((xj - xi) * (z - zi)) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

export interface RoomLike { id: string; name: string; number: string; boundary: Array<{ x: number; z: number }>; area: number }
export interface AreaLike { id: string; name: string; number: string; boundary: Array<{ x: number; z: number }>; area: number; areaType?: string }

/** First room whose boundary contains the point, or null. */
export function roomAtPoint(rooms: readonly RoomLike[], x: number, z: number): RoomLike | null {
  for (const r of rooms) {
    if (r.boundary?.length >= 3 && pointInBoundary(x, z, r.boundary)) return r;
  }
  return null;
}

/** First area whose boundary contains the point, or null. */
export function areaAtPoint(areas: readonly AreaLike[], x: number, z: number): AreaLike | null {
  for (const a of areas) {
    if (a.boundary?.length >= 3 && pointInBoundary(x, z, a.boundary)) return a;
  }
  return null;
}

export function roomTagLabel(room: RoomLike): string {
  return `Room ${room.number} ${room.name}`;
}

export function areaTagLabel(area: AreaLike): string {
  return `Area ${area.number} ${area.name} — ${area.area.toFixed(1)} m²`;
}

// ── Dimension chains: Continuous vs Baseline ─────────────────────────────

export type ChainKind = "continuous" | "baseline";

export interface ChainPoint { x: number; z: number; ref?: unknown }
export interface ChainLine { ox: number; oz: number; ux: number; uz: number }

/**
 * The dimension line for a chain, mirroring the plan view's finishDimChain:
 * linear chains run horizontal or vertical; aligned chains run along the
 * first two picked boundaries. `at` is the empty-space click that places
 * the line; without it the line sits `defaultOffset` (world metres) off the
 * picked points.
 */
export function chainLineForPoints(
  pts: readonly ChainPoint[],
  linear: boolean,
  at: { x: number; z: number } | undefined,
  defaultOffset: number,
): ChainLine {
  const a = pts[0], b = pts[1];
  if (linear) {
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
    if (horizontal) {
      const z = at ? at.z : Math.min(...pts.map((q) => q.z)) - defaultOffset;
      return { ox: 0, oz: z, ux: 1, uz: 0 };
    }
    const x = at ? at.x : Math.min(...pts.map((q) => q.x)) - defaultOffset;
    return { ox: x, oz: 0, ux: 0, uz: 1 };
  }
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L, nx = -uz, nz = ux;
  const off = at ? (at.x - a.x) * nx + (at.z - a.z) * nz : defaultOffset;
  return { ox: a.x + nx * off, oz: a.z + nz * off, ux, uz };
}

export interface ChainSegment { i1: number; i2: number; x1: number; z1: number; x2: number; z2: number }

/**
 * Segments of a chain over the picked boundaries (indices, so the caller
 * can attach each segment's refs).
 * - Continuous: consecutive pairs — each segment starts where the previous
 *   one ended, end-to-end along the chain.
 * - Baseline: every segment starts at the first picked boundary (the
 *   common origin) — all dimensions are measured from the same baseline.
 * Zero-length pairs (< 1 mm) are skipped, as in the plan view.
 */
export function chainSegments(
  pts: readonly ChainPoint[],
  kind: ChainKind,
  line: ChainLine,
): ChainSegment[] {
  // A pair counts only if it has length along the dimension line (a target
  // directly across from the origin projects to zero and is skipped).
  const along = (p: ChainPoint, q: ChainPoint) =>
    Math.abs((q.x - p.x) * line.ux + (q.z - p.z) * line.uz);
  const out: ChainSegment[] = [];
  if (kind === "baseline") {
    for (let i = 1; i < pts.length; i++) {
      const p = pts[0], q = pts[i];
      if (along(p, q) < 0.001) continue;
      out.push({ i1: 0, i2: i, x1: p.x, z1: p.z, x2: q.x, z2: q.z });
    }
    return out;
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    if (along(p, q) < 0.001) continue;
    out.push({ i1: i, i2: i + 1, x1: p.x, z1: p.z, x2: q.x, z2: q.z });
  }
  return out;
}

// ── Slope dimension ──────────────────────────────────────────────────────

export interface SlopeInfo {
  /** Slope in percent (rise / horizontal run * 100). */
  percent: number;
  /** 1:N run ratio, e.g. 50 for 2%. */
  ratio: number;
  /** Run endpoints in plan (the sloped element's run). */
  x1: number; z1: number; x2: number; z2: number;
}

/**
 * Slope of an authored element, or null when it has none.
 * - MEP linear runs (duct / pipe / cable-tray / conduit) carry
 *   params.elevation + params.endElevation; the slope is the rise over the
 *   horizontal run (modules/mep/slope).
 * - Sloped floors / ramps carry properties.slope (%) + properties.slopeDirection
 *   (deg, 0 = +X); the run is the element's anchor direction.
 * Anything else (flat runs, walls, columns) has no slope — unlike Spot
 * Elevation, which labels any point.
 */
export function slopeOfElement(el: any): SlopeInfo | null {
  const p = el?.params ?? {};
  if (p.start && p.end) {
    const horiz = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
    if (p.endElevation != null && horiz > 1e-9) {
      const percent = slopePercent(Number(p.elevation ?? 0), Number(p.endElevation), horiz);
      if (Math.abs(percent) < 1e-9) return null;
      return {
        percent,
        ratio: Math.abs(percent) > 1e-9 ? 100 / Math.abs(percent) : Infinity,
        x1: p.start[0], z1: p.start[1], x2: p.end[0], z2: p.end[1],
      };
    }
    return null;
  }
  const pct = Number(el?.properties?.slope ?? 0);
  if (pct) {
    const dirDeg = Number(el?.properties?.slopeDirection ?? 0);
    const dir = (dirDeg * Math.PI) / 180;
    const a = elementAnchorOf(el) ?? { x: 0, z: 0 };
    const half = 0.5;
    return {
      percent: pct,
      ratio: 100 / Math.abs(pct),
      x1: a.x - Math.cos(dir) * half, z1: a.z - Math.sin(dir) * half,
      x2: a.x + Math.cos(dir) * half, z2: a.z + Math.sin(dir) * half,
    };
  }
  return null;
}

function elementAnchorOf(el: any): { x: number; z: number } | null {
  const p = el?.params ?? {};
  if (p.point) return { x: Number(p.point[0]), z: Number(p.point[1]) };
  if (p.start && p.end) return { x: (p.start[0] + p.end[0]) / 2, z: (p.start[1] + p.end[1]) / 2 };
  if (Array.isArray(p.polygon) && p.polygon.length) {
    let x = 0, z = 0;
    for (const v of p.polygon) { x += v[0]; z += v[1]; }
    return { x: x / p.polygon.length, z: z / p.polygon.length };
  }
  return null;
}

/** "↗ 2.00%  1:50" — arrow shows the rising direction, ratio the Revit-style 1:N. */
export function slopeLabel(percent: number): string {
  const arrow = percent >= 0 ? "↗" : "↘";
  const ratio = Math.abs(percent) > 1e-9 ? Math.round(100 / Math.abs(percent)) : 0;
  return `${arrow} ${Math.abs(percent).toFixed(2)}%  1:${ratio}`;
}

// ── Detail Line vs Insulation ────────────────────────────────────────────

/** Line style carried on an mline element's properties.lineStyle. */
export type PlanLineStyle = "detail" | "insulation";

/**
 * Insulation batting: a sine wave along a run, the way Revit draws
 * insulation batting — a centreline with a regular wave. Points are world
 * XZ metres; the caller maps them to screen space. The wave starts and ends
 * on the centreline and oscillates across it (amplitude ~6 cm, wavelength
 * ~15 cm, matching the hatch-pattern insulation in detail-patterns).
 */
export function insulationBattingPoints(
  x1: number, z1: number, x2: number, z2: number,
  amplitude = 0.06,
  wavelength = 0.15,
): Array<{ x: number; z: number }> {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return [{ x: x1, z: z1 }];
  const ux = dx / len, uz = dz / len;
  const nx = -uz, nz = ux;
  const steps = Math.max(2, Math.ceil(len / (wavelength / 8)));
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const along = t * len;
    const off = amplitude * Math.sin((along / wavelength) * Math.PI * 2);
    out.push({ x: x1 + ux * along + nx * off, z: z1 + uz * along + nz * off });
  }
  return out;
}
