/**
 * Selection Filter dialog, Select All Instances and Select Previous
 * (Revit 2D gap G4, shared by the plan view, the 3D viewport context
 * menu and the Modify tab — G2 surfaces the same commands).
 *
 * All three operate on the MIXED selection: authored elements
 * (authoring.ts) plus fragment elements (selection manager). The pure
 * rules live in selection-semantics.ts; this module only gathers the
 * two sides, shows the dialog, and applies the result.
 */
import { selection, type SelectionSnapshot } from "./selection";
import {
  getElements,
  getElementById,
  getSelectedIds,
  setSelectedAuthored,
  selectPreviousAuthored,
  hasPreviousAuthoredSelection,
} from "./authoring";
import { openFormModal } from "./form-modal";
import { notify } from "../core/notify";
import {
  categoryOfAuthored,
  filterSelectionByCategories,
  selectAllInstances,
  selectionCategories,
  type InstanceScope,
  type SelectionItem,
} from "./selection-semantics";

function toast(message: string, kind: "info" | "success" | "warn" | "error" = "info"): void {
  try {
    notify(kind, message);
  } catch {
    /* notify is best-effort here */
  }
}

function authoredItem(el: {
  id: string;
  type: string;
  familyTypeId?: string;
  properties?: Record<string, unknown> | null;
}): SelectionItem {
  return {
    key: el.id,
    source: "authored",
    category: categoryOfAuthored(el),
    // Revit matches family:type; without a family the element kind is the type.
    type: el.familyTypeId ?? el.type,
    authoredId: el.id,
  };
}

/** The current mixed selection, as SelectionItems. */
export async function currentSelectionItems(): Promise<SelectionItem[]> {
  const items: SelectionItem[] = [];
  for (const id of getSelectedIds()) {
    const el = getElementById(id);
    if (el) items.push(authoredItem(el));
  }
  try {
    items.push(...(await selection.selectionItems()));
  } catch {
    /* fragment side is optional */
  }
  return items;
}

/** Apply a set of SelectionItems as the new mixed selection. */
export async function applySelectionItems(items: readonly SelectionItem[]): Promise<void> {
  const authoredIds = items.filter((i) => i.source === "authored").map((i) => i.authoredId ?? i.key);
  const snap: SelectionSnapshot = {};
  for (const item of items) {
    if (item.source !== "fragment" || item.modelId == null || item.localId == null) continue;
    if (!snap[item.modelId]) snap[item.modelId] = new Set();
    snap[item.modelId].add(item.localId);
  }
  setSelectedAuthored(authoredIds, "replace");
  selection.replace(snap);
  await selection.applyToHighlighter();
}

/**
 * Revit Filter dialog: one checkbox per category present in the current
 * selection, with counts. Submitting narrows the selection to the checked
 * categories (unchecking everything keeps nothing — the dialog warns
 * first). Returns the kept count, or null when cancelled / nothing selected.
 */
export async function openSelectionFilterDialog(): Promise<number | null> {
  const items = await currentSelectionItems();
  if (!items.length) {
    toast("Filter: select elements first", "warn");
    return null;
  }
  const cats = selectionCategories(items);
  const fields = cats.map((c, i) => ({
    kind: "checkbox" as const,
    key: `cat${i}`,
    label: `${c.category} (${c.count})`,
    default: true,
  }));
  const values = await openFormModal({
    title: "Filter Selection",
    subtitle: `${items.length} element(s) selected — uncheck a category to remove it from the selection.`,
    fields,
    submitLabel: "Apply Filter",
  });
  if (!values) return null;
  const allowed = cats.filter((_, i) => values[`cat${i}`]).map((c) => c.category);
  if (!allowed.length) {
    toast("Filter: nothing kept — all categories unchecked", "warn");
    return 0;
  }
  const kept = filterSelectionByCategories(items, allowed);
  await applySelectionItems(kept);
  toast(`Filter: ${kept.length} of ${items.length} element(s) kept`, "success");
  return kept.length;
}

/**
 * Revit "Select All Instances": every element sharing the seed element's
 * category + type (family:type for authored, IFC class for fragments).
 * The seed is the first selected element (authored first, else fragment).
 *
 * Scope: "project" selects in the entire project. "view" restricts the
 * result to `visibleKeys` — the caller must pass the ids visible in the
 * current view; without a visible set the "view" scope falls back to the
 * whole project and the caller must say so (the 3D viewport has no
 * per-view visibility query for fragments, so its menu entry is
 * entire-project; the plan view passes its rendered element ids).
 */
export async function selectAllInstancesCombined(options?: {
  scope?: InstanceScope;
  visibleAuthoredIds?: ReadonlySet<string>;
  visibleFragmentKeys?: ReadonlySet<string>;
}): Promise<number> {
  const scope = options?.scope ?? "project";
  const selected = await currentSelectionItems();
  if (!selected.length) {
    toast("Select All Instances: select an element first", "warn");
    return 0;
  }
  const seed = selected[0];
  const catalog: SelectionItem[] = getElements().map((el) => authoredItem(el as any));
  try {
    catalog.push(...(await selection.fragmentCatalog()));
  } catch {
    /* fragment side is optional */
  }
  const suppliedVisible = [
    ...(options?.visibleAuthoredIds ?? []),
    ...(options?.visibleFragmentKeys ?? []),
  ];
  // No visible set supplied: "view" falls back to the whole project (the
  // shared query's contract) and the toast below says so.
  const visible = scope === "view" && suppliedVisible.length ? new Set<string>(suppliedVisible) : null;
  const matches = selectAllInstances(catalog, seed.key, scope, visible);
  await applySelectionItems(matches);
  toast(
    `Select All Instances: ${matches.length} ${seed.category} element(s)` +
      (scope === "view" && !visible ? " (entire project — no view query)" : scope === "view" ? " (visible in view)" : " (entire project)"),
    "success",
  );
  return matches.length;
}

/**
 * Revit "Select Previous" (Ctrl+Left): restore the selection in place
 * before the last change, on both the authored and fragment sides.
 * When the plan view is open it owns the selection, so the plan's own
 * restore runs instead. Returns true when something was restored.
 */
export async function selectPreviousCombined(): Promise<boolean> {
  // When the plan view is open it owns the selection, so the plan's own
  // restore is the whole answer (it toasts when there is nothing to restore).
  try {
    if ((window as any).__obsPlanVisible?.()) {
      const planRestore = (window as any).__obsPlanSelectPrevious as (() => boolean) | undefined;
      if (typeof planRestore === "function") return planRestore();
    }
  } catch {
    /* plan hook is optional */
  }
  const hadAuthored = hasPreviousAuthoredSelection();
  const hadFragments = selection.hasPreviousSelection();
  if (!hadAuthored && !hadFragments) {
    toast("Select Previous: no previous selection", "warn");
    return false;
  }
  if (hadAuthored) selectPreviousAuthored();
  if (hadFragments) await selection.selectPrevious();
  toast("Previous selection restored", "success");
  return true;
}
