/**
 * Shared selection semantics (Revit 2D gap G4).
 *
 * Pure, dependency-free helpers used by the plan view, the 3D fragment
 * selection manager, the context menu and the Filter dialog, so the same
 * rules apply everywhere and the Modify tab (G2) can converge onto them:
 *
 * - Revit click modifiers: Ctrl/Cmd adds (+), Shift removes (−), a plain
 *   click replaces. Alt is kept as a remove alias, matching the 3D click
 *   path's long-standing behaviour.
 * - Select Previous: a snapshot store that remembers the selection before
 *   the last change and restores it (restoring swaps, so a second press
 *   toggles back).
 * - Filter: category counts over a mixed authored + fragment selection,
 *   and narrowing that selection to the checked categories.
 * - Select All Instances: every element sharing the seed element's
 *   category + type, optionally restricted to a visible-in-view set.
 *
 * No DOM, no THREE, no app imports: this module compiles standalone and
 * is unit-tested directly (tests/selection-semantics.test.cjs).
 */

export type ClickMode = "replace" | "add" | "remove" | "toggle";

export interface ClickMods {
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Revit click semantics. Ctrl/Cmd adds; Shift removes (and wins over Ctrl
 * when both are held — Shift is the explicit "take away" gesture); Alt
 * removes like Shift; otherwise the click replaces the selection.
 */
export function resolveClickMode(mods: ClickMods): "replace" | "add" | "remove" {
  if (mods.shift || mods.alt) return "remove";
  if (mods.ctrl || mods.meta) return "add";
  return "replace";
}

/** Apply one click-mode operation to a set of selected ids. Pure. */
export function applyClickToSet<T>(set: Set<T>, id: T, mode: ClickMode): Set<T> {
  const next = new Set(set);
  if (mode === "replace") {
    next.clear();
    next.add(id);
  } else if (mode === "add") {
    next.add(id);
  } else if (mode === "remove") {
    next.delete(id);
  } else if (mode === "toggle") {
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** Apply a click mode to many ids at once (box selection). Pure. */
export function applyClickToMany<T>(set: Set<T>, ids: Iterable<T>, mode: "replace" | "add" | "remove"): Set<T> {
  const next = mode === "replace" ? new Set<T>() : new Set(set);
  for (const id of ids) {
    if (mode === "remove") next.delete(id);
    else next.add(id);
  }
  return next;
}

function sameIdList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

/**
 * Previous-selection store. `note()` snapshots the current selection
 * before a change (no-op when nothing changed, so repeated no-op commits
 * cannot overwrite a meaningful previous set); `restore()` returns the
 * stored snapshot and swaps it with the current one, so pressing
 * Select Previous twice toggles between the two sets.
 */
export class PreviousSelectionStore<T> {
  private previous: T[] | null = null;

  /** Remember `current` as the previous selection, ahead of a change. */
  note(current: readonly T[]): void {
    if (this.previous !== null && sameIdList(this.previous, current)) return;
    this.previous = [...current];
  }

  hasPrevious(): boolean {
    // An empty previous set is a real restore target (it clears the
    // selection); only "never noted" means nothing to restore.
    return this.previous !== null;
  }

  peekPrevious(): T[] | null {
    return this.previous === null ? null : [...this.previous];
  }

  /**
   * Restore the previous selection. Returns null when there is nothing to
   * restore. `current` becomes the new previous set (swap / toggle).
   */
  restore(current: readonly T[]): T[] | null {
    if (this.previous === null) return null;
    const prev = this.previous;
    this.previous = [...current];
    return [...prev];
  }

  clear(): void {
    this.previous = null;
  }
}

/** One selectable element, authored or fragment, for filter / instance queries. */
export interface SelectionItem {
  /** Stable key: authored id, or `modelId:localId` for a fragment. */
  key: string;
  source: "authored" | "fragment";
  /** Category as shown in the Filter dialog (authored type, or IFC class). */
  category: string;
  /** Family / type name within the category ("Basic Wall", "W1", …). */
  type: string;
  /** Authored element id, when source is "authored". */
  authoredId?: string;
  /** Fragment model id / local id, when source is "fragment". */
  modelId?: string;
  localId?: number;
}

/** Category label for an authored element: its type, else its IFC class. */
export function categoryOfAuthored(el: {
  type?: string;
  properties?: Record<string, unknown> | null;
}): string {
  const props = el.properties ?? {};
  const raw =
    (typeof el.type === "string" && el.type) ||
    (typeof props.ifcType === "string" && props.ifcType) ||
    (typeof props.ifcEntity === "string" && props.ifcEntity) ||
    (typeof props.ifcClass === "string" && props.ifcClass) ||
    "unknown";
  return raw;
}

/**
 * Normalise a category for comparison: "IfcWall", "ifc-wall" and "wall"
 * are the same category. Mirrors the normaliser already used by the
 * fragment selection manager.
 */
export function normalizeSelectionCategory(value: string): string {
  return value.trim().toLowerCase().replace(/^ifc/, "").replace(/[^a-z0-9]/g, "");
}

export function categoriesMatch(a: string, b: string): boolean {
  return normalizeSelectionCategory(a) === normalizeSelectionCategory(b);
}

export interface CategoryCount {
  category: string;
  count: number;
}

/** Categories present in a selection, with counts, most-common first. */
export function selectionCategories(items: readonly SelectionItem[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.category || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

/** Narrow a selection to the given categories (empty list keeps nothing). */
export function filterSelectionByCategories(
  items: readonly SelectionItem[],
  allowedCategories: readonly string[],
): SelectionItem[] {
  if (!allowedCategories.length) return [];
  const allowed = allowedCategories.map(normalizeSelectionCategory);
  return items.filter((item) => allowed.includes(normalizeSelectionCategory(item.category)));
}

export type InstanceScope = "project" | "view";

/**
 * Select All Instances: every catalogued element sharing the seed's
 * category AND type. With scope "view" the result is restricted to
 * `visibleKeys` (the ids visible in the current view); without a visible
 * set, "view" falls back to the whole catalog — callers that offer a
 * "Visible in View" entry must pass the view's ids, and say so when they
 * cannot. Returns the matching items (seed included).
 */
export function selectAllInstances(
  catalog: readonly SelectionItem[],
  seedKey: string,
  scope: InstanceScope = "project",
  visibleKeys?: ReadonlySet<string> | null,
): SelectionItem[] {
  const seed = catalog.find((item) => item.key === seedKey);
  if (!seed) return [];
  const visible = scope === "view" ? visibleKeys ?? null : null;
  return catalog.filter(
    (item) =>
      categoriesMatch(item.category, seed.category) &&
      item.type === seed.type &&
      (visible === null || visible.has(item.key)),
  );
}
