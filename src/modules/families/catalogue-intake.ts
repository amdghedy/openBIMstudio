/**
 * Catalogue intake primitives for the BIM Family Generator.
 *
 * This module deliberately produces the existing FamilyDefinition contract;
 * it does not introduce a parallel family store or geometry kernel.
 * CSV/TSV ingestion is deterministic and local. OCR/PDF/CAD extraction is
 * handled by later importer adapters and must never fabricate values.
 */
import type { FamilyDefinition, FamilyParameter, FamilyType } from "./types";

export interface CatalogueRow {
  model: string;
  manufacturer?: string;
  productCode?: string;
  width?: number;
  depth?: number;
  height?: number;
  airflow?: number;
  staticPressure?: number;
  power?: number;
  voltage?: number;
  [key: string]: string | number | undefined;
}

export interface CatalogueParseResult {
  headers: string[];
  rows: CatalogueRow[];
  errors: string[];
}

const HEADER_ALIASES: Record<string, keyof CatalogueRow> = {
  model: "model", modelnumber: "model", modelno: "model", type: "model", typename: "model",
  manufacturer: "manufacturer", brand: "manufacturer",
  productcode: "productCode", itemcode: "productCode", sku: "productCode",
  width: "width", w: "width", depth: "depth", d: "depth", length: "depth",
  height: "height", h: "height",
  airflow: "airflow", airvolume: "airflow", flow: "airflow",
  staticpressure: "staticPressure", pressure: "staticPressure", externalstaticpressure: "staticPressure",
  power: "power", inputpower: "power", kw: "power",
  voltage: "voltage", volt: "voltage",
};

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** RFC-4180-style delimiter parser supporting quoted fields and escaped quotes. */
export function parseDelimitedCatalogue(source: string, delimiter?: string): CatalogueParseResult {
  const text = String(source ?? "").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = delimiter ?? (firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",");
  const matrix: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.length === 0) quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n") { row.push(cell.trim().replace(/\r$/, "")); matrix.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (quoted) return { headers: [], rows: [], errors: ["Catalogue contains an unterminated quoted field."] };
  if (cell.length || row.length) { row.push(cell.trim().replace(/\r$/, "")); matrix.push(row); }
  const nonEmpty = matrix.filter((r) => r.some((v) => v.trim() !== ""));
  if (nonEmpty.length < 2) return { headers: [], rows: [], errors: ["Catalogue must contain a header row and at least one product row."] };
  const headers = nonEmpty[0].map((h) => h.trim());
  const mapped = headers.map((h) => HEADER_ALIASES[normalizedHeader(h)]);
  const modelIndex = mapped.indexOf("model");
  if (modelIndex < 0) return { headers, rows: [], errors: ["A Model, Model Number, Type or Type Name column is required."] };
  const errors: string[] = [];
  const rows: CatalogueRow[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cells = nonEmpty[r];
    const item: CatalogueRow = { model: cells[modelIndex] ?? "" };
    if (!item.model.trim()) { errors.push(`Row ${r + 1}: missing model identifier; row skipped.`); continue; }
    for (let c = 0; c < mapped.length; c++) {
      const key = mapped[c];
      if (!key || key === "model") continue;
      const raw = cells[c] ?? "";
      if (!raw) continue;
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const n = Number(raw.replace(/,/g, ""));
        if (!Number.isFinite(n) || n < 0) { errors.push(`Row ${r + 1}: invalid numeric value for ${headers[c]}.`); continue; }
        item[key] = n;
      } else item[key] = raw;
    }
    rows.push(item);
  }
  return { headers, rows, errors };
}

function dimensionToMetres(value: number | undefined, sourceUnit: string): number {
  if (value === undefined) return 1;
  const unit = sourceUnit.toLowerCase();
  if (unit === "mm" || unit === "millimetres" || unit === "millimeters") return value / 1000;
  if (unit === "cm" || unit === "centimetres" || unit === "centimeters") return value / 100;
  return value;
}

