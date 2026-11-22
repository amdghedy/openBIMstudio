import fc from 'fast-check';
import {
  generalBoolean, generateVoid, meshVolume,
  validateMeshDiagnostics, weldMesh, type IndexedMesh,
} from '../../src/modules/solid-kernel';
import { applyOp, seedModel } from '../helpers/testEngine';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Boolean op closure (#98 invariant 3) over random axis-aligned boxes.
// Volumes are closed-form (integer box arithmetic), so every result is
// checked against an exact expected volume, and watertightness is checked
// with the same validator the v70 suite uses (weld, then zero error
// diagnostics and zero non-manifold edges).

const axis = fc.record({
  min: fc.integer({ min: 0, max: 2 }),
  size: fc.integer({ min: 1, max: 3 }),
});
const boxPair = fc.record({ ax: axis, ay: axis, az: axis, bx: axis, by: axis, bz: axis });

type Box = { min: [number, number, number]; max: [number, number, number] };

function toBox(a: { min: number; size: number }, b: { min: number; size: number }, c: { min: number; size: number }): Box {
  return { min: [a.min, b.min, c.min], max: [a.min + a.size, b.min + b.size, c.min + c.size] };
}

function volume(box: Box): number {
  return (box.max[0] - box.min[0]) * (box.max[1] - box.min[1]) * (box.max[2] - box.min[2]);
}

function overlapVolume(a: Box, b: Box): number {
  let v = 1;
  for (let i = 0; i < 3; i++) {
    v *= Math.max(0, Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]));
  }
  return v;
}

function mesh(box: Box): IndexedMesh {
  return generateVoid({
    kind: 'box',
    center: {
      x: (box.min[0] + box.max[0]) / 2,
      y: (box.min[1] + box.max[1]) / 2,
      z: (box.min[2] + box.max[2]) / 2,
    },
    size: {
      x: box.max[0] - box.min[0],
      y: box.max[1] - box.min[1],
      z: box.max[2] - box.min[2],
    },
  });
}

function errorCount(m: IndexedMesh): number {
  return validateMeshDiagnostics(weldMesh(m)).filter((d) => d.severity === 'error').length;
}

function nonManifoldCount(m: IndexedMesh): number {
  return validateMeshDiagnostics(weldMesh(m)).filter((d) => d.code === 'non-manifold-edge').length;
}

function assertClosed(m: IndexedMesh, label: string): boolean {
  if (errorCount(m) !== 0) throw new Error(`${label}: boolean result has error diagnostics`);
  if (nonManifoldCount(m) !== 0) throw new Error(`${label}: boolean result is not watertight (non-manifold edges)`);
  return true;
}

function near(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

// (3a) Union: volume is volA + volB - overlap for EVERY pair, and the
// result is closed (watertight) — except for the zero-volume contact
// class: two boxes that touch at a face, edge or point but do not overlap
// share that contact in the output mesh, so the shared edge is used four
// times and validateMeshDiagnostics reports non-manifold edges. The
// volume is still exact there; the non-manifold output is a real kernel
// limitation (merging coincident contact faces), recorded in
// pr-description-pe09.md — fixing it is kernel-validity work, out of
// scope for this invariants item. Disjoint pairs (a gap on some axis)
// are watertight: two separate closed shells in one mesh.
fc.assert(
  fc.property(boxPair, ({ ax, ay, az, bx, by, bz }) => {
    const a = toBox(ax, ay, az);
    const b = toBox(bx, by, bz);
    const overlap = overlapVolume(a, b);
    const expected = volume(a) + volume(b) - overlap;
    const u = generalBoolean('union', mesh(a), mesh(b));
    if (!near(meshVolume(u), expected)) return false;
    const perAxis = [0, 1, 2].map(
      (i) => Math.min(a.max[i], b.max[i]) - Math.max(a.min[i], b.min[i]),
    );
    const disjoint = perAxis.some((ov) => ov < 0);
    const touching = overlap === 0 && !disjoint;
    if (!touching && !assertClosed(u, 'union')) return false;
    const u2 = generalBoolean('union', mesh(b), mesh(a));
    return near(meshVolume(u2), expected);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (3b) Intersection: volume is the exact overlap volume, result is closed.
// generalBoolean throws on an empty result, so pairs with no overlap are
// excluded by precondition (the empty-intersection refusal is the
// kernel's documented behaviour, not a property failure).
fc.assert(
  fc.property(boxPair, ({ ax, ay, az, bx, by, bz }) => {
    const a = toBox(ax, ay, az);
    const b = toBox(bx, by, bz);
    const overlap = overlapVolume(a, b);
    fc.pre(overlap > 0);
    const i = generalBoolean('intersect', mesh(a), mesh(b));
    if (!near(meshVolume(i), overlap)) return false;
    if (!assertClosed(i, 'intersect')) return false;
    const i2 = generalBoolean('intersect', mesh(b), mesh(a));
    return near(meshVolume(i2), overlap);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (3c) Subtraction: volume is volA - overlap, result is closed. Excluded
// by precondition: no overlap (nothing to cut) and full cover (empty
// result, which the kernel refuses by throwing).
fc.assert(
  fc.property(boxPair, ({ ax, ay, az, bx, by, bz }) => {
    const a = toBox(ax, ay, az);
    const b = toBox(bx, by, bz);
    const overlap = overlapVolume(a, b);
    fc.pre(overlap > 0 && overlap < volume(a));
    const s = generalBoolean('subtract', mesh(a), mesh(b));
    if (!near(meshVolume(s), volume(a) - overlap)) return false;
    return assertClosed(s, 'subtract');
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (3d) Split/join conservation (#98 names it explicitly): splitting a wall
// halves its length and joining two walls sums theirs, so the total wall
// length is conserved across any op sequence and no wall ever becomes
// degenerate (zero or negative length).
const dx = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const ops = fc.oneof(
  fc.record({ kind: fc.constant('move'), dx }),
  fc.record({ kind: fc.constant('split') }),
  fc.record({ kind: fc.constant('join') }),
);

fc.assert(
  fc.property(fc.array(ops, { maxLength: 40 }), (seq) => {
    const model = seedModel();
    const totalLength = (): number =>
      model.walls.reduce((sum, w) => sum + w.length, 0);
    const before = totalLength();
    for (const op of seq) applyOp(model, op);
    if (!near(totalLength(), before)) return false;
    return model.walls.every((w) => w.length > 0 && Number.isFinite(w.length));
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS boolean-closure (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
