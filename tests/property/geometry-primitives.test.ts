import fc from 'fast-check';
import { cloneElement, mirrorTransform } from '../../src/modules/modify/duplicate';
import { offsetPolyline, trimExtendSegment } from '../../src/modules/modify/edit';
import { selfIntersectsOpen } from '../../src/modules/solid-kernel/forms';
import { AlignCommand, MoveCommand, RotateCommand } from '../../src/modules/modify/transform';
import type { ElementStore, ModifyElement } from '../../src/modules/modify/command';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Geometry-primitive coverage (#98): the pure primitives in
// src/modules/modify/transform.ts and its neighbours beyond
// `rotateAboutAxis` (covered in transform-invariant.test.ts). transform.ts
// exports exactly one pure function — rotateAboutAxis — the rest of its
// surface is the Move/Rotate/Align command classes, covered here through
// a minimal in-memory ElementStore. The neighbouring pure primitives
// are `mirrorTransform` / `cloneElement` (duplicate.ts) and
// `offsetPolyline` / `trimExtendSegment` (edit.ts). There is no scale
// primitive to cover: the modify registry lists a "scale" id, but no
// ScaleCommand or pure scale function exists in src/modules/modify/ —
// the scale gizmo is the only implementation, and it is not a pure
// primitive. Every invariant below asserts a real geometric property
// (isometry, involution, area, distance-to-edge, parameter value), not
// a tautology.

type V2 = [number, number];

const coord = fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true });
const point2 = fc.tuple(coord, coord) as fc.Arbitrary<V2>;
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true, noDefaultInfinity: true });
const lineDir = fc.tuple(coord, coord).filter(([x, y]) => Math.hypot(x, y) > 1e-3) as fc.Arbitrary<V2>;

function near2(a: V2, b: V2, tol = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
}

