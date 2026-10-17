/**
 * Type Catalog - Revit-style .txt type catalogs for family types.
 *
 * Format (tab-separated):
 *   ,Width##length##meters,Height##length##meters,LeafCount##other##
 *   900 x 2100,0.9,2.1,1
 *   1000 x 2100,1.0,2.1,1
 *
 * First column = type name; header row declares parameter names + units.
 */

import { ctx } from "../../core/context";
import type { FamilyType } from "../families/types";

export interface CatalogColumn {
  name: string;
  unitType: string; // length | other | angle | ...
  unit: string;     // meters | millimeters | ...
}

export interface TypeCatalog {
  familyName: string;
  columns: CatalogColumn[];
  rows: Array<{ typeName: string; values: Record<string, number | string | boolean> }>;
}

function parseHeaderCell(cell: string): CatalogColumn | null {
  // Width##length##meters
  const parts = cell.split("##");
  if (!parts[0] || parts[0].trim() === "") return null;
  return {
    name: parts[0].trim(),
    unitType: (parts[1] ?? "other").trim(),
    unit: (parts[2] ?? "").trim(),
  };
}

function coerce(raw: string, col: CatalogColumn): number | string | boolean {
  const s = raw.trim();
  if (col.unitType === "yesno" || col.unitType === "boolean") {
    return /^(1|true|yes)$/i.test(s);
  }
  if (col.unitType === "length" || col.unitType === "number" || col.unitType === "integer") {
    let n = Number(s);
    if (!Number.isFinite(n)) return s;
    // Convert common units - metres
    const u = col.unit.toLowerCase();
    if (u === "millimeters" || u === "mm") n = n / 1000;
    else if (u === "centimeters" || u === "cm") n = n / 100;
    else if (u === "feet" || u === "ft") n = n * 0.3048;
    else if (u === "inches" || u === "in") n = n * 0.0254;
    if (col.unitType === "integer") n = Math.round(n);
    return n;
  }
  return s;
}

/**
 * Parse a Revit-compatible type catalog text.
 */
export function parseTypeCatalog(text: string, familyName = ""): TypeCatalog {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !l.startsWith("#"));

  if (!lines.length) {
    return { familyName, columns: [], rows: [] };
  }

  const headerCells = lines[0].split("\t");
  const columns: CatalogColumn[] = [];
  // First header cell is typically empty (type name column)
  for (let i = 1; i < headerCells.length; i++) {
    const col = parseHeaderCell(headerCells[i]);
    if (col) columns.push(col);
  }

  const rows: TypeCatalog["rows"] = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = lines[r].split("\t");
    const typeName = (cells[0] ?? `Type ${r}`).trim();
    const values: Record<string, number | string | boolean> = {};
    for (let c = 0; c < columns.length; c++) {
      const raw = cells[c + 1] ?? "";
      if (raw === "") continue;
      values[columns[c].name] = coerce(raw, columns[c]);
    }
    rows.push({ typeName, values });
  }

  return { familyName, columns, rows };
}

/**
 * Serialize family types to a type catalog text.
 */
export function exportTypeCatalog(
  familyName: string,
  types: FamilyType[],
  columns: CatalogColumn[],
): string {
  const header = [""].concat(
    columns.map((c) => `${c.name}##${c.unitType}##${c.unit}`),
  );
  const lines = [header.join("\t")];
  for (const t of types) {
    const cells = [t.name];
    for (const c of columns) {
      const v = t.values[c.name];
      cells.push(v == null ? "" : String(v));
    }
    lines.push(cells.join("\t"));
  }
  return lines.join("\n");
}

/**
 * Apply a catalog to a family: create/update types by name.
 */
export function applyCatalogToFamily(
  catalog: TypeCatalog,
  existingTypes: FamilyType[],
  createType: (name: string, values: Record<string, any>) => FamilyType | null,
  updateType: (typeId: string, values: Record<string, any>) => void,
): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  const byName = new Map(existingTypes.map((t) => [t.name, t]));

  for (const row of catalog.rows) {
    const existing = byName.get(row.typeName);
    if (existing) {
      updateType(existing.id, { ...existing.values, ...row.values });
      updated++;
    } else {
      const t = createType(row.typeName, row.values);
      if (t) created++;
    }
  }
  return { created, updated };
}

export function setupTypeCatalog(): void {
  const api = { parseTypeCatalog, exportTypeCatalog, applyCatalogToFamily };
  (ctx.features as any).typeCatalog = api;
  (window as any).__obsTypeCatalog = api;
  console.log("[type-catalog] ready");
}
