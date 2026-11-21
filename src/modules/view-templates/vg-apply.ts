/**
 * Per-view element visibility resolution (View Templates + VG).
 *
 * The single place that answers "is this element visible in this view, and
 * should it draw halftone?" for a given effective VisibilityGraphicsState.
 * Both the 2D plan generator and (via the visibility filter) the 3D bridge
 * ultimately consult this logic; the plan path calls it directly because
 * the global visibility filter holds one view's state at a time while a
 * plan view carries its own template + local overrides.
 *
 * Order matches the VG dialog's stated rule: category visibility first,
 * then phase / design-option filters. Filter *rules* (ViewFilterRule) are
 * not evaluated here — they are recorded as remaining work; see the
 * `view-templates-vg` registry entry.
 *
 * Pure apart from the optional predicates, which default to "no filtering"
 * so node tests can exercise the resolver without the phase / design-option
 * stores. Callers in the app pass the real store predicates.
 */

import type { VisibilityGraphicsState } from "./types";
import { toVgCategory } from "./category-map";

export interface ElementVisibilityInput {
  id: string;
  /** Authored element type ("wall", "duct", …) or a VG category id. */
  type?: string;
  /** Explicit category when the caller already knows it. */
  category?: string;
  phaseCreated?: string | null;
  phaseDemolished?: string | null;
  designOptionId?: string | null;
  /** Phase / design-option tags also live in properties (bridge parity). */
  properties?: Record<string, unknown>;
}

export interface PhaseAssignmentInput {
  phaseCreated: string | null;
  phaseDemolished: string | null;
}

export interface VisibilityPredicates {
  /** Return false when the element's phase assignment hides it. */
  phaseVisible?: (a: PhaseAssignmentInput) => boolean;
  /** Return false when the element's design option hides it. */
  designOptionVisible?: (id: string | null | undefined) => boolean;
}

export interface ResolvedElementVisibility {
  visible: boolean;
  halftone: boolean;
}

function phaseTags(el: ElementVisibilityInput): PhaseAssignmentInput {
  const pr = (el.properties ?? {}) as Record<string, unknown>;
  const pick = (v: unknown): string | null =>
    typeof v === "string" && v ? v : null;
  return {
    phaseCreated: el.phaseCreated ?? pick(pr.phaseCreated),
    phaseDemolished: el.phaseDemolished ?? pick(pr.phaseDemolished),
  };
}

function designOptionTag(el: ElementVisibilityInput): string | null {
  const pr = (el.properties ?? {}) as Record<string, unknown>;
  if (typeof el.designOptionId === "string" && el.designOptionId) return el.designOptionId;
  return typeof pr.designOptionId === "string" && pr.designOptionId
    ? (pr.designOptionId as string)
    : null;
}

/**
 * Resolve visibility + halftone for one element under an effective VG state.
 * Never throws; unknown categories and missing predicates mean "visible".
 */
export function resolveElementVisibility(
  el: ElementVisibilityInput,
  vg: VisibilityGraphicsState,
  preds: VisibilityPredicates = {},
): ResolvedElementVisibility {
  if (!vg.showModel) return { visible: false, halftone: false };
  const cat = toVgCategory(el.category ?? el.type ?? "");
  const ov = cat ? vg.categoryOverrides[cat] : undefined;
  if (ov && ov.visible === false) return { visible: false, halftone: false };
  const tags = phaseTags(el);
  if (preds.phaseVisible && !preds.phaseVisible(tags)) {
    return { visible: false, halftone: false };
  }
  const optId = designOptionTag(el);
  if (preds.designOptionVisible && !preds.designOptionVisible(optId)) {
    return { visible: false, halftone: false };
  }
  return { visible: true, halftone: !!ov?.halftone };
}

/** Annotation categories (dimensions, tags, notes, grids…) for a view. */
export function annotationsVisible(vg: VisibilityGraphicsState): boolean {
  return !!vg.showAnnotations;
}