function nearNum(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

function dist(a: V2, b: V2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function cross(a: V2, b: V2): number {
  return a[0] * b[1] - a[1] * b[0];
}

function sub(a: V2, b: V2): V2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function unit(a: V2): V2 {
  const l = Math.hypot(a[0], a[1]);
  return [a[0] / l, a[1] / l];
}

/** Distance from a point to the infinite line through a→b. */
function distToLine(p: V2, a: V2, b: V2): number {
  return Math.abs(cross(sub(b, a), sub(p, a))) / dist(a, b);
}

function shoelaceArea(ring: Array<V2>): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

// ── mirrorTransform (duplicate.ts) ───────────────────────────────────────

// (M1) Involution: mirroring twice about the same line is the identity.
fc.assert(
  fc.property(point2, point2, lineDir, (p, lp, ld) => {
    const once = mirrorTransform(p, lp, ld);
    return near2(mirrorTransform(once, lp, ld), p);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (M2) Points on the mirror line are fixed.
fc.assert(
  fc.property(point2, lineDir, fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }), (lp, ld, t) => {
    const u = unit(ld);
    const onLine: V2 = [lp[0] + u[0] * t, lp[1] + u[1] * t];
    return near2(mirrorTransform(onLine, lp, ld), onLine);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (M3) Mirror is an isometry: it preserves the distance between any
// two points.
fc.assert(
  fc.property(point2, point2, point2, lineDir, (p, q, lp, ld) => {
    const mp = mirrorTransform(p, lp, ld);
    const mq = mirrorTransform(q, lp, ld);
    return nearNum(dist(mp, mq), dist(p, q));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (M4) The signed distance to the mirror line flips sign (same
// magnitude, opposite side).
fc.assert(
  fc.property(point2, point2, lineDir, (p, lp, ld) => {
    const u = unit(ld);
    const sd = (x: V2): number => cross(u, sub(x, lp));
    return nearNum(sd(mirrorTransform(p, lp, ld)), -sd(p));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (M5) Mirror reverses orientation: the signed area of a triangle flips
// sign while its magnitude is preserved.
fc.assert(
  fc.property(point2, point2, point2, point2, lineDir, (a, b, c, lp, ld) => {
    const area = cross(sub(b, a), sub(c, a));
    fc.pre(Math.abs(area) > 0.1);
    const ma = mirrorTransform(a, lp, ld);
    const mb = mirrorTransform(b, lp, ld);
    const mc = mirrorTransform(c, lp, ld);
    return nearNum(cross(sub(mb, ma), sub(mc, ma)), -area);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// ── offsetPolyline (edit.ts) ─────────────────────────────────────────────

// Open polylines with distinct consecutive points and no near-parallel
// consecutive segments (the corner construction is a line intersection;
// near-parallel neighbours would make the corner numerically unstable).
const openPolyline = fc.array(point2, { minLength: 3, maxLength: 6 }).filter((pts) => {
  for (let i = 0; i + 1 < pts.length; i++) {
    if (dist(pts[i], pts[i + 1]) < 1) return false;
  }
  for (let i = 0; i + 2 < pts.length; i++) {
    const d1 = unit(sub(pts[i + 1], pts[i]));
    const d2 = unit(sub(pts[i + 2], pts[i + 1]));
    if (Math.abs(cross(d1, d2)) < 0.05) return false;
  }
  return true;
}) as fc.Arbitrary<Array<V2>>;

const offsetDistance = fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true });

// Simple closed rings: points on a circle at increasing angles, so the
// ring is convex (never self-intersecting) and no two consecutive
// chords are near-parallel. A random point array is NOT a valid closed
// ring in general — its closing edge can cross the other edges.
const simpleRing = fc
  .tuple(
    point2,
    fc.double({ min: 5, max: 50, noNaN: true, noDefaultInfinity: true }),
    fc.array(fc.double({ min: 0.05, max: Math.PI * 2 - 0.05, noNaN: true, noDefaultInfinity: true }), { minLength: 3, maxLength: 8 }),
  )
  .filter(([, , gaps]) => gaps.every((g) => g > 0.3))
  .map(([c, r, gaps]): Array<V2> => {
    const total = gaps.reduce((a, b) => a + b, 0);
    let acc = 0;
    return gaps.map((g) => {
      acc += g;
      const t = (acc / total) * Math.PI * 2;
      return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as V2;
    });
  }) as fc.Arbitrary<Array<V2>>;


// (O1) Zero distance is the identity for an open polyline: the offset
// polyline and corners are the original vertices, and the
// self-intersection flag mirrors the input's own open-profile status.
// It must NOT inherit the closed-ring test's false positive from the
// imaginary closing segment (see the fix in edit.ts and the zigzag
// case in tests/validator-holes.test.cjs). Note an open polyline may
// itself (nearly) cross, so the assertion is equality with the input's
// status, not an unconditional "clean".
fc.assert(
  fc.property(openPolyline, (pts) => {
    const open = offsetPolyline(pts, 0, false);
    if (open.polyline.length !== pts.length) return false;
    if (!open.polyline.every((p, i) => near2(p, pts[i]))) return false;
    if (!open.corners.every((p, i) => near2(p, pts[i + 1]))) return false;
    const profile = pts.map(([x, y]) => ({ u: x, v: y }));
    return open.selfIntersects === selfIntersectsOpen(profile);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O1c) The zigzag regression (deterministic): this open polyline is
// simple, but the closed-ring test false-positives on it — its
// imaginary closing segment (2,2)->(0,0) properly crosses the middle
// segment (2,1)->(0,2). Offsetting it must report clean, at zero and
// at small nonzero distances.
fc.assert(
  fc.property(fc.constant(0), () => {
    const zigzag: Array<V2> = [[0, 0], [2, 1], [0, 2], [2, 2]];
    if (offsetPolyline(zigzag, 0, false).selfIntersects) return false;
    if (offsetPolyline(zigzag, 0.25, false).selfIntersects) return false;
    return !offsetPolyline(zigzag, -0.25, false).selfIntersects;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O1b) Zero distance is the identity for a simple closed ring, with
// no self-intersection and corners at the original vertices.
fc.assert(
  fc.property(simpleRing, (pts) => {
    const closed = offsetPolyline(pts, 0, true);
    if (closed.polyline.length !== pts.length || closed.selfIntersects) return false;
    if (!closed.polyline.every((p, i) => near2(p, pts[i]))) return false;
    return closed.corners.every((p, i) => near2(p, pts[i]));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O2) Round trip: offsetting by d and then by −d recovers the original
// open polyline — provided the offset preserves every segment's
// direction. The pairwise-corner construction can fold a segment back
// when |d| is large against a short segment next to a sharp turn: the
// corner overshoots the segment end, so the offset segment runs in the
// opposite direction to the original (e.g. pts [[0,5.006],[-1,0],
// [0,0]] at d = -1: the offset of the last segment runs right-to-left
// while the original runs left-to-right), and the offset is no longer
// invertible — the back-offset then computes its corner from a reversed
// segment. The offset vertices are still at distance |d| from the
// original edges in that case (O5 holds), so this is a limitation of
// invertibility, not of the offset itself. The precondition requires a
// positive forward component on every segment (with a 1e-6 relative
// margin, which also excludes the measure-zero collapse where the
// corner lands exactly on the offset endpoint and the segment has no
// direction at all).
fc.assert(
  fc.property(openPolyline, offsetDistance, (pts, d) => {
    const out = offsetPolyline(pts, d, false);
    for (let i = 0; i + 1 < out.polyline.length; i++) {
      const origSeg = sub(pts[i + 1], pts[i]);
      const outSeg = sub(out.polyline[i + 1], out.polyline[i]);
      const origLenSq = origSeg[0] * origSeg[0] + origSeg[1] * origSeg[1];
      fc.pre(outSeg[0] * origSeg[0] + outSeg[1] * origSeg[1] > 1e-6 * origLenSq);
    }
    const back = offsetPolyline(out.polyline, -d, false);
    if (back.polyline.length !== pts.length) return false;
    return back.polyline.every((p, i) => near2(p, pts[i], 1e-7));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O3) Closed CCW rectangle: outward offset grows the area to
// (w+2d)(h+2d), inward offset shrinks it to (w−2d)(h−2d), the vertex
// count is preserved, and neither offset self-intersects.
fc.assert(
  fc.property(
    fc.double({ min: 2, max: 10, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 2, max: 10, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
    (w, h, d) => {
      const rect: Array<V2> = [[0, 0], [w, 0], [w, h], [0, h]];
      const out = offsetPolyline(rect, d, true);
      if (out.polyline.length !== 4 || out.selfIntersects) return false;
      if (!nearNum(shoelaceArea(out.polyline), (w + 2 * d) * (h + 2 * d), 1e-7)) return false;
      const inner = offsetPolyline(rect, -d, true);
      if (inner.polyline.length !== 4 || inner.selfIntersects) return false;
      return nearNum(shoelaceArea(inner.polyline), (w - 2 * d) * (h - 2 * d), 1e-7);
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O4) Deep inward offset of a convex ring collapses it: offsetting a
// w×h rectangle inward past its inradius (A/s = wh/(w+h)) reports a
// self-intersecting profile instead of emitting a spurious smaller ring.
fc.assert(
  fc.property(
    fc.double({ min: 1, max: 10, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 1, max: 10, noNaN: true, noDefaultInfinity: true }),
    (w, h) => {
      const rect: Array<V2> = [[0, 0], [w, 0], [w, h], [0, h]];
      const inradius = (w * h) / (w + h);
      return offsetPolyline(rect, -(inradius + 0.5), true).selfIntersects;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (O5) Every offset vertex sits exactly |d| from the line of each
// adjacent original edge — the defining property of an offset curve.
function checkVertexDistances(pts: Array<V2>, out: Array<V2>, d: number, closed: boolean): boolean {
  const n = pts.length;
  for (let i = 0; i < out.length; i++) {
    const edges = closed ? [(i - 1 + n) % n, i] : i === 0 ? [0] : i === n - 1 ? [n - 2] : [i - 1, i];
    for (const e of edges) {
      if (!nearNum(distToLine(out[i], pts[e], pts[(e + 1) % n]), Math.abs(d), 1e-7)) return false;
    }
  }
  return true;
}

fc.assert(
  fc.property(openPolyline, offsetDistance, (pts, d) => {
    fc.pre(Math.abs(d) > 0.1);
    const out = offsetPolyline(pts, d, false);
    if (out.polyline.length !== pts.length) return false;
    return checkVertexDistances(pts, out.polyline, d, false);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

fc.assert(
  fc.property(simpleRing, offsetDistance, (pts, d) => {
    fc.pre(Math.abs(d) > 0.1);
    const out = offsetPolyline(pts, d, true);
    if (out.polyline.length !== pts.length) return false;
    return checkVertexDistances(pts, out.polyline, d, true);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// ── trimExtendSegment (edit.ts) ──────────────────────────────────────────

const segment = fc.record({ a: point2, b: point2 }).filter(({ a, b }) => dist(a, b) > 1);
// Boundary direction as an angle, kept non-parallel to the segment
// (|sin| between the boundary direction and the segment direction > 0.2).
function dirFromAngle(t: number): V2 {
  return [Math.cos(t), Math.sin(t)];
}

function dirIsNonParallel(a: V2, b: V2, dirAngle: number): boolean {
  return Math.abs(cross(dirFromAngle(dirAngle), unit(sub(b, a)))) > 0.2;
}

const trimCase = fc
  .record({
    a: point2,
    b: point2,
    t0: fc.double({ min: 0.1, max: 0.9, noNaN: true, noDefaultInfinity: true }),
    dirAngle: fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
  })
  .filter(({ a, b, dirAngle }) => dist(a, b) > 1 && dirIsNonParallel(a, b, dirAngle));

const extendCase = fc
  .record({
    a: point2,
    b: point2,
    k: fc.double({ min: 0.5, max: 5, noNaN: true, noDefaultInfinity: true }),
    dirAngle: fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
  })
  .filter(({ a, b, dirAngle }) => dist(a, b) > 1 && dirIsNonParallel(a, b, dirAngle));

function lerp(a: V2, b: V2, t: number): V2 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// (T1) Trim, keep the start side: the end moves to the boundary
// crossing at parameter t0, the start is untouched, the result is
// shorter and not extended.
fc.assert(
  fc.property(trimCase, ({ a, b, t0, dirAngle }) => {
    const bd = dirFromAngle(dirAngle);
    const c = lerp(a, b, t0);
    const pick = lerp(a, c, 0.5);
    const r = trimExtendSegment(a, b, { point: c, dir: bd }, pick, 'trim');
    if (r === null) return false;
    if (r.extended) return false;
    if (!nearNum(r.parameter, t0)) return false;
    if (!near2(r.start, a) || !near2(r.end, c)) return false;
    return nearNum(dist(r.start, r.end), t0 * dist(a, b));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (T2) Trim, keep the end side: the start moves to the boundary
// crossing, the end is untouched.
fc.assert(
  fc.property(trimCase, ({ a, b, t0, dirAngle }) => {
    const bd = dirFromAngle(dirAngle);
    const c = lerp(a, b, t0);
    const pick = lerp(c, b, 0.5);
    const r = trimExtendSegment(a, b, { point: c, dir: bd }, pick, 'trim');
    if (r === null) return false;
    if (r.extended) return false;
    if (!nearNum(r.parameter, t0)) return false;
    if (!near2(r.start, c) || !near2(r.end, b)) return false;
    return nearNum(dist(r.start, r.end), (1 - t0) * dist(a, b));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (T3) Extend beyond the end: the new end is the boundary point on the
// segment line, the start is untouched, the parameter is > 1.
fc.assert(
  fc.property(extendCase, ({ a, b, k, dirAngle }) => {
    const bd = dirFromAngle(dirAngle);
    const u = unit(sub(b, a));
    const len = dist(a, b);
    const bp: V2 = [b[0] + u[0] * k, b[1] + u[1] * k];
    const r = trimExtendSegment(a, b, { point: bp, dir: bd }, a, 'extend');
    if (r === null) return false;
    if (!r.extended) return false;
    if (!nearNum(r.parameter, 1 + k / len)) return false;
    if (!near2(r.start, a) || !near2(r.end, bp)) return false;
    return nearNum(dist(r.start, r.end), len + k);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (T4) Extend beyond the start: symmetric to (T3), the parameter is < 0.
fc.assert(
  fc.property(extendCase, ({ a, b, k, dirAngle }) => {
    const bd = dirFromAngle(dirAngle);
    const u = unit(sub(b, a));
    const len = dist(a, b);
    const bp: V2 = [a[0] - u[0] * k, a[1] - u[1] * k];
    const r = trimExtendSegment(a, b, { point: bp, dir: bd }, b, 'extend');
    if (r === null) return false;
    if (!r.extended) return false;
    if (!nearNum(r.parameter, -k / len)) return false;
    if (!near2(r.start, bp) || !near2(r.end, b)) return false;
    return nearNum(dist(r.start, r.end), len + k);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (T5) A boundary parallel to the segment never intersects it: trim
// and extend both return null.
fc.assert(
  fc.property(segment, fc.constantFrom('trim', 'extend' as const), ({ a, b }, mode) => {
    const dir = unit(sub(b, a));
    const c = lerp(a, b, 0.5);
    return trimExtendSegment(a, b, { point: c, dir }, a, mode) === null;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// ── cloneElement (duplicate.ts) ──────────────────────────────────────────

// (K1) A clone gets the fresh id, copies position/rotation/curve/params
// by value, is never pinned, and is a deep copy: mutating the clone
// leaves the source untouched.
fc.assert(
  fc.property(
    fc.record({
      position: point2,
      rotationZ: angle,
      pinned: fc.boolean(),
      curve: fc.option(fc.record({ start: point2, end: point2 }), { nil: undefined }),
      params: fc.option(
        fc.record({
          width: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
          height: fc.double({ min: 0.1, max: 10, noNaN: true, noDefaultInfinity: true }),
        }),
        { nil: undefined },
      ),
    }),
    (spec) => {
      const src: ModifyElement = {
        id: 'src',
        categoryId: 'wall',
        pinned: spec.pinned,
        editable: true,
        position: spec.position,
        rotationZ: spec.rotationZ,
        curve: spec.curve,
        params: spec.params,
      };
      const srcPosition: V2 = [...spec.position];
      const srcCurve = spec.curve
        ? { start: [...spec.curve.start] as V2, end: [...spec.curve.end] as V2 }
        : undefined;
      const srcParams = spec.params ? { ...spec.params } : undefined;
      const clone = cloneElement(src, 'copy-1');
      if (clone.id !== 'copy-1') return false;
      if (!near2(clone.position, spec.position)) return false;
      if (!nearNum(clone.rotationZ, spec.rotationZ)) return false;
      if (clone.pinned) return false;
      if (spec.curve) {
        if (!clone.curve || !near2(clone.curve.start, spec.curve.start) || !near2(clone.curve.end, spec.curve.end)) return false;
      } else if (clone.curve !== undefined) return false;
      if (spec.params) {
        if (!clone.params || clone.params.width !== spec.params.width || clone.params.height !== spec.params.height) return false;
      } else if (clone.params !== undefined) return false;
      // Deep copy: mutate the clone, the source must not move.
      clone.position[0] += 1;
      if (clone.curve) clone.curve.start[0] += 1;
      if (clone.params) clone.params.width += 1;
      if (!near2(src.position, srcPosition)) return false;
      if (srcCurve && clone.curve && !near2(src.curve!.start, srcCurve.start)) return false;
      if (srcParams && clone.params && src.params.width !== srcParams.width) return false;
      return true;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// ── Move / Rotate / Align commands (transform.ts) ────────────────────────

// Minimal in-memory ElementStore: the commands' required collaborator.
// The store is test scaffolding, not the code under test — the command
// math (translation, rotation about a pivot, alignment) is what's
// being pinned.
function makeStore(els: ModifyElement[]): { store: ElementStore; map: Map<string, ModifyElement> } {
  const map = new Map<string, ModifyElement>();
  for (const el of els) {
    map.set(el.id, {
      ...el,
      position: [...el.position] as V2,
      curve: el.curve ? { start: [...el.curve.start] as V2, end: [...el.curve.end] as V2 } : undefined,
      params: el.params ? { ...el.params } : undefined,
    });
  }
  const store: ElementStore = {
    get: (id) => map.get(id),
    apply: (id, patch) => {
      const el = map.get(id);
      if (!el) return false;
      if (patch.position) el.position = [...patch.position] as V2;
      if (patch.rotationZ !== undefined) el.rotationZ = patch.rotationZ;
      if (patch.curve) el.curve = { start: [...patch.curve.start] as V2, end: [...patch.curve.end] as V2 };
      if (patch.params) el.params = { ...patch.params };
      return true;
    },
    insert: (el) => {
      map.set(el.id, el);
    },
    all: () => [...map.values()],
  };
  return { store, map };
}

function makeElements(p1: V2, p2: V2, r1: number, r2: number): ModifyElement[] {
  return [
    { id: 'e1', categoryId: 'wall', pinned: false, editable: true, position: p1, rotationZ: r1 },
    { id: 'e2', categoryId: 'wall', pinned: false, editable: true, position: p2, rotationZ: r2 },
  ];
}

const twoElements = fc
  .record({ p1: point2, p2: point2, r1: angle, r2: angle })
  .filter(({ p1, p2 }) => dist(p1, p2) > 1);

// (Cmd1) Move by translation: the preview patches are the old positions
// plus (to − from), the store is untouched until Commit, and the commit
// moves both elements by exactly that translation (pairwise distance
// preserved).
fc.assert(
  fc.property(twoElements, point2, point2, ({ p1, p2, r1, r2 }, from, to) => {
    const { store, map } = makeStore(makeElements(p1, p2, r1, r2));
    const shift: V2 = [to[0] - from[0], to[1] - from[1]];
    const cmd = new MoveCommand({ store });
    cmd.Begin(['e1', 'e2']);
    const preview = cmd.UpdatePreview({ type: 'translation', from, to });
    if (preview.length !== 2) return false;
    if (!near2(cmd.currentTranslation, shift)) return false;
    for (const change of preview) {
      const before = change.elementId === 'e1' ? p1 : p2;
      if (!change.patch.position || !near2(change.patch.position, [before[0] + shift[0], before[1] + shift[1]])) return false;
    }
    // Discipline (spec 2C.11): preview never mutates the model.
    if (!near2(map.get('e1')!.position, p1) || !near2(map.get('e2')!.position, p2)) return false;
    const result = cmd.Commit();
    if (!result.ok || result.applied !== 2) return false;
    if (!near2(map.get('e1')!.position, [p1[0] + shift[0], p1[1] + shift[1]])) return false;
    if (!near2(map.get('e2')!.position, [p2[0] + shift[0], p2[1] + shift[1]])) return false;
    return nearNum(dist(map.get('e1')!.position, map.get('e2')!.position), dist(p1, p2));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (Cmd2) Move by numeric offset: same translation, given as (dx, dy).
fc.assert(
  fc.property(
    twoElements,
    fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
    ({ p1, p2, r1, r2 }, dx, dy) => {
      const { store, map } = makeStore(makeElements(p1, p2, r1, r2));
      const cmd = new MoveCommand({ store });
      cmd.Begin(['e1', 'e2']);
      cmd.UpdatePreview({ type: 'numeric-offset', dx, dy });
      const result = cmd.Commit();
      if (!result.ok || result.applied !== 2) return false;
      if (!near2(map.get('e1')!.position, [p1[0] + dx, p1[1] + dy])) return false;
      return near2(map.get('e2')!.position, [p2[0] + dx, p2[1] + dy]);
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (Cmd3) Rotate about a pivot: every element keeps its distance to the
// pivot, its rotation accumulates the angle, and its new position is
// the pivot plus the rotated offset.
fc.assert(
  fc.property(twoElements, point2, angle, ({ p1, p2, r1, r2 }, pivot, theta) => {
    const { store, map } = makeStore(makeElements(p1, p2, r1, r2));
    const cmd = new RotateCommand({ store });
    cmd.Begin(['e1', 'e2']);
    cmd.UpdatePreview({ type: 'rotation', pivot, angle: theta });
    if (!near2(map.get('e1')!.position, p1) || !near2(map.get('e2')!.position, p2)) return false;
    const result = cmd.Commit();
    if (!result.ok || result.applied !== 2) return false;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (const [id, before, rotBefore] of [['e1', p1, r1], ['e2', p2, r2]] as const) {
      const after = map.get(id)!;
      if (!nearNum(dist(after.position, pivot), dist(before, pivot))) return false;
      if (!nearNum(after.rotationZ, rotBefore + theta)) return false;
      const dx = before[0] - pivot[0];
      const dy = before[1] - pivot[1];
      const expected: V2 = [pivot[0] + dx * c - dy * s, pivot[1] + dx * s + dy * c];
      if (!near2(after.position, expected)) return false;
    }
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (Cmd4) Rotate by θ and then by −θ (fresh command, same store) restores
// both positions and rotations exactly.
fc.assert(
  fc.property(twoElements, point2, angle, ({ p1, p2, r1, r2 }, pivot, theta) => {
    const { store, map } = makeStore(makeElements(p1, p2, r1, r2));
    const first = new RotateCommand({ store });
    first.Begin(['e1', 'e2']);
    first.UpdatePreview({ type: 'rotation', pivot, angle: theta });
    if (!first.Commit().ok) return false;
    const second = new RotateCommand({ store });
    second.Begin(['e1', 'e2']);
    second.UpdatePreview({ type: 'rotation', pivot, angle: -theta });
    if (!second.Commit().ok) return false;
    if (!near2(map.get('e1')!.position, p1) || !near2(map.get('e2')!.position, p2)) return false;
    return nearNum(map.get('e1')!.rotationZ, r1) && nearNum(map.get('e2')!.rotationZ, r2);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (Cmd5) Align: the source element lands exactly on the target
// position; the target does not move.
fc.assert(
  fc.property(twoElements, ({ p1, p2, r1, r2 }) => {
    const { store, map } = makeStore(makeElements(p1, p2, r1, r2));
    const cmd = new AlignCommand({ store });
    cmd.setReferences({
      source: { elementId: 'e1', position: p1 },
      target: { elementId: 'e2', position: p2 },
    });
    cmd.Begin(['e1']);
    cmd.UpdatePreview({ type: 'translation', from: [0, 0], to: [0, 0] });
    const result = cmd.Commit();
    if (!result.ok || result.applied !== 1) return false;
    if (!near2(map.get('e1')!.position, p2)) return false;
    return near2(map.get('e2')!.position, p2);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (Cmd6) Pinned elements reject every modify command (spec 2C.9):
// CanExecute refuses and Begin throws naming the pin.
fc.assert(
  fc.property(point2, (p) => {
    const { store } = makeStore([
      { id: 'e1', categoryId: 'wall', pinned: true, editable: true, position: p, rotationZ: 0 },
    ]);
    const cmd = new MoveCommand({ store });
    if (cmd.CanExecute(['e1']).can) return false;
    try {
      cmd.Begin(['e1']);
    } catch (e) {
      return /pinned/.test(String((e as Error).message));
    }
    return false;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS geometry-primitives (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
