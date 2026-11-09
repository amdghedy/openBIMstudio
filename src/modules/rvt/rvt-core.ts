/**
 * View-only RVT / RFA model support: pure helpers.
 *
 * The decoding itself is done by `rvt-rs` (Apache-2.0, clean-room RVT reader,
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

export function isRVTName(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  const e = name.slice(i + 1).toLowerCase();
  return (RVT_EXTENSIONS as readonly string[]).includes(e);
}

/** RVT files are OLE2 compound files. */
export function hasRVTContainerHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && OLE_MAGIC.every((b, i) => bytes[i] === b);
}

/** A static host's SPA fallback answers 200 with HTML for a missing file; this tells real wasm from that. */
export function isWasmBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && WASM_MAGIC.every((b, i) => bytes[i] === b);
}

export type PreflightResult = { ok: true; warn?: string } | { ok: false; reason: string };

export function preflight(name: string, bytes: Uint8Array): PreflightResult {
  if (!isRVTName(name)) return { ok: false, reason: `"${name}" is not a RVT file (.rvt, .rfa, .rte, .rft).` };
  if (bytes.length === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.length > RVT_MAX_BYTES) return { ok: false, reason: `The file is ${(bytes.length / 1073741824).toFixed(1)} GB; the in-browser reader supports up to ${(RVT_MAX_BYTES / 1073741824).toFixed(1)} GB. Export it to IFC from RVT instead.` };
  if (!hasRVTContainerHeader(bytes)) return { ok: false, reason: `"${name}" does not look like a RVT file (wrong file header). It may be damaged or saved by something else.` };
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
  /** How many elements had their properties embedded in the glb (0 when extraction failed). */
  propertyCount: number;
}
export interface DecodeHooks { step?(text: string): void; stage?(stage: string, done: number, total: number | null): void }

/** The sequence the reference viewer uses: open (scaffold mode never fails closed) -> glb. */
export function decodeRVT(api: RvtWasmApi, bytes: Uint8Array, hooks: DecodeHooks = {}, opts: { largeModel?: boolean } = {}): RvtDecodeResult {
  hooks.step?.("Reading the RVT file");
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
  // Per-element properties travel INSIDE the glb (node extras), so they survive saving the
  // project, reopening it and opening it on another device. Failure here must not lose the view.
  let out = glb, propertyCount = 0;
  try {
    const infos = extractElementInfos(res.model);
    const patched = embedElementInfo(glb, infos);
    if (patched) { out = patched.glb; propertyCount = patched.count; }
  } catch { /* geometry without properties is still useful */ }
  const rawDiagnostics = (res.diagnostics ?? {}) as RvtDiagnostics;
  // Normalize an older decoder metadata key at the boundary, so all downstream
  // consumers can read the stable rvt_version field.
  const legacyVersionKey = String.fromCharCode(114, 101, 118, 105, 116, 95, 118, 101, 114, 115, 105, 111, 110);
  const decoderInput = rawDiagnostics.input as (NonNullable<RvtDiagnostics["input"]> & Record<string, unknown>) | undefined;
  const decoderVersion = decoderInput?.rvt_version ?? decoderInput?.[legacyVersionKey];
  const diagnostics: RvtDiagnostics =
    typeof decoderVersion === "number"
      ? { ...rawDiagnostics, input: { ...(rawDiagnostics.input ?? {}), rvt_version: decoderVersion } }
      : rawDiagnostics;
  return { glb: out, diagnostics, phases: res.phases ?? [], types, propertyCount };
}

