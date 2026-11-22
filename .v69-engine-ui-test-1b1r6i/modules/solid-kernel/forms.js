"use strict";
/**
 * Parametric form generation (Design spec MODULE 2.8).
 *
 * Extrusions, revolutions, sweeps and blends from validated 2D profiles,
 * producing watertight indexed meshes with outward winding so that
 * `meshVolume` (divergence theorem) recovers exact volumes.
 *
 * Validation per spec 2.8/2.12 (performed BEFORE geometry is built):
 *   - open profile (first point != last point within tolerance) → error
 *   - fewer than 3 distinct points → error
 *   - self-intersecting profile → error (segment-segment intersection,
 *     excluding adjacent segments)
 *   - zero-depth / negative depth → error
 *   - revolution axis crossing the profile → error (spec: axis-profile
 *     intersections produce invalid topology)
 *
 * Evidence classification: level E — standard computational-geometry
 * constructions, matching the observable RVT behavior that these forms
 * regenerate from their parametric definitions.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateProfile = validateProfile;
exports.selfIntersects = selfIntersects;
exports.signedArea = signedArea;
exports.extrude = extrude;
exports.revolve = revolve;
exports.sweep = sweep;
exports.blend = blend;
exports.resampleByAngle = resampleByAngle;
exports.resampleByAngles = resampleByAngles;
exports.sharedSampleAngles = sharedSampleAngles;
const adaptive_1 = require("../adaptive");
const brep_1 = require("./brep");
function formError(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}
/** Validate a closed profile; returns the ring without a duplicated endpoint. */
function validateProfile(profile) {
    if (!Array.isArray(profile) || profile.length < 3) {
        throw formError("degenerate-profile", "profile needs at least 3 points");
    }
    // Strip an explicitly repeated closing point, but require closure.
    const ring = [...profile];
    const first = ring[0];
    const last = ring[ring.length - 1];
    const explicitlyClosed = Math.abs(first.u - last.u) <= brep_1.COINCIDENT_TOL && Math.abs(first.v - last.v) <= brep_1.COINCIDENT_TOL;
    if (explicitlyClosed)
        ring.pop();
    if (ring.length < 3)
        throw formError("degenerate-profile", "profile closes on itself with < 3 distinct points");
    if (!explicitlyClosed) {
        // Implicit closure is NOT accepted (spec 2.8 "closed profiles").
        throw formError("open-profile", "profile must be closed: first and last points must coincide");
    }
    for (const p of ring) {
        if (!Number.isFinite(p.u) || !Number.isFinite(p.v)) {
            throw formError("degenerate-profile", "profile contains non-finite coordinates");
        }
    }
    if (selfIntersects(ring)) {
        throw formError("self-intersection", "profile is self-intersecting");
    }
    return ring;
}
/** Segment-segment intersection test excluding shared endpoints. */
function segInt(p1, p2, p3, p4) {
    const d1x = p2.u - p1.u, d1y = p2.v - p1.v;
    const d2x = p4.u - p3.u, d2y = p4.v - p3.v;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-15)
        return false; // parallel
    const t = ((p3.u - p1.u) * d2y - (p3.v - p1.v) * d2x) / denom;
    const s = ((p3.u - p1.u) * d1y - (p3.v - p1.v) * d1x) / denom;
    const eps = 1e-12;
    return t > eps && t < 1 - eps && s > eps && s < 1 - eps;
}
/** O(n²) self-intersection test for a closed ring (fine for family profiles). */
function selfIntersects(ring) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (j === i || (j + 1) % n === i || (i + 1) % n === j)
                continue;
            if (segInt(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]))
                return true;
        }
    }
    return false;
}
/** Shoelace signed area, positive for CCW rings. */
function signedArea(ring) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
        const p = ring[i];
        const q = ring[(i + 1) % ring.length];
        a += p.u * q.v - q.u * p.v;
    }
    return a / 2;
}
/** Extrude a validated closed profile along +z. Outward winding. */
function extrude(params) {
    const ring = validateProfile(params.profile);
    const depth = params.depth;
    if (!Number.isFinite(depth) || depth <= brep_1.COINCIDENT_TOL) {
        throw formError("invalid-parameter", `depth must be > 0, got ${params.depth}`);
    }
    const z0 = params.startOffset ?? 0;
    if (signedArea(ring) < 0)
        ring.reverse(); // ensure CCW
    const n = ring.length;
    const vertices = [];
    for (const p of ring)
        vertices.push({ x: p.u, y: p.v, z: z0 });
    for (const p of ring)
        vertices.push({ x: p.u, y: p.v, z: z0 + depth });
    const faces = [];
    // Bottom cap (normal −z): reversed winding.
    for (let i = 1; i < n - 1; i++)
        faces.push([0, i + 1, i]);
    // Top cap (normal +z).
    const top = n;
    for (let i = 1; i < n - 1; i++)
        faces.push([top, top + i, top + i + 1]);
    // Side quads: outward (ring is CCW seen from +z).
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push([i, j, n + j]);
        faces.push([i, n + j, n + i]);
    }
    return { vertices, faces };
}
/**
 * Revolve a validated profile around an axis. The profile must stay
 * strictly on one side of the axis (u >= 0); crossings are rejected
 * (spec 2.8 "axis-profile intersections").
 */
