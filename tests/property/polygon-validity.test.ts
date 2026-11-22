import fc from 'fast-check';
import { validateProfile, selfIntersects, signedArea, extrude } from '../../src/modules/solid-kernel/forms';
import { meshVolume } from '../../src/modules/adaptive';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Polygon validity (#98 invariant 5) for `validateProfile`
// (src/modules/solid-kernel/forms.ts): a valid closed profile is accepted
// and its extrusion has the exact closed-form volume; any other random
// ring is either accepted as a genuinely valid ring or rejected with a
// typed FormError code — never silently accepted as invalid geometry.

const FORM_ERROR_CODES = new Set([
  'open-profile',
  'degenerate-profile',
  'self-intersection',
  'invalid-parameter',
  'axis-crosses-profile',
]);

// Valid polygons: vertices at jittered regular-polygon angles around the
// origin with random radii — star-shaped, hence non-self-intersecting by
// construction. The jitter is bounded to a fraction of the angular step so
// no two angles can coincide (coincident angles would collapse vertices
// into a degenerate ring, which is a generator bug, not a valid polygon).
const validRing = fc.record({
  n: fc.integer({ min: 3, max: 8 }),
  jitter: fc.array(fc.double({ min: -0.1, max: 0.1, noNaN: true, noDefaultInfinity: true }), { minLength: 8, maxLength: 8 }),
  radii: fc.array(fc.double({ min: 0.5, max: 3, noNaN: true, noDefaultInfinity: true }), { minLength: 8, maxLength: 8 }),
}).map(({ n, jitter, radii }) => {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n + jitter[i] * (Math.PI / n);
    ring.push({ u: radii[i] * Math.cos(a), v: radii[i] * Math.sin(a) });
  }
  ring.push({ ...ring[0] }); // explicit closure, as validateProfile requires
  return ring;
});

// (5a) Valid rings are accepted with the closing point stripped, are
// non-self-intersecting, have non-zero area, and extrude to the exact
// closed-form volume area × depth.
fc.assert(
  fc.property(
    validRing,
    fc.double({ min: 0.1, max: 5, noNaN: true, noDefaultInfinity: true }),
    (profile, depth) => {
      const ring = validateProfile(profile);
      if (ring.length !== profile.length - 1) return false;
      if (ring.some((p) => !Number.isFinite(p.u) || !Number.isFinite(p.v))) return false;
      if (selfIntersects(ring)) return false;
      const area = signedArea(ring);
      if (!(Math.abs(area) > 1e-9)) return false;
      const solid = extrude({ profile, depth });
      return Math.abs(meshVolume(solid) - Math.abs(area) * depth) <= 1e-9;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (5b) Hostile rings: arbitrary points, open or closed. The validator must
// either return a genuinely valid ring (finite, ≥ 3 points, no
// self-intersection) or throw a typed FormError with a known code.
const hostileRing = fc.array(
  fc.record({
    u: fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
    v: fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 3, maxLength: 8 },
).chain((pts) =>
  fc.record({
    ring: fc.constant(pts),
    close: fc.boolean(),
  }).map(({ ring, close }) => (close ? [...ring, { ...ring[0] }] : ring)),
);

fc.assert(
  fc.property(hostileRing, (profile) => {
    try {
      const ring = validateProfile(profile);
      if (ring.length < 3) return false;
      if (ring.some((p) => !Number.isFinite(p.u) || !Number.isFinite(p.v))) return false;
      return !selfIntersects(ring);
    } catch (e) {
      return FORM_ERROR_CODES.has((e as { code?: string }).code ?? '');
    }
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// Named case: the classic bowtie is a self-intersection, not a valid ring.
{
  const bowtie = [
    { u: 0, v: 0 }, { u: 1, v: 1 }, { u: 1, v: 0 }, { u: 0, v: 1 }, { u: 0, v: 0 },
  ];
  try {
    validateProfile(bowtie);
    throw new Error('bowtie profile was accepted');
  } catch (e) {
    if ((e as { code?: string }).code !== 'self-intersection') throw e;
  }
  const open = [{ u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: 1 }, { u: 0, v: 1 }];
  try {
    validateProfile(open);
    throw new Error('open profile was accepted');
  } catch (e) {
    if ((e as { code?: string }).code !== 'open-profile') throw e;
  }
  const nonFinite = [
    { u: 0, v: 0 }, { u: 1, v: 0 }, { u: 1, v: Number.NaN }, { u: 0, v: 0 },
  ];
  try {
    validateProfile(nonFinite);
    throw new Error('non-finite profile was accepted');
  } catch (e) {
    if ((e as { code?: string }).code !== 'degenerate-profile') throw e;
  }
}

console.log(`PASS polygon-validity (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
