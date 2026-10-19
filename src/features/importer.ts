/**
 * IFC importer with 5 BIM-style positioning modes + live offset control.
 *
 * Position pinning
 * ────────────────
 * Fragments sets `matrixAutoUpdate = false` on loaded models. The pin loop
 * forces it true, writes position, and calls updateMatrix + updateMatrixWorld
 * inside renderer.render so the SDK's auto-coordinator cannot shift models.
 *
 * Offsets
 * ───────
 * Each model has an "offset" (its world position). Default is (0,0,0).
 * The alignment panel writes offsets; the pin loop enforces them forever.
 */
import * as THREE from "three";
import * as FRAGS from "@thatopen/fragments";
import * as WEBIFC from "web-ifc";
import { ctx } from "../core/context";
import {
  computeSceneBounds, fitAll,
  recenterSceneNow, resetOffsets, setRecenterEnabled,
} from "./camera-tools";
import { refreshModelSelectionUI } from "./clash";

export type PositioningMode =
  | "origin-to-origin"
  | "shared-coordinates"
  | "center-to-center"
  | "project-base-to-project-base"
  | "manual";

export interface PositioningModeInfo {
  id: PositioningMode;
  label: string;
  description: string;
}

export const POSITIONING_MODES: PositioningModeInfo[] = [
  {
    id: "origin-to-origin",
    label: "Origin to Origin",
    description:
      "Both files at (0,0,0). Works when the IFC were exported with Project Base Point positioning — geometry carries the shared offsets.",
  },
  {
    id: "shared-coordinates",
    label: "By Shared Coordinates",
    description:
      "Both files at (0,0,0). Same as origin-to-origin, but for IFC exported with Shared Coordinates (Survey Point).",
  },
  {
    id: "center-to-center",
    label: "Center to Center",
    description:
      "Aligns visible bounding box centers. Always stacks the models visually — use when files have different internal origins.",
  },
  {
    id: "project-base-to-project-base",
    label: "Project Base to Project Base",
    description:
      "Re-anchors each model's Project Base Point onto (0,0,0). Requires the IFC to carry PBP metadata.",
  },
  {
    id: "manual",
    label: "Manual",
    description:
      "No automatic placement. Drag models with the transform gizmo, or use the alignment panel.",
  },
];

// ── Types ──
type ImportStatus =
  | "queued" | "reading" | "converting" | "loading"
  | "done" | "failed" | "cancelled" | "skipped";

interface ImportTask {
  uid: number;
  file: File;
  sizeMB: number;
  schema: string;
  status: ImportStatus;
  progress: number;
  phase: string;
  elapsedMs: number;
  error?: string;
  fragBytes?: Uint8Array;
  modelId?: string;
  elements?: number;
}

export type IfcSettings = {
  cdn: "local" | "unpkg" | "jsdelivr" | "custom";
  version: string;
  customPath: string;
  autoFit: boolean;
  keepFragInMemory: boolean;
  replaceExisting: boolean;
  recenter: boolean;
  maxSizeMB: number;
  useCoord: boolean;
  coordX: number; coordY: number; coordZ: number;
  positioning: PositioningMode;
};

const IFC_SETTINGS_KEY = "toc.ifc.settings.v1";

const defaultIfcSettings: IfcSettings = {
  cdn: "local", version: "0.0.77", customPath: "",
  autoFit: true, keepFragInMemory: true, replaceExisting: false,
  recenter: false, maxSizeMB: 500, useCoord: false, coordX: 0, coordY: 0, coordZ: 0,
  positioning: "origin-to-origin",
};

let ifcSettings: IfcSettings = { ...defaultIfcSettings };
try {
  const raw = localStorage.getItem(IFC_SETTINGS_KEY);
  if (raw) ifcSettings = { ...defaultIfcSettings, ...JSON.parse(raw) };
  if (ifcSettings.cdn === "unpkg" || ifcSettings.cdn === "jsdelivr") {
    ifcSettings.cdn = "local";
    saveIfcSettings();
  }
} catch { /* */ }

function saveIfcSettings() {
  try { localStorage.setItem(IFC_SETTINGS_KEY, JSON.stringify(ifcSettings)); } catch { /* */ }
}

function wasmPath(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  if (ifcSettings.cdn === "custom" && ifcSettings.customPath.trim()) {
    let c = ifcSettings.customPath.trim();
    if (!c.endsWith("/")) c += "/";
    return c;
  }
  return `${origin}/web-ifc/`;
}

function snapshotBytes(src: any): Uint8Array {
  try {
    if (src instanceof Uint8Array) return src.slice();
    if (src instanceof ArrayBuffer) return new Uint8Array(src);
    if (ArrayBuffer.isView(src)) {
      const v = src as ArrayBufferView;
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
    }
  } catch { /* */ }
  return new Uint8Array(0);
}

// ── Importer lifecycle ──
let ifcImporter: any = null;
let cancelRequested = false;
let cancelAllRequested = false;
let rejectActive: ((reason?: any) => void) | null = null;

