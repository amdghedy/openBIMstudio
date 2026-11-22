/**
 * DWG reader protocol — shared contract between the main thread and the
 * DWG reader worker (dwg-reader-worker.ts). Pure types + helpers only:
 * no wasm, no DOM, so it is safe to import from both sides and from tests.
 *
 * WHY THE READER LIVES IN A WORKER
 * --------------------------------
 * The LibreDWG wasm build (@mlightcad/libredwg-web) exposes its entire API
 * through emscripten embind/emval. During `__wasm_call_ctors` the C++ static
 * initializers call `_embind_register_class/_embind_register_function/...`,
 * and embind creates each invoker with `new Function(...)` — JavaScript
 * string evaluation. The main application CSP intentionally does NOT allow
 * 'unsafe-eval', so reader startup in the main document throws:
 *   "Evaluating a string as JavaScript violates ... script-src 'self'
 *    'wasm-unsafe-eval' ..."
 * The parser therefore runs in a dedicated module worker whose document is
 * served with a scoped CSP that permits dynamic execution for this parser
 * only (see applySecurityHeaders in vite.config.ts, vercel.json and
 * public/_headers). The main application policy stays strict and the worker
 * has no DOM or BIM state: its only I/O is bytes in, geometry JSON out.
 */

/** Structured failure codes surfaced by the reader (task diagnostics taxonomy). */
export type DwgReaderErrorCode =
  | "init-failed"          // wasm/emscripten startup failed inside the worker
  | "invalid-file"         // not a DWG file (missing/unknown version header)
  | "unsupported-version"  // a DWG header libredwg cannot read
  | "parse-failed"         // reader rejected the file (corrupt/encrypted/too new)
  | "internal";            // unexpected failure inside the reader

export interface DwgParseRequest {
  id: number;
  kind: "parse";
  bytes: ArrayBuffer;
  fileName: string;
  /** Keep block references native (INSERT + block table) instead of expanding them. */
  nativeBlocks?: boolean;
}

/** thumbnail extraction: extract the embedded preview bitmap of a DWG. */
export interface DwgThumbnailRequest {
  id: number;
  kind: "thumbnail";
  bytes: ArrayBuffer;
  fileName: string;
}

export type DwgReaderRequest = DwgParseRequest | DwgThumbnailRequest;

export type DwgParseResponse =
  | { id: number; kind: "started" }
  | { id: number; ok: true; doc: unknown; summary: string; version: string; entityCount: number }
  | { id: number; ok: false; code: DwgReaderErrorCode; message: string; detail?: string };

export type DwgThumbnailResponse =
  | { id: number; kind: "started" }
  | { id: number; kind: "thumbnail"; ok: true; mime: string; dataB64: string }
  | { id: number; kind: "thumbnail"; ok: false; code: DwgReaderErrorCode; message: string; detail?: string };

export type DwgReaderResponse = DwgParseResponse | DwgThumbnailResponse;

/** Reader-side payload ceiling (issue #90): mirrors the `dwg` file-guard limit
 * (src/core/file-guard.ts). The main-thread caller checks the File size first;
 * the worker re-checks the transferred bytes so a malformed request fails as a
 * typed reader error instead of handing unbounded bytes to the wasm parser. */
export const DWG_READER_MAX_BYTES = 256 * 1024 * 1024;

/** Longest file name the worker accepts (File names are OS-bounded; this only
 * stops a hand-built request from smuggling an unbounded string into logs). */
export const DWG_READER_MAX_FILE_NAME = 1024;

/** Known DWG version stamps (offset 0, 6 ASCII chars) -> human readable label. */

export type DwgReaderRequestValidation =
  | { ok: true; request: DwgReaderRequest }
  | { ok: false; id: number | null; message: string };

/**
 * Validate an incoming reader-worker request BEFORE the bytes reach the wasm
 * parser (issue #90). Same-origin workers are trusted code, but a buggy or
 * future caller must fail as a typed `invalid-file` error, never crash the
 * worker or hang the main thread's parse timeout. Mirrors the solid reader
 * worker's payload validation.
 */
export function validateDwgReaderRequest(req: unknown): DwgReaderRequestValidation {
  if (!req || typeof req !== "object") {
    return { ok: false, id: null, message: "The DWG reader received a malformed request (expected an object)." };
  }
  const r = req as Record<string, unknown>;
  const id = typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id >= 0 ? r.id : null;
  if (id === null) {
    return { ok: false, id: null, message: "The DWG reader received a request without a valid numeric id." };
  }
  if (r.kind !== "parse" && r.kind !== "thumbnail") {
    return { ok: false, id, message: `The DWG reader received an unknown request kind (${String(r.kind)}).` };
  }
  if (!(r.bytes instanceof ArrayBuffer)) {
    return { ok: false, id, message: "The DWG reader received an invalid file payload (expected file bytes as an ArrayBuffer)." };
  }
  if (r.bytes.byteLength === 0 || r.bytes.byteLength > DWG_READER_MAX_BYTES) {
    return { ok: false, id, message: `The DWG reader received an invalid file payload (expected file bytes up to ${DWG_READER_MAX_BYTES / 1024 / 1024} MB).` };
  }
  if (typeof r.fileName !== "string" || r.fileName.length === 0 || r.fileName.length > DWG_READER_MAX_FILE_NAME) {
    return { ok: false, id, message: "The DWG reader received a request without a valid file name." };
  }
  if (r.nativeBlocks !== undefined && typeof r.nativeBlocks !== "boolean") {
    return { ok: false, id, message: "The DWG reader received an invalid nativeBlocks option (expected a boolean)." };
  }
  return { ok: true, request: req as DwgReaderRequest };
}
const DWG_VERSION_LABELS: Record<string, string> = {
  AC1006: "DWG R10",
  AC1009: "DWG R11/R12",
  AC1012: "DWG R13",
  AC1014: "DWG R14",
  AC1015: "DWG 2000",
  AC1018: "DWG 2004",
  AC1021: "DWG 2007",
  AC1024: "DWG 2010",
  AC1027: "DWG 2013",
  AC1032: "DWG 2018",
};

