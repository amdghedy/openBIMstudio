/**
 * View-only Revit (.rvt / .rfa) support: pure helpers.
 *
 * The decoding itself is done by `rvt-rs` (Apache-2.0, clean-room Revit reader,
 * https://github.com/DrunkOnJava/rvt-rs) compiled to WebAssembly and loaded from
 * /rvt/ (built by scripts/build-rvt-wasm.mjs). It runs in a Worker inside the
 * tab; the file is never uploaded. This module holds everything that does not
 * need the DOM or the wasm, so it is unit-tested with a fake decoder.
 *
 * Honesty rule: decoding a closed format is partial. Every result carries the
 * decoder's own confidence and we always say so; geometry is for viewing, not
 * for measuring or clash detection.
 */

export const RVT_EXTENSIONS = ["rvt", "rfa", "rte", "rft"] as const;
/** Refused above this: the wasm32 decoder cannot address more than 4 GiB. */
export const RVT_MAX_BYTES = 1.5 * 1024 * 1024 * 1024;
/** Warned above this: decoding needs several times the file size in memory. */
export const RVT_WARN_BYTES = 300 * 1024 * 1024;
export const RVT_WASM_URL = "/rvt/rvt_bg.wasm";
export const RVT_JS_URL = "/rvt/rvt.js";

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export function isRevitName(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  const e = name.slice(i + 1).toLowerCase();
  return (RVT_EXTENSIONS as readonly string[]).includes(e);
}

/** Revit files are OLE2 compound files. */
export function hasRevitContainerHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && OLE_MAGIC.every((b, i) => bytes[i] === b);
}

/** A static host's SPA fallback answers 200 with HTML for a missing file; this tells real wasm from that. */
export function isWasmBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && WASM_MAGIC.every((b, i) => bytes[i] === b);
}

export type PreflightResult = { ok: true; warn?: string } | { ok: false; reason: string };

export function preflight(name: string, bytes: Uint8Array): PreflightResult {
  if (!isRevitName(name)) return { ok: false, reason: `"${name}" is not a Revit file (.rvt, .rfa, .rte, .rft).` };
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > RVT_MAX_BYTES) return { ok: false, reason: `The file is ${(bytes.length / 1073741824).toFixed(1)} GB; the in-browser reader supports up to ${(RVT_MAX_BYTES / 1073741824).toFixed(1)} GB. Export it to IFC from Revit instead.` };
  if (!hasRevitContainerHeader(bytes)) return { ok: false, reason: `"${name}" does not look like a Revit file (wrong file header). It may be damaged or saved by something else.` };
  if (bytes.length > RVT_WARN_BYTES) return { ok: true, warn: `Large file (${Math.round(bytes.length / 1048576)} MB): decoding needs a lot of memory and may be slow or fail on a phone.` };
  return { ok: true };
}

/* ── decoder API (the functions rvt-wasm exports, see rvt-wasm/src/lib.rs) ── */
export interface RvtWasmApi {
  openRvtBytesWithDiagnosticsModeAndOpenLimits(bytes: Uint8Array, mode: string, limits: unknown, onStage: (stage: string, done: number, total: number | null) => void): { model: unknown; diagnostics: unknown; phases?: unknown[] };
  modelToGlb(model: unknown): Uint8Array;
  buildSceneGraph?(model: unknown): unknown;
  distinctIfcTypes?(scene: unknown): unknown;
  quickSummary?(bytes: Uint8Array): unknown;
}

export interface RvtDecodeResult {
  glb: Uint8Array;
  diagnostics: RvtDiagnostics;
  phases: unknown[];
  types: string[];
}
export interface DecodeHooks { step?(text: string): void; stage?(stage: string, done: number, total: number | null): void }

