/**
 * Plan view controls — pure, unit-testable model behind audit gap G9
 * (REVIT_2D_ENVIRONMENT.md §2 G9): the plan scale list, the crop-view
 * follow-active-view rule, and the Revit "Underlay: Below" level rule.
 *
 * Revit behaviour (knowledge): plan scales run 1:5–1:1000+; the crop region
 * follows the active view; Underlay shows another level's plan beneath the
 * current view, greyed. Visual styles in plan are out of reach here — the
 * plan is SVG linework — so this module deliberately models nothing for
 * them; the existing Display Model / Wall Poché toggles stay as they are.
 *
 * The plan renderer honours a scale through paper size: annotation and
 * dimension graphics are sized in paper millimetres at the view scale
 * (`paperMmToWorld`), while model geometry stays in model units. The render
 * factor is continuous in the scale, so every scale in the list below maps
 * to a distinct, real render factor — no scale is listed that the renderer
 * cannot honour.
 */

import type { PlanSegment } from "../drawings/plan-types";

/** Fallback view id used only when no view has been marked active. */
export const PLAN_CROP_FALLBACK_VIEW_ID = "plan-view-1";

/**
 * Full Revit-style plan scale list (denominator of 1:N). The intermediate
 * steps are the ones Revit's scale dropdown offers (1:5, 1:10, 1:20, 1:25,
 * 1:30, 1:40, 1:50, 1:75, 1:100, 1:150, 1:200, 1:250, 1:300, 1:400, 1:500,
 * 1:1000). The old list (50/100/200/500 only) is replaced everywhere the
 * plan scale is offered.
 */
export const PLAN_VIEW_SCALES: readonly number[] = [
  5, 10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 1000,
];

/** `<select>` options for the plan scale: [value, label]. */
export const PLAN_VIEW_SCALE_OPTIONS: ReadonlyArray<readonly [string, string]> =
  PLAN_VIEW_SCALES.map((s) => [String(s), `1 : ${s}`] as const);

export function isListedPlanScale(value: number): boolean {
  return Number.isFinite(value) && (PLAN_VIEW_SCALES as readonly number[]).includes(value);
}

/**
 * Accept only a listed scale; anything else (stale localStorage, a typo,
 * NaN) falls back to `fallback` (default 1:100). This is what the persisted
 * scale loader uses, so an old stored value can never strand the plan on
 * an unlisted scale.
 */
export function normalizePlanScale(value: unknown, fallback = 100): number {
  const n = typeof value === "number" ? value : Number(value);
  return isListedPlanScale(n) ? n : fallback;
}

/**
 * Paper millimetres → world metres at a plan scale. Pure form of the
 * renderer's `paperMmToWorld`: a 2.5 mm text at 1:100 is 0.25 m in model
 * space. Strictly increasing in `scale`, so each listed scale renders
 * annotation graphics at a distinct size.
 */
export function paperMmToWorldForScale(mm: number, scale: number): number {
  return (Math.max(0.1, mm) / 1000) * Math.max(1, scale);
}

/** Greyed-underlay render style (Revit underlays draw halftone/grey). */
export const UNDERLAY_STROKE = "#9ca3af";
export const UNDERLAY_OPACITY = 0.55;
/** Underlay linework is drawn thinner than the cut lines of the live view. */
export const UNDERLAY_STROKE_WIDTH = 0.8;

export interface PlanLevelRef {
  name: string;
  elevation: number;
}

/**
 * Revit Underlay "Below": the level directly below the current one.
 * Returns null when the current level is the lowest (or the only) level —
 * there is nothing below to show, and the renderer draws no underlay.
 */
export function resolveUnderlayLevel(
  levels: ReadonlyArray<PlanLevelRef>,
  currentIndex: number,
): PlanLevelRef | null {
  if (!levels.length || currentIndex <= 0 || currentIndex >= levels.length) return null;
  return levels[currentIndex - 1] ?? null;
}

/** A plan segment restyled for the greyed underlay layer. */
export interface UnderlaySegment {
  x1: number; z1: number;
  x2: number; z2: number;
  kind: PlanSegment["kind"];
  source?: string;
  /** Greyed Revit-underlay stroke. */
  stroke: string;
  opacity: number;
  strokeWidth: number;
  /** Underlay linework is never interactive. */
  pointerEvents: "none";
}

/**
 * Map a level's plan segments onto the underlay layer: geometry is kept
 * exactly (same coordinates, same kind), only the presentation is greyed.
 * Arcs are rendered by the same rule in the panel (same stroke/opacity).
 */
export function greyUnderlaySegments(
  segments: ReadonlyArray<PlanSegment>,
): UnderlaySegment[] {
  return segments.map((s) => ({
    x1: s.x1, z1: s.z1, x2: s.x2, z2: s.z2,
    kind: s.kind,
    source: s.source,
    stroke: UNDERLAY_STROKE,
    opacity: UNDERLAY_OPACITY,
    strokeWidth: UNDERLAY_STROKE_WIDTH,
    pointerEvents: "none",
  }));
}

/**
 * Crop follows the active view: the View tab crop buttons act on whichever
 * view the crop module has marked active, and fall back to the single plan
 * view id only when nothing is active yet (e.g. the plan was never opened).
 * The caller must never hardcode a view id at the call site.
 */
export function resolveCropViewId(
  activeViewId: string | null | undefined,
  fallback: string = PLAN_CROP_FALLBACK_VIEW_ID,
): string {
  return activeViewId && activeViewId.length > 0 ? activeViewId : fallback;
}
