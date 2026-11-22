"use strict";
/**
 * Open BIM Studio - Parametric Engine (BIM-competitive core)
 *
 * Orchestrates:
 *   1. Formula evaluation (topo-sorted, units-aware, conditional)
 *   2. Dimensional + geometric constraint solving
 *   3. Nested family instances & array expansion
 *   4. Geometry build (extrude / sweep / revolve / loft / void / conditional)
 *   5. Change propagation (type - instance - nested children)
 *
 * Public API is pure / side-effect free except for registered custom builders.
 * Authoring, UI, and store sit on top of this module.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyTypeValues = exports.resolveNested = exports.expandArrays = exports.solveConstraints = exports.tintObject = exports.getCustomBuilder = exports.registerCustomBuilder = exports.resolveTransform = exports.resolveNumber = exports.buildParametricGeometry = exports.evaluateParameters = void 0;
exports.resolveParametricValues = resolveParametricValues;
exports.buildExtendedGeometry = buildExtendedGeometry;
exports.buildParametricFamily = buildParametricFamily;
exports.resolveInstanceAfterTypeChange = resolveInstanceAfterTypeChange;
exports.extractInstanceOverrides = extractInstanceOverrides;
exports.propagateTypeChange = propagateTypeChange;
exports.collectReportingValues = collectReportingValues;
const THREE = require("three");
const three_csg_ts_1 = require("three-csg-ts");
const formula_engine_1 = require("./formula-engine");
Object.defineProperty(exports, "evaluateParameters", { enumerable: true, get: function () { return formula_engine_1.evaluateParameters; } });
const parametric_geometry_1 = require("./parametric-geometry");
Object.defineProperty(exports, "buildParametricGeometry", { enumerable: true, get: function () { return parametric_geometry_1.buildParametricGeometry; } });
Object.defineProperty(exports, "resolveNumber", { enumerable: true, get: function () { return parametric_geometry_1.resolveNumber; } });
Object.defineProperty(exports, "resolveTransform", { enumerable: true, get: function () { return parametric_geometry_1.resolveTransform; } });
Object.defineProperty(exports, "registerCustomBuilder", { enumerable: true, get: function () { return parametric_geometry_1.registerCustomBuilder; } });
Object.defineProperty(exports, "getCustomBuilder", { enumerable: true, get: function () { return parametric_geometry_1.getCustomBuilder; } });
Object.defineProperty(exports, "tintObject", { enumerable: true, get: function () { return parametric_geometry_1.tintObject; } });
const constraint_graph_1 = require("./constraint-graph");
Object.defineProperty(exports, "solveConstraints", { enumerable: true, get: function () { return constraint_graph_1.solveConstraints; } });
const parameter_scope_1 = require("./parameter-scope");
Object.defineProperty(exports, "applyTypeValues", { enumerable: true, get: function () { return parameter_scope_1.applyTypeValues; } });
const array_expander_1 = require("./array-expander");
Object.defineProperty(exports, "expandArrays", { enumerable: true, get: function () { return array_expander_1.expandArrays; } });
const nested_families_1 = require("./nested-families");
Object.defineProperty(exports, "resolveNested", { enumerable: true, get: function () { return nested_families_1.resolveNested; } });
const loft_1 = require("../solid-kernel/loft");
/* ---------------------------------------------------------------------------
   Parameter pipeline
   --------------------------------------------------------------------------- */
/**
 * Full parameter resolution pipeline matching BIM's order of operations:
 *   defaults - shared/project - type - instance overrides - formulas - constraints
 *
 * The type layer is scope-enforced: a type value only applies to a
 * parameter declared with scope "type". A type value targeting an
 * instance-scope parameter, or a parameter the family does not declare,
 * is ignored and reported in the returned `warnings` (see
 * parameter-scope.ts) — it must never silently set an instance value.
 */
