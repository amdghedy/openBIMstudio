import fc from 'fast-check';
import { evaluateParameters, evaluateFormula } from '../../src/modules/families/formula-engine';
import type { FamilyParameter } from '../../src/modules/families/types';
import { PROPERTY_RUNS, PROPERTY_SEED } from './seed';

// Formula evaluation determinism (#98 invariant 8) for
// src/modules/families/formula-engine.ts (via safe-expr): same
// declarations always evaluate to the same values in a valid topological
// order, cycles are rejected with a named error and never computed, and
// one-off evaluation is deterministic and fail-closed (null, never a
// throw) on unknown names and non-finite results.

function param(name: string, formula?: string, def = 0): FamilyParameter {
  return { name, type: 'number', scope: 'instance', default: def, editable: true, formula };
}

// The DAG generator below builds declarations inside the property from a
// per-index spec: each entry picks a referenced earlier index (or none).
const dagSpec = fc.array(
  fc.record({
    ref: fc.integer({ min: 0, max: 5 }),
    op: fc.constantFrom('+', '-', '*'),
    constant: fc.double({ min: -10, max: 10, noNaN: true, noDefaultInfinity: true }),
    hasFormula: fc.boolean(),
    def: fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }),
  }),
  { minLength: 1, maxLength: 6 },
);

function declarationsFrom(spec: Array<{ ref: number; op: string; constant: number; hasFormula: boolean; def: number }>): FamilyParameter[] {
  return spec.map((s, i) => {
    if (!s.hasFormula || i === 0) return param(`p${i}`, undefined, s.def);
    const j = s.ref % i; // earlier param only — acyclic by construction
    return param(`p${i}`, `=p${j} ${s.op} ${s.constant}`, s.def);
  });
}

// (8a) Determinism: evaluating the same declarations twice gives identical
// values, order and errors.
fc.assert(
  fc.property(dagSpec, (spec) => {
    const decls = declarationsFrom(spec);
    const a = evaluateParameters(decls, {});
    const b = evaluateParameters(decls, {});
    return JSON.stringify(a) === JSON.stringify(b);
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (8b) Topo-order validity + successful evaluation: the returned order
// contains every declaration exactly once, every non-cyclic parameter's
// dependencies precede it, nothing errors, every formula parameter is
// computed, and every value is a finite number.
fc.assert(
  fc.property(dagSpec, (spec) => {
    const decls = declarationsFrom(spec);
    const result = evaluateParameters(decls, {});
    if (result.errors.length !== 0) return false;
    if (result.order.length !== decls.length) return false;
    if (new Set(result.order).size !== decls.length) return false;
    for (const name of result.order) {
      const idx = result.order.indexOf(name);
      for (const dep of result.dependencies[name] ?? []) {
        if (result.order.indexOf(dep) >= idx) return false;
      }
    }
    for (const p of decls) {
      if (p.formula && !result.computed.has(p.name)) return false;
      const v = result.values[p.name];
      if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    }
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (8c) Cross-check: each computed value equals a direct one-off evaluation
// of its formula against the final values — the topo-ordered evaluation
// and the direct evaluation agree.
fc.assert(
  fc.property(dagSpec, (spec) => {
    const decls = declarationsFrom(spec);
    const result = evaluateParameters(decls, {});
    if (result.errors.length !== 0) return false;
    for (const p of decls) {
      if (!p.formula) continue;
      const direct = evaluateFormula(p.formula, result.values);
      if (typeof direct !== 'number' || !Number.isFinite(direct)) return false;
      if (Math.abs(direct - result.values[p.name]) > 1e-9) return false;
    }
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (8d) Cycle rejection: a two-parameter cycle (plus a downstream parameter
// that depends on the cycle) is reported as a cycle error, and no cyclic
// parameter is ever computed.
fc.assert(
  fc.property(fc.constant(0), () => {
    const decls = [
      param('a', '=b + 1', 0),
      param('b', '=a + 1', 0),
      param('c', '=a + 2', 0),
    ];
    const result = evaluateParameters(decls, {});
    const cycleErrors = result.errors.filter((e) => /Cycle detected/.test(e.message));
    if (cycleErrors.length === 0) return false;
    if (!cycleErrors.some((e) => e.parameter === 'a')) return false;
    if (!cycleErrors.some((e) => e.parameter === 'b')) return false;
    if (result.computed.has('a') || result.computed.has('b')) return false;
    return true;
  }),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

// (8e) One-off evaluation is deterministic and fail-closed: the same
// expression always gives the same result, and unknown names, unknown
// functions and non-finite results yield null instead of throwing.
fc.assert(
  fc.property(
    fc.oneof(
      fc.tuple(fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true }), fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true })).map(
        ([a, b]) => `${a} + ${b} * 2`,
      ),
      fc.constant('foo(1)'),
      fc.constant('missingParam + 1'),
      fc.constant('1 / 0'),
      fc.constant('process.exit(0)'),
    ),
    (expr) => {
      const a = evaluateFormula(expr, { p0: 3 });
      const b = evaluateFormula(expr, { p0: 3 });
      if (JSON.stringify(a) !== JSON.stringify(b)) return false;
      if (/foo|missingParam|process/.test(expr)) return a === null;
      if (expr === '1 / 0') return a === null;
      return typeof a === 'number' && Number.isFinite(a);
    },
  ),
  { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED },
);

console.log(`PASS formula-invariant (${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`);
