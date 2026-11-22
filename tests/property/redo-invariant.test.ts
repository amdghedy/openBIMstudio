import fc from 'fast-check';
import { applyOp, undo, redo, hashState, seedModel } from '../helpers/testEngine';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

const dx = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const ops = fc.oneof(
  fc.record({ kind: fc.constant('move'), dx }),
  fc.record({ kind: fc.constant('split') }),
  fc.record({ kind: fc.constant('join') }),
);
const seqs = fc.array(ops, { maxLength: 40 });

// (2a) Undoing every op and then redoing every op restores the exact
// post-op state — redo replays the same snapshots undo reverted.
fc.assert(
  fc.property(seqs, (seq) => {
    const model = seedModel();
    for (const op of seq) applyOp(model, op);
    const afterOps = hashState(model);
    for (let i = 0; i < seq.length; i++) undo(model);
    for (let i = 0; i < seq.length; i++) redo(model);
    return hashState(model) === afterOps;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (2b) Redo with nothing undone is a no-op, and undo with nothing to undo
// is a no-op: neither may change the model hash.
fc.assert(
  fc.property(seqs, (seq) => {
    const model = seedModel();
    const before = hashState(model);
    redo(model);
    if (hashState(model) !== before) return false;
    undo(model);
    if (hashState(model) !== before) return false;
    for (const op of seq) applyOp(model, op);
    const afterOps = hashState(model);
    redo(model);
    return hashState(model) === afterOps;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (2c) Partial undo/redo: undoing k ops and redoing the same k restores
// the post-op state for any k in [0, seq.length].
fc.assert(
  fc.property(
    fc.array(ops, { minLength: 1, maxLength: 40 }),
    fc.integer({ min: 0, max: 40 }),
    (seq, kRaw) => {
      const model = seedModel();
      for (const op of seq) applyOp(model, op);
      const afterOps = hashState(model);
      const k = Math.min(kRaw, seq.length);
      for (let i = 0; i < k; i++) undo(model);
      for (let i = 0; i < k; i++) redo(model);
      return hashState(model) === afterOps;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (2d) Undo lands on the exact intermediate state: undoing the last k ops
// yields exactly the model produced by applying only the first n-k ops
// to a fresh model, and redoing k returns to the post-op state. Unlike
// (2a)/(2c) this pins undo through an independent oracle, so it also
// catches a broken undo (see the mutation check in pr-description-pe09.md).
fc.assert(
  fc.property(
    fc.array(ops, { minLength: 1, maxLength: 40 }),
    fc.integer({ min: 0, max: 40 }),
    (seq, kRaw) => {
      const model = seedModel();
      for (const op of seq) applyOp(model, op);
      const afterOps = hashState(model);
      const k = Math.min(kRaw, seq.length);
      const ref = seedModel();
      for (let i = 0; i < seq.length - k; i++) applyOp(ref, seq[i]);
      const intermediate = hashState(ref);
      for (let i = 0; i < k; i++) undo(model);
      if (hashState(model) !== intermediate) return false;
      for (let i = 0; i < k; i++) redo(model);
      return hashState(model) === afterOps;
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS redo-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
