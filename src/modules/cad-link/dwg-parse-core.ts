/**
 * DWG parse pipeline (isomorphic core): runs inside the reader worker and in
 * Node regression tests.
 *
 * Primary reader: the acadrust WASM engine (acad-engine.ts) — native-grade
 * DXF/DWG reading with full entity coverage. When the engine artifact is
 * unavailable or fails, falls back to @mlightcad/libredwg-web and converts
 * its database via dwgDatabaseToDxfDocument. Every failure exits through
 * DwgParseError with a structured code so the UI can show actionable
 * diagnostics instead of a raw wasm message.
 */
import type { DxfDocument } from "../drawings/dxf-types";
import { dwgDatabaseToDxfDocument } from "../drawings/dwg-convert";
import { parseWithAcadEngine } from "../drawings/acad-engine";
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

async function loadReaderModule(): Promise<{ LibreDwg: Any; FileType: Any }> {
  let mod: Any;
  try {
    mod = await import("@mlightcad/libredwg-web");
  } catch {
    throw new DwgParseError("init-failed", "the DWG reader (@mlightcad/libredwg-web) is not installed - run npm install");
  }
  const LibreDwg = mod.LibreDwg ?? mod.default?.LibreDwg;
  const FileType = mod.Dwg_File_Type ?? mod.default?.Dwg_File_Type;
  if (!LibreDwg?.create) {
    throw new DwgParseError("init-failed", "the installed libredwg-web has an unexpected API (LibreDwg.create missing)");
  }
  return { LibreDwg, FileType };
}

async function startReader(LibreDwg: Any): Promise<Any> {
  const attempts: Array<() => Promise<Any>> = [
    () => LibreDwg.create(),
    // Copied next to the app by scripts/copy-libredwg-wasm.mjs (npm postinstall).
    () => LibreDwg.create("/libredwg/"),
  ];
  let last: unknown;
  for (const a of attempts) {
    try { return await a(); } catch (e) { last = e; }
  }
  throw new DwgParseError(
    "init-failed",
    `could not start the DWG reader (WASM failed to load): ${last instanceof Error ? last.message : String(last)}`,
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
    if (acad && acad.entityCount === 0 && acad.stats?.entities === 0 && !acad.stats.streamCompleted) {
      // Engine started but could not decode the stream at all — fall through.
      console.warn("[dwg-reader] acadrust produced no entities, falling back to libredwg", acad.summary);
    }
  } catch (e) {
    console.warn("[dwg-reader] acadrust path failed, falling back to libredwg:", e);
  }

  const { lib, FileType } = await getReader();

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
      "libredwg could not read this DWG (very new AutoCAD version, encrypted or damaged file)",
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
 * Extract the embedded preview bitmap of a DWG (LibreDWG dwg_bmp parity).
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

