/**
 * GJK (Gilbert–Johnson–Keerthi) for convex shapes in 3D.
 * - Intersection test
 * - Approximate minimum distance (when separated)
 * - Support mapping from triangle soups (convex hull of vertices)
 *
 * Used as mid-phase clash: AABB → GJK(convex) → optional triangle refine.
 */
const EPS = 1e-8;
const MAX_ITER = 32;
// ── vector ops ──────────────────────────────────────────────────────────────
function v3(x = 0, y = 0, z = 0) {
    return { x, y, z };
}
function copy(a) {
    return { x: a.x, y: a.y, z: a.z };
}
function set(out, x, y, z) {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
}
function add(a, b, out = v3()) {
    return set(out, a.x + b.x, a.y + b.y, a.z + b.z);
}
function sub(a, b, out = v3()) {
    return set(out, a.x - b.x, a.y - b.y, a.z - b.z);
}
function scale(a, s, out = v3()) {
    return set(out, a.x * s, a.y * s, a.z * s);
}
function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a, b, out = v3()) {
    return set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
function lenSq(a) {
    return dot(a, a);
}
function len(a) {
    return Math.sqrt(lenSq(a));
}
function normalize(a, out = v3()) {
    const l = len(a);
    if (l < EPS)
        return set(out, 0, 0, 0);
    return scale(a, 1 / l, out);
}
function neg(a, out = v3()) {
    return scale(a, -1, out);
}
function sameDir(a, b) {
    return dot(a, b) > 0;
}
/** Convex hull of a vertex set (e.g. triangle soup vertices). */
export class PointCloudConvex {
    points;
    constructor(points) {
        this.points = points.length ? points : [v3()];
    }
    static fromTriangles(tris) {
        const pts = [];
        const seen = new Set();
        const key = (x, y, z) => `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
        for (const t of tris) {
            for (let i = 0; i < 3; i++) {
                const x = t[i * 3], y = t[i * 3 + 1], z = t[i * 3 + 2];
                const k = key(x, y, z);
                if (seen.has(k))
                    continue;
                seen.add(k);
                pts.push(v3(x, y, z));
            }
        }
        return new PointCloudConvex(pts);
    }
    static fromBox(box) {
        const min = box.min, max = box.max;
        return new PointCloudConvex([
            v3(min.x, min.y, min.z),
            v3(max.x, min.y, min.z),
            v3(min.x, max.y, min.z),
            v3(max.x, max.y, min.z),
            v3(min.x, min.y, max.z),
            v3(max.x, min.y, max.z),
            v3(min.x, max.y, max.z),
            v3(max.x, max.y, max.z),
        ]);
    }
    support(d) {
        let best = this.points[0];
        let bestDot = -Infinity;
        for (const p of this.points) {
            const dd = dot(p, d);
            if (dd > bestDot) {
                bestDot = dd;
                best = p;
            }
        }
        return copy(best);
    }
}
/** Minkowski difference support: S_A(d) - S_B(-d). */
function supportDiff(a, b, d) {
    const pa = a.support(d);
    const pb = b.support(neg(d));
    return sub(pa, pb);
}
/**
 * Evolve simplex toward origin. Returns true if origin is inside simplex (intersection).
 * Updates `dir` to the next search direction.
 */
function doSimplex(simplex, dir) {
    const n = simplex.length;
    if (n === 2) {
        // Line: A = last, B = previous
        const A = simplex[1];
        const B = simplex[0];
        const AB = sub(B, A);
        const AO = neg(A);
        if (sameDir(AB, AO)) {
            cross(cross(AB, AO), AB, dir);
        }
        else {
            simplex.splice(0, 1); // keep A
            set(dir, AO.x, AO.y, AO.z);
        }
        if (lenSq(dir) < EPS)
            return true;
        return false;
    }
    if (n === 3) {
        // Triangle
        const A = simplex[2];
        const B = simplex[1];
        const C = simplex[0];
        const AB = sub(B, A);
        const AC = sub(C, A);
        const AO = neg(A);
        const ABC = cross(AB, AC);
        const abPerp = cross(ABC, AB);
        if (sameDir(abPerp, AO)) {
            // AB edge region
            if (sameDir(AB, AO)) {
                simplex.splice(0, 1); // remove C → [B,A] wait indices: C=0,B=1,A=2 → keep B,A
                simplex.splice(0, 1); // remove C, left [B,A]
                cross(cross(AB, AO), AB, dir);
            }
            else {
                simplex.splice(0, 2); // keep A
                set(dir, AO.x, AO.y, AO.z);
            }
            return false;
        }
        const acPerp = cross(AC, ABC);
        if (sameDir(acPerp, AO)) {
            if (sameDir(AC, AO)) {
                // keep C, A → remove B
                simplex.splice(1, 1);
                cross(cross(AC, AO), AC, dir);
            }
            else {
                simplex.splice(0, 2);
                set(dir, AO.x, AO.y, AO.z);
            }
            return false;
        }
        // Above or below triangle
        if (sameDir(ABC, AO)) {
            set(dir, ABC.x, ABC.y, ABC.z);
        }
        else {
            // flip winding: swap B and C
            const tmp = simplex[0];
            simplex[0] = simplex[1];
            simplex[1] = tmp;
            set(dir, -ABC.x, -ABC.y, -ABC.z);
        }
        return false;
    }
    if (n === 4) {
        // Tetrahedron: D=0, C=1, B=2, A=3 (A newest)
        const A = simplex[3];
        const B = simplex[2];
        const C = simplex[1];
        const D = simplex[0];
        const AO = neg(A);
        const AB = sub(B, A);
        const AC = sub(C, A);
        const AD = sub(D, A);
        const ABC = cross(AB, AC);
        const ACD = cross(AC, AD);
        const ADB = cross(AD, AB);
        if (sameDir(ABC, AO)) {
            simplex.splice(0, 1); // remove D → [C,B,A]
            set(dir, ABC.x, ABC.y, ABC.z);
            return false;
        }
        if (sameDir(ACD, AO)) {
            // keep D,C,A → remove B: [D,C,A]
            simplex.splice(2, 1);
            set(dir, ACD.x, ACD.y, ACD.z);
            return false;
        }
        if (sameDir(ADB, AO)) {
            // keep D,B,A → remove C
            simplex.splice(1, 1);
            set(dir, ADB.x, ADB.y, ADB.z);
            return false;
        }
        // Origin inside tetrahedron
        return true;
    }
    return false;
}
/**
 * GJK intersection + distance between two convex shapes.
 */
export function gjk(a, b) {
    // Initial direction: difference of centers approximated by support along X then arbitrary
    let dir = v3(1, 0, 0);
    const simplex = [];
    // First support
    let p = supportDiff(a, b, dir);
    simplex.push(p);
    if (lenSq(p) < EPS) {
        return { intersect: true, iterations: 1, distance: 0, closest: v3() };
    }
    dir = neg(p);
    let iterations = 1;
    for (; iterations < MAX_ITER; iterations++) {
        p = supportDiff(a, b, dir);
        if (dot(p, dir) < 0) {
            // No intersection — compute approx distance from simplex to origin
            const closest = closestPointOnSimplex(simplex);
            return {
                intersect: false,
                iterations,
                distance: len(closest),
                closest,
            };
        }
        simplex.push(p);
        if (doSimplex(simplex, dir)) {
            return { intersect: true, iterations, distance: 0, closest: v3() };
        }
        if (lenSq(dir) < EPS) {
            return { intersect: true, iterations, distance: 0, closest: v3() };
        }
    }
    const closest = closestPointOnSimplex(simplex);
    return {
        intersect: len(closest) < 1e-5,
        iterations,
        distance: len(closest),
        closest,
    };
}
/** Closest point on current simplex to origin (for separation distance). */
function closestPointOnSimplex(simplex) {
    if (simplex.length === 0)
        return v3();
    if (simplex.length === 1)
        return copy(simplex[0]);
    if (simplex.length === 2) {
        const A = simplex[0], B = simplex[1];
        const AB = sub(B, A);
        const t = Math.max(0, Math.min(1, -dot(A, AB) / (lenSq(AB) + EPS)));
        return add(A, scale(AB, t));
    }
    // Triangle or tetra: project origin onto triangle of last 3 points
    const A = simplex[simplex.length - 1];
    const B = simplex[simplex.length - 2];
    const C = simplex[simplex.length - 3];
    return closestPointOnTriangle(v3(), A, B, C);
}
function closestPointOnTriangle(p, a, b, c) {
    // Ericson — Real-Time Collision Detection
    const ab = sub(b, a);
    const ac = sub(c, a);
    const ap = sub(p, a);
    const d1 = dot(ab, ap);
    const d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0)
        return copy(a);
    const bp = sub(p, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3)
        return copy(b);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3 + EPS);
        return add(a, scale(ab, v));
    }
    const cp = sub(p, c);
    const d5 = dot(ab, cp);
    const d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6)
        return copy(c);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6 + EPS);
        return add(a, scale(ac, w));
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const w = (d4 - d3) / (d4 - d3 + d5 - d6 + EPS);
        return add(b, scale(sub(c, b), w));
    }
    const denom = 1 / (va + vb + vc + EPS);
    const v = vb * denom;
    const w = vc * denom;
    return add(a, add(scale(ab, v), scale(ac, w)));
}
/**
 * Convenience: GJK between two triangle soups treated as convex hulls.
 */
export function gjkTriangles(trisA, trisB) {
    const a = PointCloudConvex.fromTriangles(trisA);
    const b = PointCloudConvex.fromTriangles(trisB);
    return gjk(a, b);
}
/**
 * GJK between two AABB boxes (convex).
 */
export function gjkBoxes(boxA, boxB) {
    return gjk(PointCloudConvex.fromBox(boxA), PointCloudConvex.fromBox(boxB));
}
