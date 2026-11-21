/** Plan view types. */

export type PlanLineKind =
  | "cut"        // element cut by the plan plane
  | "overhead"   // element above the cut plane (dashed)
  | "below"      // element below (dashed, lighter)
  | "grid"       // grid line
  | "dimension"  // dimension line
  | "title";     // title-block line

export interface PlanSegment {
  x1: number; z1: number;
  x2: number; z2: number;
  kind: PlanLineKind;
  source?: string;
  /** True when the source element's view VG marks its category halftone. */
  halftone?: boolean;
  /** Detail-line style for mline runs (G7): "insulation" renders as batting
   *  in the plan view instead of the plain thick outline. Absent = plain. */
  lineStyle?: "insulation" | "detail";
}

export interface PlanArc {
  cx: number; cz: number;
  r: number;
  start: number; // radians
  end: number;
  // "door-swing" → dashed thin indicator
  // "fitting"    → solid MEP elbow outer/inner boundary arc
  kind: "door-swing" | "fitting";
  /** Authored element that produced this arc (for selection highlight). */
  source?: string;
  /** True when the source element's view VG marks its category halftone. */
  halftone?: boolean;
}

/**
 * Cut-fill polygon (wall poché): the solid face of an element cut by the plan
 * plane. Points are world XZ metres; `pattern` is a hatch id from
 * modules/views/hatch-patterns.ts or null/"poche" for a solid fill.
 */
export interface PlanFill {
  points: Array<[number, number]>;
  /** Authored element that produced this fill (selection highlight). */
  source?: string;
  /** Cut pattern id, or null for solid poché. */
  pattern?: string | null;
  /** Background tint / solid color. */
  color: string;
  /** True when the source element's view VG marks its category halftone. */
  halftone?: boolean;
}

export interface PlanText {
  x: number; z: number;
  text: string;
  kind: "grid" | "level" | "room" | "title";
  rotation?: number;   // degrees
  anchor?: "start" | "middle" | "end";
  size?: number;       // metres (approximate)
}

export interface PlanView {
  level: { name: string; elevation: number };
  cutElevation: number;
  segments: PlanSegment[];
  arcs: PlanArc[];
  texts: PlanText[];
  /** Wall poché: cut fills rendered under the outline segments. */
  fills: PlanFill[];
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  generatedAt: number;
  truncated: boolean;
  stats: {
    authoredElements: number;
    fragmentElements: number;
    segments: number;
    fragmentEdgeCount: number;
  };
}

import type { AuthoredElement } from "../projects/types";

/**
 * Per-element visibility supplied by the calling view. When present, the
 * generator skips elements the view hides and stamps halftone on the
 * geometry of elements the view marks halftone. When absent, every element
 * draws as before (no behaviour change for callers that do not pass it).
 *
 * The plan scene generator builds this from the view's effective VG
 * (template + local overrides) via view-templates/vg-apply; it is an
 * explicit option here so the generator stays testable without the stores.
 */
export interface PlanVisibility {
  isVisible(el: AuthoredElement): boolean;
  halftone(el: AuthoredElement): boolean;
}

export interface PlanGenerationOptions {
  levelName: string;
  levelElevation: number;
  /** Cut height above level (metres). BIM default: 1.2. */
  cutHeight: number;
  /** Depth below level to include (metres). BIM default: 0.5. */
  cutDepth: number;
  /** Optional BIM-like view-range offsets relative to the associated level. */
  viewRangeTop?: number;
  viewRangeBottom?: number;
  viewDepth?: number;
  /** Include elements above the cut in dashed lines. */
  includeOverhead: boolean;
  /** Include elements below the level. */
  includeBelow: boolean;
  /** Hard cap on generated segments; stops extraction if exceeded. */
  maxSegments: number;
  /** Optional per-view visibility (templates / VG). See PlanVisibility. */
  visibility?: PlanVisibility;
  onProgress?: (p: { phase: string; current: number; total: number }) => void;
  signal?: { cancelled: boolean };
}