// Free family creator: a generic catalogue size table reader (data-driven).
//
// A catalogue sheet often has one header line that names the size columns and then one line per
// dimension, starting with a row key (A, B, C, W, D, H ...) followed by one number per column.
// This reader is driven by a TableProfile (header words, column count, row keys, unit scale) instead
// of code, so a new sheet layout is a new profile, not a new reader. Like the booster reader it
// returns EVERY column and never picks one. Units come from the profile and are labelled as the
// profile's own assumption (`unitBasis`). Unreadable tables return ok false with the reason.

import type { ProductSpec } from "./build";

export interface TableProfile {
  /** A line starting with this text holds the column labels (the rest of the line, split on spaces). */
  headerPrefix: string;
  columnCount: number;
  /** Row keys to read. A cell marked "x" means the sheet gives no value for that column. */
  rowKeys: string[];
  /** Rows that must exist for the table to count as read. */
  requiredRows: string[];
  /** Metres per sheet unit (0.0254 for inches, 0.001 for mm). */
  metresPerUnit: number;
  /** Shown to the user: where the unit comes from and that it is an assumption when the sheet has no unit column. */
  unitBasis: string;
}

export interface TableColumn { id: string; label: string; rows: Record<string, number> }

export interface TableSheet {
  ok: boolean;
  reason?: string;
  unitBasis: string;
  metresPerUnit: number;
  columns: TableColumn[];
  /** Page and line (1-based) of the header and of each row, for a Sources view. */
  lines: Record<string, { page: number; line: number }>;
}

const num = (s: string): number | null => (/^\d+(\.\d+)?$/.test(s) ? Number(s) : null);

export function readDimensionTable(pages: string[], profile: TableProfile): TableSheet {
  const empty = (reason: string): TableSheet => ({ ok: false, reason, unitBasis: profile.unitBasis, metresPerUnit: profile.metresPerUnit, columns: [], lines: {} });
  const lines: TableSheet["lines"] = {};
  let labels: string[] | null = null;
  const rows: Record<string, string[]> = {};
  const n = profile.columnCount;
  for (let p = 0; p < pages.length; p++) {
    const ls = pages[p].split("\n");
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i].trim();
      const where = { page: p + 1, line: i + 1 };
      if (!labels && line.startsWith(profile.headerPrefix)) {
        const toks = line.slice(profile.headerPrefix.length).trim().split(/\s+/);
        if (toks.length >= n) { labels = toks.slice(0, n); lines.header = where; }
        continue;
      }
      const toks = line.split(/\s+/);
      if (profile.rowKeys.includes(toks[0]) && !rows[toks[0]] && toks.length >= n + 1) {
        const vals = toks.slice(1, n + 1);
        if (vals.every((v) => num(v) !== null || v === "x")) { rows[toks[0]] = vals; lines[toks[0]] = where; }
      }
    }
  }
  if (!labels) return empty(`The header line starting "${profile.headerPrefix}" with ${n} columns was not found.`);
  for (const k of profile.requiredRows) if (!rows[k]) return empty(`Row ${k} was not found in the table.`);
  const seen = new Set<string>();
  const columns: TableColumn[] = labels.map((label, c) => {
    let id = label; for (let k = 2; seen.has(id); k++) id = `${label}#${k}`;
    seen.add(id);
    const r: Record<string, number> = {};
    for (const [k, vals] of Object.entries(rows)) { const v = num(vals[c]); if (v !== null) r[k] = v; }
    return { id, label, rows: r };
  });
  return { ok: true, unitBasis: profile.unitBasis, metresPerUnit: profile.metresPerUnit, columns, lines };
}

export interface TableMapping {
  templateId: NonNullable<ProductSpec["templateId"]>;
  manufacturer?: string;
  model?: string;
  /** Row key for overall width, depth and height. */
  width: string; depth: string; height: string;
  /** Row key -> template parameter name (value converted to metres). Rows with no value for the column are skipped. */
  params?: Record<string, string>;
}

export interface TableSpecResult { spec: ProductSpec; provenance: Array<{ param: string; valueM: number; source: string }> }

/** One column plus a mapping becomes a ProductSpec. Throws when the column or a mapped size row is missing. */
export function specFromTable(sheet: TableSheet, columnId: string, map: TableMapping, name?: string): TableSpecResult {
  if (!sheet.ok) throw new Error(sheet.reason ?? "Sheet not read");
  const col = sheet.columns.find((c) => c.id === columnId);
  if (!col) throw new Error(`No such column: ${columnId}`);
  const prov: TableSpecResult["provenance"] = [];
  const take = (param: string, row: string, required: boolean): number | undefined => {
    const v = col.rows[row];
    if (v === undefined) { if (required) throw new Error(`Row ${row} has no value for ${col.id}`); return undefined; }
    const m = v * sheet.metresPerUnit;
    prov.push({ param, valueM: m, source: `sheet row ${row}, ${col.id}` });
    return m;
  };
  const widthM = take("Width", map.width, true)!, depthM = take("Depth", map.depth, true)!, heightM = take("Height", map.height, true)!;
  const params: Record<string, number> = {};
  for (const [row, param] of Object.entries(map.params ?? {})) { const m = take(param, row, false); if (m !== undefined) params[param] = m; }
  return { spec: { name: name ?? `${map.model ?? "Product"} ${col.label}`, manufacturer: map.manufacturer, model: map.model, widthM, depthM, heightM, templateId: map.templateId, params }, provenance: prov };
}
