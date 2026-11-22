/**
 * Local PDF catalogue extraction for the BIM Family Generator.
 *
 * Text PDFs are parsed with the repository's bundled PDF.js dependency.
 * Image-only pages can be sent to the user's configured LOCAL Ollama vision
 * model for OCR. No PDF or rendered page is sent to a cloud provider.
 */
import { assertFileAllowed } from "../../core/file-guard";
import { loadProviderConfig } from "../../features/ai-providers";
import { mapCatalogueHeader, type CatalogueRow } from "./catalogue-intake";

export interface PdfCatalogueOptions {
  /** Enable OCR only for pages without selectable text. Requires local Ollama + a vision model. */
  useLocalVisionOcr?: boolean;
  /** Maximum number of pages to inspect. Defaults to 80. */
  maxPages?: number;
  /** Progress callback; current/total are 1-based page counts. */
  onProgress?: (current: number, total: number, phase: "text" | "ocr") => void;
  /** Test seam; production callers should omit this. */
  ocrPage?: (imageBase64: string, pageNumber: number) => Promise<CatalogueRow[]>;
}

export interface PdfCatalogueExtractionResult {
  pageCount: number;
  processedPages: number;
  rows: CatalogueRow[];
  textPages: number[];
  scannedPages: number[];
  ocrPages: number[];
  warnings: string[];
  pageText: Array<{ page: number; text: string }>;
}

interface PdfTextToken { x: number; y: number; text: string; width: number; height: number; }
interface PdfTextLine { y: number; tokens: PdfTextToken[]; text: string; }

const MAX_PDF_BYTES = 40 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 1_200_000;
const DEFAULT_MAX_PAGES = 80;

