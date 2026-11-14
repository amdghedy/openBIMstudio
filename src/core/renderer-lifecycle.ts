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

/**
 * Pause a render loop target and return a restore function that puts back
 * the exact prior `enabled` state, so independent pause sources compose:
 *
 * - Import queue pauses the loop; the plan overlay pauses it too. Whoever
 *   finishes first restores only its own flip — the loop stays paused until
 *   every source resumed, and a source that found it already paused never
 *   re-enables it for someone else.
 * - If the loop was already paused (import running, plan opens), the plan's
 *   restore is a no-op and the import's restore decides — the 3D loop never
 *   runs under the plan overlay and never runs while the import queue is
 *   still mutating the scene.
 *
 * Returns null when the target is missing/malformed (callers skip restore).
 */
export function pauseRenderLoop(
  target: RenderLoopTarget | null | undefined,
): (() => void) | null {
  if (!target || typeof target.enabled !== "boolean") return null;
  const prev = target.enabled;
  const flipped = setOverlayRendererEnabled(target, false);
  if (!flipped) return () => { /* already paused by another source — not ours */ };
  return () => { setOverlayRendererEnabled(target, prev); };
}
