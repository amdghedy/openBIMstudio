/**
 * Unified select-all.
 *
 * The Fragment selection manager handles model elements; authored elements
 * are tracked separately in authoring.ts. This module selects both in one
 * call so a user pressing Ctrl+A (or clicking the ribbon button) gets
 * everything visible — model elements from every loaded model AND every
 * natively drawn element.
 */
import { ctx } from "../core/context";
import { selection } from "./selection";
import { getElements, selectAllAuthored } from "./authoring";

export interface SelectAllResult {
  fragments: number;
  authored: number;
  models: number;
}

export async function selectAllObjects(): Promise<SelectAllResult> {
  let fragments = 0;
  let models = 0;

  // ── 1. Every element in every loaded fragments model ──
  try {
    await selection.selectAll();
    fragments = selection.size();
    models = selection.modelCount();
  } catch (err) {
    console.warn("[select-all] fragments failed", err);
  }

  // ── 2. Every authored element ──
  let authored = 0;
  try {
    const ids = getElements().map((e) => e.id);
    selectAllAuthored(ids);
    authored = ids.length;
  } catch (err) {
    console.warn("[select-all] authored failed", err);
  }

  return { fragments, authored, models };
}

/** Clear both selection systems in one call. */
export async function clearAllSelection(): Promise<void> {
  try {
    selection.clear();
    await selection.applyToHighlighter();
  } catch {
    /* */
  }
  try {
    selectAllAuthored([]);
  } catch {
    /* */
  }
}

/**
 * Select only the authored elements (all of them). Handy for cost takeoff
 * workflows where you want to see only what was drawn in-app.
 */
export function selectAllAuthoredOnly(): number {
  const ids = getElements().map((e) => e.id);
  selectAllAuthored(ids);
  return ids.length;
}