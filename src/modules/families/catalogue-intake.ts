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

export type CatalogueField = "model" | "manufacturer" | "productCode" | "width" | "depth" | "height" | "airflow" | "staticPressure" | "power" | "voltage";

export interface CatalogueMappingSuggestion {
  sourceHeader: string;
  suggestedField: CatalogueField | null;
  confidence: "high" | "medium" | "none";
  reason: string;
}

export type CatalogueMappingOverrides = Record<string, CatalogueField | null>;
export interface CatalogueMappingProfile {
  schemaVersion: 1;
  name: string;
  manufacturer?: string;
  mappings: CatalogueMappingOverrides;
  updatedAt: string;
}

const CATALOGUE_FIELDS = new Set<CatalogueField>([
  "model", "manufacturer", "productCode", "width", "depth", "height",
  "airflow", "staticPressure", "power", "voltage",
]);

/** Validate imported/shared mapping profiles before they can affect catalogue parsing. */
export function parseCatalogueMappingProfile(value: unknown): CatalogueMappingProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mapping profile must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (input.schemaVersion !== 1) throw new Error("Unsupported mapping profile schema version.");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new Error("Mapping profile name must contain 1–120 characters.");
  if (!input.mappings || typeof input.mappings !== "object" || Array.isArray(input.mappings)) {
    throw new Error("Mapping profile must contain a mappings object.");
  }
  const mappings: CatalogueMappingOverrides = Object.create(null) as CatalogueMappingOverrides;
  for (const [header, field] of Object.entries(input.mappings as Record<string, unknown>)) {
    if (!header.trim() || header.length > 200) throw new Error("Mapping profile contains an invalid source heading.");
    if (field !== null && (typeof field !== "string" || !CATALOGUE_FIELDS.has(field as CatalogueField))) {
      throw new Error(`Mapping profile contains an unsupported target for "${header}".`);
    }
    mappings[header] = field as CatalogueField | null;
  }
  if (Object.keys(mappings).length > 250) throw new Error("Mapping profile exceeds the 250-column safety limit.");
  const manufacturer = typeof input.manufacturer === "string" ? input.manufacturer.trim().slice(0, 120) : undefined;
  return {
    schemaVersion: 1,
    name,
    manufacturer: manufacturer || undefined,
    mappings,
    updatedAt: typeof input.updatedAt === "string" && !Number.isNaN(Date.parse(input.updatedAt))
      ? input.updatedAt : new Date(0).toISOString(),
  };
}


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

/** Suggest safe, explainable mappings without silently applying uncertain matches. */
export function suggestCatalogueMappings(headers: string[]): CatalogueMappingSuggestion[] {
  return headers.map((sourceHeader) => {
    const direct = mapCatalogueHeader(sourceHeader);
    if (direct) {
      return {
        sourceHeader,
        suggestedField: direct,
        confidence: "high" as const,
        reason: "Recognized manufacturer alias or standard parameter heading.",
      };
    }
    const key = normalizedHeader(sourceHeader);
    const candidates: Array<[RegExp, CatalogueField, string]> = [
      [/^(?:model|type|unit)(?:id|identifier|number|no|ref|reference)?$/, "model", "Looks like a product or type identifier."],
      [/(?:manufacturer|maker|brand|vendor)/, "manufacturer", "Contains a manufacturer or brand term."],
      [/(?:product|item|part)(?:code|number|no|id)/, "productCode", "Looks like a product or part reference."],
      [/(?:width|wide)/, "width", "Contains a width-related term; confirm whether this is overall or nominal width."],
      [/(?:depth|length)/, "depth", "Contains a depth or length-related term; confirm the intended dimension."],
      [/(?:height|high)/, "height", "Contains a height-related term."],
      [/(?:air|volume|flow)/, "airflow", "Contains an airflow-related term; verify units."],
      [/(?:pressure|esp)/, "staticPressure", "Contains a pressure-related term; verify whether it is static pressure."],
      [/(?:power|watt|kw)/, "power", "Contains an electrical power-related term; verify units."],
      [/(?:voltage|volt)/, "voltage", "Contains a voltage-related term; verify units."],
    ];
    const matches = candidates.filter(([pattern]) => pattern.test(key));
    if (matches.length === 1) {
      return {
        sourceHeader,
        suggestedField: matches[0][1],
        confidence: "medium" as const,
        reason: matches[0][2],
      };
    }
    return {
      sourceHeader,
      suggestedField: null,
      confidence: "none" as const,
      reason: "No reliable standard mapping found. Keep as an unclassified source field or map manually.",
    };
  });
}