/**
 * Read the 6-character version stamp at the start of a DWG file.
 * Returns { code, label } for a plausible DWG stamp, or null when the bytes
 * clearly are not a DWG (used for early, actionable validation before the
 * wasm reader is invoked).
 */
export function sniffDwgVersion(u8: Uint8Array): { code: string; label: string } | null {
  if (!u8 || u8.length < 6) return null;
  let code = "";
  for (let i = 0; i < 6; i++) code += String.fromCharCode(u8[i]);
  // Accept the AC10xx family (R10..2018) and AC1.x oddballs; reject everything
  // else early so a DXF renamed to .dwg or a zip slice fails fast and clear.
  if (/^AC10[0-9]{2}$/.test(code) || /^AC1[0-9]{3}$/.test(code)) {
    return { code, label: DWG_VERSION_LABELS[code] ?? `DWG ${code}` };
  }
  return null;
}

/** Error carrying a structured reader code so callers can branch reliably. */
export class DwgParseError extends Error {
  code: DwgReaderErrorCode;
  detail?: string;
  constructor(code: DwgReaderErrorCode, message: string, detail?: string) {
    super(message);
    this.name = "DwgParseError";
    this.code = code;
    this.detail = detail;
  }
}

/* ── Reply validation (main-thread side, issue #90) ───────────────────── */
/**
 * The worker is same-origin, but its replies cross a trust boundary too: a
 * worker that returns `ok: true` with a non-object `doc`, a negative
 * `entityCount`, or a non-string thumbnail payload must fail as a typed
 * error — not hand garbage to the CAD link layer. These validators are pure
 * so node tests can exercise them without spawning a worker.
 */
const DWG_ERROR_CODES: ReadonlySet<string> = new Set([
  "init-failed", "invalid-file", "unsupported-version", "parse-failed", "internal",
]);

export type DwgParseSuccessData = { doc: unknown; summary: string; version: string; entityCount: number };
export type DwgThumbSuccessData = { mime: string; dataB64: string };

export function validateDwgParseSuccess(res: unknown):
  | { ok: true; data: DwgParseSuccessData }
  | { ok: false; message: string } {
  if (!res || typeof res !== "object") return { ok: false, message: "The DWG reader returned a malformed response (expected an object)." };
  const r = res as Record<string, unknown>;
  if (typeof r.doc !== "object" || r.doc === null) return { ok: false, message: "The DWG reader returned a success without a document object." };
  if (typeof r.summary !== "string" || typeof r.version !== "string") return { ok: false, message: "The DWG reader returned a success without summary/version strings." };
  if (!Number.isSafeInteger(r.entityCount) || (r.entityCount as number) < 0) return { ok: false, message: "The DWG reader returned a success with an invalid entity count." };
  return { ok: true, data: { doc: r.doc, summary: r.summary as string, version: r.version as string, entityCount: r.entityCount as number } };
}

export function validateDwgThumbSuccess(res: unknown):
  | { ok: true; data: DwgThumbSuccessData }
  | { ok: false; message: string } {
  if (!res || typeof res !== "object") return { ok: false, message: "The DWG reader returned a malformed response (expected an object)." };
  const r = res as Record<string, unknown>;
  if (typeof r.mime !== "string" || r.mime.length === 0) return { ok: false, message: "The DWG reader returned a thumbnail without a mime type." };
  if (typeof r.dataB64 !== "string") return { ok: false, message: "The DWG reader returned a thumbnail without base64 data." };
  return { ok: true, data: { mime: r.mime as string, dataB64: r.dataB64 as string } };
}

export function validateDwgFailure(res: unknown):
  | { ok: true; code: DwgReaderErrorCode; message: string; detail?: string }
  | { ok: false; message: string } {
  if (!res || typeof res !== "object") return { ok: false, message: "The DWG reader returned a malformed response (expected an object)." };
  const r = res as Record<string, unknown>;
  if (typeof r.code !== "string" || !DWG_ERROR_CODES.has(r.code)) return { ok: false, message: "The DWG reader returned a failure without a known error code." };
  if (typeof r.message !== "string" || r.message.length === 0) return { ok: false, message: "The DWG reader returned a failure without a message." };
  const out: { code: DwgReaderErrorCode; message: string; detail?: string } =
    { code: r.code as DwgReaderErrorCode, message: r.message as string };
  if (typeof r.detail === "string") out.detail = r.detail;
  return { ok: true, ...out };
}
