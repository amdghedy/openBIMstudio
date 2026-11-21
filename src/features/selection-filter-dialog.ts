/**
 * Selection Filter dialog — Revit 2D environment audit gap G2.
 *
 * Revit's Filter dialog narrows the current selection by category. This is
 * the small, real version: one checkbox per category present in the current
 * selection (authored element types + linked IFC classes), all checked by
 * default; Apply keeps only the checked categories.
 *
 * One-shot, not persistent: unlike the Edit → Selection & Snapping palette
 * (`selection.setFilter`, which also gates future picks), this narrows the
 * current selection only — authored ids via `selectAllAuthored`, fragment
 * ids via the fragment selection service `replace`. It never touches the
 * persistent category filter.
 */
import { ctx } from "../core/context";
import { selectAllAuthored } from "./authoring";
import { selectedAuthored } from "./modify-options";
import {
  categoryLabel,
  filterElementsByCategories,
  filterFragmentIdsByCategories,
  selectionCategories,
  type ModifyTabElement,
} from "../shell/modify-tab-model";
import { openFormModal } from "./form-modal";
import { noteSelectionChange, withSelectionRecordingPaused } from "./select-previous";

function toast(message: string, kind = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

/** Fragment category index for one model: local id → IFC class. */
async function fragmentCategoryMap(modelId: string): Promise<Map<number, string>> {
  const byId = new Map<number, string>();
  try {
    const model: any = (ctx as any).fragments?.list?.get?.(modelId);
    const cats = await model?.getItemsOfCategories?.([/.+/]);
    for (const [category, ids] of Object.entries(cats ?? {})) {
      for (const id of (ids as number[]) ?? []) byId.set(id, category);
    }
  } catch (err) {
    console.warn("[selection-filter] category lookup failed for model", modelId, err);
  }
  return byId;
}

function fragmentSnapshot(): Record<string, Set<number>> {
  try {
    const snap = (ctx.features as any).selection?.snapshot?.() as Record<string, Set<number>> | undefined;
    return snap ?? {};
  } catch {
    return {};
  }
}

/** Categories in the current selection (authored + linked), with counts. */
export async function currentSelectionCategories(): Promise<Array<{ category: string; count: number }>> {
  const elements: ModifyTabElement[] = selectedAuthored().map((e) => ({
    id: e.id,
    category: e.type,
    sourceKind: "native" as const,
  }));
  const snap = fragmentSnapshot();
  for (const [modelId, ids] of Object.entries(snap)) {
    const byId = await fragmentCategoryMap(modelId);
    for (const id of ids) {
      elements.push({ id: `${modelId}:${id}`, category: byId.get(id) ?? "Linked", sourceKind: "linked" });
    }
  }
  return selectionCategories(elements);
}

/**
 * Open the Filter dialog over the current selection. Returns the chosen
 * category names, or null when the dialog was cancelled / nothing is
 * selected.
 */
export async function openSelectionFilterDialog(): Promise<string[] | null> {
  const cats = await currentSelectionCategories();
  if (!cats.length) {
    toast("Nothing selected — select elements first, then Filter.", "warn");
    return null;
  }
  const total = cats.reduce((n, c) => n + c.count, 0);
  const fields = cats.map((c, i) => ({
    kind: "checkbox" as const,
    key: `cat-${i}`,
    label: `${categoryLabel(c.category)} (${c.count})`,
    default: true,
  }));
  const values = await openFormModal({
    title: "Filter Selection",
    subtitle: `Keep only the checked categories — ${total} element${total === 1 ? "" : "s"} selected.`,
    fields,
    submitLabel: "Apply Filter",
  });
  if (!values) return null;
  return cats.filter((_, i) => values[`cat-${i}`] === true).map((c) => c.category);
}

export interface SelectionFilterResult {
  readonly keptAuthored: number;
  readonly keptLinked: number;
  readonly before: number;
}

/**
 * Narrow the current selection to `categories` (matched with the same
 * normalisation as the model: "Walls" matches type "wall" and class
 * "IfcWall"). Returns the kept counts. An empty `categories` list keeps
 * nothing — the caller toasts that the selection was emptied.
 */
export async function applySelectionFilter(chosen: readonly string[]): Promise<SelectionFilterResult> {
  const authored = selectedAuthored();
  const before = authored.length;
  let keptAuthored = 0;
  let keptLinked = 0;
  let beforeLinked = 0;

  // Two-step narrowing (authored, then fragments) runs with previous-
  // selection recording paused so the half-filtered intermediate state
  // never becomes the stored "previous"; the filtered result is recorded
  // once at the end, with the pre-filter selection as previous.
  await withSelectionRecordingPaused(async () => {
    // ── Authored ──
    const kept = filterElementsByCategories(
      authored.map((e) => ({ id: e.id, category: e.type, sourceKind: "native" as const })),
      chosen,
    );
    const keptIds = kept.map((e) => e.id);
    selectAllAuthored(keptIds);
    keptAuthored = keptIds.length;

    // ── Linked / fragment ──
    const snap = fragmentSnapshot();
    const next: Record<string, Set<number>> = {};
    for (const [modelId, ids] of Object.entries(snap)) {
      beforeLinked += ids.size;
      const byId = await fragmentCategoryMap(modelId);
      const keptFrag = filterFragmentIdsByCategories(byId, ids, chosen);
      if (keptFrag.length) next[modelId] = new Set(keptFrag);
      keptLinked += keptFrag.length;
    }
    const sel: any = (ctx.features as any).selection;
    if (Object.keys(snap).length) {
      try {
        sel?.replace?.(next);
        await sel?.applyToHighlighter?.();
      } catch (err) {
        console.warn("[selection-filter] fragment selection replace failed", err);
      }
    }
  });
  noteSelectionChange();

  const keptTotal = keptAuthored + keptLinked;
  const beforeTotal = before + beforeLinked;
  if (keptTotal === 0) toast("Filter kept no elements — selection is now empty.", "warn");
  else toast(`Filter: ${keptTotal} of ${beforeTotal} element${beforeTotal === 1 ? "" : "s"} kept.`, "success");
  return { keptAuthored, keptLinked, before: beforeTotal };
}
