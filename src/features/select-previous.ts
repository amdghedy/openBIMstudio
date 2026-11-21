/**
 * Select Previous — Revit 2D environment audit gap G2 (Ctrl+Left in Revit).
 *
 * A single-slot previous-selection store (`PreviousSelectionStore` in
 * `src/shell/modify-tab-model.ts`, unit-tested there). The ribbon records
 * the current selection on every selection change (`noteSelectionChange`,
 * called from `syncContextTab`) and restores the stored snapshot on demand.
 *
 * Two-step restores (authored ids, then fragment ids) are wrapped in
 * `withSelectionRecordingPaused` so the transient half-restored snapshot
 * never becomes the stored "previous" — after the restore, one explicit
 * `noteSelectionChange()` records the restored snapshot as current and the
 * pre-restore selection as previous, so pressing Select Previous twice
 * toggles back.
 *
 * Keyboard binding: NOT registered here. Revit's Ctrl+Left is contested —
 * the arrow-key nudge handler in `src/features/authoring.ts` fires on ANY
 * arrow key (no ctrlKey guard) whenever a selection exists, so Ctrl+Left
 * nudges today. The binding decision belongs to the G8 keyboard worker;
 * the command + ribbon button ship now.
 */
import { ctx } from "../core/context";
import { getElements, selectAllAuthored } from "./authoring";
import { currentSelectionSnapshot } from "./modify-options";
import { PreviousSelectionStore } from "../shell/modify-tab-model";

function toast(message: string, kind = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

export const previousSelection = new PreviousSelectionStore();

let recordingPaused = false;

/** Record the current selection as the store's current snapshot (no-op
 *  while recording is paused for a two-step restore / filter). */
export function noteSelectionChange(): void {
  if (recordingPaused) return;
  try {
    previousSelection.noteCurrent(currentSelectionSnapshot());
  } catch { /* selection not ready yet */ }
}

/** Run `fn` without letting intermediate selection states shift the
 *  previous-selection slot. The caller records the final state afterwards
 *  with `noteSelectionChange()`. */
export async function withSelectionRecordingPaused<T>(fn: () => T | Promise<T>): Promise<T> {
  recordingPaused = true;
  try {
    return await fn();
  } finally {
    recordingPaused = false;
  }
}

export interface RestorePreviousResult {
  readonly restoredAuthored: number;
  readonly restoredLinked: number;
  readonly droppedAuthored: number;
}

/**
 * Restore the stored previous selection. Authored ids that no longer
 * exist (deleted since) are dropped and counted. Returns null when there
 * is no previous selection to restore.
 */
export async function restorePreviousSelection(): Promise<RestorePreviousResult | null> {
  const prev = previousSelection.previousSnapshot;
  if (!prev) {
    toast("No previous selection to restore.", "warn");
    return null;
  }
  const existing = new Set(getElements().map((e) => e.id));
  const authoredIds = prev.authoredIds.filter((id) => existing.has(id));
  const droppedAuthored = prev.authoredIds.length - authoredIds.length;
  let restoredLinked = 0;
  for (const ids of Object.values(prev.linked)) restoredLinked += ids.length;

  await withSelectionRecordingPaused(async () => {
    try {
      selectAllAuthored(authoredIds);
    } catch { /* */ }
    const sel: any = (ctx.features as any).selection;
    try {
      const map: Record<string, Set<number>> = {};
      for (const [modelId, ids] of Object.entries(prev.linked)) {
        if (ids.length) map[modelId] = new Set(ids);
      }
      sel?.replace?.(map);
      await sel?.applyToHighlighter?.();
    } catch { /* */ }
  });
  // Record the restored state as current; the pre-restore selection stays
  // in the previous slot, so a second press toggles back.
  noteSelectionChange();

  const total = authoredIds.length + restoredLinked;
  if (total === 0) {
    toast("Previous selection no longer exists — nothing to restore.", "warn");
  } else {
    toast(
      `Restored previous selection: ${total} element${total === 1 ? "" : "s"}` +
        (droppedAuthored ? ` (${droppedAuthored} deleted element${droppedAuthored === 1 ? "" : "s"} skipped)` : "") +
        ".",
      "success",
    );
  }
  return { restoredAuthored: authoredIds.length, restoredLinked, droppedAuthored };
}