function normalizedNumber(value: string): number | undefined {
  const cleaned = value.replace(/\s/g, "").replace(/(mm|cm|m3\/h|m³\/h|pa|kw|kv|v|a)$/i, "");
  const match = cleaned.match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return undefined;
  const raw = match[0];
  const normalized = raw.includes(",") && !raw.includes(".")
    ? raw.replace(",", ".")
    : raw.replace(/,/g, "");
  const result = Number(normalized);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function groupTextItems(items: any[]): PdfTextLine[] {
  const tokens: PdfTextToken[] = [];
  for (const item of items ?? []) {
    if (typeof item?.str !== "string" || !item.str.trim() || !Array.isArray(item.transform)) continue;
    const x = Number(item.transform[4]);
    const y = Number(item.transform[5]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const raw = item.str.trim();
    const cells = raw.split(/\\s{2,}|\\t/).filter(Boolean);
    if (cells.length > 1) {
      let offset = 0;
      for (const cell of cells) {
        const relative = offset / Math.max(1, raw.length);
        tokens.push({ x: x + (Number(item.width) || raw.length * 5) * relative, y, text: cell.trim(), width: cell.length * 5, height: Number(item.height) || 0 });
        offset += cell.length + 2;
      }
    } else {
      tokens.push({
        x, y, text: raw,
        width: Number.isFinite(item.width) ? Math.max(0, item.width) : 0,
        height: Number.isFinite(item.height) ? Math.max(0, item.height) : 0,
      });
    }
  }
  tokens.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextLine[] = [];
  for (const token of tokens) {
    const tolerance = Math.max(2, Math.min(5, token.height * 0.45));
    let line = lines.find((candidate) => Math.abs(candidate.y - token.y) <= tolerance);
    if (!line) {
      line = { y: token.y, tokens: [], text: "" };
      lines.push(line);
    }
    line.tokens.push(token);
    line.y = line.tokens.reduce((sum, item) => sum + item.y, 0) / line.tokens.length;
  }
  for (const line of lines) {
    line.tokens.sort((a, b) => a.x - b.x);
    line.text = line.tokens.map((item) => item.text).join(" ").replace(/\\s+/g, " ").trim();
  }
  return lines.sort((a, b) => b.y - a.y);
}

function parseTableRows(lines: PdfTextLine[], pageNumber: number): CatalogueRow[] {
  const rows: CatalogueRow[] = [];
  let header: PdfTextLine | null = null;
  let columns: Array<{ x: number; key: string }> = [];
  for (const line of lines) {
    const recognized: Array<{ x: number; key: string }> = [];
    for (let index = 0; index < line.tokens.length; index++) {
      const token = line.tokens[index];
      const next = line.tokens[index + 1];
      const combined = next ? mapCatalogueHeader(`${token.text} ${next.text}`) : undefined;
      if (combined) {
        recognized.push({ x: token.x, key: combined });
        index++;
        continue;
      }
      const key = mapCatalogueHeader(token.text);
      if (key) recognized.push({ x: token.x, key });
    }
    if (recognized.some((entry) => entry.key === "model") && recognized.length >= 2) {
      header = line;
      columns = recognized.sort((a, b) => a.x - b.x);
      break;
    }
  }
  if (!header || columns.length < 2) return rows;
  const boundaries = columns.map((column, index) => ({
    ...column,
    left: index === 0 ? Number.NEGATIVE_INFINITY : (columns[index - 1].x + column.x) / 2,
    right: index === columns.length - 1 ? Number.POSITIVE_INFINITY : (column.x + columns[index + 1].x) / 2,
  }));
  for (const line of lines) {
    if (line.y >= header.y - 1) continue;
    const cells = new Map<string, string[]>();
    if (line.tokens.length === columns.length) {
      line.tokens.forEach((token, index) => cells.set(columns[index].key, [token.text]));
    } else {
      for (const token of line.tokens) {
        const column = boundaries.find((candidate) => token.x >= candidate.left && token.x < candidate.right);
        if (!column) continue;
        const bucket = cells.get(column.key) ?? [];
        bucket.push(token.text);
        cells.set(column.key, bucket);
      }
    }
    const model = (cells.get("model") ?? []).join(" ").trim();
    if (!model || /^(model|type|model no\.?|model number)$/i.test(model)) continue;
    const item: CatalogueRow = { model, sourcePage: pageNumber };
    for (const [key, values] of cells) {
      if (key === "model") continue;
      const value = values.join(" ").trim();
      if (!value) continue;
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const n = normalizedNumber(value);
        if (n !== undefined) (item as Record<string, string | number | undefined>)[key] = n;
      } else {
        (item as Record<string, string | number | undefined>)[key] = value;
      }
    }
    rows.push(item);
  }
  return rows;
}

export function parsePdfCatalogueLines(lines: string[], pageNumber = 1): CatalogueRow[] {
  const matrix = lines.map((line) => line.trim().split(/\\s{2,}|\\t/).map((cell) => cell.trim()).filter(Boolean));
  const headerIndex = matrix.findIndex((cells) => cells.some((cell) => mapCatalogueHeader(cell) === "model") &&
    cells.filter((cell) => Boolean(mapCatalogueHeader(cell))).length >= 2);
  if (headerIndex < 0) return [];
  const headers = matrix[headerIndex].map((cell) => mapCatalogueHeader(cell));
  const rows: CatalogueRow[] = [];
  for (const cells of matrix.slice(headerIndex + 1)) {
    const modelIndex = headers.indexOf("model");
    const model = cells[modelIndex]?.trim();
    if (!model) continue;
    const row: CatalogueRow = { model, sourcePage: pageNumber };
    headers.forEach((key, index) => {
      if (!key || key === "model" || !cells[index]) return;
      const value = cells[index].trim();
      if (["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"].includes(key)) {
        const n = normalizedNumber(value);
        if (n !== undefined) (row as Record<string, string | number | undefined>)[key] = n;
      } else (row as Record<string, string | number | undefined>)[key] = value;
    });
    rows.push(row);
  }
  return rows;
}

function localOllamaBase(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("The configured Ollama endpoint is not a valid URL."); }
  const host = url.hostname.toLowerCase();
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Ollama OCR requires an HTTP(S) local endpoint.");
  if (!localHost) throw new Error("PDF OCR is local-only. Configure Ollama on localhost or a private LAN address; cloud endpoints are not used.");
  return url.toString().replace(/\/+$/, "");
}

