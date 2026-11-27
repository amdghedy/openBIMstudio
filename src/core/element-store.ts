/**
 * Canonical element store — Phase 1 "single source of truth", step 1.
 *
 * Design: docs/engineering/decisions/2026-11-26-canonical-element-store.md
 *
 * Today element state lives in several parallel owners (authoring native
 * elements, the CAD engines, the family store, and the project store's own
 * elements array), so one element can be edited in one store and saved
 * from another. This module is the single front door those owners register
 * into. Step 1 changes no behavior: each kind adapter delegates to the
 * discipline's existing functions; the store only establishes that one id
 * maps to one record and that parameter changes funnel through one entry
 * point. Later steps move CAD and family elements in, then point
 * persistence at the store.
 *
 * This module is intentionally dependency-free (no imports) so it can be
 * unit-tested standalone and imported from anywhere without cycle risk.
 */

/** A discipline's view onto the elements it owns. */
export interface ElementKindAdapter {
  /** Discipline tag, e.g. "authored" (native BIM), later "cad", "family". */
  readonly kind: string;
  /** Every element id this kind currently owns. */
  listIds(): string[];
  /** True when this kind owns the id. */
  owns(id: string): boolean;
  /**
   * Apply one parameter change through the kind's own validated path
   * (validation, regeneration and history stay with the kind in step 1).
   */
  applyParamChange(
    id: string,
    param: string,
    value: number | string | boolean,
  ): { ok: boolean; reason?: string };
  /**
   * Bulk export of this kind's element records for persistence
   * (decision step 4). Optional while a kind is not yet persisted.
   */
  serialize?(): unknown[];
  /** Bulk replace this kind's element records from persistence. */
  hydrate?(records: unknown[]): void;
}

export interface ParamChangeResult {
  ok: boolean;
  reason?: string;
}

const kinds = new Map<string, ElementKindAdapter>();

/** Register a discipline adapter. Re-registering the same kind replaces it. */
export function registerKind(adapter: ElementKindAdapter): void {
  kinds.set(adapter.kind, adapter);
}

export function registeredKinds(): string[] {
  return [...kinds.keys()];
}

/** Which kind owns an element id, or null when no registered kind does. */
export function kindOf(id: string): string | null {
  let found: string | null = null;
  for (const [kind, adapter] of kinds) {
    if (!adapter.owns(id)) continue;
    if (found !== null) {
      // Exactly the failure this store exists to surface: two owners, one id.
      console.warn(
        `[element-store] id "${id}" is owned by both "${found}" and "${kind}" — one element must have one owner`,
      );
      continue; // first registered owner wins; the warning is the alarm
    }
    found = kind;
  }
  return found;
}

/** All element ids across all kinds. */
export function listAllIds(): string[] {
  const out: string[] = [];
  for (const adapter of kinds.values()) out.push(...adapter.listIds());
  return out;
}

/**
 * Persistence (decision step 4): the project store reads and writes
 * element state through the store, not through side imports of one
 * discipline's internals. Kinds without serialize/hydrate are not yet
 * persisted — the caller gets an empty list / a loud skip, never a
 * silent partial save.
 */
export function serializeKind(kind: string): unknown[] {
  const adapter = kinds.get(kind);
  if (!adapter?.serialize) {
    console.warn(`[element-store] kind "${kind}" has no serialize() — nothing persisted`);
    return [];
  }
  return adapter.serialize();
}

export function hydrateKind(kind: string, records: unknown[]): void {
  const adapter = kinds.get(kind);
  if (!adapter?.hydrate) {
    console.warn(
      `[element-store] kind "${kind}" has no hydrate() — ${records.length} record(s) skipped`,
    );
    return;
  }
  adapter.hydrate(records);
}

/** Total element count across all kinds. */
export function elementCount(): number {
  let n = 0;
  for (const adapter of kinds.values()) n += adapter.listIds().length;
  return n;
}

/**
 * The one parameter-change entry point. Routes to the kind that owns the
 * element; unknown elements fail loudly with a named reason instead of
 * silently editing (or losing) a parallel copy.
 */
export function applyParamChange(
  id: string,
  param: string,
  value: number | string | boolean,
): ParamChangeResult {
  const kind = kindOf(id);
  if (kind === null) return { ok: false, reason: "unknown_element" };
  return kinds.get(kind)!.applyParamChange(id, param, value);
}

/** Test hook: drop all registered kinds. */
export function resetElementStoreForTest(): void {
  kinds.clear();
}