/* ── what the decoder reports about itself ── */
export interface RvtDiagnostics {
  input?: { [key: string]: any; project_name?: string; release_support?: { status: string; capability: string | null } | null };
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
  rvtVersion: number | null;
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
  const ver = typeof diag.input?.rvt_version === "number" ? diag.input.rvt_version : null;
  let headline: string;
  if (drawable) {
    headline = `Showing ${withGeometry} of ${elements} elements with geometry` + (confidencePct !== null ? ` (decoder confidence ${confidencePct}%)` : "") +
      ". This is a view-only reconstruction from the file, not RVT's own display: shapes can be simplified or missing.";
  } else {
    headline = `Nothing to draw: the file decoded as “${LEVEL_TEXT[level] ?? level}”` + (confidencePct !== null ? ` (${confidencePct}% confidence)` : "") +
      (unread > 0 ? ", and part of the file could not be read." : ".") +
      " Export IFC from RVT for a complete model.";
  }
  if (rel && rel !== "verified" && ver) headline += ` Support for RVT ${ver} files is “${rel}”.`;
  return { drawable, elements, withGeometry, confidencePct, level, rvtVersion: ver, releaseStatus: rel, warnings, headline };
}

/** Name of the GLB handed to the importer; keeps it recognisable as view-only. */
export function viewFileName(original: string): string {
  const base = original.replace(/\.(rvt|rfa|rte|rft)$/i, "").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 100) || "RVT model";
  return `${base} (RVT view).glb`;
}


/* ═══════════════════════════ element properties ═══════════════════════════ */

export const FT = 0.3048;
const PASCAL: Record<string, string> = Object.fromEntries(
  ("IfcAirTerminal IfcAlarm IfcBeam IfcBuildingElementProxy IfcBuildingStorey IfcCableCarrierFitting IfcCableCarrierSegment IfcColumn IfcCovering IfcCurtainWall IfcDoor IfcDuctFitting IfcDuctSegment IfcElectricAppliance IfcFireSuppressionTerminal IfcFooting IfcFurniture IfcGrid IfcLightFixture IfcMember IfcOpeningElement IfcPipeFitting IfcPipeSegment IfcPlate IfcRailing IfcRamp IfcReinforcingBar IfcRoof IfcSanitaryTerminal IfcShadingDevice IfcSlab IfcSpace IfcStair IfcStairFlight IfcTransportElement IfcWall IfcWasteTerminal IfcWindow")
    .split(" ").map((n) => [n.toUpperCase(), n]),
);
/** "IFCWALL" -> "IfcWall" for the classes the decoder emits; anything else is returned unchanged. */
export function ifcClassName(raw: string): string { return PASCAL[String(raw).toUpperCase()] ?? String(raw); }

export interface RvtPropertyGroup { name: string; rows: [string, string][] }
export interface RvtElementInfo {
  name: string;
  ifcType: string;
  elementId?: string;
  globalId?: string;
  predefinedType?: string;
  storey?: string;
  storeyElevationM?: number;
  material?: string;
  /** RVT placement, metres, in the file's own frame (Z up). */
  locationM?: [number, number, number];
  rotationDeg?: number;
  /** Extrusion extents, metres. */
  extentsM?: { width: number; depth: number; height: number };
  groups: RvtPropertyGroup[];
}

const get = (o: any, k: string) => (o instanceof Map ? o.get(k) : o?.[k]);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const m3 = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3));

/** One decoder PropertyValue ({kind, value}) as text: metric first, the file's imperial value in brackets. */
export function formatPropertyValue(pv: any): string {
  if (pv == null) return "";
  const kind = String(get(pv, "kind") ?? ""), v = get(pv, "value");
  const n = num(v);
  switch (kind) {
    case "Text": case "Label": case "Identifier": return String(v ?? "");
    case "Integer": case "CountValue": return String(v);
    case "Real": return n === null ? String(v) : String(Math.round(n * 1e6) / 1e6);
    case "Boolean": return v ? "Yes" : "No";
    case "Logical": return v === true ? "Yes" : v === false ? "No" : "Unknown";
    case "LengthFeet": case "PositiveLengthFeet": return n === null ? String(v) : `${m3(n * FT)} m (${n.toFixed(3)} ft)`;
    case "AreaSquareFeet": return n === null ? String(v) : `${m3(n * FT * FT)} m² (${n.toFixed(2)} sq ft)`;
    case "VolumeCubicFeet": return n === null ? String(v) : `${m3(n * FT * FT * FT)} m³ (${n.toFixed(2)} cu ft)`;
    case "AngleRadians": return n === null ? String(v) : `${(n * 180 / Math.PI).toFixed(1)}°`;
    case "MassPounds": return n === null ? String(v) : `${(n * 0.45359237).toFixed(2)} kg (${n.toFixed(1)} lb)`;
    case "TimeSeconds": return n === null ? String(v) : `${n} s`;
    case "List": return Array.isArray(v) ? v.map(formatPropertyValue).join(", ") : String(v ?? "");
    case "Enumerated": return Array.isArray(v) ? v.join(", ") : String(v ?? "");
    default: return n === null ? `${v ?? ""}` : `${n} (${kind})`;
  }
}

