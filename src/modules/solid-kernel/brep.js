/**
 * B-Rep topology model (Design spec MODULE 2.7).
 *
 * The kernel keeps THREE representations, with clear authority (spec 5.1):
 *   1. Parametric definition (profile, depth, axis, path) — authoritative.
 *   2. B-Rep / polygon boundary — derived, validated, used for booleans
 *      and quantity takeoff.
 *   3. Display mesh — the render copy; never an authority for dimensions.
 *
 * This file defines the boundary representation and its structural rules:
 *   - A `BRepSolid` is one or more shells; each face carries one outer loop
 *     of ordered vertex ids; edges are derived as ordered vertex pairs.
 *   - Manifold rule (level E, standard boundary-representation invariant):
 *     every undirected edge must appear exactly twice across all loops of
 *     the solid, once in each direction. Violations are reported as
 *     diagnostics by validate.ts, never silently repaired.
 *   - Winding: outward faces are CCW seen from outside; `meshVolume`
 *     (divergence theorem) returns positive volume for outward solids.
 *   - Tolerance: coincident-vertex welding uses `COINCIDENT_TOL` (1e-9 m
 *     at ordinary BIM scales, scale-relative per the unified tolerance
 *     policy — see docs/engineering/TOLERANCE_POLICY.md and
 *     ./tolerance.ts; the old "spec 5.2" citation pointed at a document
 *     that did not exist).
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 */
import { COINCIDENT_TOLERANCE, FACE_NORMAL_TOLERANCE, coincidentTolerance, meshMagnitude, } from "./tolerance";
/**
 * Geometric coincidence tolerance, metres (unified tolerance policy).
 * Re-exported here so existing importers (`hosting`, `snapping`) keep
 * working; new code should import COINCIDENT_TOLERANCE from ./tolerance.
 */
export const COINCIDENT_TOL = COINCIDENT_TOLERANCE;
export function edgeKey(a, b) {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
}
/** Derive the edge table with use counts (O(sum loop lengths)). */
export function buildEdges(solid) {
    solid.edges = new Map();
    for (const f of solid.faces) {
        const L = f.loop.length;
        for (let i = 0; i < L; i++) {
            const a = f.loop[i];
            const b = f.loop[(i + 1) % L];
            const key = edgeKey(a, b);
            const e = solid.edges.get(key);
            if (e)
                e.useCount++;
            else
                solid.edges.set(key, { a, b, key, useCount: 1 });
        }
    }
    return solid.edges;
}
/** Convert an indexed triangle mesh into a B-Rep solid (per-triangle faces). */
export function solidFromMesh(id, mesh) {
    const faces = mesh.faces.map((tri, i) => ({
        id: `${id}:f${i}`,
        loop: [...tri],
        surface: "general",
    }));
    const solid = { id, vertices: mesh.vertices.map((v) => ({ ...v })), faces, edges: new Map() };
    buildEdges(solid);
    return solid;
}
/** Rigid transform: rotate/scale/translate all vertices (spec 5.3). */
export function transformSolid(solid, m) {
    const s = m.scale ?? 1;
    const c = m.rotateZ ? Math.cos(m.rotateZ) : 1;
    const sn = m.rotateZ ? Math.sin(m.rotateZ) : 1;
    const t = m.translate ?? { x: 0, y: 0, z: 0 };
    const vertices = solid.vertices.map((v) => {
        const x = (v.x * c - v.y * sn) * s;
        const y = (v.x * sn + v.y * c) * s;
        return { x: x + t.x, y: y + t.y, z: v.z * s + t.z };
    });
    return { ...solid, vertices, edges: new Map() };
}
function weldVerticesLinear(solid, tol) {
    const map = new Map();
    const accepted = [];
    for (let i = 0; i < solid.vertices.length; i++) {
        const v = solid.vertices[i];
        let found = -1;
        for (let j = 0; j < accepted.length; j++) {
            const a = accepted[j];
            if (Math.abs(a.x - v.x) <= tol && Math.abs(a.y - v.y) <= tol && Math.abs(a.z - v.z) <= tol) {
                found = j;
                break;
            }
        }
        if (found >= 0)
            map.set(i, found);
        else {
            map.set(i, accepted.length);
            accepted.push(v);
        }
    }
    const faces = solid.faces.map((f) => ({ ...f, loop: f.loop.map((i) => map.get(i)) }))
        .filter((f) => new Set(f.loop).size === f.loop.length && f.loop.length >= 3);
    const out = { ...solid, vertices: accepted, faces, edges: new Map() };
    buildEdges(out);
    return out;
}
/**
 * Spatial-hash welding. Exact component-wise tolerance checks and first-match
 * canonical vertex semantics are preserved. Expected O(V + C); pathological
 * dense buckets can still degrade. Unsafe coordinate/tolerance ratios use
 * the conservative linear implementation.
 *
 * Default tolerance is scale-relative (tolerance.coincidentTolerance):
 * the solid's coordinate magnitude sets the weld tolerance, so welding
 * stays above float64 spacing at 1e9-scale coordinates. An explicitly
 * passed `tol` is honoured exactly (callers that pin a tolerance keep it).
 */