function resolveParametricValues(family, type, options = {}) {
    const errors = [];
    const warnings = [];
    const values = {};
    // 1. Family defaults
    for (const p of family.parameters) {
        values[p.name] = p.default;
    }
    // 2. Shared / project parameters (only keys that exist on the family)
    if (options.sharedParams) {
        for (const p of family.parameters) {
            if (p.name in options.sharedParams) {
                values[p.name] = options.sharedParams[p.name];
            }
        }
    }
    // 3. Type overrides (scope-enforced: type-scope parameters only)
    if (type) {
        const { applied, warnings: scopeWarnings } = (0, parameter_scope_1.applyTypeValues)(family, type);
        warnings.push(...scopeWarnings);
        for (const [k, v] of Object.entries(applied)) {
            values[k] = v;
        }
    }
    // 4. Instance overrides
    if (options.overrides) {
        for (const [k, v] of Object.entries(options.overrides)) {
            values[k] = v;
        }
    }
    // 5. Clamp numeric parameters to min/max before formulas
    for (const p of family.parameters) {
        if (typeof values[p.name] === "number") {
            let n = values[p.name];
            if (p.min != null && n < p.min)
                n = p.min;
            if (p.max != null && n > p.max)
                n = p.max;
            if (p.type === "integer")
                n = Math.round(n);
            values[p.name] = n;
        }
    }
    // 6. Formula evaluation (topo-sorted, cycle-safe)
    const formula = (0, formula_engine_1.evaluateParameters)(family.parameters, values);
    Object.assign(values, formula.values);
    for (const e of formula.errors) {
        errors.push(`formula:${e.parameter}: ${e.message}`);
    }
    // 7. Constraint solve (equality / ratio / sum / distance)
    let constraints = null;
    if (options.constraints && options.constraints.length) {
        constraints = (0, constraint_graph_1.solveConstraints)(values, options.constraints);
        Object.assign(values, constraints.values);
        for (const e of constraints.errors) {
            errors.push(`constraint:${e}`);
        }
    }
    // 8. Final clamp after constraints
    for (const p of family.parameters) {
        if (typeof values[p.name] === "number") {
            let n = values[p.name];
            if (p.min != null && n < p.min)
                n = p.min;
            if (p.max != null && n > p.max)
                n = p.max;
            values[p.name] = n;
        }
    }
    return { values, formula, constraints, errors, warnings };
}
/* ---------------------------------------------------------------------------
   Visibility helper
   --------------------------------------------------------------------------- */
function isVisible(spec, params) {
    if (!spec.visibleWhen)
        return true;
    const v = params[spec.visibleWhen];
    if (typeof v === "boolean")
        return v;
    if (typeof v === "number")
        return v !== 0;
    if (typeof v === "string")
        return v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
    return !!v;
}
/* ---------------------------------------------------------------------------
   Extended geometry builders
   --------------------------------------------------------------------------- */
