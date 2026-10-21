/**
 * CAD link engine (runtime): DWG / DXF links shown in 3D and in plan views,
 * placed with Revit-style options (units, positioning, rotation, level),
 * with per-layer visibility, snapping, persistence and reload.
 *
 * Pure maths lives in ./core.ts; this file owns the THREE group, the link
 * registry, file reading and the link dialog.
 */
import * as THREE from "three";
import { ctx } from "../../core/context";
import type { DxfDocument } from "../drawings/dxf-types";
import { parseDxf } from "../drawings/dxf-reader";
import { dwgDatabaseToDxfDocument } from "../drawings/dwg-convert";
import {
  buildGeometry, computePlacement, DEFAULT_LINK_OPTIONS, snapSegments,
  type LinkGeometry, type LinkOptions, type Placement, type PlacementEnv, type Theme,
} from "./core";
import { surveyToProject } from "../project-base-point/types";
import { setUnderlaySegments, clearUnderlayData } from "../../features/cad-underlay-snap";
import { getSceneBackground } from "../../features/view-graphics";

export * from "./core";

type Any = Record<string, any>;

export interface CadLink {
  id: string;
  name: string;
  format: "dxf" | "dwg";
  doc: DxfDocument;
  /** Human readable import summary (counts, skipped entity types). */
  summary: string;
  options: LinkOptions;
  /** Whole link on/off. */
  visible: boolean;
  /** Layer name -> visible (missing = visible). */
  layerVisible: Record<string, boolean>;
  placement: Placement;
  /** World geometry for the 3D view (theme follows the scene background). */
  geo3d: LinkGeometry;
  /** World geometry for plan views (light theme). */
  geoPlan: LinkGeometry;
  /** Persistence id (aux blob) or null when not stored with a project. */
  modelId: string | null;
  group: THREE.Group | null;
  loadedAt: number;
}

const links = new Map<string, CadLink>();
const listeners = new Set<() => void>();
let root: THREE.Group | null = null;
let counter = 0;

