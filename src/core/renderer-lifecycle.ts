/**
 * Renderer lifecycle for full-screen 2D overlays (Floor Plan, Drawing).
 *
 * The 2D plan overlay covers the whole 3D viewport. While it is open, a
 * continuously rendered hidden scene is pure GPU/CPU waste — measured on the
 * benchmark harness, the hidden 3D loop monopolized the main thread under
 * software GL and cost the 2D plan a ~28× pointer-latency regression
 * (bench/bench-browser.mjs, plan-2d suite).
 *
 * OBC SimpleRenderer renders in AUTO mode whenever `enabled`; pausing is
 * safe because nothing under the overlay is visible. Pure + injectable.
 */

export interface RenderLoopTarget {
  /** OBC BaseRenderer.enabled — false stops all rendering. */
  enabled: boolean;
  /** SimpleRenderer.needsUpdate — request one frame on resume (MANUAL mode). */
  needsUpdate?: boolean;
}

/**
 * Pause or resume a render loop target. Returns whether the `enabled` state
 * actually changed (callers can use this to skip redundant bookkeeping).
 * Safe no-op when the target is missing or malformed.
 */
export function setOverlayRendererEnabled(
  target: RenderLoopTarget | null | undefined,
  enabled: boolean,
): boolean {
  if (!target || typeof target.enabled !== "boolean") return false;
  const changed = target.enabled !== enabled;
  target.enabled = enabled;
  if (enabled && "needsUpdate" in target) target.needsUpdate = true;
  return changed;
}
