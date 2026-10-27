/**
 * DWG parse pipeline (isomorphic core): runs inside the reader worker and in
 * Node regression tests. Imports @mlightcad/libredwg-web lazily and converts
 * a DWG byte buffer to a DxfDocument via dwgDatabaseToDxfDocument.
 *
 * Every failure exits through DwgParseError with a structured code so the UI
 * can show actionable diagnostics instead of a raw wasm message.
 */
import type { DxfDocument } from "../drawings/dxf-types";
import { dwgDatabaseToDxfDocument } from "../drawings/dwg-convert";
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
  const bytes = new Uint8Array(buffer);
  const sniff = sniffDwgVersion(bytes);
  if (!sniff) {
    throw new DwgParseError(
      "invalid-file",
      `${fileName} is not a DWG file (missing DWG version stamp such as AC1032). If this is a DXF, import it with the DXF path.`,
    );
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

  const res = dwgDatabaseToDxfDocument(db);
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

/** Map any thrown value to a structured code (worker boundary + tests). */
export function toDwgParseError(e: unknown): { code: DwgReaderErrorCode; message: string; detail?: string } {
  if (e && typeof e === "object" && "code" in (e as Any) && typeof (e as Any).code === "string") {
    const err = e as DwgParseError;
    return { code: err.code as DwgReaderErrorCode, message: err.message, detail: err.detail };
  }
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}
