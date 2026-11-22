import fc from 'fast-check';
import {
  querySnapCandidates, rankSnapCandidates, resolveSnapAmbiguity,
  DEFAULT_SNAP_SETTINGS,
  type RankedCandidate, type SnapCandidateRaw, type SnapReferenceKind, type SnapSettings,
} from '../../src/modules/snapping/engine';
import { calculateCompoundWallContactOffset, type WallLocationLine } from '../../src/modules/snapping/wall-column';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Snapping determinism (#98 invariant 6) for src/modules/snapping/engine.ts
// (tolerance filtering, deterministic ranking, hysteresis) and for the
// wall location-line justification offset in
// src/modules/snapping/wall-column.ts (the offset a snap preserves when a
// wall is placed against a column face depends on the justification).

const KINDS: SnapReferenceKind[] = [
  'endpoint', 'midpoint', 'center', 'intersection', 'nearest', 'edge', 'face',
  'centerline', 'perpendicular-foot', 'tangent', 'grid', 'level',
  'reference-plane', 'wall-core-face', 'wall-finish-face', 'column-boundary',
  'family-reference', 'connector-origin', 'connector-axis', 'work-plane',
];

const candidate = fc.record({
  position: fc.tuple(
    fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  ),
  screen: fc.record({
    x: fc.double({ min: -40, max: 40, noNaN: true, noDefaultInfinity: true }),
    y: fc.double({ min: -40, max: 40, noNaN: true, noDefaultInfinity: true }),
  }),
  kind: fc.constantFrom(...KINDS),
  elementId: fc.string({ minLength: 1, maxLength: 8 }),
  referenceName: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
  depth: fc.double({ min: -5, max: 5, noNaN: true, noDefaultInfinity: true }),
}) as fc.Arbitrary<SnapCandidateRaw>;

const pointer = fc.record({
  x: fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true }),
  y: fc.double({ min: -20, max: 20, noNaN: true, noDefaultInfinity: true }),
});

const settings: SnapSettings = {
  ...DEFAULT_SNAP_SETTINGS,
  enabled: new Set<SnapReferenceKind>(KINDS),
};