const uid = () => (crypto as Any).randomUUID?.() ?? `cl-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function toast(message: string, kind: "info" | "warn" | "success" | "error" = "info") {
  try { window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } })); } catch { /* */ }
  console.log(`[cad-link] ${kind}: ${message}`);
}

function ext(name: string): string { return (name.split(".").pop() ?? "").toLowerCase(); }

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */
export function onCadLinksChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function emit() {
  for (const cb of listeners) { try { cb(); } catch { /* */ } }
  try { window.dispatchEvent(new CustomEvent("obs:cad-links-changed")); } catch { /* */ }
}

/* ------------------------------------------------------------------ */
/* Reading files                                                       */
/* ------------------------------------------------------------------ */
async function createLibreDwg(LibreDwg: Any): Promise<Any> {
  const attempts: Array<() => Promise<Any>> = [
    () => LibreDwg.create(),
    // Copied next to the app by scripts/copy-libredwg-wasm.mjs (npm postinstall).
    () => LibreDwg.create("/libredwg/"),
  ];
  let last: unknown;
  for (const a of attempts) {
    try { return await a(); } catch (e) { last = e; }
  }
  throw new Error(`could not start the DWG reader (WASM failed to load): ${last instanceof Error ? last.message : String(last)}`);
}

/** Read a DWG with @mlightcad/libredwg-web and convert it to a DxfDocument. */
export async function readDwg(file: File): Promise<{ doc: DxfDocument; summary: string }> {
  let mod: Any;
  try {
    mod = await import("@mlightcad/libredwg-web");
  } catch (e) {
    throw new Error("the DWG reader (@mlightcad/libredwg-web) is not installed - run npm install");
  }
  const LibreDwg = mod.LibreDwg ?? mod.default?.LibreDwg;
  const FileType = mod.Dwg_File_Type ?? mod.default?.Dwg_File_Type;
  if (!LibreDwg?.create) throw new Error("the installed libredwg-web has an unexpected API (LibreDwg.create missing)");
  const lib = await createLibreDwg(LibreDwg);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let dwg: Any | null = null;
  const errors: string[] = [];
  for (const input of [bytes, bytes.buffer] as Any[]) {
    try { dwg = lib.dwg_read_data(input, FileType?.DWG ?? 0); if (dwg) break; }
    catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  if (!dwg) {
    throw new Error(
      "libredwg could not read this DWG (very new AutoCAD version, encrypted or damaged file)" +
      (errors.length ? ` - ${errors[0]}` : ""),
    );
  }
  let db: Any;
  try { db = lib.convert ? lib.convert(dwg) : dwg; }
  finally { try { lib.dwg_free?.(dwg); } catch { /* */ } }

  try { (window as Any).__obsLastDwgDb = db; } catch { /* kept for debugging */ }
  return dwgDatabaseToDxfDocument(db);
}

export async function readCadFile(file: File): Promise<{ doc: DxfDocument; summary: string; format: "dxf" | "dwg" }> {
  const e = ext(file.name);
  if (e === "dwg") return { ...(await readDwg(file)), format: "dwg" };
  if (e === "dxf") {
    const doc = parseDxf(await file.text());
    const skipped = doc.skipped
      ? Object.entries(doc.skipped).map(([k, v]) => `${v}×${k}`).join(", ") : "";
    const summary = `${doc.entities.length} drawable entities on ${doc.layers.length} layers` +
      (skipped ? `; not drawn: ${skipped}` : "");
    return { doc, summary, format: "dxf" };
  }
  throw new Error(`unsupported CAD format .${e} (use .dwg or .dxf)`);
}

/* ------------------------------------------------------------------ */
/* Placement environment                                               */
/* ------------------------------------------------------------------ */
function modelCenter(): { x: number; z: number } {
  const box = new THREE.Box3();
  try {
    for (const [, m] of (ctx.fragments?.list ?? new Map()) as Map<string, Any>) {
      if (m?.object) {
        const b = new THREE.Box3().setFromObject(m.object);
        if (!b.isEmpty()) box.union(b);
      }
    }
  } catch { /* */ }
  try {
    const a: Any = (ctx.features as Any)?.authoring;
    for (const el of a?.getElements?.() ?? []) {
      const b = a.getElementWorldBox?.(el);
      if (b && !b.isEmpty()) box.union(b);
    }
  } catch { /* */ }
  if (box.isEmpty()) return { x: 0, z: 0 };
  const c = box.getCenter(new THREE.Vector3());
  return { x: c.x, z: c.z };
}

function env(): PlacementEnv {
  return {
    modelCenter: modelCenter(),
    surveyToProject: (e, n) => { const p = surveyToProject(e, 0, n); return [p[0], p[2]]; },
  };
}

function theme3d(): Theme {
  try { return getSceneBackground() === "paper" ? "light" : "dark"; } catch { return "dark"; }
}

/* ------------------------------------------------------------------ */
/* 3D                                                                  */
/* ------------------------------------------------------------------ */
function ensureRoot(): THREE.Group | null {
  if (root) return root;
  const scene = (ctx as Any).world?.scene?.three as THREE.Scene | undefined;
  if (!scene) return null;
  root = new THREE.Group();
  root.name = "obs-cad-links";
  root.userData.obsHelper = true;
  scene.add(root);
  return root;
}

function disposeGroup(link: CadLink) {
  if (!link.group) return;
  link.group.parent?.remove(link.group);
  link.group.traverse((o: Any) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  link.group = null;
}

function applyVisibility(link: CadLink) {
  if (!link.group) return;
  link.group.visible = link.visible;
  for (const ch of link.group.children as Any[]) {
    ch.visible = link.layerVisible[ch.userData.layer] !== false;
  }
}

function build3D(link: CadLink) {
  disposeGroup(link);
  const geo = link.geo3d;
  const r = ensureRoot();
  if (!r || !geo.bounds || !geo.groups.length) return;

  // Positions are stored relative to the link's centre: survey-sized
  // coordinates would otherwise lose precision in float32 and jitter.
  const ox = (geo.bounds.minX + geo.bounds.maxX) / 2;
  const oz = (geo.bounds.minZ + geo.bounds.maxZ) / 2;
  const oy = link.options.elevation;

  const g = new THREE.Group();
  g.name = `obs-cad-link:${link.name}`;
  g.position.set(ox, oy, oz);
  g.userData.obsHelper = true;
  g.userData.cadLinkId = link.id;

  for (const grp of geo.groups) {
    const pos = new Float32Array(grp.segs.length);
    for (let i = 0; i < grp.segs.length; i += 3) {
      pos[i] = grp.segs[i] - ox;
      pos[i + 1] = grp.segs[i + 1] - oy;
      pos[i + 2] = grp.segs[i + 2] - oz;
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    bg.computeBoundingSphere();
    const ls = new THREE.LineSegments(bg, new THREE.LineBasicMaterial({ color: grp.rgb }));
    ls.userData.layer = grp.layer;
    ls.renderOrder = -1;
    // Underlays must never intercept picking (zoom-to-cursor, selection).
    ls.raycast = () => { /* not pickable */ };
    g.add(ls);
  }
  r.add(g);
  link.group = g;
  applyVisibility(link);
}

/** World box of all visible links (null when none). */
export function getCadLinksBox(): THREE.Box3 | null {
  const box = new THREE.Box3();
  for (const l of links.values()) {
    if (!l.visible || !l.geo3d.bounds) continue;
    const b = l.geo3d.bounds;
    box.expandByPoint(new THREE.Vector3(b.minX, l.options.elevation, b.minZ));
    box.expandByPoint(new THREE.Vector3(b.maxX, l.options.elevation, b.maxZ));
  }
  return box.isEmpty() ? null : box;
}

/* ------------------------------------------------------------------ */
/* Plan                                                                */
/* ------------------------------------------------------------------ */
export interface CadLinkPlanItem {
  link: CadLink;
  geo: LinkGeometry;
  isLayerVisible: (layer: string) => boolean;
}

/** Visible links as plan geometry. `levelElevation` filters links limited to their level. */
export function getCadLinkPlanItems(levelElevation?: number): CadLinkPlanItem[] {
  const out: CadLinkPlanItem[] = [];
  for (const l of links.values()) {
    if (!l.visible) continue;
    if (
      l.options.planScope === "level" && levelElevation != null &&
      Math.abs(l.options.elevation - levelElevation) > 0.05
    ) continue;
    out.push({ link: l, geo: l.geoPlan, isLayerVisible: (n) => l.layerVisible[n] !== false });
  }
  return out;
}

/** Plan X/Z bounds of all visible links (for fitting the plan view). */
export function getCadLinksPlanBounds(levelElevation?: number):
  { minX: number; minZ: number; maxX: number; maxZ: number } | null {
  let r: { minX: number; minZ: number; maxX: number; maxZ: number } | null = null;
  for (const it of getCadLinkPlanItems(levelElevation)) {
    const b = it.geo.bounds;
    if (!b) continue;
    r = r
      ? { minX: Math.min(r.minX, b.minX), minZ: Math.min(r.minZ, b.minZ), maxX: Math.max(r.maxX, b.maxX), maxZ: Math.max(r.maxZ, b.maxZ) }
      : { ...b };
  }
  return r;
}

/* ------------------------------------------------------------------ */
/* Snapping                                                            */
/* ------------------------------------------------------------------ */
function refreshSnap() {
  const flat: number[] = [];
  for (const l of links.values()) {
    if (!l.visible) continue;
    flat.push(...snapSegments(l.geoPlan, (n) => l.layerVisible[n] !== false));
  }
  if (flat.length) setUnderlaySegments(flat);
  else clearUnderlayData();
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */
const LS_PREFIX = "obs.cad-link.";

function saveMeta(link: CadLink) {
  if (!link.modelId) return;
  try {
    localStorage.setItem(LS_PREFIX + link.modelId, JSON.stringify({
      options: link.options, layerVisible: link.layerVisible, visible: link.visible,
    }));
  } catch { /* */ }
}

function loadMeta(modelId: string): Any | null {
  try { const raw = localStorage.getItem(LS_PREFIX + modelId); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}

function markDirty() {
  try { (ctx.features as Any).projects?.markDirty?.(); } catch { /* */ }
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */
function rebuild(link: CadLink) {
  link.placement = computePlacement(link.doc, link.options, env());
  link.geo3d = buildGeometry(link.doc, link.placement, link.options, theme3d());
  link.geoPlan = buildGeometry(link.doc, link.placement, link.options, "light");
  build3D(link);
}

export interface AddLinkInput {
  name: string;
  format: "dxf" | "dwg";
  doc: DxfDocument;
  summary?: string;
  options?: Partial<LinkOptions>;
  /** Original file bytes: stored with the project so the link survives reopen. */
  bytes?: Uint8Array | null;
  modelId?: string | null;
  visible?: boolean;
  layerVisible?: Record<string, boolean>;
}

export function addCadLink(input: AddLinkInput): CadLink {
  const options: LinkOptions = {
    ...DEFAULT_LINK_OPTIONS, ...input.options,
    manual: { ...DEFAULT_LINK_OPTIONS.manual, ...(input.options?.manual ?? {}) },
  };
  const modelId = input.modelId ?? (input.bytes ? `aux-cadlink-${uid()}` : null);
  const link = {
    id: `cad-link-${++counter}`,
    name: input.name,
    format: input.format,
    doc: input.doc,
    summary: input.summary ?? "",
    options,
    visible: input.visible ?? true,
    layerVisible: { ...(input.layerVisible ?? {}) },
    modelId,
    group: null,
    loadedAt: Date.now(),
  } as CadLink;
  rebuild(link);
  links.set(link.id, link);

  if (input.bytes && modelId) {
    try { (ctx.features as Any).projects?.onModelImported?.(modelId, input.name, input.bytes); } catch { /* */ }
  }
  saveMeta(link);
  refreshSnap();
  markDirty();
  emit();
  return link;
}

export function listCadLinks(): CadLink[] { return [...links.values()]; }
export function getCadLink(id: string): CadLink | null { return links.get(id) ?? null; }

export function updateCadLink(id: string, patch: Partial<LinkOptions>): void {
  const l = links.get(id);
  if (!l) return;
  l.options = { ...l.options, ...patch, manual: { ...l.options.manual, ...(patch.manual ?? {}) } };
  rebuild(l);
  saveMeta(l);
  refreshSnap();
  markDirty();
  emit();
}

export function setCadLinkVisible(id: string, on: boolean): void {
  const l = links.get(id);
  if (!l) return;
  l.visible = on;
  applyVisibility(l);
  saveMeta(l);
  refreshSnap();
  emit();
}

export function setCadLayerVisible(id: string, layer: string, on: boolean): void {
  const l = links.get(id);
  if (!l) return;
  l.layerVisible[layer] = on;
  applyVisibility(l);
  saveMeta(l);
  refreshSnap();
  emit();
}

export function removeCadLink(id: string): void {
  const l = links.get(id);
  if (!l) return;
  disposeGroup(l);
  links.delete(id);
  if (l.modelId) {
    try { localStorage.removeItem(LS_PREFIX + l.modelId); } catch { /* */ }
    try { (ctx.features as Any).projects?.onModelRemoved?.(l.modelId); } catch { /* */ }
  }
  refreshSnap();
  markDirty();
  emit();
}

/** Replace the drawing of an existing link (Reload), keeping its placement and layer choices. */
export async function reloadCadLink(id: string, file: File): Promise<boolean> {
  const l = links.get(id);
  if (!l) return false;
  const parsed = await readCadFile(file);
  l.doc = parsed.doc;
  l.summary = parsed.summary;
  l.format = parsed.format;
  l.name = file.name;
  rebuild(l);
  if (l.modelId) {
    try {
      (ctx.features as Any).projects?.onModelImported?.(l.modelId, file.name, new Uint8Array(await file.arrayBuffer()));
    } catch { /* */ }
  }
  saveMeta(l);
  refreshSnap();
  markDirty();
  emit();
  return true;
}

/** Re-theme and re-place every link (scene background changed, model moved...). */
export function refreshCadLinks(): void {
  for (const l of links.values()) rebuild(l);
  refreshSnap();
  emit();
}

export async function zoomToCadLink(id: string): Promise<void> {
  const l = links.get(id);
  const b = l?.geo3d.bounds;
  if (!l || !b) return;
  try {
    const cam: Any = await import("../../features/camera-tools");
    cam.computeSceneBounds?.();
    const box = new THREE.Box3(
      new THREE.Vector3(b.minX, l.options.elevation - 0.5, b.minZ),
      new THREE.Vector3(b.maxX, l.options.elevation + 0.5, b.maxZ),
    );
    cam.focusOnBox?.(box);
  } catch (e) { console.warn("[cad-link] zoom failed", e); }
}

/** Re-create a link from a stored blob when a project is opened. */
export async function restoreCadLinkFromBlob(blob: Blob, name: string, modelId?: string): Promise<CadLink | null> {
  try {
    const file = new File([blob], name);
    const parsed = await readCadFile(file);
    const meta = modelId ? loadMeta(modelId) : null;
    return addCadLink({
      name, format: parsed.format, doc: parsed.doc, summary: parsed.summary,
      options: meta?.options, visible: meta?.visible ?? true, layerVisible: meta?.layerVisible,
      modelId: modelId ?? null, bytes: null,
    });
  } catch (e) {
    console.warn(`[cad-link] could not restore "${name}"`, e);
    toast(`Could not restore linked CAD "${name}": ${e instanceof Error ? e.message : e}`, "warn");
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Dialog (Revit "Link CAD Formats")                                   */
/* ------------------------------------------------------------------ */
interface DialogInput {
  title: string;
  fileName: string;
  doc: DxfDocument;
  summary: string;
  initial: LinkOptions;
  confirmLabel: string;
}

async function levelChoices(): Promise<Array<{ name: string; elevation: number }>> {
  try {
    const m: Any = await import("../../features/authoring");
    return (m.getLevels?.() ?? []).map((l: Any) => ({ name: String(l.name), elevation: Number(l.elevation) }));
  } catch { return []; }
}

export async function openLinkDialog(input: DialogInput): Promise<LinkOptions | null> {
  const levels = await levelChoices();
  return new Promise((resolve) => {
    const o: LinkOptions = { ...input.initial, manual: { ...input.initial.manual } };
    const back = document.createElement("div");
    back.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif";
    const win = document.createElement("div");
    win.style.cssText = "background:#1e2029;border:1px solid #2a2e3a;border-radius:8px;width:460px;max-width:92vw;max-height:90vh;overflow:auto;color:#e8eaf0;box-shadow:0 20px 50px rgba(0,0,0,.5)";
    back.appendChild(win);

    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
    const declared = input.doc.units && input.doc.units !== "unitless" ? input.doc.units : null;
    win.innerHTML =
      `<div style="padding:12px 16px;border-bottom:1px solid #2a2e3a;background:#161a22;border-radius:8px 8px 0 0;font-weight:700;font-size:15px">${esc(input.title)}</div>` +
      `<div style="padding:12px 16px;color:#8b949e;font-size:12px;line-height:1.5"><b style="color:#e8eaf0">${esc(input.fileName)}</b><br>${esc(input.summary)}<br>` +
      `Units in file: ${declared ? declared : "<span style='color:#f59e0b'>not declared</span>"}</div>`;

    const body = document.createElement("div");
    body.style.cssText = "padding:4px 16px 12px;display:grid;grid-template-columns:150px 1fr;gap:8px 10px;align-items:center";
    win.appendChild(body);

    const inputCss = "background:#0f1117;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:4px;padding:5px 7px;font:12px system-ui;min-width:0";
    const label = (t: string) => { const d = document.createElement("div"); d.textContent = t; d.style.color = "#c9d1d9"; body.appendChild(d); };
    const select = (opts: Array<[string, string]>, value: string, on: (v: string) => void) => {
      const s = document.createElement("select"); s.style.cssText = inputCss;
      for (const [v, t] of opts) { const op = document.createElement("option"); op.value = v; op.textContent = t; s.appendChild(op); }
      s.value = value; s.onchange = () => on(s.value); body.appendChild(s); return s;
    };
    const number = (value: number, step: string, on: (v: number) => void) => {
      const i = document.createElement("input"); i.type = "number"; i.step = step; i.value = String(value); i.style.cssText = inputCss;
      i.oninput = () => { const n = Number(i.value); if (Number.isFinite(n)) on(n); };
      body.appendChild(i); return i;
    };

    label("Import units");
    select(
      [["auto", declared ? `Auto-detect (${declared})` : "Auto-detect (will guess from size)"],
       ["mm", "Millimetres"], ["cm", "Centimetres"], ["m", "Metres"], ["in", "Inches"], ["ft", "Feet"]],
      o.units, (v) => { o.units = v as LinkOptions["units"]; });

    label("Positioning");
    const manualRow: HTMLElement[] = [];
    const pos = select(
      [["origin", "Auto - Origin to Origin"], ["center", "Auto - Center to Center"],
       ["shared", "Auto - By Shared Coordinates"], ["manual", "Manual - Offset from origin"]],
      o.positioning, (v) => { o.positioning = v as LinkOptions["positioning"]; syncManual(); });

    label("Offset X / Z (m)");
    const mx = number(o.manual.x, "0.001", (v) => { o.manual.x = v; });
    const mz = number(o.manual.z, "0.001", (v) => { o.manual.z = v; });
    mx.style.gridColumn = "2"; body.removeChild(mz);
    const mzWrap = document.createElement("div"); mzWrap.style.cssText = "grid-column:2";
    const mxWrap = document.createElement("div"); mxWrap.style.cssText = "display:flex;gap:6px";
    body.removeChild(mx); mxWrap.append(mx, mz); body.appendChild(mxWrap);
    manualRow.push(mx, mz);
    const syncManual = () => { for (const el of manualRow) (el as HTMLInputElement).disabled = o.positioning !== "manual"; };
    syncManual(); void pos; void mzWrap;

    label("Rotation (deg, CCW)");
    number(o.rotationDeg, "0.1", (v) => { o.rotationDeg = v; });

    label("Place at level");
    const elev = document.createElement("input"); elev.type = "number"; elev.step = "0.001"; elev.value = String(o.elevation); elev.style.cssText = inputCss;
    elev.oninput = () => { const n = Number(elev.value); if (Number.isFinite(n)) o.elevation = n; };
    if (levels.length) {
      const wrap = document.createElement("div"); wrap.style.cssText = "display:flex;gap:6px";
      const sel = document.createElement("select"); sel.style.cssText = inputCss + ";flex:1";
      const custom = document.createElement("option"); custom.value = ""; custom.textContent = "Custom elevation (m)"; sel.appendChild(custom);
      for (const lv of levels) { const op = document.createElement("option"); op.value = String(lv.elevation); op.textContent = `${lv.name}  (${lv.elevation} m)`; sel.appendChild(op); }
      const match = levels.find((lv) => Math.abs(lv.elevation - o.elevation) < 1e-6);
      sel.value = match ? String(match.elevation) : "";
      sel.onchange = () => { if (sel.value !== "") { o.elevation = Number(sel.value); elev.value = sel.value; } };
      elev.style.width = "90px"; wrap.append(sel, elev); body.appendChild(wrap);
    } else body.appendChild(elev);

    label("Show in plan views");
    select([["all", "All plan views"], ["level", "Placement level only"]], o.planScope, (v) => { o.planScope = v as LinkOptions["planScope"]; });

    label("Colors");
    select([["preserve", "Preserve"], ["bw", "Black and white"], ["invert", "Invert"]], o.colors, (v) => { o.colors = v as LinkOptions["colors"]; });

    label("Layers");
    select([["all", "All"], ["visible", "Visible only (skip frozen/off)"]], o.layers, (v) => { o.layers = v as LinkOptions["layers"]; });

    const foot = document.createElement("div");
    foot.style.cssText = "padding:12px 16px;border-top:1px solid #2a2e3a;display:flex;justify-content:flex-end;gap:8px;background:#161a22;border-radius:0 0 8px 8px";
    const mk = (text: string, primary: boolean) => {
      const b = document.createElement("button"); b.textContent = text;
      b.style.cssText = `padding:6px 16px;border:none;border-radius:4px;cursor:pointer;font:600 12px system-ui;background:${primary ? "#38bdf8" : "#2a2e3a"};color:${primary ? "#0b0d12" : "#e8eaf0"}`;
      return b;
    };
    const cancel = mk("Cancel", false), ok = mk(input.confirmLabel, true);
    const done = (v: LinkOptions | null) => { back.remove(); window.removeEventListener("keydown", onKey, true); resolve(v); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); done(null); } };
    cancel.onclick = () => done(null);
    ok.onclick = () => done(o);
    window.addEventListener("keydown", onKey, true);
    foot.append(cancel, ok);
    win.appendChild(foot);
    document.body.appendChild(back);
  });
}

/* ------------------------------------------------------------------ */
/* Interactive link / settings                                          */
/* ------------------------------------------------------------------ */
/** Revit-style: read the file, ask for placement, create the link. */
export async function linkCadFileInteractive(file: File): Promise<CadLink | null> {
  toast(`Reading ${file.name}...`, "info");
  let parsed: Awaited<ReturnType<typeof readCadFile>>;
  try {
    parsed = await readCadFile(file);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[cad-link] read failed", e);
    alert(
      `Could not read "${file.name}":\n${msg}\n\n` +
      (ext(file.name) === "dwg"
        ? "Tip: in AutoCAD use SAVEAS and choose a DXF (ASCII, R2013 or R2018), then link the DXF."
        : "The file may not be an ASCII DXF. Binary DXF is not supported - save as ASCII DXF."),
    );
    return null;
  }
  if (!parsed.doc.entities.length) {
    alert(
      `"${file.name}" was read but contains no geometry this viewer can draw.\n\n${parsed.summary}\n\n` +
      "Check that the drawing has model-space geometry (not only paper-space layouts, hatches or images).",
    );
    return null;
  }
  const options = await openLinkDialog({
    title: "Link CAD Formats", fileName: file.name, doc: parsed.doc,
    summary: parsed.summary, initial: DEFAULT_LINK_OPTIONS, confirmLabel: "Link",
  });
  if (!options) return null;

  const bytes = new Uint8Array(await file.arrayBuffer());
  const link = addCadLink({
    name: file.name, format: parsed.format, doc: parsed.doc, summary: parsed.summary, options, bytes,
  });
  const note = link.placement.unitsGuessed
    ? ` Units were not in the file; assumed ${link.placement.unitsUsed} - use Manage Links to correct.` : "";
  toast(`Linked ${file.name}: ${parsed.summary}.${note}`, link.placement.unitsGuessed ? "warn" : "success");
  void zoomToCadLink(link.id);
  try { (await import("../../features/camera-tools") as Any).computeSceneBounds?.(); } catch { /* */ }
  return link;
}

/** Change placement of an existing link (Manage Links -> Settings). */
export async function editCadLinkInteractive(id: string): Promise<void> {
  const l = links.get(id);
  if (!l) return;
  const options = await openLinkDialog({
    title: "Link settings", fileName: l.name, doc: l.doc, summary: l.summary,
    initial: l.options, confirmLabel: "Apply",
  });
  if (options) updateCadLink(id, options);
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */
let installed = false;
export function setupCadLinks(): void {
  if (installed) return;
  installed = true;
  ensureRoot();
  const api = {
    list: listCadLinks, get: getCadLink, add: addCadLink, update: updateCadLink,
    remove: removeCadLink, reload: reloadCadLink, setVisible: setCadLinkVisible,
    setLayerVisible: setCadLayerVisible, zoomTo: zoomToCadLink, getBox: getCadLinksBox,
    getPlanItems: getCadLinkPlanItems, getPlanBounds: getCadLinksPlanBounds,
    linkFile: linkCadFileInteractive, edit: editCadLinkInteractive, refresh: refreshCadLinks,
    restoreFromBlob: restoreCadLinkFromBlob, onChange: onCadLinksChanged,
  };
  (ctx.features as Any).cadLinks = api;
  (window as Any).__obsCadLinks = api;
  window.addEventListener("obs:scene-background", () => refreshCadLinks());
  console.log("[cad-link] ready");
}