function revolve(params) {
    const ring = validateProfile(params.profile);
    for (const p of ring) {
        if (p.u < -brep_1.COINCIDENT_TOL) {
            throw formError("axis-crosses-profile", `profile radius ${p.u} < 0 crosses the axis`);
        }
    }
    const angle = params.angle ?? Math.PI * 2;
    if (!(angle > 1e-9) || angle > Math.PI * 2 + 1e-9) {
        throw formError("invalid-parameter", `angle must be in (0, 2π], got ${angle}`);
    }
    const segs = Math.max(3, params.segments ?? 32);
    const closed = Math.abs(angle - Math.PI * 2) < 1e-9;
    // Build the axis frame: A along axisDir; R a radial unit vector ⊥ A;
    // S = A×R completes the rotation plane. Profile v maps along A, radius
    // rotates in the (R, S) plane.
    const alen = Math.hypot(params.axisDir.x, params.axisDir.y, params.axisDir.z);
    if (alen < 1e-12)
        throw formError("invalid-parameter", "zero-length axis");
    const A = { x: params.axisDir.x / alen, y: params.axisDir.y / alen, z: params.axisDir.z / alen };
    const ref = Math.abs(A.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const cross = (a, b) => ({
        x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x,
    });
    const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    // R = ref − (ref·A)A, normalised (rejection of the axis component).
    const dra = dot3(ref, A);
    const R0 = { x: ref.x - A.x * dra, y: ref.y - A.y * dra, z: ref.z - A.z * dra };
    const Rl = Math.hypot(R0.x, R0.y, R0.z);
    if (Rl < 1e-12)
        throw formError("invalid-parameter", "cannot build a radial frame for this axis");
    const R = { x: R0.x / Rl, y: R0.y / Rl, z: R0.z / Rl };
    const S = cross(A, R); // unit (A ⊥ R ⇒ |A×R| = 1)
    // Ring of section frames around the axis.
    const section = (i) => {
        const a = (angle * i) / segs;
        const dir = {
            x: R.x * Math.cos(a) + S.x * Math.sin(a),
            y: R.y * Math.cos(a) + S.y * Math.sin(a),
            z: R.z * Math.cos(a) + S.z * Math.sin(a),
        };
        return ring.map((p) => ({
            x: params.axisPoint.x + dir.x * p.u + A.x * p.v,
            y: params.axisPoint.y + dir.y * p.u + A.y * p.v,
            z: params.axisPoint.z + dir.z * p.u + A.z * p.v,
        }));
    };
    const vertices = [];
    const faces = [];
    const ringCount = closed ? segs : segs + 1;
    for (let i = 0; i < ringCount; i++) {
        for (const p of section(i))
            vertices.push(p);
    }
    const n = ring.length;
    // Side surface quads between consecutive sections (the modulo handles
    // both the closed wrap and the open last strip).
    for (let s = 0; s < segs; s++) {
        const s1 = s * n;
        const s2 = ((s + 1) % (closed ? segs : segs + 1)) * n;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            faces.push([s1 + i, s2 + i, s2 + j]);
            faces.push([s1 + i, s2 + j, s1 + j]);
        }
    }
    // Caps for partial revolutions.
    if (!closed) {
        const capA = 0;
        const capB = segs * n;
        for (let i = 1; i < n - 1; i++) {
            faces.push([capA, capA + i, capA + i + 1]);
            faces.push([capB, capB + i + 1, capB + i]);
        }
    }
    return { vertices, faces };
}
/** Sweep a validated profile along a 3D path (delegates to adaptive.sweepProfile). */
function sweep(params) {
    validateProfile(params.profile);
    if (params.path.length < 2)
        throw formError("invalid-parameter", "sweep path needs >= 2 points");
    return (0, adaptive_1.sweepProfile)(params.profile, params.path);
}
/**
 * Blend two validated profiles (loft). Degenerate handling (spec 2.8):
 * equal vertex counts pair vertices in order (exact linear
 * interpolation); when counts differ, sections are re-sampled to a
 * common vertex count by polar-angle parameterisation at one angle set
 * shared by both profiles, so rectangular-to-round blends remain
 * watertight and no corner is chamfered away.
 */
