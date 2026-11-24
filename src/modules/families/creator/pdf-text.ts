// Free family creator: read the text of a PDF, page by page, in the browser.
//
// Uses the bundled pdf.js (legacy build, same-origin worker, no network).
// Output is one string per page with one visual line per row, so the cut
// sheet reader can report page and line. It reads text only. A scanned PDF
// has no text layer and comes back empty: there is no OCR here, and the
// caller says so rather than guessing.

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 40;

export interface PdfTextResult {
  pages: string[];
  pageCount: number;
  /** True when pages were skipped because of MAX_PDF_PAGES. */
  truncated: boolean;
  /** True when no page had any text (for example a scanned PDF). */
  noText: boolean;
}

async function loadPdfjs(): Promise<any> {
  if (typeof document !== "undefined") {
    // Legacy build: the modern one needs Uint8Array.toHex, missing in many browsers.
    const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
    return pdfjs;
  }
  return (await import("pdfjs-dist/legacy/build/pdf.mjs")) as any;
}

interface Item { str: string; x: number; y: number; w: number }

/** Group positioned text items into visual lines (top to bottom, left to right). */
export function itemsToLines(items: Item[]): string[] {
  const sorted = [...items].filter((i) => i.str.trim() !== "").sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= 2.5) row.push(it);
    else rows.push([it]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x - b.x);
    let line = "";
    let end = Number.NEGATIVE_INFINITY;
    for (const it of row) {
      if (line && it.x - end > 1.5) line += " ";
      line += it.str;
      end = it.x + it.w;
    }
    return line.replace(/\s+/g, " ").trim();
  });
}

export async function extractPdfPages(bytes: Uint8Array): Promise<PdfTextResult> {
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error(`PDF is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`);
  const pdfjs = await loadPdfjs();
  // pdf.js may transfer the buffer to its worker, so hand it a private copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
  const pdf = await task.promise;
  const pageCount: number = pdf.numPages;
  const take = Math.min(pageCount, MAX_PDF_PAGES);
  const pages: string[] = [];
  for (let p = 1; p <= take; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items: Item[] = (content.items as any[])
      .filter((i) => typeof i.str === "string" && Array.isArray(i.transform))
      .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width ?? 0 }));
    pages.push(itemsToLines(items).join("\n"));
  }
  await pdf.destroy?.();
  return { pages, pageCount, truncated: pageCount > take, noText: pages.every((t) => t.trim() === "") };
}