async function runLocalOllamaOcr(imageBase64: string, pageNumber: number): Promise<CatalogueRow[]> {
  const config = loadProviderConfig();
  if (config.kind !== "ollama") {
    throw new Error("Scanned PDF OCR requires Ollama selected in AI Settings and a vision-capable model such as LLaVA or Qwen2.5-VL. Cloud providers are deliberately not used.");
  }
  const configuredEndpoint = new URL(config.endpoint);
  const appIsLocal = typeof location !== "undefined" && (location.hostname === "localhost" || location.hostname === "127.0.0.1");
  const ollamaIsLocalhost = configuredEndpoint.hostname === "localhost" || configuredEndpoint.hostname === "127.0.0.1";
  const base = appIsLocal && ollamaIsLocalhost ? "/ollama" : localOllamaBase(config.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        images: [imageBase64],
        format: "json",
        prompt: [
          "Read this manufacturer BIM/HVAC/mechanical/electrical product catalogue page.",
          "Extract only values visibly printed on the page. Never infer missing values.",
          "Return ONLY valid JSON in this exact shape: {\"rows\":[{\"model\":\"\",\"manufacturer\":\"\",\"productCode\":\"\",\"width\":null,\"depth\":null,\"height\":null,\"airflow\":null,\"staticPressure\":null,\"power\":null,\"voltage\":null,\"dimensionUnit\":\"mm\",\"evidence\":\"\"}]}",
          "Use numbers for numeric fields and null when not visible. Keep model identifiers exactly as printed.",
          "Do not convert units. Include one row per distinct product variant. The source page is " + pageNumber + ".",
        ].join(" "),
        options: { temperature: 0 },
      }),
    });
    if (!response.ok) throw new Error(`Local Ollama OCR failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as { response?: string };
    const raw = String(payload.response ?? "").trim();
    const fenced = raw.replace(/^```(?:json)?\\s*/i, "").replace(/\\s*```$/, "");
    const firstBrace = fenced.indexOf("{");
    const lastBrace = fenced.lastIndexOf("}");
    const jsonText = firstBrace >= 0 && lastBrace > firstBrace ? fenced.slice(firstBrace, lastBrace + 1) : fenced;
    const parsed = JSON.parse(jsonText) as { rows?: unknown[] };
    if (!Array.isArray(parsed.rows)) throw new Error("The selected Ollama model did not return the required JSON rows. Use a vision-capable model.");
    return parsed.rows.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const source = value as Record<string, unknown>;
      const model = String(source.model ?? "").trim();
      if (!model) return [];
      const row: CatalogueRow = { model, sourcePage: pageNumber, extractionMethod: "local-ollama-vision" };
      for (const key of ["manufacturer", "productCode"] as const) {
        if (source[key] != null && String(source[key]).trim()) row[key] = String(source[key]).trim();
      }
      for (const key of ["width", "depth", "height", "airflow", "staticPressure", "power", "voltage"] as const) {
        const n = typeof source[key] === "number" ? source[key] as number : Number(source[key]);
        if (source[key] != null && Number.isFinite(n) && n >= 0) row[key] = n;
      }
      if (source.dimensionUnit) row.dimensionUnit = String(source.dimensionUnit);
      if (source.evidence) row.evidence = String(source.evidence);
      return [row];
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("Local OCR timed out after 120 seconds. Try fewer pages or a smaller vision model.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function renderPageForOcr(pdfPage: any, pageNumber: number): Promise<string> {
  if (typeof document === "undefined") throw new Error("PDF page OCR rendering is available in the browser only.");
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(0.5, Math.min(2, 2200 / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not allocate a canvas for scanned PDF OCR.");
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
  canvas.width = 0;
  canvas.height = 0;
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (!encoded) throw new Error(`Could not render PDF page ${pageNumber} for OCR.`);
  return encoded;
}

let pdfjsPromise: Promise<any> | null = null;
async function loadPdfJs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs: any) => {
      if (typeof document !== "undefined") {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      }
      return pdfjs;
    }).catch((error: unknown) => {
      pdfjsPromise = null;
      throw new Error(`Could not load the bundled PDF.js parser: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return pdfjsPromise;
}