function getImporter(): any {
  const path = wasmPath();

  // Force single-thread: under Vite/ESM document.currentScript is undefined
  // and the multi-thread worker URL becomes "undefined" → SyntaxError '<'
  try {
    const proto = (WEBIFC as any).IfcAPI?.prototype;
    if (proto && typeof proto.Init === "function" && !(proto.Init as any).__obsForcedST) {
      const origInit = proto.Init;
      proto.Init = function (handler?: any, _forceST?: boolean) {
        // Always force single-thread
        return origInit.call(this, handler, true);
      };
      (proto.Init as any).__obsForcedST = true;
      console.log("[importer] web-ifc Init patched → forceSingleThread=true");
    }
  } catch (e) {
    console.warn("[importer] could not patch web-ifc Init", e);
  }

  // Also make the page appear non-cross-origin-isolated during conversion
  // so web-ifc never chooses the MT path
  try {
    if (typeof self !== "undefined" && self.crossOriginIsolated) {
      Object.defineProperty(self, "crossOriginIsolated", {
        get: () => false,
        configurable: true,
      });
    }
  } catch { /* ignore */ }

  if (!ifcImporter) {
    ifcImporter = new FRAGS.IfcImporter();
  }
  ifcImporter.wasm = { absolute: true, path };
  // CRITICAL FIX: Force COORDINATE_TO_ORIGIN = false so web-ifc preserves
  // absolute IFC world coordinates instead of recentering each file's
  // geometry to its own first-element origin.
  //
  // The @thatopen/fragments IfcImporter defaults to
  //   webIfcSettings: { COORDINATE_TO_ORIGIN: true }
  // which tells web-ifc to translate every loaded IFC file so that its
  // first element's placement becomes (0, 0, 0). This strips absolute
  // world coordinates and breaks "Origin to Origin" linking — two IFC
  // files exported from the same Revit project (linked origin-to-origin
  // in Revit) end up at DIFFERENT local origins in openBIMstudio,
  // appearing far apart.
  //
  // With COORDINATE_TO_ORIGIN = false, web-ifc preserves the absolute
  // IFC ObjectPlacement coordinates. Two IFC files that share a Revit
  // coordinate system will appear at the correct relative positions in
  // openBIMstudio — matching Revit's "Origin to Origin" linking.
  //
  // Center-to-center positioning still works because it measures the
  // actual mesh bounds after load (setModelOffset uses the bbox center).
  // Manual positioning also still works (user picks an offset explicitly).
  try {
    ifcImporter.webIfcSettings = ifcImporter.webIfcSettings ?? {};
    ifcImporter.webIfcSettings.COORDINATE_TO_ORIGIN = false;
  } catch (e) {
    console.warn("[importer] could not override COORDINATE_TO_ORIGIN", e);
  }
  return ifcImporter;
}

async function ensureWasmAvailable(): Promise<void> {
  const base = wasmPath();
  const join_ = (f: string) => (base.endsWith("/") ? `${base}${f}` : `${base}/${f}`);
  for (const file of ["web-ifc.wasm"]) {
    const url = join_(file);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", cache: "no-cache" });
    } catch (e: any) {
      throw new Error(
        `Network error fetching WASM: ${url}\n${e?.message || e}\n\n` +
        `Run: npm install && npm run dev, then confirm ` +
        `http://localhost:3000/web-ifc/web-ifc.wasm downloads a binary.`,
      );
    }
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.length > 0 && bytes[0] === 0x3c) {
      throw new Error(`HTML instead of WASM at ${url}. Copy WASM into public/web-ifc/ and restart Vite.`);
    }
    if (!res.ok) throw new Error(`WASM HTTP ${res.status} at ${url}`);
    if (bytes.byteLength < 1000) throw new Error(`WASM too small at ${url}`);
  }
}

function disposeImporter() {
  try { ifcImporter?.dispose?.(); } catch { /* */ }
  ifcImporter = null;
}

function cancelActiveConversion() {
  cancelRequested = true;
  try { rejectActive?.(new Error("Cancelled by user")); } catch { /* */ }
  disposeImporter();
}

// ── Queue ──
const importQueue: ImportTask[] = [];
let queueUid = 0;
let processing = false;

function isActiveStatus(s: ImportStatus) {
  return s === "reading" || s === "converting" || s === "loading";
}

export const loadStatusEl = document.createElement("div");
loadStatusEl.style.cssText = "font-size:11px;margin-top:8px;color:#a5b4fc;line-height:1.4;min-height:1.2em";

export const queueSummaryEl = document.createElement("div");
queueSummaryEl.style.cssText = "margin:8px 0 4px;font-size:11px;color:#cbd5e1;line-height:1.5";

export const queueListEl = document.createElement("div");

const btnCss =
  "font:500 10px system-ui;padding:3px 8px;background:#2a2a3a;color:#e2e8f0;border:1px solid #3a3a4a;border-radius:4px;cursor:pointer";

