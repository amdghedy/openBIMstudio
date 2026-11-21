/**
 * Snap freshness — pure helpers behind the async snap race fix.
 *
 * The defect: the snap system updates its cached result asynchronously on
 * pointermove (`updateSnapAsync` in authoring.ts), while hover dispatch is
 * throttled to one dispatch per animation frame (requestAnimationFrame in
 * input-router.ts) and the click gesture is dispatched synchronously on
 * pointerup. A click that lands within the same frame as its preceding
 * pointermove therefore reads the PREVIOUS hover's snap result and commits
 * it — two instant clicks at different points co-locate both instances
 * at the first click's point (follow-up 7 observation).
 *
 * The fix has two parts, both built on these helpers:
 *   1. Freshness: a cached snap is only usable for a click at (nearly)
 *      the same pointer position it was computed for. `isSnapFreshForEvent`
 *      enforces that; anything else falls back to grid snap of the ray
 *      hit at the actual click position.
 *   2. Generation guard: `SnapGeneration` lets `updateSnapAsync` drop a
 *      stale query that resolves after a newer hover started one — an
 *      older in-flight query must never overwrite the newer result.
 *
 * This module is dependency-free on purpose so the node test suite can
 * compile and exercise it in isolation.
 */

export interface ClientPoint {
  x: number;
  y: number;
}

/**
 * Maximum pointer travel (px) between the hover a snap was computed for
 * and the click that consumes it. Tied to the input router's drag
 * threshold (4 px, `DRAG_THRESHOLD` in input-router.ts): a click whose
 * pointer moved at least that far is a drag, not a click at the snapped
 * position, so the snap cannot be the one for this click.
 */
export const SNAP_FRESHNESS_PX = 4;

/**
 * True when a snap computed for `snapClient` may be used for a click at
 * `eventClient`: the two pointer positions must be within `tolerancePx`.
 * A null snap position is never fresh.
 */
export function isSnapFreshForEvent(
  snapClient: ClientPoint | null,
  eventClient: ClientPoint,
  tolerancePx: number = SNAP_FRESHNESS_PX,
): boolean {
  if (!snapClient) return false;
  if (
    !Number.isFinite(snapClient.x) ||
    !Number.isFinite(snapClient.y) ||
    !Number.isFinite(eventClient.x) ||
    !Number.isFinite(eventClient.y)
  ) {
    return false;
  }
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) return false;
  const dx = eventClient.x - snapClient.x;
  const dy = eventClient.y - snapClient.y;
  return dx * dx + dy * dy <= tolerancePx * tolerancePx;
}

/**
 * Monotonic generation counter for in-flight snap queries. Each hover
 * takes the next generation before awaiting the query; on resolution it
 * only writes back when its generation is still current.
 */
export class SnapGeneration {
  private current = 0;

  /** Claim the next generation for a query that is about to start. */
  next(): number {
    this.current += 1;
    return this.current;
  }

  /** True when no newer query has started since `gen` was claimed. */
  isCurrent(gen: number): boolean {
    return gen === this.current;
  }
}