function buildSweep(profile, path, closed, params) {
    // Manual sweep (no ExtrudeGeometry Frenet frames): the profile is
    // carried along the polyline path with parallel-transport frames, so
    // its orientation is deterministic — profile +Y stays as close to
    // world +Y as the path allows (profile +X follows by right-handedness)
    // — and sharp corners are mitered instead of bulging past the
    // waypoint the way a Catmull-Rom curve does. Stations sit on the
    // waypoints; each interior station's ring lies in the plane
    // perpendicular to the average (miter) tangent, so adjacent prisms
    // share exactly one face: no overlap, no gap, no overshoot.
    if (path.length < 2)
        return null;
    const pts = path.map(([x, y, z]) => new THREE.Vector3((0, parametric_geometry_1.resolveNumber)(x, params), (0, parametric_geometry_1.resolveNumber)(y, params), (0, parametric_geometry_1.resolveNumber)(z, params)));
    // Drop consecutive duplicates (a zero-length segment has no tangent).
    const clean = [];
    for (const p of pts) {
        const last = clean[clean.length - 1];
        if (!last || last.distanceToSquared(p) > 1e-12)
            clean.push(p);
    }
    if (clean.length < 2)
        return null;
    const stations = closed && clean[0].distanceToSquared(clean[clean.length - 1]) > 1e-12
        ? [...clean, clean[0].clone()]
        : clean;
    const count = stations.length;
    const wps = closed ? clean : stations;
    // Tangents: end stations use their one segment; interior stations use
    // the miter (average of adjacent segment directions). For a closed
    // path the seam station reuses station 0's tangent.
    const tangents = [];
    for (let i = 0; i < count; i++) {
        const j = closed ? i % wps.length : i;
        if (!closed && j === 0)
            tangents.push(stations[1].clone().sub(stations[0]).normalize());
        else if (!closed && j === wps.length - 1)
            tangents.push(stations[count - 1].clone().sub(stations[count - 2]).normalize());
        else {
            const prev = wps[(j - 1 + wps.length) % wps.length];
            const next = wps[(j + 1) % wps.length];
            const a = stations[i].clone().sub(prev).normalize();
            const b = next.clone().sub(stations[i]).normalize();
            const m = a.clone().add(b);
            tangents.push(m.lengthSq() > 1e-12 ? m.normalize() : a);
        }
    }
    // Parallel-transport frames: start from world-up (or world-X when the
    // path starts vertical), then rotate each frame by the shortest arc
    // between consecutive tangents.
    const frames = [];
    {
        const t0 = tangents[0];
        const up = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const b0 = up.clone().sub(t0.clone().multiplyScalar(up.dot(t0))).normalize();
        const n0 = new THREE.Vector3().crossVectors(b0, t0).normalize();
        frames.push({ n: n0, b: b0 });
        for (let i = 1; i < count; i++) {
            const q = new THREE.Quaternion().setFromUnitVectors(tangents[i - 1], tangents[i]);
            const prev = frames[i - 1];
            const n = prev.n.clone().applyQuaternion(q);
            const b = prev.b.clone().applyQuaternion(q);
            // Re-orthogonalise against the new tangent (numerical drift).
            const t = tangents[i];
            b.sub(t.clone().multiplyScalar(b.dot(t))).normalize();
            n.crossVectors(b, t).normalize();
            frames.push({ n, b });
        }
    }
    // Shear the in-plane direction at corners: the ring at a mitered
    // corner is the leg prism's intersection with the miter plane (area
    // profile / cos(half-angle)), NOT the profile rigidly rotated into
    // the plane, which shrinks the corner (a rigid 45-degree ring puts
    // the outer face at 0.354 instead of 0.5 and loses ~2.3 volume on
    // an L-path). The two legs then touch exactly at the miter plane:
    // an L-path of 1x2 profile measures 8 + 8 = 16.
    const dirs = [];
    for (let i = 0; i < count; i++) {
        const j = closed ? i % wps.length : i;
        let d = frames[i].n;
        const isCorner = closed || (j > 0 && j < wps.length - 1);
        if (isCorner) {
            const a = stations[i].clone().sub(wps[(j - 1 + wps.length) % wps.length]).normalize();
            const m = tangents[i];
            const nA = new THREE.Vector3().crossVectors(frames[i].b, a).normalize();
            const denom = a.dot(m);
            if (Math.abs(denom) > 1e-9) {
                d = nA.clone().sub(a.clone().multiplyScalar(nA.dot(m) / denom));
            }
        }
        dirs.push(d);
    }
    if (closed) {
        // The seam station must reuse station 0's frame exactly, or the
        // loop does not close.
        dirs[count - 1] = dirs[0];
        frames[count - 1] = frames[0];
    }
    const ring = profileRing(profile, params, 64);
    if (ring.length < 3)
        return null;
    const ringPts = (i) => {
        const c = stations[i], f = frames[i], d = dirs[i];
        return ring.map((p) => new THREE.Vector3(c.x + d.x * p.x + f.b.x * p.y, c.y + d.y * p.x + f.b.y * p.y, c.z + d.z * p.x + f.b.z * p.y));
    };
    const positions = [];
    const pushTri = (a, b, c) => {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    };
    const rings = stations.map((_, i) => ringPts(i));
    const m = ring.length;
    const segments = closed ? count : count - 1;
    for (let s = 0; s < segments; s++) {
        const r0 = rings[s], r1 = rings[(s + 1) % count];
        for (let k = 0; k < m; k++) {
            const k1 = (k + 1) % m;
            // Outward-facing quads (profile ring is counter-clockwise).
            pushTri(r0[k], r1[k1], r1[k]);
            pushTri(r0[k], r0[k1], r1[k1]);
        }
    }
    if (!closed) {
        // End caps (fans from the ring centroid).
        for (const [ri, flip] of [[0, true], [count - 1, false]]) {
            const r = rings[ri];
            const c = new THREE.Vector3();
            for (const p of r)
                c.add(p);
            c.multiplyScalar(1 / m);
            for (let k = 0; k < m; k++) {
                const k1 = (k + 1) % m;
                if (flip)
                    pushTri(c, r[k1], r[k]);
                else
                    pushTri(c, r[k], r[k1]);
            }
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo);
}
/** Clean ring of outline points for a profile (no duplicate closer, CCW). */
function profileRing(profile, params, divisions = 64) {
    const shape = profileToShapeLocal(profile, params);
    const raw = shape.getPoints(divisions);
    const out = [];
    for (const p of raw) {
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9)
            continue;
        out.push(new THREE.Vector2(p.x, p.y));
    }
    while (out.length > 1) {
        const f = out[0], l = out[out.length - 1];
        if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9)
            out.pop();
        else
            break;
    }
    return out;
}
/** Resample a closed polyline ring to `count` points, uniform by arc length. */
function resampleRing(points, count) {
    if (points.length < 3 || count < 3)
        return points;
    const closed = [...points, points[0]];
    const cum = [0];
    for (let i = 0; i < closed.length - 1; i++)
        cum.push(cum[i] + Math.hypot(closed[i + 1].x - closed[i].x, closed[i + 1].y - closed[i].y));
    const total = cum[cum.length - 1];
    if (total <= 0)
        return points.slice(0, count);
    const out = [];
    let seg = 0;
    for (let k = 0; k < count; k++) {
        const d = (k / count) * total;
        while (seg < cum.length - 2 && cum[seg + 1] < d)
            seg++;
        const span = cum[seg + 1] - cum[seg] || 1;
        const f = (d - cum[seg]) / span;
        const a = closed[seg], b = closed[seg + 1];
        out.push(new THREE.Vector2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f));
    }
    return out;
}
/**
 * Revolve a profile around the Y axis of shape space (radius = shape x,
 * height = shape y), then rotate the mesh for the requested axis.
 *
 * Hand-built, mirroring the Slice 6 sweep/loft rebuild: THREE's
 * LatheGeometry was measured to produce a mesh whose volume is silently
 * ZERO when the profile crosses the axis (a rect straddling the axis, or
 * a circle profile centred on it — the two halves cancel exactly while
 * the bounding box still looks right), silently accepts angles > 2π, and
 * leaves partial revolutions open (no end caps), so the result is not a
 * solid. This builder:
 * - rejects a profile that crosses the axis (any outline point with
 *   radius < 0) with a warning, as Revit does — a sphere is a 0–90°
 *   arc sector revolved, not a full circle on the axis;
 * - rejects angles outside (0, 2π] with a warning;
 * - stitches the side surface with outward-facing quads and closes
 *   partial revolutions with triangulated end caps
 *   (THREE.ShapeUtils.triangulateShape, so concave profiles cap
 *   correctly), oriented by the outward tangent at each end.
 * The side surface is still faceted by `segments` (an N-gon prism
 * approximation of the circular path), so volumes carry the analytic
 * faceting factor N·sin(2π/N)/2π — see the revolve test suite.
 */
