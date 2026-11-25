/**
 * AutoCAD grid snap (parity item A4) — pure helpers.
 *
 * AutoCAD rule: F9 / SNAP / SNAPMODE toggles snap-to-grid-point, SNAPUNIT
 * sets the grid spacing, and OSNAP (F3) is an independent master. The CAD
 * viewer used to toggle the SAME `snapOn` master for both, and the live
 * point pipeline (`constrainInputPoint` in cad-viewer.ts) had no grid step
 * at all — `userSnapStep` (SNAPUNIT) was written once and never read.
 * These helpers are the single decision point for grid snap; cad-viewer.ts
 * wires them into `constrainInputPoint`, the F9 key, the SNAP/SNAPMODE
 * command, the status-bar SNAP button and the OPTIONS dialog.
 *
 * Snap order (AutoCAD): an object snap found within aperture wins — the
 * caller substitutes the object-snap point and passes `hasObjectSnap`,
 * and grid snap is skipped. Otherwise the raw cursor point is quantized
 * to the snap grid FIRST, and the anchor-relative constraints (ortho /
 * polar / OTRACK) then operate on the quantized point, so a chained point
 * stays on its anchor's axis and on the grid in its free coordinate
 * whenever the anchor itself is on the grid. Grid snap needs no anchor:
 * the first point of a draw snaps too.
 *
 * The grid is anchored at the drawing origin (0,0) — the same origin the
 * visible grid is painted from (paintGrid rounds from multiples of the
 * step measured from 0,0) — so snapped points always land on a visible
 * grid intersection. `origin` is a parameter so the rule stays testable
 * with a non-zero origin; the viewer passes the drawing origin.
 *
 * Relationship to the removed duplicate snap engine (A14): that module's
 * `applyGridSnap` rounded to (0,0) with no origin and no float clean-up,
 * and its `resolveDraftPoint` applied grid snap AFTER an object snap (the
 * grid step would move an object-snapped point off the object). The viewer
 * never used that engine; this module is the wired decision point.
 *
 * Pure functions; no DOM, no viewer state — node-testable.
 */

export interface GridPt {
  x: number;
  y: number;
}

/** The drawing origin the visible grid and the snap grid are anchored to. */
export const DRAWING_ORIGIN: GridPt = { x: 0, y: 0 };

/**
 * Round a value that came out of `Math.round(v / step) * step` back to a
 * clean decimal. Binary floating point turns e.g. 134 * 0.1 into
 * 13.400000000000002; 15 significant digits keeps real drawing precision
 * (0.001 at coordinates of 1e12) while dropping that dust, and -0
 * becomes 0 so saved coordinates never carry a negative zero.
 */
function clean(v: number): number {
  if (!Number.isFinite(v)) return v;
  const n = Number(v.toPrecision(15));
  return Object.is(n, -0) ? 0 : n;
}

/**
 * Snap one point to the nearest grid multiple of `step`, measured from
 * `origin` (default the drawing origin). A non-positive, NaN or infinite
 * step returns the point unchanged (a copy). Never mutates its input.
 */
export function snapToGridPoint(p: GridPt, step: number, origin: GridPt = DRAWING_ORIGIN): GridPt {
  if (!(step > 0) || !Number.isFinite(step)) return { x: p.x, y: p.y };
  return {
    x: clean(origin.x + Math.round((p.x - origin.x) / step) * step),
    y: clean(origin.y + Math.round((p.y - origin.y) / step) * step),
  };
}

/**
 * The grid spacing the snap actually uses, in drawing units.
 *
 *   1. SNAPUNIT (`userSnapStep`) when the user set one — explicit wins.
 *   2. GRIDUNIT (`userGridStep`) — AutoCAD's rule is that SNAPUNIT
 *      defaults to the grid spacing, so an explicit grid spacing is the
 *      snap spacing until SNAPUNIT is set.
 *   3. The auto display step the caller passes (the viewer passes
 *      `M.gridStep(view.scale)`, the same step the visible grid paints),
 *      so snap follows the grid you see when neither value is set.
 *
 * Returns null only when no candidate is a finite spacing > 0.
 */
export function effectiveSnapStep(
  userSnapStep: number | null | undefined,
  userGridStep: number | null | undefined,
  autoStep: number | null | undefined,
): number | null {
  for (const cand of [userSnapStep, userGridStep, autoStep]) {
    if (typeof cand === "number" && Number.isFinite(cand) && cand > 0) return cand;
  }
  return null;
}

export interface GridSnapOptions {
  /** F9 / SNAP / SNAPMODE state — the grid-snap master, independent of OSNAP. */
  gridSnapOn: boolean;
  /** True when the caller already substituted a real object-snap point. */
  hasObjectSnap: boolean;
  /** Spacing from `effectiveSnapStep` (null = no usable spacing). */
  step: number | null;
  /** Grid anchor; default the drawing origin. */
  origin?: GridPt;
}

/**
 * The one grid-snap decision: grid snap applies only when it is ON, no
 * object snap won the point, and a usable spacing exists. Anything else
 * returns the point unchanged.
 */
export function resolveGridSnapPoint(p: GridPt, opts: GridSnapOptions): GridPt {
  if (!opts.gridSnapOn || opts.hasObjectSnap) return { x: p.x, y: p.y };
  if (opts.step == null) return { x: p.x, y: p.y };
  return snapToGridPoint(p, opts.step, opts.origin ?? DRAWING_ORIGIN);
}
