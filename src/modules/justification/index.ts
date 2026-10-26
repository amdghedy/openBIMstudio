/**
 * Justification & location-line engine (MASTER PROMPT §3).
 *
 * Determines how an object's reference line sits relative to its actual
 * geometry, and produces the endpoint shift that constructs the geometry
 * in the right place. Pure math — no DOM, no three.js — safe to
 * unit-test in Node and reuse by every linear tool.
 *
 * Coordinate convention (matches the existing applyWallLocationOffset in
 * features/authoring.ts, so plan-drawn and 3D-drawn walls agree):
 *
 *   For a segment start→end, the LEFT normal is n = (−dz, dx)/L.
 *   A shift s > 0 moves the drawn line toward the LEFT side.
 *   "Exterior / Outer Edge" = the RIGHT side of the draw direction.
 *   "Interior / Inner Edge" = the LEFT side of the draw direction.
 *   (Same as BIM: the finish face the mass is built away from; the user
 *   flips sides by reversing the draw direction.)
 *
 * Wall faces (total thickness t, core thickness c, centred core):
 *   right face sits at s − t/2, left face at s + t/2 from the reference.
 *   Location line ON a face ⇒ solve s:
 *     finish-exterior  → s = +t/2   (right face on the reference)
 *     finish-interior  → s = −t/2   (left face on the reference)
 *     core-exterior    → s = +c/2
 *     core-interior    → s = −c/2
 *     *-centerline     → s = 0
 *   A user offset is added on top of the face shift.
 */

export type JustificationMode = "center" | "outer" | "inner";

/** BIM wall location lines (superset: core options need compound layers). */
export type WallLocationLine =
  | "wall-centerline"
  | "core-centerline"
  | "finish-exterior"
  | "finish-interior"
  | "core-exterior"
  | "core-interior";

export type XY = [number, number];

/** Signed shift (metres) along the LEFT normal for a generic profile width. */
export function justificationShiftMeters(mode: JustificationMode, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 0;
  switch (mode) {
    case "outer": return width / 2;   // outer (right) face on the reference
    case "inner": return -width / 2;  // inner (left) face on the reference
    default: return 0;
  }
}

/**
 * Core thickness of a compound wall from its layers string
 * ("Layer 1:0.1, Core:0.1, Finish:0.025" — the format stored in
 * element.properties.layers). Returns null when the wall has no
 * recognisable core layer (single-leaf wall ⇒ core options unsupported).
 */
export function coreThicknessFromLayers(
  layersStr: string | undefined | null,
  totalThickness: number,
): number | null {
  if (!layersStr || typeof layersStr !== "string") return null;
  const parts = layersStr.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  let sum = 0;
  const parsed: Array<{ name: string; thickness: number }> = [];
  for (const p of parts) {
    const idx = p.lastIndexOf(":");
    const name = (idx >= 0 ? p.slice(0, idx) : p).trim();
    const t = idx >= 0 ? parseFloat(p.slice(idx + 1)) : NaN;
    if (!Number.isFinite(t) || t <= 0) return null;
    sum += t;
    parsed.push({ name, thickness: t });
  }
  if (sum <= 0) return null;
  // Normalise exactly like the compound-wall builder does.
  const factor = Math.abs(sum - totalThickness) > 0.01 && sum > 0 ? totalThickness / sum : 1;
  const core = parsed.find((l) => /core/i.test(l.name));
  if (!core) return null;
  const c = core.thickness * factor;
  return c > 0 && c <= totalThickness + 1e-9 ? c : null;
}

/** Face shift for a BIM wall location line (metres along the LEFT normal). */
export function wallShiftForLocationLine(
  line: WallLocationLine,
  thickness: number,
  coreThickness?: number | null,
): number {
  const t = Number.isFinite(thickness) && thickness > 0 ? thickness : 0.2;
  const c = coreThickness != null && coreThickness > 0 ? coreThickness : t;
  switch (line) {
    case "wall-centerline":
    case "core-centerline":
      return 0;
    case "finish-exterior": return t / 2;
    case "finish-interior": return -t / 2;
    case "core-exterior": return c / 2;
    case "core-interior": return -c / 2;
    default: return 0;
  }
}

/**
 * Apply justification to a segment: shift BOTH endpoints by the
 * justification shift (+ extra offset) along the segment's left normal,
 * so the chosen face lands on the ORIGINAL reference line while the
 * reference path itself is preserved (switching modes re-solves the
 * shift against the same input line).
 */
export function applyJustificationToSegment(args: {
  start: XY;
  end: XY;
  shift: number;
}): { start: XY; end: XY } {
  const [x1, z1] = args.start;
  const [x2, z2] = args.end;
  const dx = x2 - x1;
  const dz = z2 - z1;
  const L = Math.hypot(dx, dz);
  const s = Number.isFinite(args.shift) ? args.shift : 0;
  if (L < 1e-9 || s === 0) return { start: [x1, z1], end: [x2, z2] };
  const nx = -dz / L;
  const nz = dx / L;
  return {
    start: [x1 + nx * s, z1 + nz * s],
    end: [x2 + nx * s, z2 + nz * s],
  };
}

/**
 * Convenience: full wall location-line resolution — face shift + core
 * support + user offset in one call. `coreThickness` of null disables
 * core faces (they fall back to the finish faces, matching single-leaf
 * walls where core = full thickness).
 */
export function resolveWallJustification(args: {
  start: XY;
  end: XY;
  locationLine: WallLocationLine;
  thickness: number;
  coreThickness?: number | null;
  extraOffset?: number;
}): { start: XY; end: XY; shift: number } {
  const core = args.coreThickness != null ? args.coreThickness : args.thickness;
  let shift = wallShiftForLocationLine(args.locationLine, args.thickness, core);
  // Unsupported core (null) ⇒ core faces degrade to finish faces.
  if (args.coreThickness == null) {
    if (args.locationLine === "core-exterior") shift = args.thickness / 2;
    if (args.locationLine === "core-interior") shift = -args.thickness / 2;
  }
  if (args.extraOffset != null && Number.isFinite(args.extraOffset)) shift += args.extraOffset;
  const shifted = applyJustificationToSegment({ start: args.start, end: args.end, shift });
  return { ...shifted, shift };
}

/** Human-readable legend for the reference-line visualisation (§3.3). */
export function describeLocationLine(line: WallLocationLine): string {
  switch (line) {
    case "wall-centerline": return "Wall Centerline";
    case "core-centerline": return "Core Centerline";
    case "finish-exterior": return "Finish Face: Exterior";
    case "finish-interior": return "Finish Face: Interior";
    case "core-exterior": return "Core Face: Exterior";
    case "core-interior": return "Core Face: Interior";
    default: return String(line);
  }
}

/** Justification legend for beams / MEP profiles. */
export function describeJustification(mode: JustificationMode): string {
  switch (mode) {
    case "outer": return "Outer Edge";
    case "inner": return "Inner Edge";
    default: return "Center";
  }
}

/** True when the location line needs a compound core to be meaningful. */
export function locationLineNeedsCore(line: WallLocationLine): boolean {
  return line === "core-exterior" || line === "core-interior" || line === "core-centerline";
}