function buildRevolve(profile, axis, angle, segments, params, warnings = []) {
    const theta = (0, parametric_geometry_1.resolveNumber)(angle, params);
    if (!Number.isFinite(theta) || theta <= 1e-9 || theta > Math.PI * 2 + 1e-9) {
        warnings.push(`revolve angle must be in (0, 2π], got ${theta}`);
        return null;
    }
    const ring = profileRing(profile, params, 64);
    if (ring.length < 3) {
        warnings.push("revolve profile has fewer than 3 outline points");
        return null;
    }
    for (const p of ring) {
        if (p.x < -1e-9) {
            warnings.push(`revolve profile crosses the revolution axis (radius ${p.x.toFixed(3)} < 0); ` +
                "move the profile to one side of the axis — a sphere is a 0–90° arc sector, not a circle on the axis");
            return null;
        }
        if (p.x < 0)
            p.x = 0;
    }
    // Enforce a CCW ring so the side winding below faces outward.
    let area2 = 0;
    for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        area2 += a.x * b.y - b.x * a.y;
    }
    if (area2 < 0)
        ring.reverse();
    const segs = Math.max(3, Math.floor(segments));
    const closed = Math.abs(theta - Math.PI * 2) < 1e-9;
    const positions = [];
    const at = (s, i) => {
        const p = ring[i];
        // For a full revolve the last section is the first one again: wrap
        // the index instead of evaluating sin/cos at 2π, so the seam
        // vertices are bit-identical (sin(2π) is -2.4e-16, not 0) and the
        // solid is watertight by construction.
        const ss = closed ? s % segs : s;
        const phi = (theta * ss) / segs;
        return [p.x * Math.sin(phi), p.y, p.x * Math.cos(phi)];
    };
    const tri = (a, b, c) => {
        positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    };
    const n = ring.length;
    // Side surface: A = P_s(i), B = P_s(j), C = P_{s+1}(j), D = P_{s+1}(i);
    // (A, C, B) and (A, D, C) face outward for a CCW ring.
    for (let s = 0; s < segs; s++) {
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const A = at(s, i), B = at(s, j), C = at(s + 1, j), D = at(s + 1, i);
            tri(A, C, B);
            tri(A, D, C);
        }
    }
    // End caps for partial revolutions. The cap at phi is the profile ring
    // in the plane through the axis at that angle; its outward normal is
    // the tangent direction d/dphi (cos phi, 0, -sin phi), negated at the
    // start cap (the solid lies toward increasing phi) and kept at the end.
    if (!closed) {
        const faces = THREE.ShapeUtils.triangulateShape(ring, []);
        for (const [phi, outward] of [[0, -1], [theta, 1]]) {
            const dir = [Math.cos(phi), 0, -Math.sin(phi)];
            for (const f of faces) {
                const pts = f.map((k) => {
                    const p = ring[k];
                    return [p.x * Math.sin(phi), p.y, p.x * Math.cos(phi)];
                });
                const [a, b, c] = pts;
                const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
                const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                const dot = (nx * dir[0] + ny * dir[1] + nz * dir[2]) * outward;
                if (dot < 0)
                    tri(pts[0], pts[2], pts[1]);
                else
                    tri(pts[0], pts[1], pts[2]);
            }
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo);
    if (axis === "x")
        mesh.rotation.z = Math.PI / 2;
    if (axis === "z")
        mesh.rotation.x = Math.PI / 2;
    return mesh;
}
/**
 * Convert a family profile to a closed ring for the solid kernel
 * (`validateProfile` requires first == last point). Returns null for a
 * degenerate profile (non-positive / non-finite size, fewer than 3 polygon
 * points). Rings are centred on the origin, matching `profileToShapeLocal`.
 */