const statusColor: Record<ImportStatus, string> = {
  queued: "#94a3b8", reading: "#a5b4fc", converting: "#38bdf8",
  loading: "#c084fc", done: "#22c55e", failed: "#ef4444",
  cancelled: "#f59e0b", skipped: "#f59e0b",
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
function fmtDur(ms: number) {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
function errorMessage(err: any): string {
  if (err instanceof Error) return err.message;
  if (err?.message != null) return String(err.message);
  return String(err);
}
function normalizeProgress(progress: any): number {
  let pct = 0;
  if (typeof progress === "number") pct = progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
  else if (progress && typeof progress.current === "number" && progress.total) {
    pct = Math.round((progress.current / progress.total) * 100);
  }
  return Math.max(0, Math.min(100, pct));
}
function describePhase(data?: any): string {
  if (data?.state) return `${data.process || "step"}: ${data.state}`;
  if (data?.process) return String(data.process);
  return "converting";
}
function detectSchema(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder().decode(bytes.subarray(0, 8192));
    const m = text.match(/FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i);
    if (m) return m[1].toUpperCase();
    return /ISO-10303-21/i.test(text) ? "STEP (schema not found)" : "unknown";
  } catch { return "unknown"; }
}

/* ═════════════════════════════════════════════════════════════════════════
   Position pinning + per-model offsets
   ═════════════════════════════════════════════════════════════════════════ */

/** Per-model offset (world position). Enforced by the pin loop. */
const modelOffsets = new Map<string, THREE.Vector3>();
const offsetsListeners = new Set<() => void>();

function notifyOffsets() {
  for (const cb of offsetsListeners) {
    try { cb(); } catch { /* */ }
  }
}
export function onOffsetsChanged(cb: () => void): () => void {
  offsetsListeners.add(cb);
  return () => offsetsListeners.delete(cb);
}

let pinLoopRunning = false;

function enforcePins(): void {
  for (const [id, off] of modelOffsets) {
    const model: any = ctx.fragments.list.get(id);
    const obj = model?.object;
    if (!obj) continue;
    if (obj.matrixAutoUpdate === false) obj.matrixAutoUpdate = true;
    const p = obj.position;
    if (
      Math.abs(p.x - off.x) > 1e-6 ||
      Math.abs(p.y - off.y) > 1e-6 ||
      Math.abs(p.z - off.z) > 1e-6
    ) {
      p.set(off.x, off.y, off.z);
      obj.updateMatrix();
      obj.updateMatrixWorld(true);
    }
  }
}

function ensurePinLoop(): void {
  if (pinLoopRunning) return;
  pinLoopRunning = true;

  try {
    const renderer: any = (ctx.world as any)?.renderer?.three;
    if (renderer && !renderer.__obsPinPatched) {
      renderer.__obsPinPatched = true;
      const orig = renderer.render.bind(renderer);
      renderer.render = function (...args: any[]) {
        enforcePins();
        return orig(...args);
      };
    }
  } catch (e) { console.warn("[positioning] renderer hook failed", e); }

  try {
    const core: any = ctx.fragments?.core;
    if (core && typeof core.update === "function" && !core.__obsPinPatched) {
      core.__obsPinPatched = true;
      const orig = core.update.bind(core);
      core.update = function (...args: any[]) {
        const r = orig(...args);
        enforcePins();
        return r;
      };
    }
  } catch (e) { console.warn("[positioning] core.update hook failed", e); }

  // No permanent rAF loop here. The renderer.render hook and the
  // fragments.core.update hook above already cover every path through
  // which the SDK could move a model. A per-frame enforcePins() would
  // walk every loaded model on every animation frame for the whole
  // session -- the same CPU burn that camera-tools.ts explicitly warns
  // against.
}

/** Register a model. Offset defaults to (0,0,0). */
export function registerModel(modelId: string): void {
  if (!modelOffsets.has(modelId)) {
    modelOffsets.set(modelId, new THREE.Vector3(0, 0, 0));
  }
  ensurePinLoop();
  notifyOffsets();
}

export function unregisterModel(modelId: string): void {
  if (modelOffsets.delete(modelId)) notifyOffsets();
}

export function clearAllOffsets(): void {
  modelOffsets.clear();
  notifyOffsets();
}

/** Set a model's world position (the pin target). */
export function setModelOffset(modelId: string, offset: [number, number, number]): void {
  if (!modelOffsets.has(modelId)) modelOffsets.set(modelId, new THREE.Vector3());
  const v = modelOffsets.get(modelId)!;
  v.set(offset[0], offset[1], offset[2]);
  enforcePins();
  notifyOffsets();
}

export function getModelOffset(modelId: string): [number, number, number] | null {
  const v = modelOffsets.get(modelId);
  return v ? [v.x, v.y, v.z] : null;
}

export function listRegisteredModels(): string[] {
  return Array.from(modelOffsets.keys());
}

/** Measure a model's visible bbox center (world space). */
export async function getModelBBoxCenter(modelId: string): Promise<[number, number, number] | null> {
  const model: any = ctx.fragments.list.get(modelId);
  if (!model) return null;
  try {
    const ids = await model.getItemsIdsWithGeometry();
    if (!ids?.length) return null;
    const boxes = await model.getBoxes(ids);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      if (!b || !b.min || !b.max) continue;
      if (b.min.x < minX) minX = b.min.x;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.min.y < minY) minY = b.min.y;
      if (b.max.y > maxY) maxY = b.max.y;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.z > maxZ) maxZ = b.max.z;
    }
    if (!isFinite(minX)) return null;
    return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  } catch {
    return null;
  }
}

