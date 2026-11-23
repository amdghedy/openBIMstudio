/**
 * Shared deterministic seed for every fast-check property in tests/property/.
 *
 * Issue #98 requires the 12 property invariants to run seeded so a failure
 * is reproducible. Every property file passes `seed: PROPERTY_SEED` to
 * `fc.assert`. Override for a single run with `PROPERTY_SEED=<n>`; the
 * default below is the recorded seed for this suite.
 */
export const PROPERTY_SEED: number = Number(process.env.PROPERTY_SEED ?? 20261122);

/** #98-mandated run count: 500 runs per invariant. */
export const PROPERTY_RUNS = 500;