export async function extractPdfCatalogue(
  input: File | Uint8Array,
  options: PdfCatalogueOptions = {},
): Promise<PdfCatalogueExtractionResult> {
  const fileName = input instanceof Uint8Array ? "catalogue.pdf" : input.name || "catalogue.pdf";
  const bytes = input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > MAX_PDF_BYTES) throw new Error("PDF catalogue exceeds the 40 MB Family Generator processing limit.");
  assertFileAllowed("pdf", fileName, bytes.length, bytes.subarray(0, 32));
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, stopAtErrors: true });
  const pdf = await loadingTask.promise;
  const maxPages = Math.max(1, Math.min(200, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES)));
  const processedPages = Math.min(pdf.numPages, maxPages);
  const result: PdfCatalogueExtractionResult = {
    pageCount: pdf.numPages, processedPages, rows: [], textPages: [], scannedPages: [], ocrPages: [], warnings: [], pageText: [],
  };
  if (pdf.numPages > maxPages) result.warnings.push(`PDF contains ${pdf.numPages} pages; only the first ${processedPages} were processed by the configured safety limit.`);
  let totalChars = 0;
  for (let pageNumber = 1; pageNumber <= processedPages; pageNumber++) {
    options.onProgress?.(pageNumber, processedPages, "text");
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent({ includeMarkedContent: false });
    const lines = groupTextItems(content.items ?? []);
    const text = lines.map((line) => line.text).join("\n");
    totalChars += text.length;
    if (totalChars > MAX_EXTRACTED_CHARS) {
      result.warnings.push("PDF text extraction stopped at the 1.2 million character safety limit.");
      break;
    }
    result.pageText.push({ page: pageNumber, text });
    if (text.trim().length >= 20) {
      result.textPages.push(pageNumber);
      result.rows.push(...parseTableRows(lines, pageNumber));
    } else {
      result.scannedPages.push(pageNumber);
      if (options.useLocalVisionOcr) {
        try {
          options.onProgress?.(pageNumber, processedPages, "ocr");
          const image = await renderPageForOcr(page, pageNumber);
          const extracted = options.ocrPage
            ? await options.ocrPage(image, pageNumber)
            : await runLocalOllamaOcr(image, pageNumber);
          result.rows.push(...extracted);
          if (extracted.length) result.ocrPages.push(pageNumber);
          else result.warnings.push(`Page ${pageNumber}: OCR returned no identifiable product model rows; review the source page manually.`);
        } catch (error) {
          result.warnings.push(`Page ${pageNumber}: OCR was not completed — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    page.cleanup?.();
  }
  const seen = new Set<string>();
  result.rows = result.rows.filter((row) => {
    const key = row.model.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (!result.rows.length && result.scannedPages.length && !options.useLocalVisionOcr) {
    result.warnings.push("Scanned/image-only pages were detected. Enable local vision OCR and configure a vision-capable Ollama model to extract their product tables.");
  }
  if (!result.rows.length && result.textPages.length) {
    result.warnings.push("Selectable text was found, but no table with a recognizable Model/Type header was detected. Use CSV/Excel or review the extracted page text.");
  }
  await pdf.destroy?.();
  return result;
}