/** Measure a model's visible bbox (min/max). */
export async function getModelBBox(
  modelId: string,
): Promise<{ min: [number, number, number]; max: [number, number, number] } | null> {
  const model: any = ctx.fragments.list.get(modelId);
  if (!model) return null;
  try {
    const ids = await model.getItemsIdsWithGeometry();
    if (!ids?.length) return null;
    const boxes = await model.getBoxes(ids);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of boxes) {
      if (!b || !b.min || !b.max) continue;
      if (b.min.x < minX) minX = b.min.x;
      if (b.max.x > maxX) maxX = b.max.x;
      if (b.min.y < minY) minY = b.min.y;
      if (b.max.y > maxY) maxY = b.max.y;
      if (b.min.z < minZ) minZ = b.min.z;
      if (b.max.z > maxZ) maxZ = b.max.z;
    }
    if (!isFinite(minX)) return null;
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
  } catch {
    return null;
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Positioning modes
   ═════════════════════════════════════════════════════════════════════════ */

export function getPositioningMode(): PositioningMode {
  return ifcSettings.positioning;
}

export function setPositioningMode(mode: PositioningMode, persist = true): void {
  ifcSettings.positioning = mode;
  if (persist) saveIfcSettings();
  if (positioningSelect) positioningSelect.value = mode;
}

/**
 * Apply a positioning mode to every currently loaded model.
 * Called after queue finishes, after loadFragFiles, and by the alignment panel.
 */
export async function applyPositioningMode(mode: PositioningMode = ifcSettings.positioning): Promise<void> {
  const ids = Array.from(ctx.fragments.list.keys());
  if (!ids.length) return;
  console.log(`[positioning] applying "${mode}" to ${ids.length} model(s)`);

  // Always reset each model to (0,0,0) first, then compute per-mode offsets.
  for (const id of ids) setModelOffset(id, [0, 0, 0]);
  await new Promise((r) => requestAnimationFrame(r));

  try {
    if (mode === "manual") {
      // no-op — user places models themselves
    } else if (mode === "center-to-center") {
      // Measure each model's current bbox center and pin to the negative
      for (const id of ids) {
        const c = await getModelBBoxCenter(id);
        if (!c) continue;
        setModelOffset(id, [-c[0], -c[1], -c[2]]);
      }
      // Now every visible bbox center is at (0,0,0) — models overlap.
    } else if (mode === "project-base-to-project-base") {
      // Best-effort: same as origin-to-origin for IFC that carries PBP.
      for (const id of ids) setModelOffset(id, [0, 0, 0]);
    } else {
      // origin-to-origin | shared-coordinates
      // Both files at (0,0,0). Geometry carries its own shared offsets.
      for (const id of ids) setModelOffset(id, [0, 0, 0]);
    }
  } catch (err) {
    console.warn("[positioning] apply failed", err);
  }

  try { computeSceneBounds(); } catch { /* */ }
  try { fitAll(); } catch { /* */ }
  notifyOffsets();
}

// ── Positioning UI (in-panel select) ──
export const positioningSelect = document.createElement("select");
positioningSelect.style.cssText =
  "width:100%;box-sizing:border-box;padding:6px 9px;margin:4px 0 8px;" +
  "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
  "border-radius:var(--r-sm,4px);color:var(--text-primary,#e8eaf0);font:12px system-ui;" +
  "cursor:pointer;outline:none";
positioningSelect.title = "How to place the next model relative to the ones already loaded";
positioningSelect.innerHTML = POSITIONING_MODES
  .map((m) => `<option value="${m.id}">Auto — ${m.label}</option>`)
  .join("");
positioningSelect.value = ifcSettings.positioning;
positioningSelect.onchange = () => {
  ifcSettings.positioning = positioningSelect.value as PositioningMode;
  saveIfcSettings();
  void applyPositioningMode(ifcSettings.positioning);
};

export function syncPositioningSelect(): void {
  positioningSelect.value = ifcSettings.positioning;
}

/* ═════════════════════════════════════════════════════════════════════════
   Task rows
   ═════════════════════════════════════════════════════════════════════════ */
function renderTaskRow(t: ImportTask): HTMLElement {
  const row = document.createElement("div");
  row.dataset.uid = String(t.uid);
  row.style.cssText =
    "border:1px solid #2a2a35;border-radius:6px;padding:8px;margin:6px 0;background:#14141c;font-size:11px";
  queueListEl.appendChild(row);
  refreshTaskRow(t);
  return row;
}

function refreshTaskRow(t: ImportTask) {
  const row = queueListEl.querySelector<HTMLElement>(`[data-uid="${t.uid}"]`);
  if (!row) return;

  const col = statusColor[t.status] ?? "#94a3b8";
  const active = isActiveStatus(t.status);
  const size = t.sizeMB >= 1 ? `${t.sizeMB.toFixed(1)} MB` : `${(t.sizeMB * 1024).toFixed(0)} KB`;
  const elements = t.elements != null ? ` · ${t.elements.toLocaleString()} elements` : "";
  const eta = active && t.progress > 3 && t.progress < 100 && t.elapsedMs > 0
    ? `ETA ~${fmtDur((t.elapsedMs / t.progress) * (100 - t.progress))}` : "";

  const actions: string[] = [];
  if (t.status === "queued") actions.push(`<button data-act="remove" style="${btnCss}">Remove</button>`);
  if (active) actions.push(`<button data-act="cancel" style="${btnCss}">Cancel</button>`);
  if (t.status === "done" && t.fragBytes && t.fragBytes.byteLength > 0)
    actions.push(`<button data-act="download" style="${btnCss}">Save .frag</button>`);
  if (t.status === "failed" || t.status === "cancelled" || t.status === "skipped")
    actions.push(`<button data-act="retry" style="${btnCss}">Retry</button>`);

  const showBar = active || (t.progress > 0 && t.status !== "done");
  const bar = showBar
    ? `<div style="height:5px;background:#0f1117;border-radius:3px;overflow:hidden;margin:4px 0 6px">
         <div style="height:100%;width:${t.progress}%;background:${col};transition:width .25s"></div>
       </div>` : "";

  row.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px">
      <span style="width:8px;height:8px;border-radius:50%;background:${col};flex:none"></span>
      <span style="font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(t.file.name)}">${escapeHtml(t.file.name)}</span>
      <span style="opacity:.55;flex:none">${size}</span>
    </div>
    <div style="opacity:.6;margin:2px 0">${t.schema !== "—" ? escapeHtml(t.schema) + " · " : ""}${escapeHtml(t.phase)}${elements}</div>
    ${bar}
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <span style="color:${col};font-weight:700;font-size:10px;letter-spacing:.4px">${t.status.toUpperCase()}</span>
      ${t.elapsedMs > 0 ? `<span style="opacity:.55">${fmtDur(t.elapsedMs)}</span>` : ""}
      ${eta ? `<span style="opacity:.55">${eta}</span>` : ""}
      ${t.error ? `<span style="color:#f87171" title="${escapeHtml(t.error)}">⚠ ${escapeHtml(truncate(t.error, 64))}</span>` : ""}
      ${actions.join("")}
    </div>`;

  row.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((b) => {
    b.onclick = () => taskAction(t, b.dataset.act!);
  });
}

function taskAction(t: ImportTask, act: string) {
  if (act === "remove") {
    if (t.status !== "queued") return;
    const i = importQueue.indexOf(t);
    if (i >= 0) importQueue.splice(i, 1);
    queueListEl.querySelector(`[data-uid="${t.uid}"]`)?.remove();
    updateQueueSummary();
  } else if (act === "cancel") {
    if (t.status === "queued") {
      t.status = "cancelled"; t.phase = "cancelled";
      refreshTaskRow(t); updateQueueSummary();
    } else if (isActiveStatus(t.status)) {
      cancelActiveConversion();
    }
  } else if (act === "retry") {
    t.status = "queued";
    t.error = undefined;
    t.progress = 0;
    t.phase = "waiting";
    t.elapsedMs = 0;
    refreshTaskRow(t);
    updateQueueSummary();
    void processQueue();
  } else if (act === "download") {
    downloadFragBytes(t);
  }
}

function downloadFragBytes(t: ImportTask) {
  if (!t.fragBytes || t.fragBytes.byteLength === 0) {
    alert("The cached .frag bytes are no longer available.\nRe-import the IFC and try Save .frag again.");
    return;
  }
  const blob = new Blob([t.fragBytes as unknown as BlobPart], { type: "application/octet-stream" });
  if (blob.size === 0) {
    alert("Could not export: the byte cache was released.\nRe-import the IFC and try again.");
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${t.modelId || "model"}.frag`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function updateQueueSummary() {
  const q = importQueue.filter((t) => t.status === "queued").length;
  const act = importQueue.filter((t) => isActiveStatus(t.status)).length;
  const done = importQueue.filter((t) => t.status === "done").length;
  const bad = importQueue.filter((t) => ["failed", "skipped", "cancelled"].includes(t.status)).length;
  const total = importQueue.reduce((a, t) => a + t.elapsedMs, 0);
  queueSummaryEl.innerHTML =
    `Queue: <b>${q}</b> pending · <b style="color:#38bdf8">${act}</b> active · ` +
    `<b style="color:#22c55e">${done}</b> done · <b style="color:#ef4444">${bad}</b> failed` +
    (total > 0 ? ` · total ${fmtDur(total)}` : "");
}

function clearFinishedTasks() {
  for (let i = importQueue.length - 1; i >= 0; i--) {
    const t = importQueue[i];
    if (["done", "failed", "cancelled", "skipped"].includes(t.status)) {
      importQueue.splice(i, 1);
      queueListEl.querySelector(`[data-uid="${t.uid}"]`)?.remove();
    }
  }
  updateQueueSummary();
}

function cancelQueueAll() {
  cancelAllRequested = true;
  for (const t of importQueue) {
    if (t.status === "queued") {
      t.status = "cancelled"; t.phase = "cancelled";
      refreshTaskRow(t);
    }
  }
  cancelActiveConversion();
  updateQueueSummary();
}

async function nextModelId(fileName: string): Promise<string> {
  const base = fileName.replace(/\.ifc$/i, "").replace(/\.frag$/i, "").trim() || `model-${Date.now()}`;
  if (ifcSettings.replaceExisting) {
    const existing = ctx.fragments.list.get(base);
    if (existing) { try { await (existing as any).dispose?.(); } catch { /* */ } }
    return base;
  }
  if (!ctx.fragments.list.has(base)) return base;
  let i = 2;
  while (ctx.fragments.list.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

function enqueueIfc(files: File | File[]) {
  const list = Array.isArray(files) ? files : [files];
  for (const file of list) {
    if (!/\.ifc$/i.test(file.name)) continue;
    const sizeMB = file.size / (1024 * 1024);
    const t: ImportTask = {
      uid: ++queueUid, file, sizeMB, schema: "—",
      status: "queued", progress: 0, phase: "waiting in queue", elapsedMs: 0,
    };
    if (sizeMB > ifcSettings.maxSizeMB) {
      t.status = "skipped";
      t.error = `File is ${sizeMB.toFixed(0)} MB (limit ${ifcSettings.maxSizeMB} MB).`;
    }
    importQueue.push(t);
    renderTaskRow(t);
  }
  updateQueueSummary();
  void processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  cancelAllRequested = false;

  const loader = (ctx.features as any).appLoader;
  const total = importQueue.filter((x) => x.status === "queued").length;
  if (total) {
    loader?.begin?.(`Importing ${total} file(s)…`, {
      cancellable: true,
      onCancel: () => cancelQueueAll(),
    });
  }

  try {
    for (;;) {
      const t = importQueue.find((x) => x.status === "queued");
      if (!t) break;
      if (cancelAllRequested) {
        for (const x of importQueue) {
          if (x.status === "queued") { x.status = "cancelled"; x.phase = "cancelled"; refreshTaskRow(x); }
        }
        break;
      }
      await runTask(t);
    }
  } finally {
    processing = false;
    updateQueueSummary();

    // Linking sequence from working OpenBIMStudio: apply positioning, then
    // origin-to-origin identity placement (no forced recenter) — same as BIM links.
    try { await applyPositioningMode(ifcSettings.positioning); } catch (e) { console.warn(e); }
    try {
      if (ifcSettings.positioning === "origin-to-origin" || ifcSettings.positioning === "shared-coordinates") {
        const { alignOriginToOrigin } = await import("./camera-tools");
        alignOriginToOrigin();
      }
    } catch (e) { console.warn("[link-seq] alignOriginToOrigin", e); }

    if (importQueue.some((t) => t.status === "done") && ifcSettings.autoFit) {
      // Wait for the worker to stream geometry before measuring bounds.
      void (async () => {
        for (let i = 0; i < 30; i++) {
          computeSceneBounds();
          const { getSceneBox, fitAll } = await import("./camera-tools");
          const b = getSceneBox?.();
          if (b && !b.isEmpty()) { fitAll(); return; }
          await new Promise((r) => setTimeout(r, 100));
        }
        fitAll();
      })();
    }
    else computeSceneBounds();
    try { refreshModelSelectionUI(); } catch { /* */ }

    setTimeout(() => {
      try { (ctx.cam as any)?.recoverView?.(); } catch { /* */ }
    }, 400);

    loader?.finish?.();
  }
}

async function runTask(t: ImportTask) {
  const t0 = performance.now();
  cancelRequested = false;
  const loader = (ctx.features as any).appLoader;

  try {
    t.status = "reading"; t.progress = 0; t.phase = "reading file…";
    refreshTaskRow(t);
    loader?.set?.(`Reading ${t.file.name}…`, 0.05);

    const buffer = await t.file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    t.schema = detectSchema(bytes);
    refreshTaskRow(t);

    t.status = "converting"; t.phase = "checking WASM…"; refreshTaskRow(t);
    loader?.set?.("Checking WASM…", 0.1);
    await ensureWasmAvailable();

    t.phase = "starting web-ifc worker…"; refreshTaskRow(t);
    loader?.set?.("Converting IFC → FRAG…", 0.15);

    const cancelPromise = new Promise<never>((_, rej) => { rejectActive = rej; });

    const settings: any = {
      bytes,
      progressCallback: (progress: any, data?: any) => {
        t.progress = normalizeProgress(progress);
        t.phase = describePhase(data);
        t.elapsedMs = performance.now() - t0;
        refreshTaskRow(t);
        loader?.set?.(`${t.phase} · ${t.progress}%`, 0.15 + 0.7 * (t.progress / 100));
      },
    };
    if (ifcSettings.useCoord) {
      settings.coordToPlace = [ifcSettings.coordX, ifcSettings.coordY, ifcSettings.coordZ];
    }

    const processPromise = getImporter().process(settings);
    processPromise.catch(() => { /* handled via race */ });
    const rawResult: any = await Promise.race([processPromise, cancelPromise]);
    rejectActive = null;

    if (cancelRequested) throw new Error("Cancelled by user");

    const fragBytes: Uint8Array = snapshotBytes(rawResult);
    if (!fragBytes.byteLength) {
      throw new Error("Converter returned empty data — try a different web-ifc version.");
    }

    const projectBytes: Uint8Array = snapshotBytes(fragBytes);
    if (ifcSettings.keepFragInMemory) t.fragBytes = snapshotBytes(fragBytes);

    t.status = "loading"; t.progress = 100; t.phase = "loading fragments into scene…";
    refreshTaskRow(t);
    loader?.set?.("Loading fragments into scene…", 0.9);

    const modelId = await nextModelId(t.file.name);
    t.modelId = modelId;

    await ctx.fragments.core.load(fragBytes, { modelId });

    registerModel(modelId);

    try { computeSceneBounds(); } catch { /* */ }

    try {
      (ctx.features.projects as any)?.onModelImported?.(modelId, t.file.name, projectBytes);
    } catch (e) { console.warn("[ifc] project persistence hook failed", e); }

    t.elapsedMs = performance.now() - t0;
    t.status = "done"; t.phase = "done";
    refreshTaskRow(t);

    const model: any = ctx.fragments.list.get(modelId);
    (model as any)?.getItemsIdsWithGeometry?.()
      ?.then((ids: number[]) => { t.elements = ids?.length ?? undefined; refreshTaskRow(t); })
      .catch(() => { /* */ });
  } catch (err: any) {
    rejectActive = null;
    const msg = errorMessage(err);
    const cancelled = cancelRequested || msg.toLowerCase().includes("cancel");
    t.elapsedMs = performance.now() - t0;
    if (cancelled) { t.status = "cancelled"; t.phase = "cancelled by user"; }
    else {
      console.error("[ifc-import]", err);
      t.status = "failed"; t.phase = "failed";
      t.error = msg;
    }
    refreshTaskRow(t);
    disposeImporter();
  } finally {
    rejectActive = null;
    updateQueueSummary();
  }
}

// ── Settings ──
const inpCss =
  "width:100%;box-sizing:border-box;padding:4px 6px;background:#1a1a24;border:1px solid #3a3a4a;border-radius:4px;color:#e2e8f0;font-size:11px";

export const settingsBox = document.createElement("details");
settingsBox.style.cssText =
  "margin:8px 0;border:1px solid #2a2a35;border-radius:6px;padding:8px;background:#14141c;font-size:11px";
settingsBox.innerHTML = `
  <summary style="cursor:pointer;font-weight:600;opacity:.85">Importer settings</summary>
  <div style="margin-top:8px;display:grid;gap:8px">
    <label style="display:grid;gap:2px">WASM source
      <select id="ifcCdn" style="${inpCss}">
        <option value="local">Local (recommended)</option>
        <option value="unpkg">unpkg.com</option>
        <option value="jsdelivr">cdn.jsdelivr.net</option>
        <option value="custom">Custom path…</option>
      </select>
    </label>
    <label style="display:grid;gap:2px">web-ifc version
      <input id="ifcVer" style="${inpCss}" placeholder="0.0.77">
    </label>
    <label id="ifcCustomRow" style="display:none;gap:2px">Custom WASM folder URL (must end with /)
      <input id="ifcCustom" style="${inpCss}" placeholder="https://my-cdn/web-ifc/">
    </label>
    <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ifcRecenter"> Recenter first model to origin</label>
    <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ifcKeep"> Keep converted .frag in memory</label>
    <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ifcReplace"> Replace existing model with same name</label>
    <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="ifcFit"> Auto-fit camera after import</label>
    <label style="display:grid;gap:2px">Max file size (MB)
      <input id="ifcMax" type="number" min="1" style="${inpCss}">
    </label>
  </div>`;

function syncSettingsUI() {
  const $ = (id: string) => settingsBox.querySelector(`#${id}`) as any;
  $("ifcCdn").value = ifcSettings.cdn;
  $("ifcVer").value = ifcSettings.version;
  $("ifcCustom").value = ifcSettings.customPath;
  $("ifcCustomRow").style.display = ifcSettings.cdn === "custom" ? "grid" : "none";
  $("ifcRecenter").checked = !!ifcSettings.recenter;
  $("ifcKeep").checked = ifcSettings.keepFragInMemory;
  $("ifcReplace").checked = ifcSettings.replaceExisting;
  $("ifcFit").checked = ifcSettings.autoFit;
  $("ifcMax").value = String(ifcSettings.maxSizeMB);
}

settingsBox.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  const rebuild = () => disposeImporter();
  switch (el.id) {
    case "ifcCdn": ifcSettings.cdn = el.value as IfcSettings["cdn"]; syncSettingsUI(); rebuild(); break;
    case "ifcVer": ifcSettings.version = el.value.trim() || "0.0.77"; rebuild(); break;
    case "ifcCustom": ifcSettings.customPath = el.value.trim(); rebuild(); break;
    case "ifcRecenter":
      ifcSettings.recenter = el.checked;
      setRecenterEnabled(el.checked);
      if (el.checked) recenterSceneNow(); else resetOffsets();
      break;
    case "ifcKeep": ifcSettings.keepFragInMemory = el.checked; break;
    case "ifcReplace": ifcSettings.replaceExisting = el.checked; break;
    case "ifcFit": ifcSettings.autoFit = el.checked; break;
    case "ifcMax": ifcSettings.maxSizeMB = Math.max(1, Number(el.value) || 500); break;
  }
  saveIfcSettings();
});

export const queueButtons = document.createElement("div");
queueButtons.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-top:4px";
queueButtons.innerHTML = `
  <button data-qa="cancelCurrent" style="${btnCss}">Cancel current</button>
  <button data-qa="cancelAll" style="${btnCss}">Cancel all</button>
  <button data-qa="clearFinished" style="${btnCss}">Clear finished</button>`;

// ═════════════════════════════════════════════════════════════════════════
// PUBLIC LOADERS
// ═════════════════════════════════════════════════════════════════════════

export async function loadFragFiles(files: FileList | File[]) {
  const list = Array.from(files);
  if (!list.length) return;

  const loader = (ctx.features as any).appLoader;
  loader?.begin?.(`Loading ${list.length} .frag file(s)…`, { cancellable: false });

  try {
    let i = 0;
    for (const file of list) {
      i++;
      loader?.set?.(`Loading ${i} / ${list.length} · ${file.name}`, i / list.length);
      try {
        if (file.size === 0) {
          alert(`"${file.name}" is empty (0 bytes).`);
          continue;
        }
        const buffer = await file.arrayBuffer();
        const projectBytes = new Uint8Array(buffer.slice(0));

        const modelId = file.name.replace(/\.frag$/i, "").trim() || `model-${Date.now()}`;
        let id = modelId;
        try { if (ctx.fragments.list.has(id)) id = await nextModelId(file.name); }
        catch { id = modelId; }

        await ctx.fragments.core.load(buffer, { modelId: id });
        registerModel(id);

        try {
          (ctx.features.projects as any)?.onModelImported?.(id, file.name, projectBytes);
        } catch (e) { console.warn("[frag-load] project persistence hook failed", e); }
      } catch (err: any) {
        console.error("[frag-load]", err);
        alert(`Failed: ${file.name}\n${errorMessage(err)}`);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    // Linking sequence (old OpenBIMStudio FRAG linker): load as-is, apply mode,
    // then origin-to-origin so federated models stay coordinated.
    try { await applyPositioningMode(ifcSettings.positioning); } catch (e) { console.warn(e); }
    try {
      if (ifcSettings.positioning === "origin-to-origin" || ifcSettings.positioning === "shared-coordinates") {
        const { alignOriginToOrigin } = await import("./camera-tools");
        alignOriginToOrigin();
      }
    } catch (e) { console.warn("[link-seq] alignOriginToOrigin", e); }

    try { computeSceneBounds(); } catch { /* */ }
    try { fitAll(); } catch { /* */ }
    try { refreshModelSelectionUI(); } catch { /* */ }

    setTimeout(() => {
      try { (ctx.cam as any)?.recoverView?.(); } catch { /* */ }
    }, 400);
  } finally {
    loader?.finish?.();
  }
}

export function loadIfcFiles(files: FileList | File[]) {
  const list = Array.from(files).filter((f) => /\.ifc$/i.test(f.name));
  if (!list.length) { alert("Please select one or more .ifc files."); return; }
  enqueueIfc(list);
}

export function pickFiles(
  accept: string,
  multiple: boolean,
  handler: (files: FileList) => void,
) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.multiple = multiple;
  input.onchange = () => { if (input.files?.length) handler(input.files); };
  input.click();
}

// ═════════════════════════════════════════════════════════════════════════
// Setup
// ═════════════════════════════════════════════════════════════════════════
export function setupImporter() {
  setRecenterEnabled(!!ifcSettings.recenter);
  syncSettingsUI();
  syncPositioningSelect();

  queueButtons.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).dataset?.qa;
    if (act === "cancelCurrent") cancelActiveConversion();
    else if (act === "cancelAll") cancelQueueAll();
    else if (act === "clearFinished") clearFinishedTasks();
  });

  const dropHint = document.createElement("div");
  dropHint.style.cssText =
    "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
    "background:rgba(56,189,248,.08);border:2px dashed #38bdf8;z-index:50;" +
    "pointer-events:none;color:#38bdf8;font:600 16px system-ui,sans-serif";
  dropHint.textContent = "Drop .ifc / .frag files to import";
  ctx.rightHost.appendChild(dropHint);

  let dragDepth = 0;
  ctx.rightHost.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dropHint.style.display = "flex";
  });
  ctx.rightHost.addEventListener("dragover", (e) => e.preventDefault());
  ctx.rightHost.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.style.display = "none";
  });
  ctx.rightHost.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropHint.style.display = "none";
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (!files.length) return;
    const fragFiles = files.filter((f) => /\.frag$/i.test(f.name));
    const ifcFiles = files.filter((f) => /\.ifc$/i.test(f.name));
    if (fragFiles.length) void loadFragFiles(fragFiles);
    if (ifcFiles.length) enqueueIfc(ifcFiles);
  });

  ctx.features.importer = {
    loadIfcFiles, loadFragFiles, cancelActiveConversion,
    getPositioningMode, setPositioningMode, applyPositioningMode,
    registerModel, unregisterModel, clearAllOffsets,
    setModelOffset, getModelOffset, listRegisteredModels,
    getModelBBox, getModelBBoxCenter,
    onOffsetsChanged,
  };

  console.log("[importer] ready · positioning modes + live offset control");
}