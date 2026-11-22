/**
 * Run all 10 fast-check property invariants (#98), each at 500 runs with
 * the shared seed from ./seed.ts. Every file runs its fc.assert calls at
 * import time; a failure throws and exits non-zero. Each file is also
 * runnable on its own: `npx tsx tests/property/<name>.test.ts`.
 *
 * Invoked as `npm run test:property` and wired into CI via
 * scripts/ci-unit-tests.mjs.
 */
await import('./undo-invariant.test.ts');
await import('./redo-invariant.test.ts');
await import('./boolean-closure.test.ts');
await import('./transform-invariant.test.ts');
await import('./polygon-validity.test.ts');
await import('./snapping-invariant.test.ts');
await import('./serialization-roundtrip.test.ts');
await import('./formula-invariant.test.ts');
await import('./units-invariant.test.ts');
await import('./ifc-rejection.test.ts');

console.log('=== all property invariants passed ===');