function blend(params) {
    const a = validateProfile(params.startProfile);
    const b = validateProfile(params.endProfile);
    if (!Number.isFinite(params.height) || Math.abs(params.height) <= brep_1.COINCIDENT_TOL) {
        throw formError("invalid-parameter", `height must be non-zero, got ${params.height}`);
    }
    if (signedArea(a) < 0)
        a.reverse();
    if (signedArea(b) < 0)
        b.reverse();
    const ca = centroid(a);
    const cb = centroid(b);
    const targetCount = Math.max(a.length, b.length, 16);
    // Same correspondence rule as loftSections (which must stay
    // volume-identical to blend): equal vertex counts pair vertices in
    // order — exact linear interpolation — otherwise one angle set shared
    // by both profiles (grid + every vertex angle), so no corner is
    // chamfered away. See loftSections for why a plain per-profile grid
    // is not enough.
    let ra;
    let rb;
    if (a.length === b.length) {
        ra = a;
        rb = b;
    }
    else {
        const angles = sharedSampleAngles([a, b], targetCount);
        ra = resampleByAngles(a, ca, angles);
        rb = resampleByAngles(b, cb, angles);
    }
    const vertices = [];
    for (const p of ra)
        vertices.push({ x: p.u, y: p.v, z: 0 });
    for (const p of rb)
        vertices.push({ x: p.u, y: p.v, z: params.height });
    const n = ra.length;
    const faces = [];
    for (let i = 1; i < n - 1; i++)
        faces.push([0, i + 1, i]); // bottom cap
    for (let i = 1; i < n - 1; i++)
        faces.push([n, n + i, n + i + 1]); // top cap
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push([i, j, n + j]);
        faces.push([i, n + j, n + i]);
    }
    return { vertices, faces };
}
function centroid(ring) {
    let u = 0, v = 0;
    for (const p of ring) {
        u += p.u;
        v += p.v;
    }
    return { u: u / ring.length, v: v / ring.length };
}
/**
 * Re-sample a closed ring at `count` evenly spaced polar angles around
 * `c`, preserving shape. Linear interpolation between the two bracketing
 * vertices per ray (O(n·count)). Exported for the v0.70 N-section loft,
 * which must share blend()'s exact correspondence path.
 *
 * NOTE: a fixed even grid alone chamfers any profile corner that does
 * not fall on it — e.g. a 2x3 rectangle loses ~3% of its area, and its
 * corners never appear in the resampled ring. Lofts/blends therefore
 * sample at the shared angle set from `sharedSampleAngles` (grid plus
 * every vertex angle), which keeps every original vertex. This function
 * on its own is kept for callers that only need the plain grid.
 */
