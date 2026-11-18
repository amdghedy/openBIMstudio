/**
 * DWG parse pipeline (isomorphic core): runs inside the reader worker and in
 * Node regression tests.
 *
 * Primary reader: the acadrust WASM engine (acad-engine.ts) — native-grade
 * DXF/DWG reading with full entity coverage. When the engine artifact is
 * unavailable or fails, falls back to the OPTIONAL @mlightcad/libredwg-web plug-in
 * (GPL-3.0, not shipped) and converts its database via dwgDatabaseToDxfDocument. Every failure exits through
 * DwgParseError with a structured code so the UI can show actionable
 * diagnostics instead of a raw wasm message.
 */
import type { DxfDocument } from "../drawings/dxf-types";
import { dwgDatabaseToDxfDocument } from "../drawings/dwg-convert";
import { acadEngineVersion, parseWithAcadEngine } from "../drawings/acad-engine";
import { DwgParseError, sniffDwgVersion, type DwgReaderErrorCode } from "./dwg-reader-protocol";

type Any = Record<string, any>;

export interface DwgParseResult {
  doc: DxfDocument;
  summary: string;
  /** DWG version stamp detected in the header, e.g. "AC1032". */
  version: string;
  /** Number of drawable entities produced by the converter. */
  entityCount: number;
}

/** Reader singleton (wasm instantiation is expensive; reuse across parses). */
let readerPromise: Promise<{ lib: Any; FileType: Any }> | null = null;

/**
 * The LibreDWG reader is GPL-3.0, so it is NOT bundled or shipped with the product.
 * It is an optional plug-in: in a browser/worker it is loaded only from a file the
 * site owner or user supplies at /plugins/libredwg/libredwg-web.js (+ its .wasm next to it);
 * in Node (tests, tooling) it comes from node_modules when a developer installed it.
 * Without it the acadrust engine (MPL-2.0) is the only DWG reader.
 */
const OPTIONAL_READER_NODE = "@mlightcad/libredwg-web";
/** Candidate browser URLs (copy script writes both trees). */
const OPTIONAL_READER_URLS = [
  "/plugins/libredwg/libredwg-web.js",
  "/libredwg/libredwg-web.js",
  "/plugins/libredwg/index.js",
  "/libredwg/index.js",
  // CDN last-resort when the deploy did not copy public/plugins/libredwg
  "https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.4/dist/libredwg-web.js",
  "https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.4/libredwg-web.js",
];
const OPTIONAL_READER_DIRS = ["/plugins/libredwg/", "/libredwg/"];

async function loadReaderModule(): Promise<{ LibreDwg: Any; FileType: Any }> {
  const inBrowser =
    typeof window !== "undefined" ||
    typeof (globalThis as Any).WorkerGlobalScope !== "undefined";
  const errors: string[] = [];
  const tryImport = async (spec: string): Promise<Any | null> => {
    try {
      return await import(/* @vite-ignore */ spec);
    } catch (e) {
      errors.push(`${spec}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  let mod: Any | null = null;

  // 1) Prefer the npm package (bundler / worker can resolve it when present)
  mod = await tryImport(OPTIONAL_READER_NODE);

  // 2) Browser/worker: try public plugin URLs
  if (!mod && inBrowser) {
    for (const url of OPTIONAL_READER_URLS) {
      // A missing plug-in URL answers with the SPA's HTML page; importing that only produces console errors, so check first.
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok || !/javascript|ecmascript/i.test(res.headers.get("content-type") ?? "")) { errors.push(`${url}: not installed`); continue; }
      } catch (e) { errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`); continue; }
      mod = await tryImport(url);
      if (mod) break;
    }
  }

  if (!mod) {
    throw new DwgParseError(
      "init-failed",
      "this DWG could not be read by the built-in engine, and the optional fallback reader is not installed. " +
        "Fix: run `npm install` then rebuild (prebuild copies LibreDWG into /plugins/libredwg). " +
        "Or in AutoCAD/BricsCAD use SAVEAS → DXF (ASCII, R2013/R2018) and link the DXF. " +
        `(tried: ${errors.slice(0, 3).join(" | ") || "no sources"})`,
    );
  }

  const LibreDwg = mod.LibreDwg ?? mod.default?.LibreDwg ?? mod.default;
  const FileType = mod.Dwg_File_Type ?? mod.default?.Dwg_File_Type ?? mod.FileType;
  if (!LibreDwg?.create) {
    throw new DwgParseError(
      "init-failed",
      "the optional fallback reader loaded but LibreDwg.create is missing — check /plugins/libredwg assets",
    );
  }
  return { LibreDwg, FileType };
}

