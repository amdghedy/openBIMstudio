import fc from 'fast-check';
import { rotateAboutAxis } from '../../src/modules/modify/transform';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Transform correctness (#98 invariant 4) for the pure rotation primitive
// `rotateAboutAxis` (Rodrigues formula, src/modules/modify/transform.ts):
// identity, inverse, same-axis angle additivity (associativity of
// same-axis rotations), norm and dot-product preservation, axis
// invariance, and fail-closed behaviour on a zero-length axis.

type V3 = [number, number, number];

const point = fc.tuple(
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
) as fc.Arbitrary<V3>;
// Axes are kept away from zero so the property tests the rotation, not the
// zero-axis refusal (that is property 4e below).
const axis = fc.tuple(
  fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
).filter(([x, y, z]) => Math.hypot(x, y, z) > 1e-6) as fc.Arbitrary<V3>;
const angle = fc.double({ min: -Math.PI * 2, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true });

function near(a: V3, b: V3, tol = 1e-9): boolean {
  return Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
}

function norm(p: V3): number {
  return Math.hypot(p[0], p[1], p[2]);
}

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// (4a) Identity: rotating by 0, or by a full turn, leaves the point fixed.
fc.assert(
  fc.property(point, axis, (p, ax) => {
    if (!near(rotateAboutAxis(p, ax, 0), p)) return false;
    return near(rotateAboutAxis(p, ax, Math.PI * 2), p);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (4b) Inverse: rotating by θ and then by −θ about the same axis restores
// the point exactly (within float tolerance).
fc.assert(
  fc.property(point, axis, angle, (p, ax, t) => {
    const rotated = rotateAboutAxis(p, ax, t);
    return near(rotateAboutAxis(rotated, ax, -t), p);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (4c) Angle additivity: two successive same-axis rotations equal one
// rotation by the summed angle.
fc.assert(
  fc.property(point, axis, angle, angle, (p, ax, t1, t2) => {
    const stepwise = rotateAboutAxis(rotateAboutAxis(p, ax, t1), ax, t2);
    return near(stepwise, rotateAboutAxis(p, ax, t1 + t2));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (4d) Rotation is an isometry: it preserves norms, dot products, and
// fixes every point on the rotation axis.
fc.assert(
  fc.property(point, point, axis, angle, (p, q, ax, t) => {
    const rp = rotateAboutAxis(p, ax, t);
    const rq = rotateAboutAxis(q, ax, t);
    if (Math.abs(norm(rp) - norm(p)) > 1e-9) return false;
    if (Math.abs(dot(rp, rq) - dot(p, q)) > 1e-9) return false;
    const onAxis = rotateAboutAxis(ax, ax, t);
    return near(onAxis, ax);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (4e) Fail-closed: a zero-length axis throws instead of returning NaN.
fc.assert(
  fc.property(point, (p) => {
    try {
      rotateAboutAxis(p, [0, 0, 0], 1);
    } catch (e) {
      return /zero-length axis/.test(String((e as Error).message));
    }
    return false;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS transform-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