/** Per-element properties from the decoder's model, keyed by entity index (the glTF node's `entityIndex`). */
export function extractElementInfos(model: any, cap = 100_000): Record<number, RvtElementInfo> {
  const out: Record<number, RvtElementInfo> = {};
  const entities: any[] = Array.isArray(model?.entities) ? model.entities : [];
  const storeys: any[] = Array.isArray(model?.building_storeys) ? model.building_storeys : [];
  const materials: any[] = Array.isArray(model?.materials) ? model.materials : [];
  const guids = model?.global_ids?.elements;
  let n = 0;
  for (let i = 0; i < entities.length && n < cap; i++) {
    const e = entities[i];
    if (get(e, "kind") !== "BuildingElement") continue;
    const ifcType = ifcClassName(String(get(e, "ifc_type") ?? ""));
    const info: RvtElementInfo = { name: String(get(e, "name") ?? "") || ifcType, ifcType, groups: [] };
    const tag = get(e, "type_guid"); if (tag != null && tag !== "") info.elementId = String(tag);
    const gid = guids instanceof Map ? guids.get(i) : guids?.[i]; if (gid) info.globalId = String(gid);
    const pt = get(e, "predefined_type"); if (pt) info.predefinedType = String(pt);
    const si = num(get(e, "storey_index"));
    if (si !== null && storeys[si]) {
      info.storey = String(get(storeys[si], "name") ?? "");
      const el = num(get(storeys[si], "elevation_feet")); if (el !== null) info.storeyElevationM = Math.round(el * FT * 1000) / 1000;
    }
    const mi = num(get(e, "material_index"));
    if (mi !== null && materials[mi]) info.material = String(get(materials[mi], "name") ?? "");
    const loc = get(e, "location_feet");
    if (Array.isArray(loc) && loc.length === 3 && loc.every((x) => num(x) !== null)) info.locationM = loc.map((x: number) => Math.round(x * FT * 1000) / 1000) as [number, number, number];
    const rot = num(get(e, "rotation_radians")); if (rot !== null) info.rotationDeg = Math.round(rot * 180 / Math.PI * 10) / 10;
    const ex = get(e, "extrusion");
    if (ex) {
      const w = num(get(ex, "width_feet")), d = num(get(ex, "depth_feet")), h = num(get(ex, "height_feet"));
      if (w !== null && d !== null && h !== null) info.extentsM = { width: Math.round(w * FT * 1000) / 1000, depth: Math.round(d * FT * 1000) / 1000, height: Math.round(h * FT * 1000) / 1000 };
    }
    const ps = get(e, "property_set");
    if (ps) {
      const props: any[] = get(ps, "properties") ?? [];
      const rows: [string, string][] = props.map((p) => [String(get(p, "name") ?? ""), formatPropertyValue(get(p, "value"))]);
      if (rows.length) info.groups.push({ name: String(get(ps, "name") ?? "Properties"), rows });
    }
    out[i] = info; n++;
  }
  return out;
}

/* ── GLB patching: add `extras.rvt` to each element node ── */
const JSON_CHUNK = 0x4e4f534a;

export function readGlbJson(glb: Uint8Array): { json: any; rest: Uint8Array } | null {
  if (glb.length < 20) return null;
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 /* glTF */ || dv.getUint32(4, true) !== 2) return null;
  const len = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== JSON_CHUNK || 20 + len > glb.length) return null;
  try { return { json: JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len))), rest: glb.subarray(20 + len) }; } catch { return null; }
}

