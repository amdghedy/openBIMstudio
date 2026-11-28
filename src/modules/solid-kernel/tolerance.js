/**
 * Unified geometric tolerance policy (PE-10).
 *
 * This module is the single source of truth for every epsilon the kernel
 * uses. It replaces the old "spec 5.2" comment citations, which pointed at
 * a document that did not exist in the repo. The normative statement of
 * the policy — domains, the full value table, the degenerate-input rules,
 * and what is NOT claimed — lives in docs/engineering/TOLERANCE_POLICY.md.
 * Every constant below is one row of that table; do not add a per-module
 * literal epsilon elsewhere. Import from here instead.
 *
 * Scale rule (the reason this module exists): every geometric tolerance is
 * an ABSOLUTE floor plus a SCALE-RELATIVE term. A tolerance must stay
 * above float64 spacing at the coordinates it is applied to — at 1e9 m a
 * 1e-9 m epsilon is below the ~2.4e-7 m spacing and classifies noise.
 * `scaledTolerance(base, magnitude)` returns
 * `max(base, magnitude * Number.EPSILON * TOLERANCE_ULPS)` (8 ulps of
 * headroom), so at 1 m the historical values apply unchanged and at 1e9 m
 * the tolerance grows to ~1.8e-6 m. Area tolerances grow as the square of
 * the length tolerance (`scaledAreaTolerance`).
 *
 * Units: metres (m), square metres (m²), radians (rad), or dimensionless,
 * as noted per constant. Screen-space (px) and user-facing (clash) values
 * are named in the policy document as SEPARATE domains and are deliberately
 * NOT geometric tolerances — they are not imported here as kernel values.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */
// ── float64 ground truth ─────────────────────────────────────────────────
/** float64 machine epsilon (2^-52). */
export const FLOAT64_EPSILON = Number.EPSILON;
/**
 * Safety factor: a working tolerance must exceed float64 spacing by this
 * many ulps. 8 ulps keeps classification decisions clear of rounding
 * noise while staying far below any BIM feature scale.
 */
export const TOLERANCE_ULPS = 8;
/**
 * Approximate float64 spacing (1 ulp) at `magnitude`: within a factor of 2
 * of the true spacing. At |x| = 1e9 this is ~2.2e-7 m; at |x| = 1 it is
 * ~2.2e-16 m. Returns 0 at magnitude 0 (spacing there is denormal and
 * irrelevant — the absolute base dominates).
 */
export function floatSpacing(magnitude) {
    const m = Math.abs(magnitude);
    if (!(m > 0) || !Number.isFinite(m))
        return 0;
    return m * Number.EPSILON;
}
/**
 * Scale-relative tolerance: the absolute `base` floor, grown with
 * coordinate magnitude so it stays at least TOLERANCE_ULPS ulps above
 * float64 spacing. Identity at ordinary BIM scales (|magnitude| <= ~1e6
 * for a 1e-9 base); grows linearly beyond that.
 */
export function scaledTolerance(base, magnitude) {
    return Math.max(base, floatSpacing(magnitude) * TOLERANCE_ULPS);
}
/**
 * Scale-relative AREA tolerance (m²): the length tolerance squared.
 * A sliver-area cutoff must grow with the square of the coordinate
 * magnitude, or areas that are representable at 1e9-scale coordinates
 * would be dropped as noise.
 */
