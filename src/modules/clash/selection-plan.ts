/**
 * Turns the user's Selection A / Selection B / scope into the per-model input the
 * clash engine needs. Pure (no DOM, no three.js) so every scope is unit-tested.
 *
 * "Models" here are IFC models, linked models and the pseudo-model that holds native
 * authored elements; the plan treats them all the same.
 */
export type IdSet = Set<number> | "ALL" | null;
export type ClashScopeName = "all" | "viewport" | "aOnly" | "bOnly" | "both";
export type Resolved = Map<string, Set<number> | "ALL">;

export interface ModelPlan {
  modelId: string;
  /** Elements to read from the model (union of A and B for scope "both"). */
  allowed: IdSet;
  sideA: IdSet;
  sideB: IdSet;
}
export interface ScopePlan {
  models: ModelPlan[];
  /** True when only A-versus-B pairs should be tested. */
  useSides: boolean;
  /** Plain-language reason when nothing can be tested. */
  empty?: string;
}

export function unionIdSets(a: IdSet | undefined, b: IdSet | undefined): IdSet {
  if (a === "ALL" || b === "ALL") return "ALL";
  if (!a && !b) return null;
  const u = new Set<number>();
  if (a) for (const x of a) u.add(x);
  if (b) for (const x of b) u.add(x);
  return u.size ? u : null;
}

/** Add explicit id picks (e.g. from the category dialog) to a resolved selection. */
export function mergeExplicit(base: Resolved, explicit: Map<string, Set<number>>): Resolved {
  const out: Resolved = new Map();
  for (const [k, v] of base) out.set(k, v === "ALL" ? "ALL" : new Set(v));
  for (const [k, v] of explicit) {
    const cur = out.get(k);
    if (cur === "ALL") continue;
    if (!v.size) continue;
    if (!cur) out.set(k, new Set(v));
    else for (const x of v) cur.add(x);
  }
  return out;
}

export function planScope(
  scope: ClashScopeName,
  modelIds: readonly string[],
  a: Resolved,
  b: Resolved,
  viewport: Record<string, Set<number>> = {},
): ScopePlan {
  const models: ModelPlan[] = [];
  const get = (m: Resolved, id: string): IdSet => { const v = m.get(id); return v === undefined || (v !== "ALL" && !v.size) ? null : v; };

  if (scope === "viewport") {
    for (const id of modelIds) {
      const ids = viewport[id];
      if (ids?.size) models.push({ modelId: id, allowed: ids, sideA: null, sideB: null });
    }
    return { models, useSides: false, ...(models.length ? {} : { empty: "Nothing is selected in the viewport." }) };
  }
  if (scope === "all") {
    for (const id of modelIds) models.push({ modelId: id, allowed: "ALL", sideA: null, sideB: null });
    return { models, useSides: false, ...(models.length ? {} : { empty: "There are no models or native elements to test." }) };
  }
  if (scope === "aOnly" || scope === "bOnly") {
    const src = scope === "aOnly" ? a : b;
    for (const id of modelIds) {
      const s = get(src, id);
      if (s) models.push({ modelId: id, allowed: s, sideA: null, sideB: null });
    }
    return { models, useSides: false, ...(models.length ? {} : { empty: `Selection ${scope === "aOnly" ? "A" : "B"} is empty. Tick models or categories in the tree.` }) };
  }
  // both: only A-versus-B pairs, anywhere (inside one model, across models, linked, native)
  let anyA = false, anyB = false;
  for (const id of modelIds) {
    const sa = get(a, id), sb = get(b, id);
    if (sa) anyA = true;
    if (sb) anyB = true;
    const allowed = unionIdSets(sa, sb);
    if (allowed) models.push({ modelId: id, allowed, sideA: sa, sideB: sb });
  }
  let empty: string | undefined;
  if (!anyA && !anyB) empty = "Selection A and B are empty. Tick models or categories in the tree.";
  else if (!anyA) empty = "Selection A is empty. Tick at least one model or category in Selection A.";
  else if (!anyB) empty = "Selection B is empty. Tick at least one model or category in Selection B.";
  return { models: empty ? [] : models, useSides: true, ...(empty ? { empty } : {}) };
}
