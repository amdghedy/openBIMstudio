/**
 * Local XLSX catalogue reader for the BIM Family Generator.
 * Supports worksheet discovery and explicit worksheet selection.
 * Values are read from cached OOXML cell data; formulas are not recalculated.
 */
import JSZip from "jszip";
import { mapCatalogueHeader, type CatalogueRow } from "./catalogue-intake";

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CELLS = 250_000;

interface SheetRef { name: string; relationshipId: string; target: string; }
function xmlText(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function tagValue(xml: string, tag: string): string {
  const match = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  return match ? xmlText(match[1]) : "";
}
function columnIndex(reference: string): number {
  const letters = (reference.match(/^[A-Z]+/i)?.[0] ?? "").toUpperCase();
  let result = 0;
  for (const char of letters) result = result * 26 + char.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)]
    .map((match) => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => xmlText(part[1])).join(""));
}
function cellValue(cell: string, strings: string[]): string {
  const type = cell.match(/\bt="([^"]+)"/)?.[1];
  if (type === "inlineStr") return [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");
  const value = tagValue(cell, "v");
  if (type === "s") return strings[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}
function normalizeTarget(target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : "xl/" + target).split("/");
  const clean: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") clean.pop();
    else clean.push(part);
  }
  return clean.join("/");
}
async function openWorkbook(file: File | Blob) {
  if (file.size > MAX_BYTES) throw new Error("XLSX file exceeds the 40 MB intake limit.");
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) throw new Error("This file is not a valid Excel XLSX workbook.");
  const workbook = await workbookFile.async("string");
  const rels = await relsFile.async("string");
  const relationships = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((match) => {
    const attrs = match[1];
    return { id: attrs.match(/\bId="([^"]+)"/)?.[1] ?? "", target: attrs.match(/\bTarget="([^"]+)"/)?.[1] ?? "", mode: attrs.match(/\bTargetMode="([^"]+)"/)?.[1] ?? "", type: attrs.match(/\bType="([^"]+)"/)?.[1] ?? "" };
  });
  const sheets: SheetRef[] = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((match) => {
    const attrs = match[1];
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? "";
    const relationshipId = attrs.match(/\br:id="([^"]+)"/)?.[1] ?? "";
    const state = attrs.match(/\bstate="([^"]+)"/)?.[1] ?? "visible";
    const relation = relationships.find((item) => item.id === relationshipId);
    if (!name || state !== "visible" || !relation || relation.mode.toLowerCase() === "external" || !relation.type.endsWith("/worksheet")) return null;
    return { name, relationshipId, target: normalizeTarget(relation.target) };
  }).filter((item): item is SheetRef => Boolean(item));
  if (!sheets.length) throw new Error("The workbook contains no readable worksheets.");
  return { zip, sheets };
}

export interface XlsxCatalogueResult {
  rows: CatalogueRow[];
  sheetName: string;
  warnings: string[];
  sourceRowCount: number;
}
export async function listXlsxWorksheets(file: File | Blob): Promise<string[]> {
  const { sheets } = await openWorkbook(file);
  return sheets.map((sheet) => sheet.name);
}

/** Extract product rows from the explicitly selected worksheet. */
export async function extractXlsxCatalogue(file: File | Blob, requestedSheetName?: string): Promise<XlsxCatalogueResult> {
  const { zip, sheets } = await openWorkbook(file);
  const sheet = requestedSheetName ? sheets.find((item) => item.name === requestedSheetName) : sheets[0];
  if (!sheet) throw new Error("The selected worksheet was not found in this workbook. Select a worksheet again.");
  const worksheetFile = zip.file(sheet.target);
  if (!worksheetFile) throw new Error("The selected worksheet XML is missing.");
  const worksheet = await worksheetFile.async("string");
  const stringsFile = zip.file("xl/sharedStrings.xml");
  const strings = stringsFile ? sharedStrings(await stringsFile.async("string")) : [];
  const matrix: string[][] = [];
  const sourceRows: number[] = [];
  let cellCount = 0;
  for (const rowMatch of worksheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(rowMatch[1].match(/\br="(\d+)"/)?.[1] ?? matrix.length + 1);
    const row: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (++cellCount > MAX_CELLS) throw new Error("XLSX exceeds the 250,000-cell processing limit.");
      const reference = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? "";
      row[columnIndex(reference)] = cellValue(cellMatch[0], strings);
    }
    matrix.push(row);
    sourceRows.push(rowNumber);
    if (matrix.length > MAX_ROWS + 1) throw new Error("XLSX exceeds the 10,000 product-row limit.");
  }
  const headerIndex = matrix.findIndex((row) => row.some((value) => mapCatalogueHeader(value ?? "") === "model"));
  if (headerIndex < 0) throw new Error("No Model, Model Number, Type or Type Name header was found in worksheet " + sheet.name + ".");
  const headers = matrix[headerIndex].map((value) => mapCatalogueHeader(value ?? ""));
  const modelIndex = headers.indexOf("model");
  const warnings: string[] = [];
  const duplicateFields = headers.filter((key, index) => Boolean(key) && headers.indexOf(key) !== index);
  if (duplicateFields.length) warnings.push("Duplicate mapped columns detected (" + [...new Set(duplicateFields)].join(", ") + "); the first matching column is used.");
  const rows: CatalogueRow[] = [];
  for (let index = headerIndex + 1; index < matrix.length; index++) {
    const cells = matrix[index];
    const model = String(cells[modelIndex] ?? "").trim();
    if (!model) continue;
    const item: CatalogueRow = { model, sourceSheet: sheet.name, sourceRow: sourceRows[index] };
    headers.forEach((key, column) => {
      if (!key || key === "model") return;
      const raw = String(cells[column] ?? "").trim();
      if (!raw) return;
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const normalized = raw.replace(/,/g, "").replace(/\s*(mm|cm|m|m³\/h|m3\/h|pa|kpa|kw|w|v|kv)\s*$/i, "").trim();
        const numeric = Number(normalized);
        if (Number.isFinite(numeric) && numeric >= 0) (item as Record<string, string | number | undefined>)[key] = numeric;
        else warnings.push("Worksheet row " + sourceRows[index] + ": invalid numeric value in " + key + "; value omitted.");
      } else (item as Record<string, string | number | undefined>)[key] = raw;
    });
    rows.push(item);
  }
  if (!rows.length) throw new Error("No product rows were found below the catalogue header in worksheet " + sheet.name + ".");
  return { rows, sheetName: sheet.name, warnings: [...new Set(warnings)], sourceRowCount: matrix.length - headerIndex - 1 };
}
