/**
 * Catalogue intake primitives for the BIM Family Generator.
 *
 * This module deliberately produces the existing FamilyDefinition contract;
 * it does not introduce a parallel family store or geometry kernel.
 * CSV/TSV ingestion is deterministic and local. OCR/PDF/CAD extraction is
 * handled by later importer adapters and must never fabricate values.
 */
import type { FamilyDefinition, FamilyParameter, FamilyType } from "./types";
import { buildCatalogueConnectorDefinitions } from "./catalogue-connector-mapping";

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

type CatalogueField = "model" | "manufacturer" | "productCode" | "width" | "depth" | "height" | "airflow" | "staticPressure" | "power" | "voltage";

const HEADER_ALIASES: Record<string, CatalogueField> = {
  model: "model", modelnumber: "model", modelno: "model", type: "model", typename: "model",
  manufacturer: "manufacturer", brand: "manufacturer",
  productcode: "productCode", itemcode: "productCode", sku: "productCode",
  width: "width", w: "width", overallwidth: "width", overallw: "width", depth: "depth", d: "depth", overalldepth: "depth", length: "depth",
  height: "height", h: "height", overallheight: "height", overallh: "height",
  airflow: "airflow", airflowrate: "airflow", airvolume: "airflow", volumeflow: "airflow", volumeflowrate: "airflow", flow: "airflow",
  airflowratels: "airflow", volumeflowratels: "airflow", flowratels: "airflow", airflowls: "airflow", volumeflowls: "airflow", flowls: "airflow",
  staticpressure: "staticPressure", pressure: "staticPressure", externalstaticpressure: "staticPressure", esp: "staticPressure",
  power: "power", inputpower: "power", totalinputpower: "power", ratedpower: "power", kw: "power",
  voltage: "voltage", supplyvoltage: "voltage", ratedvoltage: "voltage", nominalvoltage: "voltage", volt: "voltage",
};

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePerformanceValue(value: number, header: string, field: CatalogueField): number {
  const unit = normalizedHeader(header);
  if (field === "airflow") {
    const raw = header.toLowerCase().replace(/[^a-z0-9³]/g, "");
    if (/(m3s|m³s)$/.test(raw)) return value * 3600;
    if (/(ls|lps|litrespersecond|literspersecond)$/.test(unit)) return value * 3.6;
  }
  if (field === "staticPressure" && /kpa$/.test(unit)) return value * 1000;
  if (field === "power" && /(watt|watts|w)$/.test(unit) && !/kw$/.test(unit)) return value / 1000;
  if (field === "voltage" && /kv$/.test(unit)) return value * 1000;
  return value;
}

/** Resolve common manufacturer column headings to the canonical family field. */
export function mapCatalogueHeader(value: string): CatalogueField | undefined {
  const key = normalizedHeader(value).replace(/(millimeters|millimetres|mm|centimeters|centimetres|cm|meters|metres|m3h|m3hr|m³h|m3s|m³s|litrespersecond|literspersecond|kpa|pa|kw|watts|watt|w|kv|volt|volts|v)$/i, "");
  return HEADER_ALIASES[normalizedHeader(value)] ?? HEADER_ALIASES[key];
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
  const mapped = headers.map((h) => mapCatalogueHeader(h));
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
      if (key === "model") continue;
      const raw = cells[c] ?? "";
      if (!key) { if (raw) (item as Record<string, string | number | undefined>)[headers[c]] = raw; continue; }
      if (!raw) continue;
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const n = Number(raw.replace(/,/g, ""));
        if (!Number.isFinite(n) || n < 0) { errors.push(`Row ${r + 1}: invalid numeric value for ${headers[c]}.`); continue; }
        (item as Record<string, string | number | undefined>)[key] = normalizePerformanceValue(n, headers[c], key);
      } else (item as Record<string, string | number | undefined>)[key] = raw;
    }
    rows.push(item);
  }
  return { headers, rows, errors };
}

function dimensionToMetres(value: number | undefined, sourceUnit: string): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error("Width, depth and height must all be supplied as finite positive values before family creation.");
  }
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
  const validationIssues = validateCatalogueRows(rows);
  if (validationIssues.length) {
    throw new Error("Catalogue QA must be resolved before family creation:\n" + validationIssues.map((issue) => "- " + issue).join("\n"));
  }
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
    connectorDefs: buildCatalogueConnectorDefinitions([r], unit),
  }));
  const uniqueTypes = new Set(types.map((t) => t.name.toLowerCase()));
  if (uniqueTypes.size !== types.length) throw new Error("Duplicate model names detected. Resolve duplicate catalogue types before creating the family.");
  const geometryProfiles = rows.map((row) => {
    const entry = Object.entries(row).find(([key]) => ["geometryprofile", "productgeometry", "geometrykind"].includes(normalizedHeader(key)));
    const raw = String(entry?.[1] ?? "box").trim().toLowerCase();
    if (["box", "rectangular", "rectangular-prism"].includes(raw)) return "box";
    if (["cylinder", "cylindrical", "round"].includes(raw)) return "cylinder";
    throw new Error("Unsupported catalogue geometry profile: " + raw + ". Use box or cylinder.");
  });
  if (geometryProfiles.some((profile) => profile !== geometryProfiles[0])) {
    throw new Error("All product types in one family must use the same explicit geometry profile.");
  }
  const geometry: FamilyDefinition["geometry"] = geometryProfiles[0] === "cylinder"
    ? { kind: "cylinder", r: { expr: "Width / 2" }, h: { ref: "Height" } }
    : { kind: "box", w: { ref: "Width" }, d: { ref: "Depth" }, h: { ref: "Height" } };
  return {
    name,
    category: options.category ?? "equipment",
    ifcEntity: options.ifcEntity ?? "IfcUnitaryEquipment",
    parameters,
    geometry,
    types,
    group: first.manufacturer ? `Manufacturer: ${first.manufacturer}` : "Catalogue imports",
  };
}

/** Blocking QA checks for identity, duplicate types and geometry-critical dimensions. */
export function validateCatalogueRows(rows: CatalogueRow[]): string[] {
  const issues: string[] = [];
  if (!rows.length) return ["No product rows were extracted."];
  const seenModels = new Set<string>();
  rows.forEach((r, i) => {
    if (!String(r.model ?? "").trim()) issues.push(`Row ${i + 1}: model identifier is required.`);
    const normalizedModel = String(r.model ?? "").trim().toLocaleLowerCase();
    if (normalizedModel && seenModels.has(normalizedModel)) {
      issues.push(`Row ${i + 1} (${r.model}): duplicate model identifier; resolve duplicate variants before family creation.`);
    }
    if (normalizedModel) seenModels.add(normalizedModel);
    for (const key of ["width", "depth", "height"] as const) {
      if (r[key] === undefined) issues.push(`Row ${i + 1} (${r.model}): ${key} is missing; provide a verified value before family creation.`);
      else if (!Number.isFinite(r[key]) || r[key] <= 0) issues.push(`Row ${i + 1} (${r.model}): ${key} must be a finite value greater than zero.`);
    }
  });
  return issues;
}
