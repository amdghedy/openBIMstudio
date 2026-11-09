/**
 * Transitive host→child delete cascade (RVT behavior: deleting a host
 * deletes EVERY dependent element that can only exist while its host
 * exists — doors in the wall, panels in the curtain wall, etc.).
 *
 * The old authoring cascade handled only `type === "wall"` and only one
 * level deep. This module closes the gap:
 *   - any element that is REFERENCED via `hostId` is treated as a host
 *     (wall, beam, floor, line, mline, curtain wall, ...) — the closure is
 *     reference-driven, not type-driven, so new host types are covered
 *     automatically;
 *   - the closure is transitive (wall → curtain panel → hardware);
 *   - cycles cannot hang the walk (visited set).
 *
 * Pure module: no DOM, no ctx — safe to unit-test in Node.
 */

export interface CascadeElement {
  id: string;
  type?: string;
  hostId?: string;
}

export interface CascadeResult {
  /** Seed ids requested for deletion. */
  seeds: string[];
  /** Elements NOT in seeds that die because their host chain dies. */
  dependents: string[];
  /** Human-readable one-liner for a toast / status bar. */
  summary: string;
}

/**
 * Build the transitive closure of dependents for the given seed ids.
 * Seeds that do not exist in `elements` are ignored (still returned in
 * `seeds` so callers can report them).
 */
export function collectDeleteCascade(
  seedIds: string[],
  elements: CascadeElement[],
): CascadeResult {
  const byId = new Map<string, CascadeElement>();
  for (const el of elements) {
    if (el && el.id) byId.set(String(el.id), el);
  }

  // children[hostId] = [childIds...]
  const children = new Map<string, string[]>();
  for (const el of elements) {
    const host = el?.hostId ? String(el.hostId) : null;
    if (!host || !el.id) continue;
    const list = children.get(host);
    if (list) list.push(String(el.id));
    else children.set(host, [String(el.id)]);
  }

  const seeds: string[] = [];
  const seenSeeds = new Set<string>();
  for (const id of seedIds) {
    const key = String(id);
    if (!seenSeeds.has(key)) {
      seenSeeds.add(key);
      seeds.push(key);
    }
  }

  const dependents: string[] = [];
  const seen = new Set<string>(seeds);
  const queue: string[] = [...seeds];
  while (queue.length) {
    const host = queue.shift()!;
    const kids = children.get(host);
    if (!kids) continue;
    for (const kid of kids) {
      if (seen.has(kid)) continue; // cycle-safe
      seen.add(kid);
      dependents.push(kid);
      queue.push(kid);
    }
  }

  return {
    seeds,
    dependents,
    summary: dependentSummary(dependents, elements),
  };
}

/** "2 door, 1 window dependent element(s) will be deleted" — "" when none. */
export function dependentSummary(
  dependentIds: string[],
  elements: CascadeElement[],
): string {
  if (!dependentIds.length) return "";
  const byId = new Map<string, CascadeElement>();
  for (const el of elements) {
    if (el && el.id) byId.set(String(el.id), el);
  }
  const counts = new Map<string, number>();
  for (const id of dependentIds) {
    const t = String(byId.get(id)?.type ?? "element");
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `${n} ${t}`);
  return `${parts.join(", ")} dependent element(s) will be deleted`;
}

/**
 * Elements whose hostId points at a missing host (orphans). These are the
 * leaks the wall-only cascade used to leave behind; the checker and the
 * health report can surface them, and the cleanup can remove them.
 */
export function findOrphanedHosted(
  elements: CascadeElement[],
): Array<{ id: string; hostId: string }> {
  const ids = new Set<string>();
  for (const el of elements) {
    if (el?.id) ids.add(String(el.id));
  }
  const out: Array<{ id: string; hostId: string }> = [];
  for (const el of elements) {
    const host = el?.hostId ? String(el.hostId) : null;
    if (host && !ids.has(host)) out.push({ id: String(el.id), hostId: host });
  }
  return out;
}
