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
}

export type DwgParseResponse =
  | { id: number; ok: true; doc: unknown; summary: string; version: string; entityCount: number }
  | { id: number; ok: false; code: DwgReaderErrorCode; message: string; detail?: string };

/** Known DWG version stamps (offset 0, 6 ASCII chars) -> human readable label. */
const DWG_VERSION_LABELS: Record<string, string> = {
  AC1006: "AutoCAD R10",
  AC1009: "AutoCAD R11/R12",
  AC1012: "AutoCAD R13",
  AC1014: "AutoCAD R14",
  AC1015: "AutoCAD 2000",
  AC1018: "AutoCAD 2004",
  AC1021: "AutoCAD 2007",
  AC1024: "AutoCAD 2010",
  AC1027: "AutoCAD 2013",
  AC1032: "AutoCAD 2018",
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