function resampleByAngle(ring, c, count) {
    const angles = [];
    for (let i = 0; i < count; i++)
        angles.push(-Math.PI + (2 * Math.PI * i) / count);
    return resampleByAngles(ring, c, angles);
}
/**
 * Re-sample a closed ring at the given polar angles (sorted, in
 * [-pi, pi)) around `c`. Sampling exactly at a vertex angle returns
 * that vertex, so an angle set containing every vertex angle preserves
 * the ring's corners exactly.
 */
function resampleByAngles(ring, c, angles) {
    const pts = ring.map((p) => ({ p, ang: Math.atan2(p.v - c.v, p.u - c.u) }));
    // Ensure the ring angles are monotonic starting at the first point.
    const out = [];
    for (const target of angles) {
        let k = -1;
        for (let j = 0; j < pts.length; j++) {
            const a1 = pts[j].ang;
            const a2 = pts[(j + 1) % pts.length].ang;
            const a2n = a2 <= a1 ? a2 + 2 * Math.PI : a2;
            const tn = target < a1 ? target + 2 * Math.PI : target;
            if (tn >= a1 && tn <= a2n) {
                k = j;
                break;
            }
        }
        if (k < 0) {
            out.push({ ...pts[0].p });
            continue;
        }
        const p1 = pts[k].p;
        const p2 = pts[(k + 1) % pts.length].p;
        const denom = (p2.u - p1.u) * (p2.u - p1.u) + (p2.v - p1.v) * (p2.v - p1.v);
        const t = denom > 1e-15
            ? Math.max(0, Math.min(1, polarLerpT(p1, p2, c, target)))
            : 0;
        out.push({ u: p1.u + (p2.u - p1.u) * t, v: p1.v + (p2.v - p1.v) * t });
    }
    return out;
}
/**
 * One sample-angle set shared by every ring of a loft/blend: the even
 * `count` grid plus the polar angle of every vertex of every ring (each
 * about its own centroid), sorted and de-duplicated. Resampling all
 * rings at this one set keeps the vertex correspondence across sections
 * (vertex i is at the same angle on every ring) while preserving every
 * original vertex — so rectangular corners survive resampling exactly
 * and the interpolated area integral is exact, not chamfered.
 */
function sharedSampleAngles(rings, count) {
    const angles = [];
    for (let i = 0; i < count; i++)
        angles.push(-Math.PI + (2 * Math.PI * i) / count);
    const has = (a) => angles.some((x) => Math.abs(x - a) < 1e-9);
    for (const ring of rings) {
        const c = centroid(ring);
        for (const p of ring) {
            let a = Math.atan2(p.v - c.v, p.u - c.u);
            if (a >= Math.PI)
                a -= 2 * Math.PI; // atan2 can return +pi; -pi is the same ray
            if (!has(a))
                angles.push(a);
        }
    }
    angles.sort((a, b) => a - b);
    return angles;
}
/** Parameter t along segment p1→p2 where the polar angle equals target. */
function polarLerpT(p1, p2, c, target) {
    const a1 = Math.atan2(p1.v - c.v, p1.u - c.u);
    const a2 = Math.atan2(p2.v - c.v, p2.u - c.u);
    let span = a2 - a1;
    if (span < -Math.PI)
        span += 2 * Math.PI;
    if (span > Math.PI)
        span -= 2 * Math.PI;
    let dt = target - a1;
    if (dt < -Math.PI)
        dt += 2 * Math.PI;
    if (dt > Math.PI)
        dt -= 2 * Math.PI;
    const t = span !== 0 ? dt / span : 0;
    return Math.max(0, Math.min(1, t));
}
