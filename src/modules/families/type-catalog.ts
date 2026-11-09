/** Revit-style type catalog CSV parser and serializer. */
export type CatalogParameterType =
  | "length" | "area" | "volume" | "angle" | "number" | "string" | "yesno" | "integer";

export interface CatalogParameter {
  name: string;
  type: CatalogParameterType;
  units?: string;
}

export interface TypeCatalogEntry {
  typeName: string;
  values: Record<string, string | number | boolean>;
}

export interface TypeCatalog {
  familyName: string;
  parameters: CatalogParameter[];
  types: TypeCatalogEntry[];
}

export interface TypeCatalogService {
  parseCSV(csvContent: string): TypeCatalog;
  toCSV(catalog: TypeCatalog): string;
  loadFromFile(file: File | Blob): Promise<TypeCatalog>;
  validate(catalog: TypeCatalog): string[];
}

const PARAMETER_TYPES: readonly CatalogParameterType[] = [
  "length", "area", "volume", "angle", "number", "string", "yesno", "integer",
];

/** Parse comma-separated fields, supporting quoted commas, quotes, and newlines. */
function parseCsvRecords(content: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      if (cell.length) throw new Error(`Malformed CSV: unexpected quote at character ${index + 1}.`);
      quoted = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some((field) => field.length > 0)) records.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("Malformed CSV: quoted field was not closed.");
  row.push(cell.trim());
  if (row.some((field) => field.length > 0)) records.push(row);
  return records;
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseParameterHeader(raw: string, column: number): CatalogParameter {
  const delimiter = raw.lastIndexOf("##");
  if (delimiter <= 0) {
    throw new Error(`Invalid parameter header at column ${column}: "${raw}". Expected "Name##type".`);
  }
  const name = raw.slice(0, delimiter).trim();
  const typeAndUnits = raw.slice(delimiter + 2).trim();
  const match = typeAndUnits.match(/^(length|area|volume|angle|number|string|yesno|integer)(?:\s*<\s*([^<>]+?)\s*>)?$/i);
  if (!name || !match) {
    throw new Error(`Invalid parameter header at column ${column}: "${raw}". Expected "Name##type".`);
  }
  const type = match[1].toLowerCase() as CatalogParameterType;
  const units = match[2]?.trim();
  return { name, type, ...(units ? { units } : {}) };
}