function profileToLoftRing(profile, ringPoints, params) {
    if (profile.kind === "rect") {
        const w = (0, parametric_geometry_1.resolveNumber)(profile.w, params);
        const h = (0, parametric_geometry_1.resolveNumber)(profile.h, params);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
            return null;
        const x = w / 2;
        const y = h / 2;
        return [
            { u: -x, v: -y },
            { u: x, v: -y },
            { u: x, v: y },
            { u: -x, v: y },
            { u: -x, v: -y },
        ];
    }
    if (profile.kind === "circle") {
        const r = (0, parametric_geometry_1.resolveNumber)(profile.r, params);
        if (!Number.isFinite(r) || r <= 0)
            return null;
        const pts = [];
        for (let i = 0; i < ringPoints; i++) {
            const a = (2 * Math.PI * i) / ringPoints;
            pts.push({ u: r * Math.cos(a), v: r * Math.sin(a) });
        }
        pts.push({ ...pts[0] });
        return pts;
    }
    // polygon — the only remaining closed profile kind. An `arc` profile
    // (a circular sector, added by slice 5 after this function was written)
    // is an open curve, not a closed ring, so it cannot loft; treat it as
    // degenerate rather than reading a `points` field it does not have.
    if (profile.kind !== "polygon")
        return null;
    const raw = profile.points;
    if (!Array.isArray(raw) || raw.length < 3)
        return null;
    const ring = raw.map(([u, v]) => ({ u, v }));
    if (!ring.every((p) => Number.isFinite(p.u) && Number.isFinite(p.v)))
        return null;
    // Strip a caller-supplied closing repeat; the kernel wants exactly one.
    if (ring.length > 1) {
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first.u === last.u && first.v === last.v)
            ring.pop();
        if (ring.length < 3)
            return null;
    }
    ring.push({ ...ring[0] });
    return ring;
}
/**
 * True loft: ruled interpolation between the given profiles.
 *
 * The previous implementation stacked extruded slices, each a prism with a
 * constant cross-section, so the side wall was stepped and the volume was
 * a left-Riemann sum (with the default 4 segments, ~16% low for a
 * 2x2 -> 4x4 loft). This version delegates to the solid kernel's
 * `loftSections`, which re-samples every profile to a common vertex count
 * by polar angle (shared correspondence) and connects corresponding
 * vertices with ruled side bands, capped exactly at the first and last
 * profiles. An intermediate cross-section at height z is therefore the
 * linear interpolation of the two neighbouring profiles, and the volume
 * is the exact integral of the interpolated area — not a stepped sum.
 * This is a ruled loft, not a NURBS loft: interpolation between profiles
 * is linear, so e.g. a rect-to-rect loft has planar side faces.
 *
 * The loft spans z = 0 .. `length` with profiles evenly spaced along it,
 * and returns a single watertight mesh (one BufferGeometry), not a group
 * of slice prisms. Returns null for degenerate input (< 2 profiles,
 * non-positive length, an unusable profile, or a kernel validation
 * failure such as a self-intersecting polygon).
 */
function buildLoft(profiles, segments, params, length) {
    if (profiles.length < 2)
        return null;
    if (!Number.isFinite(length) || length <= 0)
        return null;
    // Multiple of 8 (min 16): rectangular corners then land exactly on the
    // kernel's resampled end rings, so endpoints are exact, not approximate.
    const ringPoints = Math.max(16, Math.ceil(segments / 8) * 8);
    const sections = [];
    for (const profile of profiles) {
        const ring = profileToLoftRing(profile, ringPoints, params);
        if (!ring)
            return null;
        sections.push(ring);
    }
    let mesh;
    try {
        mesh = (0, loft_1.loftSections)({ sections, height: length });
    }
    catch {
        return null;
    }
    const positions = new Float32Array(mesh.vertices.length * 3);
    mesh.vertices.forEach((v, i) => {
        positions[i * 3] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;
    });
    const index = new Uint32Array(mesh.faces.length * 3);
    mesh.faces.forEach((f, i) => {
        index[i * 3] = f[0];
        index[i * 3 + 1] = f[1];
        index[i * 3 + 2] = f[2];
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo);
}
function profileToShapeLocal(profile, params) {
    const shape = new THREE.Shape();
    if (profile.kind === "rect") {
        const w = (0, parametric_geometry_1.resolveNumber)(profile.w, params);
        const h = (0, parametric_geometry_1.resolveNumber)(profile.h, params);
        shape.moveTo(-w / 2, -h / 2);
        shape.lineTo(w / 2, -h / 2);
        shape.lineTo(w / 2, h / 2);
        shape.lineTo(-w / 2, h / 2);
        shape.closePath();
    }
    else if (profile.kind === "circle") {
        const r = (0, parametric_geometry_1.resolveNumber)(profile.r, params);
        shape.absarc(0, 0, Math.max(1e-6, r), 0, Math.PI * 2, false);
    }
    else if (profile.kind === "arc") {
        const r = (0, parametric_geometry_1.resolveNumber)(profile.r, params);
        const a0 = (0, parametric_geometry_1.resolveNumber)(profile.startAngle, params) * Math.PI / 180;
        const a1 = (0, parametric_geometry_1.resolveNumber)(profile.endAngle, params) * Math.PI / 180;
        if (r > 0 && a1 > a0) {
            shape.absarc(0, 0, Math.max(1e-6, r), a0, a1, false);
            if (a1 - a0 < Math.PI * 2 - 1e-9) {
                shape.lineTo(0, 0);
                shape.closePath();
            }
        }
    }
    else if (profile.kind === "polygon") {
        const pts = profile.points;
        if (pts.length >= 3) {
            shape.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++)
                shape.lineTo(pts[i][0], pts[i][1]);
            shape.closePath();
        }
    }
    return shape;
}
function collectMeshes(root, invGroup) {
    const out = [];
    root.traverse((o) => {
        if (!o.isMesh)
            return;
        const mesh = o;
        const rel = new THREE.Matrix4().copy(invGroup).multiply(mesh.matrixWorld);
        if (!mesh.geometry.boundingBox)
            mesh.geometry.computeBoundingBox(); // returns void
        const box = mesh.geometry.boundingBox.clone().applyMatrix4(rel);
        out.push({ mesh, rel, box });
    });
    return out;
}
/**
 * Subtract every void part of a composed group from its solids, with
 * the repo's existing CSG path (`three-csg-ts`, as used for door/window
 * openings in authoring.ts — no new dependency).
 *
 * `CSG.fromMesh` transforms vertices by the mesh's LOCAL matrix, so
 * each mesh is first re-expressed with its matrix relative to the
 * composed group; the result replaces the original mesh as a direct
 * child of the group with that same relative matrix. Meshes whose
 * bounding box does not touch any void are left exactly as built (no
 * CSG round-trip). A void that touches nothing costs nothing. A
 * subtraction that throws keeps the original solid and records a
 * warning — a failed cut must never silently drop the solid.
 */