// (6a) Snap tolerance: querySnapCandidates returns exactly the candidates
// within the screen tolerance — nothing outside it, nothing inside it
// missing (no depth filtering happens at this stage).
fc.assert(
  fc.property(fc.array(candidate, { maxLength: 20 }), pointer, (raws, ptr) => {
    const got = querySnapCandidates(raws, ptr, settings);
    const expected = raws.filter(
      (r) => Math.hypot(r.screen.x - ptr.x, r.screen.y - ptr.y) <= settings.screenTolerancePx,
    );
    if (got.length !== expected.length) return false;
    return expected.every((r) => got.includes(r));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (6b) Ranking determinism: shuffling the input candidates (here: reversing
// plus rotating) must not change the ranked order — the score and the
// tie-breaks (kind, elementId, position) are pure functions of the set.
fc.assert(
  fc.property(
    fc.array(candidate, { minLength: 1, maxLength: 20 }),
    pointer,
    fc.integer({ min: 0, max: 19 }),
    (raws, ptr, k) => {
      const ranked = rankSnapCandidates(raws, ptr, settings);
      const shuffled = [...raws].reverse();
      shuffled.push(...shuffled.splice(0, k % shuffled.length));
      const ranked2 = rankSnapCandidates(shuffled, ptr, settings);
      const key = (r: RankedCandidate): string =>
        `${r.kind}|${r.raw.elementId}|${r.raw.position.join(',')}|${r.score}`;
      if (ranked.length !== ranked2.length) return false;
      return ranked.every((r, i) => key(r) === key(ranked2[i]));
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (6c) Ranking is sorted by ascending score.
fc.assert(
  fc.property(fc.array(candidate, { maxLength: 20 }), pointer, (raws, ptr) => {
    const ranked = rankSnapCandidates(raws, ptr, settings);
    return ranked.every((r, i) => i === 0 || ranked[i - 1].score <= r.score);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (6d) Hysteresis: the locked candidate is kept unless the best candidate
// beats it by the hysteresis factor (best.score * hysteresis <
// locked.score); otherwise the best wins.
function rankedCandidate(score: number, elementId: string): RankedCandidate {
  const raw: SnapCandidateRaw = {
    position: [0, 0, 0], screen: { x: 0, y: 0 }, kind: 'endpoint',
    elementId, depth: 0,
  };
  return { raw, kind: 'endpoint', screenDistance: 0, priority: 100, score };
}

fc.assert(
  fc.property(
    fc.double({ min: 0.01, max: 0.99, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.01, max: 0.99, noNaN: true, noDefaultInfinity: true }),
    (sBest, sLocked) => {
      fc.pre(sBest < sLocked);
      const best = rankedCandidate(sBest, 'best');
      const locked = rankedCandidate(sLocked, 'locked');
      const won = resolveSnapAmbiguity([best, locked], locked, settings);
      const bestWins = sBest * settings.hysteresis < sLocked;
      return bestWins ? won === best : won === locked;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (6e) Justification-offset preservation: the compound contact pullback
// for a wall against a column face is ℓ·|p·n|/|d·n|, where ℓ — the lateral
// extent of material on the penetrating side — depends on the
// justification exactly as documented in wall-column.ts (core-centerline
// w/2 on both sides; finish-face-exterior 0 on the approach side, w on
// the far side; finish-face-interior the reverse). A near-parallel
// approach that would need more than 2× the wall width is unsupported
// and pulls back 0.
const justification = fc.constantFrom(
  'core-centerline', 'finish-face-exterior', 'finish-face-interior',
) as fc.Arbitrary<WallLocationLine['justification']>;

fc.assert(
  fc.property(
    fc.double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.35, max: Math.PI - 0.35, noNaN: true, noDefaultInfinity: true }),
    justification,
    (width, theta, delta, just) => {
      const direction: [number, number] = [Math.cos(theta), Math.sin(theta)];
      const normal: [number, number] = [Math.cos(theta + delta), Math.sin(theta + delta)];
      const wall: WallLocationLine = { start: [0, 0], direction, width, justification: just };
      const got = calculateCompoundWallContactOffset(wall, normal);
      const px = -direction[1];
      const py = direction[0];
      const dn = direction[0] * normal[0] + direction[1] * normal[1];
      const pn = px * normal[0] + py * normal[1];
      const penetratingNegativeSide = pn > 0;
      const half = width / 2;
      const approachExtent =
        just === 'core-centerline' ? half : just === 'finish-face-exterior' ? 0 : width;
      const farExtent =
        just === 'core-centerline' ? half : just === 'finish-face-exterior' ? width : 0;
      const ell = penetratingNegativeSide ? approachExtent : farExtent;
      const expectedPullback = (ell * Math.abs(pn)) / Math.abs(dn);
      const expectedSupported = expectedPullback <= 2 * width + 1e-9;
      const expectedFace = penetratingNegativeSide ? 'exterior' : 'interior';
      if (got.contactFace !== expectedFace) return false;
      if (got.supported !== expectedSupported) return false;
      if (!expectedSupported) return got.pullback === 0;
      return Math.abs(got.pullback - expectedPullback) <= 1e-9;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (6f) Justification symmetry: for a core-centerline wall the pullback is
// the same approaching from either side (only the contact face flips).
fc.assert(
  fc.property(
    fc.double({ min: 0.1, max: 1, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0, max: Math.PI * 2, noNaN: true, noDefaultInfinity: true }),
    fc.double({ min: 0.35, max: Math.PI - 0.35, noNaN: true, noDefaultInfinity: true }),
    (width, theta, delta) => {
      const direction: [number, number] = [Math.cos(theta), Math.sin(theta)];
      const normal: [number, number] = [Math.cos(theta + delta), Math.sin(theta + delta)];
      const flipped: [number, number] = [-normal[0], -normal[1]];
      const wall: WallLocationLine = { start: [0, 0], direction, width, justification: 'core-centerline' };
      const a = calculateCompoundWallContactOffset(wall, normal);
      const b = calculateCompoundWallContactOffset(wall, flipped);
      if (a.supported !== b.supported) return false;
      if (Math.abs(a.pullback - b.pullback) > 1e-9) return false;
      return a.contactFace !== b.contactFace;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS snapping-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