async function startReader(LibreDwg: Any): Promise<Any> {
  const attempts: Array<() => Promise<Any>> = [
    () => LibreDwg.create(),
    ...OPTIONAL_READER_DIRS.map((dir) => () => LibreDwg.create(dir)),
  ];
  let last: unknown;
  for (const a of attempts) {
    try { return await a(); } catch (e) { last = e; }
  }
  throw new DwgParseError(
    "init-failed",
    `could not start the DWG reader (WASM failed to load): ${last instanceof Error ? last.message : String(last)}. ` +
      "Ensure .wasm files sit next to libredwg-web.js under /plugins/libredwg/",
  );
}

async function getReader(): Promise<{ lib: Any; FileType: Any }> {
  if (!readerPromise) {
    readerPromise = (async () => {
      const { LibreDwg, FileType } = await loadReaderModule();
      const lib = await startReader(LibreDwg);
      return { lib, FileType };
    })();
    readerPromise.catch(() => { readerPromise = null; }); // allow retry after failure
  }
  return readerPromise;
}

/**
 * Parse DWG bytes into a DxfDocument. Coordinates, units, layers, colors,
 * linetypes and block relationships are preserved by the converter exactly as
 * before — only the execution context changed (worker instead of main thread).
 */
export async function parseDwgBytes(buffer: ArrayBuffer, fileName: string): Promise<DwgParseResult> {
  // Total worker-turn budget: wasm read + JS conversion must finish before the
  // main-thread parse timeout (DWG_PARSE_TIMEOUT_MS = 120s) terminates the worker.
  const t0 = Date.now();
  const CONVERT_DEADLINE_MS = 115_000;
  const bytes = new Uint8Array(buffer);
  const sniff = sniffDwgVersion(bytes);
  if (!sniff) {
    throw new DwgParseError(
      "invalid-file",
      `${fileName} is not a DWG file (missing DWG version stamp such as AC1032). If this is a DXF, import it with the DXF path.`,
    );
  }

  // Primary path: the acadrust engine reads every DWG version R12–R2018+ with
  // full entity coverage and returns structured read statistics.
  let engineWhy = "";
  try {
    const acad = await parseWithAcadEngine(bytes, fileName);
    if (acad && acad.entityCount > 0) {
      return {
        doc: acad.doc,
        summary: acad.summary,
        version: acad.version || sniff.code,
        entityCount: acad.entityCount,
      };
    }
    // Partial / empty decode — try LibreDWG before giving up
    if (acad) {
      engineWhy = acad.summary;
      console.warn("[dwg-reader] acadrust produced no drawable entities, falling back to libredwg", acad.summary);
    } else {
      engineWhy = "the CAD engine (obim-cad-engine.wasm) could not be loaded";
    }
  } catch (e) {
    engineWhy = e instanceof Error ? e.message : String(e);
    console.warn("[dwg-reader] acadrust path failed, falling back to libredwg:", e);
  }

  let reader: { lib: Any; FileType: Any };
  try {
    reader = await getReader();
  } catch (e) {
    if (e instanceof DwgParseError && e.code === "init-failed") {
      let engineId = "";
      try { engineId = (await acadEngineVersion()) ?? ""; } catch { /* diagnostics only */ }
      if (engineId) engineWhy += ` [engine ${engineId}]`;
      // Say WHY the built-in engine gave up (it was only logged to the console before) and what to do next.
      throw new DwgParseError(
        "parse-failed",
        `the built-in engine could not read this ${sniff.label} (${sniff.code}) drawing: ${engineWhy || "no reason reported"}. ` +
          "The optional fallback reader is not installed in this build. " +
          "Workaround: in AutoCAD/BricsCAD/ZWCAD use SAVEAS -> DXF (ASCII, R2013 or R2018) and link the DXF; " +
          "if the same drawing also fails as DXF, send that DXF so the engine can be fixed.",
        `engine: ${engineWhy || "none"} | fallback: ${e.message}`,
      );
    }
    throw e;
  }
  const { lib, FileType } = reader;

  let dwg: Any | null = null;
  const errors: string[] = [];
  for (const input of [bytes, bytes.buffer] as Any[]) {
    try { dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0); if (dwg) break; }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  if (!dwg) {
    const detail = errors.length ? errors[0] : "dwg_read_data returned no data";
    throw new DwgParseError(
      "parse-failed",
      "libredwg could not read this DWG (very new DWG version, encrypted or damaged file)",
      `${sniff.label} (${sniff.code}) - ${detail}`,
    );
  }

  let db: Any;
  try { db = lib.convert ? lib.convert(dwg) : dwg; }
  finally { try { lib.dwg_free?.(dwg); } catch { /* */ } }

  const res = dwgDatabaseToDxfDocument(db, { deadlineMs: t0 + CONVERT_DEADLINE_MS });
  if (!res.doc.entities.length) {
    // Help diagnose converter/field-name mismatches: what did the file actually contain?
    try {
      const raw: Any[] = Array.isArray(db?.entities) ? db.entities : [];
      const hist: Record<string, number> = {};
      for (const e of raw) { const k = String(e?.type ?? e?.entityType ?? e?.name ?? "?"); hist[k] = (hist[k] ?? 0) + 1; }
      const keys = Object.keys(db ?? {}).join(", ");
      res.summary += ` | raw model entities: ${raw.length}${raw.length ? " (" + Object.entries(hist).map(([k, v]) => `${v}x${k}`).join(", ") + ")" : ""} | database keys: ${keys}`;
      console.warn("[dwg-reader] DWG produced no drawable entities", { hist, keys });
    } catch { /* */ }
  }
  return { doc: res.doc, summary: res.summary, version: sniff.code, entityCount: res.doc.entities.length };
}

