const TWO_PI = Math.PI * 2;
/** FNV-1a over the coordinates rounded to 1e-7, plus the point count. */
export function pointsSignature(points) {
    let h = 0x811c9dc5;
    const mix = (v) => {
        const s = (Math.round(v * 1e7) / 1e7).toString();
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        h ^= 0x2c;
        h = Math.imul(h, 0x01000193) >>> 0;
    };
    for (const p of points) {
        mix(p.x);
        mix(p.y);
    }
    return `${points.length}:${h.toString(16)}`;
}
/** Stores the native definition on a polyline entity and signs the current tessellation. */
export function attachNative(ent, native) {
    ent.native = native;
    ent.nativeSig = pointsSignature(ent.points);
    return ent;
}
/** The native definition, or null when absent or stale (points were edited without carrying it). */
export function nativeIfValid(ent) {
    if (!ent.native || !ent.nativeSig)
        return null;
    return ent.nativeSig === pointsSignature(ent.points) ? ent.native : null;
}
const normAngle = (a) => { const r = a % TWO_PI; return r < 0 ? r + TWO_PI : r; };
/** Applies an affine map to a native definition (exact for similarity transforms). */
export function transformNative(n, ops) {
    const P = (p) => { const q = ops.pt(p); return { x: q.x, y: q.y, z: p.z ?? 0 }; };
    if (n.kind === "SPLINE") {
        return {
            ...n,
            controlPoints: n.controlPoints.map(P),
            fitPoints: n.fitPoints?.map(P),
            knots: [...n.knots],
            weights: n.weights ? [...n.weights] : undefined,
        };
    }
    const v = ops.vec(n.majorAxis);
    let t0 = n.startParam, t1 = n.endParam;
    if (ops.reflect) {
        const full = Math.abs(t1 - t0 - TWO_PI) < 1e-9 || Math.abs(t1 - t0) < 1e-12;
        if (!full) {
            const a = -t1, b = -t0;
            t0 = normAngle(a);
            t1 = normAngle(b);
            if (t1 <= t0)
                t1 += TWO_PI;
        }
    }
    return { ...n, center: P(n.center), majorAxis: { x: v.x, y: v.y, z: n.majorAxis.z ?? 0 }, startParam: t0, endParam: t1 };
}
/**
 * Re-binds native data after a transform: when `src` had valid native data it is transformed and
 * signed against `out.points`; otherwise any stale data is dropped from `out`.
 */
export function carryNative(src, out, ops) {
    const n = nativeIfValid(src);
    if (!n) {
        delete out.native;
        delete out.nativeSig;
        return out;
    }
    out.native = transformNative(n, ops);
    out.nativeSig = pointsSignature(out.points);
    return out;
}
/** DXF group-code text for a SPLINE body (after the common entity head). */
export function splineDxfBody(n, pair) {
    const rational = !!n.weights && n.weights.length === n.controlPoints.length;
    let flags = 8; // planar
    if (n.closed)
        flags |= 1;
    if (rational)
        flags |= 4;
    let s = pair(100, "AcDbSpline");
    s += pair(210, 0) + pair(220, 0) + pair(230, 1);
    s += pair(70, flags) + pair(71, n.degree);
    s += pair(72, n.knots.length) + pair(73, n.controlPoints.length) + pair(74, n.fitPoints?.length ?? 0);
    s += pair(42, 1e-7) + pair(43, 1e-7) + pair(44, 1e-10);
    for (const k of n.knots)
        s += pair(40, k);
    if (rational)
        for (const w of n.weights)
            s += pair(41, w);
    for (const p of n.controlPoints)
        s += pair(10, p.x) + pair(20, p.y) + pair(30, p.z ?? 0);
    for (const p of n.fitPoints ?? [])
        s += pair(11, p.x) + pair(21, p.y) + pair(31, p.z ?? 0);
    return s;
}
/** DXF group-code text for an ELLIPSE body (after the common entity head). */
export function ellipseDxfBody(n, pair) {
    let s = pair(100, "AcDbEllipse");
    s += pair(10, n.center.x) + pair(20, n.center.y) + pair(30, n.center.z ?? 0);
    s += pair(11, n.majorAxis.x) + pair(21, n.majorAxis.y) + pair(31, n.majorAxis.z ?? 0);
    s += pair(210, 0) + pair(220, 0) + pair(230, 1);
    s += pair(40, n.ratio) + pair(41, n.startParam) + pair(42, n.endParam);
    return s;
}
