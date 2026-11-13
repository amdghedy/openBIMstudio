/**
 * PDF → DWG in one step.
 *
 * Reads a vector PDF (locally - nothing is uploaded), converts each requested page with the existing PDFIN extractor
 * (pdf-vector.ts) and writes a binary DWG (or DXF) per page through the same DXF writer and CAD WASM writer the drawing
 * editor uses for DWGSAVE. Pure and DOM-free so it runs under Node in tests.
 */
import { pdfToDxfDocument } from "./pdf-vector";
import { writeDxf } from "./dxf-writer";
import { exportDxfToDwg } from "./acad-engine";

export type PdfDrawingFormat = "dwg" | "dxf";

export interface PdfToDwgOptions {
  /** 1-indexed pages, or "all". Default "all". */
  pages?: number[] | "all";
  /** Drawing units per PDF inch. Default 25.4 = true-size millimetres. */
  unitsPerInch?: number;
  format?: PdfDrawingFormat;
  onProgress?: (done: number, total: number) => void;
}

export interface PdfToDwgFile { name: string; data: Uint8Array; page: number; entities: number }
export interface PdfToDwgResult {
  files: PdfToDwgFile[];
  /** Pages that produced no file, with the reason. */
  skipped: Array<{ page: number; reason: string }>;
  pageCount: number;
}

/** "all", "3", "1-3,5" → sorted unique page numbers within 1..pageCount. Throws on nonsense. */
export function parsePageSpec(spec: string, pageCount: number): number[] {
  const s = spec.trim().toLowerCase();
  if (!s || s === "all" || s === "*") return Array.from({ length: pageCount }, (_, i) => i + 1);
  const out = new Set<number>();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a page number or range (use for example 1, 2-4, 7).`);
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a) throw new Error(`"${part}" is not a valid page range.`);
    if (b > pageCount) throw new Error(`Page ${b} is out of range: this PDF has ${pageCount} page(s).`);
    for (let p = a; p <= b; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}

function safeBase(name: string): string {
  return (name.replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "_").trim() || "drawing");
}

export async function convertPdfToDwg(bytes: Uint8Array, fileName: string, opts: PdfToDwgOptions = {}): Promise<PdfToDwgResult> {
  const format: PdfDrawingFormat = opts.format ?? "dwg";
  const unitsPerInch = opts.unitsPerInch;
  const base = safeBase(fileName);

  // Page 1 tells us the page count (and is reused if it is requested).
  const first = await pdfToDxfDocument(bytes, { page: 1, unitsPerInch });
  const pageCount = first.pageCount;
  const pages = opts.pages === undefined || opts.pages === "all"
    ? Array.from({ length: pageCount }, (_, i) => i + 1)
    : [...new Set(opts.pages)].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  if (!pages.length) throw new Error(`No valid pages requested (this PDF has ${pageCount} page(s)).`);

  const files: PdfToDwgFile[] = [];
  const skipped: PdfToDwgResult["skipped"] = [];
  let done = 0;
  for (const page of pages) {
    try {
      const res = page === 1 ? first : await pdfToDxfDocument(bytes, { page, unitsPerInch });
      if (!res.doc.entities.length) {
        skipped.push({ page, reason: "no vector content (a scanned or raster page cannot be converted)" });
      } else {
        const dxf = writeDxf(res.doc);
        const data = format === "dwg" ? await exportDxfToDwg(dxf) : new TextEncoder().encode(dxf);
        const suffix = pageCount > 1 ? `-p${page}` : "";
        files.push({ name: `${base}${suffix}.${format}`, data, page, entities: res.doc.entities.length });
      }
    } catch (e) {
      skipped.push({ page, reason: (e as Error).message });
    }
    opts.onProgress?.(++done, pages.length);
  }
  return { files, skipped, pageCount };
}
