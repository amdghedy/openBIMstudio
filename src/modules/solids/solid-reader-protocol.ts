/**
 * Solid reader protocol — shared contract between the main thread and the
 * solid reader worker (solid-reader-worker.ts). Pure types + helpers only:
 * no wasm, no DOM, so it is safe to import from both sides and from tests.
 *
 * WHY THE READERS LIVE IN A WORKER
 * --------------------------------
 * The vendored occt-import-js and rhino3dm builds expose their API through
 * emscripten glue that evaluates JavaScript strings while the module starts
 * (the same embind dynamic-invoker generation the LibreDWG reader performs).
 * The main application CSP intentionally does NOT allow 'unsafe-eval', so
 * glue startup in the main document throws:
 *   "Evaluating a string as JavaScript violates ... script-src 'self'
 *    'wasm-unsafe-eval' ..."
 * — found in a real-browser session on 2026-11-16: every STEP / IGES / BREP
 * / 3dm import failed with exactly that CSP error, even though the vendored
 * reader files were deployed and the wasm fetched fine.
 * The parsing therefore runs in a dedicated module worker whose document is
 * served with a scoped CSP that permits dynamic execution for these readers
 * only (see applySecurityHeaders in vite.config.ts, vercel.json and
 * public/_headers). The main application policy stays strict and the worker
 * has no DOM or BIM state: its only I/O is bytes in, triangle buffers out.
 */

/** Structured failure codes surfaced by the reader (mirrors the DWG taxonomy). */
export type SolidReaderErrorCode =
  | "init-failed"   // wasm/emscripten startup failed inside the worker
  | "invalid-file"  // not a STEP/IGES/BREP/3dm file (header check failed)
  | "parse-failed"  // reader rejected the file (corrupt or unsupported)
  | "internal";     // unexpected failure inside the reader

export interface SolidOcctRequest {
  id: number;
  kind: "occt";
  fileKind: "step" | "iges" | "brep";
  bytes: ArrayBuffer;
  fileName: string;
}

export interface SolidRhinoRequest {
  id: number;
  kind: "rhino";
  bytes: ArrayBuffer;
  fileName: string;
}

export type SolidReaderRequest = SolidOcctRequest | SolidRhinoRequest;

/** Ack: lets the main thread start its per-request timeout only now. */
export interface SolidReaderStarted {
  id: number;
  kind: "started";
}

export interface SolidReaderSuccess {
  id: number;
  kind: "done";
  ok: true;
  /** Triangle buffers for each drawable part (positions/normals in metres, app axes, flipped winding). */
  parts: Array<{
    name: string;
    /** 0..1 RGB, or null when the file gave no colour. */
    color: [number, number, number] | null;
    positions: Float32Array;
    normals: Float32Array | null;
    indices: Uint32Array;
  }>;
  warnings: string[];
  triangles: number;
  /** 3dm only: which object types were counted but not drawn. */
  skippedTypes?: Record<string, number>;
  /** 3dm only: recognised length unit of the file. */
  unitLabel?: string;
  unitKnown?: boolean;
}

export interface SolidReaderFailure {
  id: number;
  kind: "done";
  ok: false;
  code: SolidReaderErrorCode;
  message: string;
}

export type SolidReaderResponse = SolidReaderStarted | SolidReaderSuccess | SolidReaderFailure;