function inferUntypedValue(raw: string): string | number | boolean {
  const value = raw.trim();
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (value !== "" && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function coerceValue(raw: string, type: CatalogParameterType): string | number | boolean {
  const value = raw.trim();
  if (type === "string") return value;
  if (type === "yesno") {
    if (/^(yes|true|1)$/i.test(value)) return true;
    if (/^(no|false|0)$/i.test(value)) return false;
    throw new Error(`Expected Yes/No boolean value, received "${value}".`);
  }
  if (type === "integer") {
    if (!/^[+-]?\d+$/.test(value)) throw new Error(`Expected an integer, received "${value}".`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`Integer value is out of range: "${value}".`);
    return parsed;
  }
  const parsed = Number(value);
  if (value === "" || !Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric ${type} value, received "${value}".`);
  }
  return parsed;
}

export class TypeCatalogManager {
  /** Parse a Revit-style catalog with a ##TYPE marker and typed header row. */
  static parseCSV(csvContent: string): TypeCatalog {
    if (typeof csvContent !== "string" || !csvContent.trim()) {
      throw new Error("Type catalog content is empty or not a string.");
    }
    const records = parseCsvRecords(csvContent.replace(/^\uFEFF/, ""));
    if (records.length < 2) throw new Error("Type catalog must include ##TYPE and a header row.");
    if (records[0][0]?.trim().toUpperCase() !== "##TYPE") {
      throw new Error(`Type catalog must start with "##TYPE". Found: "${records[0][0] ?? ""}".`);
    }
    const header = records[1];
    if (header.length < 2 || !header[0]) {
      throw new Error("Type catalog header must include a family name and at least one parameter.");
    }
    const familyName = header[0].trim();
    const parameters = header.slice(1).map((field, index) => parseParameterHeader(field, index + 2));
    const seen = new Set<string>();
    for (const parameter of parameters) {
      const normalized = parameter.name.toLocaleLowerCase();
      if (seen.has(normalized)) throw new Error(`Duplicate parameter name: "${parameter.name}".`);
      seen.add(normalized);
    }
    const types: TypeCatalogEntry[] = [];
    for (let rowIndex = 2; rowIndex < records.length; rowIndex += 1) {
      const cells = records[rowIndex];
      const rowNumber = rowIndex + 1;
      if (cells.length !== parameters.length + 1) {
        throw new Error(`Row ${rowNumber} has ${cells.length} column(s); expected ${parameters.length + 1}.`);
      }
      const typeName = cells[0]?.trim();
      if (!typeName) throw new Error(`Row ${rowNumber} is missing a type name.`);
      const values: TypeCatalogEntry["values"] = {};
      for (let column = 0; column < parameters.length; column += 1) {
        const parameter = parameters[column];
        const raw = cells[column + 1];
        try {
          values[parameter.name] = parameter.type
            ? coerceValue(raw, parameter.type)
            : inferUntypedValue(raw);
        } catch (error) {
          throw new Error(`Row ${rowNumber}, parameter "${parameter.name}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      types.push({ typeName, values });
    }
    if (!types.length) throw new Error("Type catalog contains no type rows.");
    return { familyName, parameters, types };
  }

  /** Serializes a catalog to valid CSV while preserving its type metadata. */
  static toCSV(catalog: TypeCatalog): string {
    if (!catalog || typeof catalog.familyName !== "string" || !Array.isArray(catalog.parameters) || !Array.isArray(catalog.types)) {
      throw new Error("Cannot export an invalid type catalog.");
    }
    const rows = [
      ["##TYPE"],
      [catalog.familyName, ...catalog.parameters.map((parameter) =>
        `${parameter.name}##${parameter.type}${parameter.units ? `<${parameter.units}>` : ""}`,
      )],
      ...catalog.types.map((entry) => [entry.typeName, ...catalog.parameters.map((parameter) => {
        const value = entry.values[parameter.name];
        if (value === undefined) return "";
        if (typeof value === "boolean") return value ? "Yes" : "No";
        return String(value);
      })]),
    ];
    return rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  }

  /** Reads and parses a browser File or Blob; errors are wrapped with context. */
  static async loadFromFile(file: File | Blob): Promise<TypeCatalog> {
    try {
      return TypeCatalogManager.parseCSV(await file.text());
    } catch (error) {
      throw new Error(`Failed to load type catalog: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Reports non-fatal consistency warnings for an already-parsed catalog. */
  static validate(catalog: TypeCatalog): string[] {
    const warnings: string[] = [];
    if (!catalog.familyName.trim()) warnings.push("Family name is empty.");
    if (!catalog.parameters.length) warnings.push("No parameters defined.");
    const names = new Set<string>();
    for (const parameter of catalog.parameters) {
      const name = parameter.name.toLocaleLowerCase();
      if (names.has(name)) warnings.push(`Duplicate parameter name: "${parameter.name}".`);
      names.add(name);
    }
    for (const entry of catalog.types) {
      if (!entry.typeName.trim()) warnings.push("A type row has an empty name.");
    }
    return warnings;
  }
}

export const typeCatalogService: TypeCatalogService = {
  parseCSV: TypeCatalogManager.parseCSV,
  toCSV: TypeCatalogManager.toCSV,
  loadFromFile: TypeCatalogManager.loadFromFile,
  validate: TypeCatalogManager.validate,
};

import type { ServiceMap } from "../../core/services";
declare module "../../core/services" {
  interface ServiceMap {
    typeCatalog: TypeCatalogService;
  }
}
void ({} as ServiceMap);
