/**
 * Schedule totals policy — which columns may be totalled.
 *
 * Pure module (no DOM, no three.js) so it compiles standalone for unit
 * tests, matching the house pattern of schedule-sheet-layout.ts.
 *
 * Revit semantics: a schedule's totals row sums quantities (Length, Area,
 * Volume, Count, Cost, Weight) but never per-element dimensions — summing
 * every wall's Thickness or Height into a "total height" is meaningless
 * and used to leak into both group subtotals and the grand total row.
 */

/** Keys (lower-cased, non-alphanumerics stripped) that may be summed. */
export const SUMMABLE_KEYS: ReadonlySet<string> = new Set([
  "length",
  "area",
  "volume",
  "netarea",
  "count",
  "qty",
  "quantity",
  "linecost",
  "total",
  "cost",
  "weight",
  "mass",
  "runtime",
  "costtotal",
]);

export interface TotalableColumn {
  key: string;
  format?: string;
}

/**
 * True when the column may appear in a totals row.
 *  - text / date columns are never totalled;
 *  - formula columns (derived quantities such as "[Area] * 0.85") are
 *    treated as summable — they are computed from quantity columns;
 *  - everything else must be a known quantity key.
 */
export function isSummableColumn(col: TotalableColumn): boolean {
  if (col.format === "text" || col.format === "date") return false;
  if (col.format === "formula") return true;
  const k = col.key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SUMMABLE_KEYS.has(k);
}

/** Filter a definition's columns down to the ones a totals row may sum. */
export function summableColumnKeys(
  columns: TotalableColumn[],
): string[] {
  return columns.filter(isSummableColumn).map((c) => c.key);
}
