/**
 * Decision gate for 3D hover picking on pointermove.
 *
 * Each hover cast runs the fragments GPU fast pick (FastModelPickers), which
 * is a full ID-render pass of the scene. While any pointer button is held the
 * user is orbiting / panning / box-selecting / dragging a gizmo — nobody is
 * hovering — so the pick is pure waste and, at heavy scenes, directly steals
 * frame budget from the interaction. Pure + injectable for tests.
 */

export interface HoverGateDecision {
  /** Run the hover pick now. */
  pick: boolean;
  /** Clear a stale preselect highlight once (drag just started). */
  clearStale: boolean;
}

export function hoverGate(
  buttons: number,
  hoverPending: boolean,
  hoveredCount: number,
): HoverGateDecision {
  if (buttons !== 0) {
    return { pick: false, clearStale: !hoverPending && hoveredCount > 0 };
  }
  return { pick: !hoverPending, clearStale: false };
}
