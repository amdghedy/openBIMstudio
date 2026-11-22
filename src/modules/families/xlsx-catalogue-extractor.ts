/**
 * Local XLSX catalogue reader for the BIM Family Generator.
 * Reads the first worksheet from an OOXML workbook using the
 * repository's existing JSZip dependency. No upload or cloud conversion.
 */
import JSZip from "jszip";
import { mapCatalogueHeader, type CatalogueRow } from "./catalogue-intake";

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CELLS = 250_000;

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
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)</si>/g)]
    .map((match) => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)</t>/g)].map((part) => xmlText(part[1])).join(""));
}
function cellValue(cell: string, strings: string[]): string {
  const type = cell.match(/\bt="([^"]+)"/)?.[1];
  if (type === "inlineStr") return [...cell.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join("");
  const value = tagValue(cell, "v");
  if (type === "s") return strings[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value;
}

export interface XlsxCatalogueResult {
  rows: CatalogueRow[];
  sheetName: string;
  warnings: string[];
  sourceRowCount: number;
}

/** Extract product rows from the first worksheet; values are never inferred. */
export async function extractXlsxCatalogue(file: File | Blob): Promise<XlsxCatalogueResult> {
  if (file.size > MAX_BYTES) throw new Error("XLSX file exceeds the 40 MB intake limit.");
  const zip = await JSZip.loadAsync(await file.arrayBuffer(), { checkCRC32: true });
  const workbookFile = zip.file("xl/workbook.xml");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbookFile || !relsFile) throw new Error("This file is not a valid Excel XLSX workbook.");
  const workbook = await workbookFile.async("string");
  const rels = await relsFile.async("string");
  const sheet = workbook.match(/<sheet\b([^>]*)\/?>/);
  if (!sheet) throw new Error("The workbook contains no worksheets.");
  const sheetName = sheet[1].match(/\bname="([^"]*)"/)?.[1] ?? "Sheet1";
  const relationshipId = sheet[1].match(/\br:id="([^"]+)"/)?.[1];
  if (!relationshipId) throw new Error("The first worksheet relationship is missing.");
  const relation = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .find((match) => match[1].match(/\bId="([^"]+)"/)?.[1] === relationshipId);
  const target = relation?.[1].match(/\bTarget="([^"]+)"/)?.[1];
  if (!target) throw new Error("The first worksheet file could not be resolved.");
  const normalizedTarget = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const worksheetFile = zip.file(normalizedTarget);
  if (!worksheetFile) throw new Error("The first worksheet XML is missing.");
  const worksheet = await worksheetFile.async("string");
  const stringsFile = zip.file("xl/sharedStrings.xml");
  const strings = stringsFile ? sharedStrings(await stringsFile.async("string")) : [];
  const matrix: string[][] = [];
  let cellCount = 0;
  for (const rowMatch of worksheet.matchAll(/<row\b[^>]*>([\s\S]*?)</row>/g)) {
    const row: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)</c>/g)) {
      if (++cellCount > MAX_CELLS) throw new Error("XLSX exceeds the 250,000-cell processing limit.");
      const reference = cellMatch[1].match(/\br="([^"]+)"/)?.[1] ?? "";
      row[columnIndex(reference)] = cellValue(cellMatch[0], strings);
    }
    matrix.push(row);
    if (matrix.length > MAX_ROWS + 1) throw new Error("XLSX exceeds the 10,000 product-row limit.");
  }
  const headerIndex = matrix.findIndex((row) => row.some((value) => mapCatalogueHeader(value ?? "") === "model"));
  if (headerIndex < 0) throw new Error("No Model, Model Number, Type or Type Name header was found in the first worksheet.");
  const headers = matrix[headerIndex].map((value) => mapCatalogueHeader(value ?? ""));
  const modelIndex = headers.indexOf("model");
  const rows: CatalogueRow[] = [];
  const warnings: string[] = [];
  for (let index = headerIndex + 1; index < matrix.length; index++) {
    const cells = matrix[index];
    const model = String(cells[modelIndex] ?? "").trim();
    if (!model) continue;
    const item: CatalogueRow = { model };
    headers.forEach((key, column) => {
      if (!key || key === "model") return;
      const raw = String(cells[column] ?? "").trim();
      if (!raw) return;
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const numeric = Number(raw.replace(/,/g, ""));
        if (Number.isFinite(numeric) && numeric >= 0) (item as Record<string, string | number | undefined>)[key] = numeric;
        else warnings.push(`Worksheet row ${index + 1}: invalid numeric value in ${key}; value omitted.`);
      } else (item as Record<string, string | number | undefined>)[key] = raw;
    });
    rows.push(item);
  }
  if (!rows.length) throw new Error("No product rows were found below the catalogue header.");
  return { rows, sheetName, warnings: [...new Set(warnings)], sourceRowCount: matrix.length - headerIndex - 1 };
}