export function weldVertices(solid, tol = coincidentTolerance(meshMagnitude(solid))) {
    if (!(tol > 0) || !Number.isFinite(tol))
        return weldVerticesLinear(solid, tol);
    const map = new Map();
    const accepted = [];
    const buckets = new Map();
    const overflow = [];
    const cell = (v) => Math.floor(v / tol);
    const keyOf = (x, y, z) => `${x},${y},${z}`;
    const hashable = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) &&
        [v.x, v.y, v.z].every((n) => Number.isSafeInteger(cell(n)));
    for (let i = 0; i < solid.vertices.length; i++) {
        const v = solid.vertices[i];
        let found = -1;
        if (hashable(v)) {
            const cx = cell(v.x), cy = cell(v.y), cz = cell(v.z);
            let best = Number.POSITIVE_INFINITY;
            for (let dx = -1; dx <= 1; dx++)
                for (let dy = -1; dy <= 1; dy++)
                    for (let dz = -1; dz <= 1; dz++) {
                        const candidates = buckets.get(keyOf(cx + dx, cy + dy, cz + dz));
                        if (!candidates)
                            continue;
                        for (const j of candidates) {
                            if (j >= best)
                                continue;
                            const a = accepted[j];
                            if (Math.abs(a.x - v.x) <= tol && Math.abs(a.y - v.y) <= tol && Math.abs(a.z - v.z) <= tol)
                                best = j;
                        }
                    }
            for (const j of overflow) {
                if (j >= best)
                    continue;
                const a = accepted[j];
                if (Math.abs(a.x - v.x) <= tol && Math.abs(a.y - v.y) <= tol && Math.abs(a.z - v.z) <= tol)
                    best = j;
            }
            if (Number.isFinite(best))
                found = best;
        }
        else {
            for (let j = 0; j < accepted.length; j++) {
                const a = accepted[j];
                if (Math.abs(a.x - v.x) <= tol && Math.abs(a.y - v.y) <= tol && Math.abs(a.z - v.z) <= tol) {
                    found = j;
                    break;
                }
            }
        }
        if (found >= 0) {
            map.set(i, found);
            continue;
        }
        const index = accepted.length;
        map.set(i, index);
        accepted.push(v);
        if (hashable(v)) {
            const key = keyOf(cell(v.x), cell(v.y), cell(v.z));
            const list = buckets.get(key);
            if (list)
                list.push(index);
            else
                buckets.set(key, [index]);
        }
        else
            overflow.push(index);
    }
    const faces = solid.faces.map((f) => ({ ...f, loop: f.loop.map((i) => map.get(i)) }))
        .filter((f) => new Set(f.loop).size === f.loop.length && f.loop.length >= 3);
    const out = { ...solid, vertices: accepted, faces, edges: new Map() };
    buildEdges(out);
    return out;
}
/** Face normal via Newell's method (robust for non-planar-ish loops). */
export function faceNormal(vertices, loop) {
    let nx = 0, ny = 0, nz = 0;
    const L = loop.length;
    for (let i = 0; i < L; i++) {
        const p = vertices[loop[i]];
        const q = vertices[loop[(i + 1) % L]];
        nx += (p.y - q.y) * (p.z + q.z);
        ny += (p.z - q.z) * (p.x + q.x);
        nz += (p.x - q.x) * (p.y + q.y);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < FACE_NORMAL_TOLERANCE)
        return { x: 0, y: 0, z: 0 };
    return { x: nx / len, y: ny / len, z: nz / len };
}
/** Outward-oriented indexed mesh of the solid (triangles, fan per face). */
export function solidToMesh(solid) {
    const vertices = solid.vertices;
    const faces = [];
    for (const f of solid.faces) {
        for (let i = 1; i < f.loop.length - 1; i++) {
            faces.push([f.loop[0], f.loop[i], f.loop[i + 1]]);
        }
    }
    return { vertices, faces };
}