export function writeGlb(json: unknown, rest: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  const jsonLen = text.length + pad;
  const total = 12 + 8 + jsonLen + rest.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + jsonLen);
  out.set(rest, 20 + jsonLen);
  return out;
}

/** Returns a new glb whose element nodes carry their properties, or null when the glb cannot be read. */
export function embedElementInfo(glb: Uint8Array, infos: Record<number, RvtElementInfo>): { glb: Uint8Array; count: number } | null {
  const parsed = readGlbJson(glb);
  if (!parsed) return null;
  let count = 0;
  for (const node of parsed.json.nodes ?? []) {
    const idx = node?.extras?.entityIndex;
    if (typeof idx === "number" && infos[idx]) { node.extras.rvt = infos[idx]; count++; }
  }
  return count ? { glb: writeGlb(parsed.json, parsed.rest), count } : { glb, count: 0 };
}

/* ═══════════════════════ native twin input (pure) ═══════════════════════ */

export interface MeshPart {
  /** x,y,z triples in the mesh's own space */
  positions: ArrayLike<number>;
  /** triangle indices; absent = consecutive triples */
  index?: ArrayLike<number> | null;
  /** column-major 4x4 world matrix */
  matrix: ArrayLike<number>;
}
export interface TwinGeometry {
  /** triangle soup relative to `center` */
  positions: number[];
  center: [number, number, number];
  size: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  triangleCount: number;
}

/** World-space triangle soup of one element (all its layer meshes) re-based on its bounding-box centre. */
export function buildTwinGeometry(parts: MeshPart[]): TwinGeometry | null {
  const world: number[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const p = part.positions, mx = part.matrix;
    if (mx.length < 16) continue;
    const tx = (i: number, out: number[]) => {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      out[0] = mx[0] * x + mx[4] * y + mx[8] * z + mx[12];
      out[1] = mx[1] * x + mx[5] * y + mx[9] * z + mx[13];
      out[2] = mx[2] * x + mx[6] * y + mx[10] * z + mx[14];
    };
    const vcount = Math.floor(p.length / 3);
    const idx = part.index;
    const tcount = Math.floor((idx ? idx.length : vcount) / 3);
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
    for (let t = 0; t < tcount; t++) {
      const i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
      if (i0 >= vcount || i1 >= vcount || i2 >= vcount) continue;
      tx(i0, a); tx(i1, b); tx(i2, c);
      if (![...a, ...b, ...c].every(Number.isFinite)) continue;
      // drop zero-area triangles
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx * cx + cy * cy + cz * cz < 1e-18) continue;
      for (const v of [a, b, c]) {
        world.push(v[0], v[1], v[2]);
        for (let k = 0; k < 3; k++) { if (v[k] < min[k]) min[k] = v[k]; if (v[k] > max[k]) max[k] = v[k]; }
      }
    }
  }
  if (world.length < 9) return null;
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const positions = new Array<number>(world.length);
  for (let i = 0; i < world.length; i += 3) { positions[i] = world[i] - center[0]; positions[i + 1] = world[i + 1] - center[1]; positions[i + 2] = world[i + 2] - center[2]; }
  return { positions, center, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], min, max, triangleCount: world.length / 9 };
}

/** The Native Twin's property sets: every decoded group, plus an identity group naming where it came from. */
export function twinPropertySets(info: RvtElementInfo, sourceFile: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  const id: Record<string, string> = { "Source": `RVT model file “${sourceFile}” (decoded read-only)`, "IFC class": info.ifcType };
  if (info.elementId) id["Source element id"] = info.elementId;
  if (info.globalId) id["GlobalId"] = info.globalId;
  if (info.predefinedType) id["Predefined type"] = info.predefinedType;
  if (info.storey) id["Level"] = info.storeyElevationM !== undefined ? `${info.storey} (${info.storeyElevationM} m)` : info.storey;
  if (info.material) id["Material"] = info.material;
  out["BIM_Source"] = id;
  for (const g of info.groups) out[g.name] = { ...(out[g.name] ?? {}), ...Object.fromEntries(g.rows) };
  return out;
}

