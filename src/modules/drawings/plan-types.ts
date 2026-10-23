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
  onProgress?: (p: { phase: string; current: number; total: number }) => void;
  signal?: { cancelled: boolean };
}