/**
 * Extract the embedded preview bitmap of a DWG (LibreDWG thumbnail extraction).
 * Returns a browser-displayable MIME type plus base64 payload:
 *   BMP (type 2) -> image/bmp, PNG (type 6) -> image/png,
 *   WMF (type 3) -> image/x-wmf (not browser-renderable; callers show it
 *   as a download instead of an image).
 */
export async function extractDwgThumbnail(buffer: ArrayBuffer, fileName: string): Promise<{ mime: string; dataB64: string }> {
  const bytes = new Uint8Array(buffer);
  const sniff = sniffDwgVersion(bytes);
  if (!sniff) {
    throw new DwgParseError("invalid-file", `${fileName} is not a DWG file (missing DWG version stamp such as AC1032).`);
  }
  const { lib, FileType } = await getReader();
  let dwg: Any | null = null;
  const errors: string[] = [];
  for (const input of [bytes, bytes.buffer] as Any[]) {
    try { dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0); if (dwg) break; }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  if (!dwg) {
    throw new DwgParseError(
      "parse-failed",
      "LibreDWG could not read this DWG to extract its preview.",
      `${sniff.label} (${sniff.code}) - ${errors[0] ?? "dwg_read_data returned no data"}`,
    );
  }
  let thumb: { data?: Uint8Array | null; type?: number } | null = null;
  try {
    thumb = typeof lib.dwg_bmp === "function" ? lib.dwg_bmp(dwg) : null;
  } finally {
    try { lib.dwg_free?.(dwg); } catch { /* best-effort native cleanup */ }
  }
  const data = thumb?.data;
  if (!thumb || !data || !data.length) {
    throw new DwgParseError(
      "parse-failed",
      "This DWG has no embedded preview bitmap (it was saved without a thumbnail). Export SVG instead for a live preview.",
    );
  }
  const mime = thumb.type === 6 ? "image/png" : thumb.type === 3 ? "image/x-wmf" : "image/bmp";
  return { mime, dataB64: b64encodeChunked(data) };
}

/** Chunked base64 (avoids String.fromCharCode call-size limits on big blobs). */
function b64encodeChunked(view: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Map any thrown value to a structured code (worker boundary + tests). */
export function toDwgParseError(e: unknown): { code: DwgReaderErrorCode; message: string; detail?: string } {
  if (e && typeof e === "object" && "code" in (e as Any) && typeof (e as Any).code === "string") {
    const err = e as DwgParseError;
    return { code: err.code as DwgReaderErrorCode, message: err.message, detail: err.detail };
  }
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

/**
 * Independent DWG validation entry point. This deliberately bypasses acadrust
 * and invokes the separately implemented LibreDWG reader directly. Keep this
 * exported so export acceptance tests can verify writer interoperability
 * without allowing the writer to validate its own output.
 */
export async function parseDwgBytesWithLibreDwg(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<DwgParseResult> {
  const t0 = Date.now();
  const bytes = new Uint8Array(buffer);
  const sniff = sniffDwgVersion(bytes);
  if (!sniff) {
    throw new DwgParseError(
      "invalid-file",
      `${fileName} is not a DWG file (missing DWG version stamp such as AC1032).`,
    );
  }

  const { lib, FileType } = await getReader();
  let dwg: Any | null = null;
  const errors: string[] = [];
  for (const input of [bytes, bytes.buffer] as Any[]) {
    try {
      dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0);
      if (dwg) break;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (!dwg) {
    const detail = errors.length ? errors[0] : "dwg_read_data returned no data";
    throw new DwgParseError(
      "parse-failed",
      "LibreDWG could not read this DWG (unsupported version, encrypted or damaged file)",
      `${sniff.label} (${sniff.code}) - ${detail}`,
    );
  }

  let db: Any;
  try {
    db = lib.convert ? lib.convert(dwg) : dwg;
  } finally {
    try { lib.dwg_free?.(dwg); } catch { /* best-effort native cleanup */ }
  }

  const res = dwgDatabaseToDxfDocument(db, { deadlineMs: t0 + 115_000 });
  return {
    doc: res.doc,
    summary: `Independently parsed by LibreDWG: ${res.summary}`,
    version: sniff.code,
    entityCount: res.doc.entities.length,
  };
}