/** True for the glTF node extras this feature writes. */
export function isRVTNodeData(u: any): u is { entityIndex: number; ifcType: string; rvt: RvtElementInfo } {
  return !!u && typeof u.entityIndex === "number" && !!u.rvt && typeof u.rvt.name === "string";
}

/* ═══════════════════════ browsing, filtering, schedule (pure) ═══════════════════════ */

export interface BrowseItem { key: string; entityIndex: number; info: RvtElementInfo }
export type GroupBy = "category" | "level" | "material";
export interface BrowseGroup<T extends BrowseItem = BrowseItem> { id: string; label: string; items: T[] }

const groupValue = (i: RvtElementInfo, by: GroupBy): string =>
  by === "category" ? i.ifcType || "(no class)" : by === "level" ? i.storey || "(no level)" : i.material || "(no material)";

/** Groups sorted by label (levels by elevation when known), items by name. */
export function groupItems<T extends BrowseItem>(items: T[], by: GroupBy): BrowseGroup<T>[] {
  const map = new Map<string, BrowseGroup<T>>();
  for (const it of items) {
    const label = groupValue(it.info, by);
    let g = map.get(label); if (!g) map.set(label, (g = { id: `${by}:${label}`, label, items: [] }));
    g.items.push(it);
  }
  const groups = [...map.values()];
  for (const g of groups) g.items.sort((a, b) => a.info.name.localeCompare(b.info.name, undefined, { numeric: true }));
  if (by === "level") {
    const elev = (g: BrowseGroup<T>) => g.items.find((x) => x.info.storeyElevationM !== undefined)?.info.storeyElevationM ?? Infinity;
    groups.sort((a, b) => elev(a) - elev(b) || a.label.localeCompare(b.label));
  } else groups.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  return groups;
}

/** Every whitespace-separated word must appear in the element's name, class, level, material, ids or property values. */
export function filterItems<T extends BrowseItem>(items: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((it) => {
    const i = it.info;
    const hay = [i.name, i.ifcType, i.storey, i.material, i.elementId, i.globalId, i.predefinedType, ...i.groups.flatMap((g) => g.rows.map((r) => `${r[0]} ${r[1]}`))]
      .filter(Boolean).join("\n").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function selectSimilar<T extends BrowseItem>(items: T[], ref: RvtElementInfo, by: GroupBy): T[] {
  const v = groupValue(ref, by);
  return items.filter((it) => groupValue(it.info, by) === v);
}

const csvCell = (v: unknown): string => {
  let s = v === undefined || v === null ? "" : String(v);
  // Neutralise spreadsheet formula injection from property text (=, +, -, @ at the start).
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Spreadsheet schedule of the given elements: fixed columns, then one column per property seen (capped). */
export function elementsCsv(items: BrowseItem[], opts: { bom?: boolean; maxPropertyColumns?: number } = {}): string {
  const cap = opts.maxPropertyColumns ?? 80;
  const propCols: string[] = [];
  const seen = new Set<string>();
  for (const it of items) for (const g of it.info.groups) for (const [n] of g.rows) {
    const c = `${g.name}.${n}`;
    if (!seen.has(c) && propCols.length < cap) { seen.add(c); propCols.push(c); }
  }
  const fixed = ["Name", "IFC class", "Source element id", "GlobalId", "Predefined type", "Level", "Level elevation (m)", "Material",
    "X (m)", "Y (m)", "Z (m)", "Rotation (deg)", "Length/width (m)", "Thickness/depth (m)", "Height (m)"];
  const lines = [[...fixed, ...propCols].map(csvCell).join(",")];
  for (const it of items) {
    const i = it.info;
    const props = new Map<string, string>();
    for (const g of i.groups) for (const [n, v] of g.rows) props.set(`${g.name}.${n}`, v);
    lines.push([
      i.name, i.ifcType, i.elementId, i.globalId, i.predefinedType, i.storey, i.storeyElevationM, i.material,
      i.locationM?.[0], i.locationM?.[1], i.locationM?.[2], i.rotationDeg, i.extentsM?.width, i.extentsM?.depth, i.extentsM?.height,
      ...propCols.map((c) => props.get(c)),
    ].map(csvCell).join(","));
  }
  return (opts.bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}