export interface CatalogueFamilyOptions {
  name: string;
  category?: FamilyDefinition["category"];
  dimensionUnit?: "mm" | "cm" | "m";
  ifcEntity?: string;
}

/** Convert reviewed catalogue rows into the platform's existing family schema. */
export function buildCatalogueFamilyDefinition(
  rows: CatalogueRow[],
  options: CatalogueFamilyOptions,
): Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn"> {
  if (!rows.length) throw new Error("At least one reviewed catalogue product is required.");
  const name = options.name.trim();
  if (!name) throw new Error("Family name is required.");
  const unit = options.dimensionUnit ?? "mm";
  const first = rows[0];
  const parameters: FamilyParameter[] = [
    { name: "Width", type: "length", scope: "type", default: dimensionToMetres(first.width, unit), editable: true, unit: "m", group: "Dimensions" },
    { name: "Depth", type: "length", scope: "type", default: dimensionToMetres(first.depth, unit), editable: true, unit: "m", group: "Dimensions" },
    { name: "Height", type: "length", scope: "type", default: dimensionToMetres(first.height, unit), editable: true, unit: "m", group: "Dimensions" },
    { name: "Manufacturer", type: "text", scope: "type", default: first.manufacturer ?? "", editable: true, group: "Identity" },
    { name: "ProductCode", type: "text", scope: "type", default: first.productCode ?? "", editable: true, group: "Identity" },
    { name: "Airflow", type: "number", scope: "type", default: first.airflow ?? 0, editable: true, unit: "m³/h", group: "Performance" },
    { name: "StaticPressure", type: "number", scope: "type", default: first.staticPressure ?? 0, editable: true, unit: "Pa", group: "Performance" },
    { name: "Power", type: "number", scope: "type", default: first.power ?? 0, editable: true, unit: "kW", group: "Electrical" },
    { name: "Voltage", type: "number", scope: "type", default: first.voltage ?? 0, editable: true, unit: "V", group: "Electrical" },
  ];
  const types: FamilyType[] = rows.map((r, index) => ({
    id: `catalogue-type-${index + 1}`,
    name: r.model.trim(),
    values: {
      Width: dimensionToMetres(r.width, unit),
      Depth: dimensionToMetres(r.depth, unit),
      Height: dimensionToMetres(r.height, unit),
      Manufacturer: r.manufacturer ?? first.manufacturer ?? "",
      ProductCode: r.productCode ?? "",
      Airflow: r.airflow ?? 0,
      StaticPressure: r.staticPressure ?? 0,
      Power: r.power ?? 0,
      Voltage: r.voltage ?? 0,
    },
  }));
  const uniqueTypes = new Set(types.map((t) => t.name.toLowerCase()));
  if (uniqueTypes.size !== types.length) throw new Error("Duplicate model names detected. Resolve duplicate catalogue types before creating the family.");
  return {
    name,
    category: options.category ?? "equipment",
    ifcEntity: options.ifcEntity ?? "IfcUnitaryEquipment",
    parameters,
    geometry: { kind: "box", w: { ref: "Width" }, d: { ref: "Depth" }, h: { ref: "Height" } },
    types,
    group: first.manufacturer ? `Manufacturer: ${first.manufacturer}` : "Catalogue imports",
  };
}

/** Basic completeness checks; missing catalogue values are warnings, not invented defaults. */
export function validateCatalogueRows(rows: CatalogueRow[]): string[] {
  const issues: string[] = [];
  if (!rows.length) return ["No product rows were extracted."];
  rows.forEach((r, i) => {
    for (const key of ["width", "depth", "height"] as const) {
      if (r[key] === undefined) issues.push(`Row ${i + 1} (${r.model}): ${key} is missing; preview geometry will use a 1 m fallback until corrected.`);
      else if (r[key] <= 0) issues.push(`Row ${i + 1} (${r.model}): ${key} must be greater than zero.`);
    }
  });
  return issues;
}
