/**
 * View Filters — rule-based graphics overrides applied per-view.
 *
 * BIM-equivalent of Revit's "View Filters" tool. A filter is a named rule
 * (category + parameter predicate) bound to graphics overrides
 * (colour, lineweight, pattern, transparency, halftone, hidden).
 *
 * Filters are stored centrally; each view holds an ordered list of filter IDs
 * with apply/visibility flags.
 */

export type FilterCategory = "walls" | "doors" | "windows" | "floors" | "roofs" | "columns" | "beams" | "ducts" | "pipes" | "conduits" | "cable-trays" | "furniture" | "planting" | "rooms";

export type FilterOperator = "equals" | "not-equals" | "greater" | "less" | "contains" | "between";

export interface FilterRule {
  /** Parameter name (e.g. "FireRating", "Level", "Mark"). */
  parameter: string;
  operator: FilterOperator;
  /** Comparison value (string/number). */
  value: string | number;
  /** For "between" — upper bound. */
  upper?: number;
}

export interface GraphicsOverride {
  /** Projection line colour (hex), or null for "no override". */
  projectionColor: number | null;
  /** Cut line colour (hex). */
  cutColor: number | null;
  /** Line weight (1-16, BIM convention). */
  lineWeight: number;
  /** Fill pattern ID for surfaces. */
  surfacePattern: string | null;
  /** Fill pattern ID for cut. */
  cutPattern: string | null;
  /** Transparency 0-100 (100 = invisible). */
  transparency: number;
  /** Halftone (50% opacity grey blend). */
  halftone: boolean;
  /** Visible in this view? */
  visible: boolean;
}

export interface ViewFilter {
  id: string;
  name: string;
  /** Categories this filter matches. */
  categories: FilterCategory[];
  /** Rule predicate tree (AND-combined). */
  rules: FilterRule[];
  /** Graphics overrides applied to matches. */
  overrides: GraphicsOverride;
}

export interface ViewFilterBinding {
  /** View ID. */
  viewId: string;
  /** Ordered list of filter IDs. */
  filterIds: string[];
  /** Map of filterId → enabled in this view. */
  enabled: Record<string, boolean>;
}

const filterRegistry = new Map<string, ViewFilter>();
const viewBindings = new Map<string, ViewFilterBinding>();
let counter = 0;

const DEFAULT_OVERRIDES: GraphicsOverride = {
  projectionColor: 0xff0000,
  cutColor: 0xff0000,
  lineWeight: 3,
  surfacePattern: null,
  cutPattern: null,
  transparency: 0,
  halftone: false,
  visible: true,
};

/** Create a new view filter. */
export function createViewFilter(input: Partial<ViewFilter> = {}): ViewFilter {
  const id = input.id ?? `vf-${++counter}`;
  const filter: ViewFilter = {
    id,
    name: input.name ?? `Filter ${counter}`,
    categories: input.categories ?? [],
    rules: input.rules ?? [],
    overrides: { ...DEFAULT_OVERRIDES, ...input.overrides },
  };
  filterRegistry.set(id, filter);
  return filter;
}

/** List all filters. */
export function listViewFilters(): ViewFilter[] {
  return Array.from(filterRegistry.values());
}

/** Get a filter by ID. */
export function getViewFilter(id: string): ViewFilter | undefined {
  return filterRegistry.get(id);
}

/** Delete a filter (also removes from all views). */
export function deleteViewFilter(id: string): boolean {
  const ok = filterRegistry.delete(id);
  if (ok) {
    for (const binding of viewBindings.values()) {
      binding.filterIds = binding.filterIds.filter((f) => f !== id);
      delete binding.enabled[id];
    }
  }
  return ok;
}

/** Get or create the binding for a view. */
export function getViewBinding(viewId: string): ViewFilterBinding {
  let b = viewBindings.get(viewId);
  if (!b) {
    b = { viewId, filterIds: [], enabled: {} };
    viewBindings.set(viewId, b);
  }
  return b;
}

/** Add a filter to a view. */
export function addFilterToView(viewId: string, filterId: string, enabled = true): boolean {
  if (!filterRegistry.has(filterId)) return false;
  const b = getViewBinding(viewId);
  if (!b.filterIds.includes(filterId)) b.filterIds.push(filterId);
  b.enabled[filterId] = enabled;
  return true;
}

/** Remove a filter from a view. */
export function removeFilterFromView(viewId: string, filterId: string): boolean {
  const b = viewBindings.get(viewId);
  if (!b) return false;
  b.filterIds = b.filterIds.filter((f) => f !== filterId);
  delete b.enabled[filterId];
  return true;
}

/** Toggle a filter's enable state in a view. */
export function toggleFilterInView(viewId: string, filterId: string): boolean {
  const b = viewBindings.get(viewId);
  if (!b || !(filterId in b.enabled)) return false;
  b.enabled[filterId] = !b.enabled[filterId];
  return b.enabled[filterId];
}

/** Evaluate a rule against a set of parameters. */
export function evaluateRule(rule: FilterRule, params: Record<string, string | number>): boolean {
  if (!(rule.parameter in params)) return false;
  const actual = params[rule.parameter];
  if (rule.operator === "equals") return String(actual) === String(rule.value);
  if (rule.operator === "not-equals") return String(actual) !== String(rule.value);
  if (rule.operator === "contains") return String(actual).includes(String(rule.value));
  const numActual = typeof actual === "number" ? actual : parseFloat(String(actual));
  const numValue = typeof rule.value === "number" ? rule.value : parseFloat(String(rule.value));
  if (isNaN(numActual) || isNaN(numValue)) return false;
  if (rule.operator === "greater") return numActual > numValue;
  if (rule.operator === "less") return numActual < numValue;
  if (rule.operator === "between" && rule.upper !== undefined) {
    return numActual >= numValue && numActual <= rule.upper;
  }
  return false;
}

/** Test whether an element matches a filter. */
export function matchesFilter(filter: ViewFilter, category: FilterCategory, params: Record<string, string | number>): boolean {
  if (filter.categories.length && !filter.categories.includes(category)) return false;
  if (filter.rules.length === 0) return true;
  return filter.rules.every((r) => evaluateRule(r, params));
}

/** Resolve the effective override for an element in a view. Returns null if no filter matches. */
export function resolveOverride(viewId: string, category: FilterCategory, params: Record<string, string | number>): GraphicsOverride | null {
  const b = viewBindings.get(viewId);
  if (!b) return null;
  for (const filterId of b.filterIds) {
    const filter = filterRegistry.get(filterId);
    if (!filter) continue;
    if (b.enabled[filterId] && matchesFilter(filter, category, params)) {
      return filter.overrides;
    }
  }
  return null;
}

/** Clear all registries (used in tests). */
export function resetViewFilters(): void {
  filterRegistry.clear();
  viewBindings.clear();
  counter = 0;
}
