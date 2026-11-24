// Free family creator: read text from a picture or a scanned page, on this device.
//
// Tesseract (tesseract.js 7.0.0, Apache-2.0) running as WebAssembly with the
// English model from tesseract-ocr (tessdata_best_int, Apache-2.0). The
// worker, engine and model are served from this site (public/ocr, copied by
// scripts/sync-ocr-assets.mjs). Nothing is fetched from another origin and
// nothing is uploaded.
//
// OCR can misread digits. Callers must show the text as "read from an image,
// check it" and keep the page and line so the user can compare with the sheet.

export interface OcrOptions {
  /** Folder holding worker.min.js, tesseract-core-*.wasm.js and eng.traineddata.gz. Default: BASE_URL + "ocr". */
  assetDir?: string;
  /** Called with 0..1 while a page is read. */
  onProgress?: (fraction: number) => void;
}

export interface OcrResult {
  text: string;
  /** Mean word confidence, 0 to 100, as reported by the engine. */
  confidence: number;
}

let workerPromise: Promise<any> | null = null;
let progressCb: ((f: number) => void) | undefined;

function defaultAssetDir(): string {
  const base = (import.meta as any).env?.BASE_URL ?? "/";
  return `${base.replace(/\/?$/, "/")}ocr`;
}

async function getWorker(opts: OcrOptions): Promise<any> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const T: any = await import("tesseract.js");
    const createWorker = T.createWorker ?? T.default?.createWorker;
    const dir = opts.assetDir ?? defaultAssetDir();
    const isBrowser = typeof document !== "undefined";
    // LSTM_ONLY engine mode (1). Same-origin paths only; nothing comes from a CDN.
    const options: Record<string, unknown> = {
      langPath: dir,
      gzip: true,
      cacheMethod: "none",
      logger: (m: any) => { if (m && m.status === "recognizing text" && typeof m.progress === "number") progressCb?.(m.progress); },
    };
    if (isBrowser) { options.workerPath = `${dir}/worker.min.js`; options.corePath = dir; options.workerBlobURL = false; }
    // LSTM_ONLY engine mode (1). Same-origin paths only; nothing comes from a CDN.
    const worker = await createWorker("eng", 1, options);
    return worker;
  })();
  workerPromise.catch(() => { workerPromise = null; });
  return workerPromise;
}

/** Read the text in an image (canvas, Blob, or PNG/JPEG bytes in Node). */
export async function recognizeImage(image: unknown, opts: OcrOptions = {}): Promise<OcrResult> {
  const worker = await getWorker(opts);
  progressCb = opts.onProgress;
  const { data } = await worker.recognize(image);
  progressCb = undefined;
  return { text: String(data.text ?? ""), confidence: Number(data.confidence ?? 0) };
}

export async function stopOcr(): Promise<void> {
  const p = workerPromise;
  workerPromise = null;
  if (p) { try { await (await p).terminate(); } catch { /* already gone */ } }
}

/**
 * Clean up OCR output for the size reader: trim blank lines and normalise
 * the multiplication sign and stray spacing. It never changes digits.
 */
export function tidyOcrText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/[\u00D7\u2715\u2716]/g, "x").replace(/[\u2013\u2014]/g, "-").replace(/[ \t]+/g, " ").trim())
    .filter((l) => l !== "")
    .join("\n");
}
