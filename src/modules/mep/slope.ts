/**
 * Sloped linear MEP runs (pipes, ducts, trays, conduits).
 *
 * A run keeps its `elevation` (the start end) and may carry an optional
 * `endElevation`. When absent the run is flat, so existing models and files
 * are unaffected. Slope is a percentage: rise / horizontal run * 100, positive
 * when the end is higher than the start.
 */

/** Absolute end elevation for a run of horizontal length `horiz` at `pct` slope. */
export function endElevationFromSlope(startElev: number, horiz: number, pct: number): number {
  return startElev + (horiz * pct) / 100;
}

/** Slope in percent from the two end elevations (0 when the run has no length). */
export function slopePercent(startElev: number, endElev: number | undefined, horiz: number): number {
  if (endElev == null || horiz < 1e-9) return 0;
  return ((endElev - startElev) / horiz) * 100;
}

export interface SlopedRun {
  /** True length along the sloped axis. */
  length: number;
  /** Pitch about the horizontal axis, radians (positive = rising toward the end). */
  pitch: number;
  /** Rise from start to end. */
  rise: number;
  /** Elevation of the run's mid-point (bottom reference). */
  midElevation: number;
}

export function slopedRun(startElev: number, endElev: number | undefined, horiz: number): SlopedRun {
  const rise = endElev == null ? 0 : endElev - startElev;
  return {
    length: Math.hypot(horiz, rise),
    pitch: Math.atan2(rise, horiz),
    rise,
    midElevation: startElev + rise / 2,
  };
}