function subtractVoids(group, solids, voids, warnings) {
    group.updateMatrixWorld(true);
    const invGroup = group.matrixWorld.clone().invert();
    const solidMeshes = solids.flatMap((s) => collectMeshes(s, invGroup));
    const voidMeshes = voids.flatMap((v) => collectMeshes(v, invGroup));
    if (!solidMeshes.length || !voidMeshes.length)
        return;
    for (const s of solidMeshes) {
        let working = null;
        for (const v of voidMeshes) {
            if (!s.box.intersectsBox(v.box))
                continue;
            try {
                const src = working ?? (() => {
                    const tmp = new THREE.Mesh(s.mesh.geometry, s.mesh.material);
                    tmp.matrix.copy(s.rel);
                    return tmp;
                })();
                const cutter = new THREE.Mesh(v.mesh.geometry, v.mesh.material);
                cutter.matrix.copy(v.rel);
                const result = three_csg_ts_1.CSG.toMesh(three_csg_ts_1.CSG.fromMesh(src).subtract(three_csg_ts_1.CSG.fromMesh(cutter)), s.rel, s.mesh.material);
                result.userData = { ...(s.mesh.userData ?? {}) };
                working = result;
            }
            catch (err) {
                const msg = `void subtraction failed: ${err instanceof Error ? err.message : String(err)}`;
                warnings.push(msg);
                console.warn("[parametric-engine] " + msg);
            }
        }
        if (working) {
            const parent = s.mesh.parent;
            if (parent)
                parent.remove(s.mesh);
            group.add(working);
        }
    }
    // Voids are cutters, not geometry: remove them from the output.
    for (const v of voids)
        group.remove(v);
}
function buildExtendedGeometry(spec, params, options = {}) {
    // Visibility gate (shared by most extended kinds)
    if ("visibleWhen" in spec && !isVisible(spec, params)) {
        return null;
    }
    switch (spec.kind) {
        case "box":
        case "cylinder":
        case "extrusion":
        case "custom":
            return (0, parametric_geometry_1.buildParametricGeometry)(spec, params);
        case "composed": {
            // Build parts through the extended builder (the classic builder
            // silently drops void/sweep/loft parts), then subtract the void
            // parts from the solids. Skipped for previews (options.preview),
            // where the old mark-only behaviour is kept for speed.
            const parts = spec.parts ?? [];
            const group = new THREE.Group();
            const solids = [];
            const voids = [];
            for (const part of parts) {
                const child = buildExtendedGeometry(part, params, options);
                if (!child)
                    continue;
                if (child.userData?.isVoid)
                    voids.push(child);
                else
                    solids.push(child);
                group.add(child);
            }
            if (!group.children.length)
                return null;
            if (voids.length && !options.preview) {
                subtractVoids(group, solids, voids, options.warnings ?? []);
            }
            return group;
        }
        case "sweep": {
            const mesh = buildSweep(spec.profile, spec.path, !!spec.closed, params);
            if (!mesh)
                return null;
            const wrap = (0, parametric_geometry_1.resolveTransform)(spec.transform, params);
            wrap.add(mesh);
            return wrap;
        }
        case "revolve": {
            const mesh = buildRevolve(spec.profile, spec.axis, spec.angle, spec.segments ?? 32, params, options.warnings ?? []);
            if (!mesh)
                return null;
            const wrap = (0, parametric_geometry_1.resolveTransform)(spec.transform, params);
            wrap.add(mesh);
            return wrap;
        }
        case "loft": {
            const length = spec.length !== undefined ? (0, parametric_geometry_1.resolveNumber)(spec.length, params) : 1;
            const obj = buildLoft(spec.profiles, spec.segments ?? 4, params, length);
            if (!obj)
                return null;
            const wrap = (0, parametric_geometry_1.resolveTransform)(spec.transform, params);
            wrap.add(obj);
            return wrap;
        }
        case "void": {
            // Mark as void; CSG subtraction is applied at composed-group level.
            const solid = (0, parametric_geometry_1.buildParametricGeometry)(spec.solid, params);
            if (!solid)
                return null;
            solid.userData.isVoid = true;
            const wrap = (0, parametric_geometry_1.resolveTransform)(spec.transform, params);
            wrap.add(solid);
            wrap.userData.isVoid = true;
            return wrap;
        }
        case "conditional": {
            const v = params[spec.when];
            const truthy = typeof v === "boolean" ? v :
                typeof v === "number" ? v !== 0 :
                    !!v;
            const branch = truthy ? spec.then : spec.else;
            if (!branch)
                return null;
            return buildExtendedGeometry(branch, params, options);
        }
        case "nested": {
            if (!options.familyLookup) {
                console.warn("[parametric-engine] nested family requires familyLookup");
                return null;
            }
            const warnings = options.warnings ?? [];
            // Circular nesting is rejected, not recursed into: A -> B -> A
            // would otherwise recurse until the stack overflows and the only
            // evidence would be "Maximum call stack size exceeded".
            const stack = options.nestingStack ?? [];
            if (stack.includes(spec.familyId)) {
                const chain = [...stack, spec.familyId].join(" -> ");
                const msg = `circular nesting rejected: ${chain}`;
                warnings.push(msg);
                console.warn("[parametric-engine] " + msg);
                return null;
            }
            const nestedFam = options.familyLookup(spec.familyId);
            if (!nestedFam) {
                const msg = `nested family not found: ${spec.familyId}`;
                warnings.push(msg);
                console.warn("[parametric-engine] " + msg);
                return null;
            }
            const nestedType = spec.typeId
                ? options.typeLookup?.(spec.familyId, spec.typeId) ?? null
                : null;
            // Map parent params - nested overrides. A binding that names a
            // parent parameter which does not exist is skipped (with a
            // warning) instead of writing `undefined` into the child, which
            // would poison its resolution with NaN geometry.
            const nestedOverrides = {};
            if (spec.paramMap) {
                for (const [childKey, ref] of Object.entries(spec.paramMap)) {
                    if (typeof ref === "string") {
                        if (!(ref in params)) {
                            const msg = `paramMap '${childKey}' references missing parent parameter '${ref}' (family ${spec.familyId})`;
                            warnings.push(msg);
                            console.warn("[parametric-engine] " + msg);
                            continue;
                        }
                        nestedOverrides[childKey] = params[ref];
                    }
                    else {
                        if ("ref" in ref && !(ref.ref in params)) {
                            const msg = `paramMap '${childKey}' references missing parent parameter '${ref.ref}' (family ${spec.familyId})`;
                            warnings.push(msg);
                            console.warn("[parametric-engine] " + msg);
                            continue;
                        }
                        nestedOverrides[childKey] = (0, parametric_geometry_1.resolveNumber)(ref, params);
                    }
                }
            }
            const nested = buildParametricFamily(nestedFam, nestedType, {
                ...options,
                overrides: nestedOverrides,
            });
            if (!nested.object)
                return null;
            const wrap = (0, parametric_geometry_1.resolveTransform)(spec.transform, params);
            wrap.add(nested.object);
            // Identity for scheduling: every nested child is findable by
            // family id; a `shared` child additionally carries its own
            // schedule row (family, type, resolved params) on the wrap, so
            // `collectSchedulableInstances` can list it independently of
            // the parent. A non-shared child is part of the parent and
            // produces no row of its own.
            wrap.userData.nestedFamilyId = spec.familyId;
            wrap.userData.nestedTypeId = nestedType?.id ?? null;
            if (spec.shared) {
                wrap.userData.sharedNested = {
                    familyId: spec.familyId,
                    typeId: nestedType?.id ?? null,
                    label: nestedFam.name,
                    params: { ...nested.params },
                };
            }
            return wrap;
        }
        case "array": {
            const count = Math.max(0, Math.floor((0, parametric_geometry_1.resolveNumber)(spec.count, params)));
            if (count === 0)
                return null;
            const dx = (0, parametric_geometry_1.resolveNumber)(spec.step[0], params);
            const dy = (0, parametric_geometry_1.resolveNumber)(spec.step[1], params);
            const dz = (0, parametric_geometry_1.resolveNumber)(spec.step[2], params);
            const rx = spec.rotateStep ? (0, parametric_geometry_1.resolveNumber)(spec.rotateStep[0], params) : 0;
            const ry = spec.rotateStep ? (0, parametric_geometry_1.resolveNumber)(spec.rotateStep[1], params) : 0;
            const rz = spec.rotateStep ? (0, parametric_geometry_1.resolveNumber)(spec.rotateStep[2], params) : 0;
            const group = new THREE.Group();
            for (let i = 0; i < count; i++) {
                const child = buildExtendedGeometry(spec.of, params, options);
                if (!child)
                    continue;
                child.position.set(dx * i, dy * i, dz * i);
                if (rx || ry || rz)
                    child.rotation.set(rx * i, ry * i, rz * i);
                group.add(child);
            }
            return group.children.length ? group : null;
        }
        default:
            return null;
    }
}
/* ---------------------------------------------------------------------------
   Public: build a complete parametric family instance
   --------------------------------------------------------------------------- */