/** RFC-4180-style delimiter parser supporting quoted fields and escaped quotes. */
export function parseDelimitedCatalogue(source: string, delimiter?: string, mappingOverrides: CatalogueMappingOverrides = {}): CatalogueParseResult {
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
  const mapped = headers.map((h) => Object.prototype.hasOwnProperty.call(mappingOverrides, h) ? mappingOverrides[h] ?? undefined : mapCatalogueHeader(h));
  const mappedColumns = new Map<CatalogueField, number[]>();
  mapped.forEach((field, index) => {
    if (!field) return;
    const indexes = mappedColumns.get(field) ?? [];
    indexes.push(index);
    mappedColumns.set(field, indexes);
  });
  const duplicateMappingEntries = Array.from(mappedColumns.entries()).filter(([, indexes]) => indexes.length > 1);
  const duplicateMappings = duplicateMappingEntries.map(([field, indexes]) => `Multiple columns map to "${field}": ${indexes.map((index) => headers[index]).join(", ")}. Choose one source column or assign distinct mappings before import.`);
  const ambiguousIndexes = new Set(duplicateMappingEntries.flatMap(([, indexes]) => indexes));
  const modelIndex = mapped.indexOf("model");
  if (modelIndex < 0) return { headers, rows: [], errors: ["A Model, Model Number, Type or Type Name column is required."] };
  const errors: string[] = [...duplicateMappings];
  const rows: CatalogueRow[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cells = nonEmpty[r];
    const item: CatalogueRow = { model: cells[modelIndex] ?? "" };
    if (!item.model.trim()) { errors.push(`Row ${r + 1}: missing model identifier; row skipped.`); continue; }
    for (let c = 0; c < mapped.length; c++) {
      if (ambiguousIndexes.has(c)) continue;
      const key = mapped[c];
      if (key === "model") continue;
      const raw = cells[c] ?? "";
      if (!key) { if (raw) Object.defineProperty(item, headers[c], { value: raw, enumerable: true, configurable: true, writable: true }); continue; }
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

export type CatalogueColumnUnitOverrides = Partial<Record<"width" | "depth" | "height" | "airflow" | "staticPressure" | "power" | "voltage", string>>;

/** Convert explicitly reviewed source units into the family contract units. */
export function normalizeCatalogueRowsWithUnits(
  rows: CatalogueRow[],
  units: CatalogueColumnUnitOverrides,
  dimensionTarget: "mm" | "cm" | "m" = "mm",
): CatalogueRow[] {
  const dimensionToM: Record<string, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254, ft: 0.3048 };
  const dimensionFromM: Record<string, number> = { mm: 1000, cm: 100, m: 1 };
  const performance: Record<string, Record<string, number>> = {
    airflow: { "m3/h": 1, "m³/h": 1, "m3/s": 3600, "m³/s": 3600, "l/s": 3.6, "l/min": 0.06 },
    staticPressure: { pa: 1, kpa: 1000, bar: 100000 },
    power: { kw: 1, w: 0.001 },
    voltage: { v: 1, kv: 1000 },
  };
  const normalizedUnit = (value: string) => value.trim().toLowerCase().replace(/\\s+/g, "");
  return rows.map((row, rowIndex) => {
    const next: CatalogueRow = { ...row };
    for (const field of ["width", "depth", "height"] as const) {
      const sourceUnit = units[field];
      if (!sourceUnit || next[field] === undefined) continue;
      const factor = dimensionToM[normalizedUnit(sourceUnit)];
      if (!factor) throw new Error(`Unsupported ${field} source unit "${sourceUnit}" (use mm, cm, m, in or ft).`);
      const metres = Number(next[field]) * factor;
      next[field] = metres * dimensionFromM[dimensionTarget];
    }
    for (const field of ["airflow", "staticPressure", "power", "voltage"] as const) {
      const sourceUnit = units[field];
      if (!sourceUnit || next[field] === undefined) continue;
      const factor = performance[field][normalizedUnit(sourceUnit)];
      if (factor === undefined) throw new Error(`Unsupported ${field} source unit "${sourceUnit}".`);
      next[field] = Number(next[field]) * factor;
    }
    Object.defineProperty(next, "__unitNormalization", {
      value: { ...units, dimensionTarget, row: rowIndex + 1 }, enumerable: true, configurable: true,
    });
    return next;
  });
}

export interface CatalogueFamilyOptions {
  name: string;
  category?: FamilyDefinition["category"];
  dimensionUnit?: "mm" | "cm" | "m";
  ifcEntity?: string;
  /** Optional per-parameter scope overrides; type scope remains the safe default. */
  parameterScopes?: Record<string, "type" | "instance">;
  /** Optional pre-existing shared-parameter UUIDs keyed by generated parameter name. */
  parameterGuids?: Record<string, string>;
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
  const usedGuids = new Set<string>();
  for (const parameter of parameters) {
    const requestedScope = options.parameterScopes?.[parameter.name];
    if (requestedScope && requestedScope !== "type" && requestedScope !== "instance") throw new Error(`Unsupported scope for "${parameter.name}".`);
    if (requestedScope) parameter.scope = requestedScope;
    const guid = options.parameterGuids?.[parameter.name]?.trim();
    if (guid) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guid)) {
        throw new Error(`Shared parameter GUID for "${parameter.name}" is not a valid RFC 4122 UUID.`);
      }
      const normalized = guid.toLowerCase();
      if (usedGuids.has(normalized)) throw new Error(`Shared parameter GUID "${guid}" is assigned more than once.`);
      usedGuids.add(normalized);
      parameter.guid = normalized;
    }
  }
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
  for (const parameter of parameters) {
    if (parameter.scope === "instance") {
      const values = new Set(types.map((type) => JSON.stringify(type.values[parameter.name])));
      if (values.size > 1) throw new Error(`Parameter "${parameter.name}" cannot use instance scope because catalogue variants contain different values. Keep it type-scoped or split the catalogue into separate families.`);
    }
  }
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