export function scaledAreaTolerance(baseArea, magnitude) {
    const len = floatSpacing(magnitude) * TOLERANCE_ULPS;
    return Math.max(baseArea, len * len);
}
/** Largest absolute coordinate component over a list of points. */
export function coordinateMagnitude(points) {
    let m = 0;
    for (const p of points) {
        if (Number.isFinite(p.x))
            m = Math.max(m, Math.abs(p.x));
        if (Number.isFinite(p.y))
            m = Math.max(m, Math.abs(p.y));
        if (Number.isFinite(p.z))
            m = Math.max(m, Math.abs(p.z));
    }
    return m;
}
/** Largest absolute vertex coordinate of an indexed mesh. */
export function meshMagnitude(mesh) {
    return coordinateMagnitude(mesh.vertices);
}
// ── Geometric tolerances (metres unless noted) ───────────────────────────
/** Vertex welding / profile closure (brep COINCIDENT_TOL, forms, shell). */
export const COINCIDENT_TOLERANCE = 1e-9;
/** Half-space classification in convex splitting (csg EPS). */
export const CLASSIFICATION_TOLERANCE = 1e-9;
/** Support-plane merge: normal components (dimensionless) and w (m). */
export const PLANE_MATCH_TOLERANCE = 1e-9;
/** Half-space side test during general-CSG fragment splitting. */
export const SPLIT_TOLERANCE = 1e-9;
/** Vertex-on-plane tagging for coplanar handling (general-csg). */
export const ON_PLANE_TOLERANCE = 1e-8;
/** Probe displacement off a fragment face for inside/outside tests. */
export const PROBE_TOLERANCE = 1e-6;
/** Coplanar check in csg.coplanarWithAny. */
export const COPLANAR_CHECK_TOLERANCE = 1e-6;
/** Cells below this area (m²) are sliver noise — recorded, see below. */
export const SLIVER_AREA_TOLERANCE = 1e-12;
/** |cross| of a triangle's edges below this (m²) => degenerate triangle. */
export const TRIANGLE_CROSS_TOLERANCE = 1e-12;
/** Ray/triangle determinant guard (csg ray casting). */
export const RAY_DETERMINANT_TOLERANCE = 1e-15;
/** Ray/bounds epsilon in point-in-mesh queries (m). */
export const RAY_EPSILON = 1e-9;
/** Newell normal magnitude below this => zero-area face (brep). */
export const FACE_NORMAL_TOLERANCE = 1e-15;
/** Segment-parallel denominator in 2D profile intersection (forms, m²). */
export const SEGMENT_PARALLEL_DENOMINATOR = 1e-15;
/** Dimensionless parameter window for segment intersection (forms). */
export const SEGMENT_PARAMETER_TOLERANCE = 1e-12;
/** Revolution angle validity window (rad). */
export const REVOLUTION_ANGLE_TOLERANCE = 1e-9;
/** Revolution axis length below this => zero-length axis (m). */
export const REVOLUTION_AXIS_TOLERANCE = 1e-12;
/** Radial-frame rejection length (revolve, m). */
export const RADIAL_FRAME_TOLERANCE = 1e-12;
/** Polar resample denominator guard (forms, m²). */
export const RESAMPLE_DENOMINATOR = 1e-15;
/** Angle de-duplication when sharing sample angles across profiles (rad). */
export const ANGLE_DEDUPE_TOLERANCE = 1e-9;
/** Default weld tolerance for polygon-soup meshes (general-csg weldMesh). */
export const WELD_MESH_TOLERANCE = 1e-7;
/** Quantisation grid for on-plane edge keys (general-csg, m). */
export const EDGE_KEY_GRID = 1e-7;
/** Barycentric sign guard in point-in-triangle (general-csg). */
export const BARYCENTRIC_TOLERANCE = 1e-12;
/** Degenerate edge length / edge-normal guard in cut objects (m, m²). */
export const EDGE_LENGTH_TOLERANCE = 1e-12;
export const EDGE_NORMAL_TOLERANCE = 1e-12;
/** Zero-length rotation axis (modify/transform, m). */
export const ROTATION_AXIS_TOLERANCE = 1e-15;
/** AABB overlap slack (voids, m). */
export const AABB_OVERLAP_TOLERANCE = 1e-12;
/** Triangle/triangle plane-distance guard (voids, m). */
export const TRIANGLE_PLANE_TOLERANCE = 1e-12;
/** Coplanar triangle-pair direction guard (voids, dimensionless). */
export const COPLANAR_DIRECTION_TOLERANCE = 1e-15;
/** Interval-overlap slack on the triangle-intersection line (voids, m). */
export const INTERVAL_OVERLAP_TOLERANCE = 1e-15;
/** Segment-parallel denominator in shell offsets (m²). */
export const SHELL_PARALLEL_DENOMINATOR = 1e-12;
/** Sine of the angle between adjacent shell edges below this => parallel. */
export const SHELL_PARALLEL_SINE = 1e-9;
/** Point coincidence in shell ring cleanup (m). */
export const SHELL_POINT_TOLERANCE = 1e-9;
/** Geometric epsilon for magnetic snapping (snapping/magnetic, m). */
export const SNAP_GEOMETRIC_TOLERANCE = 1e-9;
/** Dimensionless parameter window in magnetic segment intersection. */
export const SNAP_PARAMETER_TOLERANCE = 1e-9;
/** 2D polygon point-in-polygon division guard (poly-boolean). */
export const POLY_POINT_GUARD = 1e-15;
/** 2D segment-intersection denominator guard (poly-boolean, m²). */
export const POLY_SEGMENT_DENOMINATOR = 1e-12;
/** 2D segment parameter window (poly-boolean, dimensionless). */
export const POLY_PARAMETER_TOLERANCE = 1e-9;
/** 2D clip half-plane inclusion guard (poly-boolean, m²). */
export const POLY_CLIP_TOLERANCE = 1e-9;
// ── Scale-relative accessors ─────────────────────────────────────────────
/** Coincident/weld tolerance at the given coordinate magnitude. */
export const coincidentTolerance = (magnitude) => scaledTolerance(COINCIDENT_TOLERANCE, magnitude);
/** Half-space classification tolerance at the given magnitude. */
export const classificationTolerance = (magnitude) => scaledTolerance(CLASSIFICATION_TOLERANCE, magnitude);
/** Fragment-split tolerance at the given magnitude. */
export const splitTolerance = (magnitude) => scaledTolerance(SPLIT_TOLERANCE, magnitude);
/** On-plane tagging tolerance at the given magnitude. */
export const onPlaneTolerance = (magnitude) => scaledTolerance(ON_PLANE_TOLERANCE, magnitude);
/** Inside/outside probe displacement at the given magnitude. */
export const probeTolerance = (magnitude) => scaledTolerance(PROBE_TOLERANCE, magnitude);
/** Sliver-area cutoff (m²) at the given magnitude. */
export const sliverAreaTolerance = (magnitude) => scaledAreaTolerance(SLIVER_AREA_TOLERANCE, magnitude);
/** Ray-query epsilon at the given magnitude. */
export const rayEpsilon = (magnitude) => scaledTolerance(RAY_EPSILON, magnitude);
/** Typed error for degenerate caller-supplied input. Never silent. */
export class DegenerateInputError extends Error {
    code = "degenerate-input";
    reason;
    constructor(reason, message) {
        super(`degenerate-input (${reason}): ${message}`);
        this.name = "DegenerateInputError";
        this.reason = reason;
    }
}
/** Append (or aggregate into) a diagnostic entry on a collector list. */
export function recordDiagnostic(diagnostics, code, message, count = 1, totalArea2) {
    if (!diagnostics)
        return;
    const existing = diagnostics.find((d) => d.code === code);
    if (existing) {
        existing.count += count;
        if (totalArea2 !== undefined) {
            existing.totalArea2 = (existing.totalArea2 ?? 0) + totalArea2;
        }
        return;
    }
    diagnostics.push({ code, message, count, totalArea2 });
}