function buildParametricFamily(family, type, options = {}) {
    // Use the caller's warnings array when one is provided, so warnings
    // raised in a nested (recursive) build accumulate into the top-level
    // result instead of being dropped with the nested call's fresh array
    // (that is how the circular-nesting warning was lost before).
    const warnings = options.warnings ?? [];
    const { values, formula, constraints, errors, warnings: resolvedWarnings } = resolveParametricValues(family, type, options);
    // Scope warnings from this level's resolution join the caller's
    // array, so they reach the top-level result (and nested callers).
    warnings.push(...resolvedWarnings);
    let object = null;
    try {
        object = buildExtendedGeometry(family.geometry, values, { ...options, warnings, nestingStack: [...(options.nestingStack ?? []), family.id] });
    }
    catch (err) {
        errors.push(`geometry: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (object) {
        object.userData.familyId = family.id;
        object.userData.familyName = family.name;
        object.userData.familyTypeId = type?.id ?? null;
        object.userData.familyParams = { ...values };
        object.userData.ifcEntity = family.ifcEntity;
        if (options.colour)
            (0, parametric_geometry_1.tintObject)(object, options.colour);
    }
    return {
        object,
        params: values,
        formula,
        constraints,
        errors,
        warnings,
    };
}
/**
 * Re-resolve one instance after a type change, with that instance's
 * overrides applied on top of the (new) type values. Pure: the same
 * inputs always produce the same resolved map. This is the single
 * per-instance re-resolution used by `propagateTypeChange` and by the
 * authoring sync path — overrides are never silently dropped here.
 */
function resolveInstanceAfterTypeChange(family, type, instanceOverrides = {}, options = {}) {
    return resolveParametricValues(family, type, {
        ...options,
        overrides: instanceOverrides,
    });
}
/**
 * Recover the instance overrides an element is carrying, from its stored
 * parameters alone. An override is a stored finite-number value for one
 * of `keys` that differs from what the given type resolves to on its own
 * (or a stored value for a key the type resolution does not produce at
 * all, e.g. placement-level values such as `elevation`, which are
 * per-instance by nature). Values that match the type resolution are
 * inherited, not overrides, and are left out.
 *
 * Pure map diff — it does not touch the scene, the store, or the type.
 * Callers must pass the resolution of the type the element was last
 * synced against; comparing against a *changed* type would misread stale
 * inherited values as overrides.
 */
function extractInstanceOverrides(typeResolvedValues, storedParams, keys) {
    const overrides = {};
    for (const key of keys) {
        const stored = storedParams[key];
        if (typeof stored !== "number" || !Number.isFinite(stored))
            continue;
        const base = typeResolvedValues[key];
        if (base === undefined || stored !== base)
            overrides[key] = stored;
    }
    return overrides;
}
/**
 * Given a type parameter change, recompute every bound instance's effective
 * parameter map. Does not touch the scene - caller applies geometry rebuild.
 */
function propagateTypeChange(family, type, instances, options = {}) {
    const out = new Map();
    for (const inst of instances) {
        if (inst.familyId !== family.id)
            continue;
        if (inst.typeId !== type.id)
            continue;
        const { values } = resolveInstanceAfterTypeChange(family, type, inst.overrides, options);
        out.set(inst.elementId, values);
    }
    return out;
}
/* ---------------------------------------------------------------------------
   Reporting parameters (read-only, derived, shown in schedules)
   --------------------------------------------------------------------------- */
function collectReportingValues(family, values) {
    const report = {};
    for (const p of family.parameters) {
        // Convention: group === "Reporting" or name starts with "Report_"
        if (p.group === "Reporting" || p.name.startsWith("Report_") || !p.editable) {
            if (p.formula || p.group === "Reporting") {
                report[p.name] = values[p.name];
            }
        }
    }
    return report;
}