/** The sequence the reference viewer uses: open (scaffold mode never fails closed) -> glb. */
export function decodeRevit(api: RvtWasmApi, bytes: Uint8Array, hooks: DecodeHooks = {}, opts: { largeModel?: boolean } = {}): RvtDecodeResult {
  hooks.step?.("Reading the Revit file");
  const res = api.openRvtBytesWithDiagnosticsModeAndOpenLimits(
    bytes, "scaffold", opts.largeModel ? { largeModel: true } : null,
    (stage, done, total) => hooks.stage?.(stage, done, total),
  );
  if (!res || typeof res !== "object" || !("model" in res)) throw new Error("The decoder returned no model.");
  let types: string[] = [];
  try {
    if (api.buildSceneGraph && api.distinctIfcTypes) { const t = api.distinctIfcTypes(api.buildSceneGraph(res.model)); if (Array.isArray(t)) types = t.map(String); }
  } catch { /* the type list is informational */ }
  hooks.step?.("Building the 3D view");
  const glb = api.modelToGlb(res.model);
  if (!(glb instanceof Uint8Array) || glb.length < 12) throw new Error("The decoder produced no 3D data.");
  return { glb, diagnostics: (res.diagnostics ?? {}) as RvtDiagnostics, phases: res.phases ?? [], types };
}

/* ── what the decoder reports about itself ── */
export interface RvtDiagnostics {
  input?: { revit_version?: number; project_name?: string; release_support?: { status: string; capability: string | null } | null };
  confidence?: { level?: string; score?: number; has_geometry?: boolean };
  exported?: { building_elements?: number; building_elements_with_geometry?: number; bounding_box_bodies?: number; storey_count?: number };
  warnings?: string[];
  skipped?: { reason?: string; count?: number }[];
}

export interface RvtSummary {
  /** true when there is something to draw */
  drawable: boolean;
  elements: number;
  withGeometry: number;
  confidencePct: number | null;
  level: string;
  revitVersion: number | null;
  releaseStatus: string | null;
  warnings: string[];
  /** One honest sentence for the user. */
  headline: string;
}

const LEVEL_TEXT: Record<string, string> = {
  geometry: "geometry decoded",
  typed_no_geometry: "elements decoded but without geometry",
  diagnostic_partial: "partly decoded",
  proxy_only: "placeholder objects only",
  scaffold: "project structure only",
};

export function summarizeDiagnostics(d: RvtDiagnostics | undefined | null, drawnTriangles?: number): RvtSummary {
  const diag = d ?? {};
  const elements = diag.exported?.building_elements ?? 0;
  const withGeometry = diag.exported?.building_elements_with_geometry ?? 0;
  const level = diag.confidence?.level ?? "unknown";
  const score = diag.confidence?.score;
  const confidencePct = typeof score === "number" ? Math.round(score * 100) : null;
  const unread = (diag.skipped ?? []).reduce((n, s) => n + (s.count ?? 0), 0);
  const drawable = withGeometry > 0 && (drawnTriangles === undefined || drawnTriangles > 0);
  const warnings = (diag.warnings ?? []).slice(0, 5).map((w) => String(w).slice(0, 200));
  const rel = diag.input?.release_support?.status ?? null;
  const ver = typeof diag.input?.revit_version === "number" ? diag.input.revit_version : null;
  let headline: string;
  if (drawable) {
    headline = `Showing ${withGeometry} of ${elements} elements with geometry` + (confidencePct !== null ? ` (decoder confidence ${confidencePct}%)` : "") +
      ". This is a view-only reconstruction from the file, not Revit's own display: shapes can be simplified or missing.";
  } else {
    headline = `Nothing to draw: the file decoded as “${LEVEL_TEXT[level] ?? level}”` + (confidencePct !== null ? ` (${confidencePct}% confidence)` : "") +
      (unread > 0 ? ", and part of the file could not be read." : ".") +
      " Export IFC from Revit for a complete model.";
  }
  if (rel && rel !== "verified" && ver) headline += ` Support for Revit ${ver} files is “${rel}”.`;
  return { drawable, elements, withGeometry, confidencePct, level, revitVersion: ver, releaseStatus: rel, warnings, headline };
}

/** Name of the GLB handed to the importer; keeps it recognisable as view-only. */
export function viewFileName(original: string): string {
  const base = original.replace(/\.(rvt|rfa|rte|rft)$/i, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100) || "Revit model";
  return `${base} (Revit view).glb`;
}
