/**
 * Edit guard — the single choke point where the authoring path asks whether
 * an element may be edited or deleted right now.
 *
 * Guards are a SET, not a singleton: the central binding registers one per
 * session, and an edit is refused if ANY registered guard refuses (fail
 * closed). In the browser there is exactly one binding per page, so this is
 * identical to a single guard; the set exists so two bindings in one
 * process (the Node integration tests) each get their own guard instead of
 * the last-constructed binding silently replacing the first.
 *
 * The guard runs synchronously inside `applyElementParamChange`,
 * `deleteElements` / `removeElementById` and `transformElements`, so every
 * caller — property palette, modify bar, parametric tools, keyboard nudge,
 * align — gets the same refusal with the same reason string. Remote
 * application of authoritative central state bypasses the guards via
 * `withGuardSuspended` (a server decision is not a user edit).
 */

export type EditGuardResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export type EditGuardFn = (elementId: string) => EditGuardResult;

const guards = new Set<EditGuardFn>();

/** Register a guard. Returns an unregister function. */
export function registerEditGuard(fn: EditGuardFn): () => void {
  guards.add(fn);
  return () => {
    guards.delete(fn);
  };
}

/** Remove a previously registered guard. */
export function unregisterEditGuard(fn: EditGuardFn): void {
  guards.delete(fn);
}

/** Ask the registered guards whether `elementId` may be edited/deleted. */
export function checkEditAllowed(elementId: string): EditGuardResult {
  for (const guard of guards) {
    try {
      const r = guard(elementId);
      if (!r.allowed) return r;
    } catch {
      // A broken guard must never block solo editing.
    }
  }
  return { allowed: true };
}

/**
 * Run `fn` with all guards suspended. For applying authoritative central
 * state only: a remote update that the server already sequenced is not a
 * local user edit, so the local lock check must not refuse it (e.g. a
 * conflict resolution applying the winner's value to an element the local
 * user still holds a borrow on). Synchronous only — the guards are restored
 * before `fn` returns, so there is no window for a user edit to slip
 * through unguarded.
 */
export function withGuardSuspended<T>(fn: () => T): T {
  const prev = new Set(guards);
  guards.clear();
  try {
    return fn();
  } finally {
    guards.clear();
    for (const g of prev) guards.add(g);
  }
}
