import fc from 'fast-check';
import { applyOp, undo, hashState, seedModel } from '../helpers/testEngine';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

const dx = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const ops = fc.oneof(
  fc.record({ kind: fc.constant('move'), dx }),
  fc.record({ kind: fc.constant('split') }),
  fc.record({ kind: fc.constant('join') }),
);

fc.assert(
  fc.property(fc.array(ops, { maxLength: 40 }), (seq) => {
    const model = seedModel();
    const before = hashState(model);
    for (const op of seq) applyOp(model, op);
    for (let i = 0; i < seq.length; i++) undo(model);
    return hashState(model) === before;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS undo-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
