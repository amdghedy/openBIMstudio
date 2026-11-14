/**
 * Selecting elements of an opened RVT model, reading their properties, and turning
 * one into an editable Native Twin.
 *
 * The decoder embeds each element's properties in its glTF node (see rvt-core
 * embedElementInfo), so everything here works on the loaded meshes alone: it keeps
 * working after the project is saved and reopened, or opened on another device.
 *
 *  - left click       : select + properties panel
 *  - right click      : menu with "Make editable native twin"
 *  - the twin         : a real authored element carrying the element's triangles and properties
 *                       (same path as IFC Native Twins); the RVT source mesh is hidden while
 *                       the twin exists and shown again if the twin is deleted.
 *
 * Properties are what the decoder could read from the file; parameters it cannot decode are absent.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { escapeHtml } from "../core/html-escape";
import {
  buildTwinGeometry, elementsCsv, filterItems, groupItems, ifcClassName, isRVTNodeData, selectSimilar, twinPropertySets,
  type BrowseItem, type GroupBy, type RvtElementInfo,
} from "../modules/rvt/rvt-core";
import { addNativeGeometryElement, getElements, isDrawingActive, pickAuthoredHitAt, removeElementById, setSelectedAuthored } from "./authoring";
import { history } from "./history";

export interface RVTHit {
  mesh: THREE.Mesh;
  root: THREE.Object3D;
  entityIndex: number;
  info: RvtElementInfo;
  distance: number;
}

const SOURCE_PREFIX = "rvt:";
const origMaterial = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
/** Current selection, in click order; the first entry is the one shown in detail. */
let selection: RVTHit[] = [];
let panel: HTMLDivElement | null = null;
let browser: HTMLDivElement | null = null;
const highlighted = new Set<THREE.Mesh>();
const keyOf = (h: Pick<RVTHit, "root" | "entityIndex">) => `${h.root.name}::${h.entityIndex}`;

function auxRoots(): THREE.Object3D[] {
  try { return (ctx.features as any).fileInterop?.getAuxObjects?.() ?? []; } catch { return []; }
}
const visibleChain = (o: THREE.Object3D | null) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
const rootOf = (o: THREE.Object3D): THREE.Object3D => { let x = o; const roots = new Set(auxRoots()); while (x.parent && !roots.has(x)) x = x.parent; return x; };

/** Does this scene object tree contain RVT element nodes? */
export function hasRVTElements(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((o) => { if (!found && isRVTNodeData(o.userData)) found = true; });
  return found;
}

function elementMeshes(root: THREE.Object3D, entityIndex: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o: any) => { if (o.isMesh && isRVTNodeData(o.userData) && o.userData.entityIndex === entityIndex) out.push(o); });
  return out;
}

/** Nearest visible RVT element under the pointer. */
export function pickRVTAt(e: MouseEvent): RVTHit | null {
  const cam = ctx.world?.camera?.three;
  if (!cam) return null;
  const targets: THREE.Mesh[] = [];
  for (const r of auxRoots()) r.traverse((o: any) => { if (o.isMesh && isRVTNodeData(o.userData) && visibleChain(o)) targets.push(o); });
  if (!targets.length) return null;
  const rect = ctx.rightHost.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit) return null;
  const mesh = hit.object as THREE.Mesh;
  const data = mesh.userData as { entityIndex: number; rvt: RvtElementInfo };
  return { mesh, root: rootOf(mesh), entityIndex: data.entityIndex, info: data.rvt, distance: hit.distance };
}

/* ── highlight ── */
function clearHighlight() {
  for (const m of highlighted) {
    const o = origMaterial.get(m);
    if (o) { const cur = m.material; m.material = o; origMaterial.delete(m); for (const c of Array.isArray(cur) ? cur : [cur]) c.dispose?.(); }
  }
  highlighted.clear();
}
function applyHighlight(hit: RVTHit) {
  for (const m of elementMeshes(hit.root, hit.entityIndex)) {
    if (origMaterial.has(m)) continue;
    origMaterial.set(m, m.material);
    const tint = (src: THREE.Material) => {
      const c = src.clone() as THREE.MeshStandardMaterial;
      if ("emissive" in c) { c.emissive = new THREE.Color(0x2563eb); (c as any).emissiveIntensity = 0.65; }
      else if ("color" in c) (c as any).color = new THREE.Color(0x60a5fa);
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(tint) : tint(m.material);
    highlighted.add(m);
  }
}

/** Replace the selection (or add/toggle with mode). Passing nothing clears it. */
export function selectRVTElements(hits: RVTHit[], mode: "replace" | "add" | "toggle" = "replace") {
  clearHighlight();
  let next = mode === "replace" ? [] : [...selection];
  for (const h of hits) {
    const i = next.findIndex((x) => keyOf(x) === keyOf(h));
    if (mode === "toggle" && i >= 0) next.splice(i, 1);
    else if (i < 0) next.push(h);
  }
  selection = next;
  for (const h of selection) applyHighlight(h);
  if (selection.length) showPanel(); else hidePanel();
  refreshBrowserSelection();
}
/** Right-click behaviour: keep a multi-selection if the clicked element is part of it, otherwise select just that element. */
export function ensureSelected(hit: RVTHit) {
  if (!selection.some((x) => keyOf(x) === keyOf(hit))) selectRVTElements([hit], "replace");
}
export function selectRVTElement(hit: RVTHit | null) { selectRVTElements(hit ? [hit] : [], "replace"); }
export const getSelectedRVTElement = () => selection[0] ?? null;
export const getSelectedRVTElements = () => [...selection];

/* ── element index over all loaded RVT models ── */
export function rvtRoots(): THREE.Object3D[] { return auxRoots().filter(hasRVTElements); }
function itemsOf(root: THREE.Object3D): (BrowseItem & { hit: RVTHit })[] {
  const seen = new Map<number, THREE.Mesh>();
  root.traverse((o: any) => { if (o.isMesh && isRVTNodeData(o.userData) && !seen.has(o.userData.entityIndex)) seen.set(o.userData.entityIndex, o); });
  return [...seen].map(([entityIndex, mesh]) => {
    const info = (mesh.userData as any).rvt as RvtElementInfo;
    const hit: RVTHit = { mesh, root, entityIndex, info, distance: 0 };
    return { key: keyOf(hit), entityIndex, info, hit };
  });
}
export function allRVTItems(): (BrowseItem & { hit: RVTHit })[] { return rvtRoots().flatMap(itemsOf); }

/* ── visibility: hide / isolate / show all (session only; twins always hide their source) ── */
const userHidden = new Set<string>();
function setHiddenKeys(keys: Iterable<string>, hidden: boolean) { for (const k of keys) hidden ? userHidden.add(k) : userHidden.delete(k); syncTwinVisibility(); }
export function hideElements(hits: RVTHit[]) { setHiddenKeys(hits.map(keyOf), true); selectRVTElements([]); }
export function isolateElements(hits: RVTHit[]) {
  const keep = new Set(hits.map(keyOf));
  const hide = allRVTItems().filter((it) => !keep.has(it.key)).map((it) => it.key);
  setHiddenKeys(hide, true); setHiddenKeys(keep, false);
}
export function showAllRVT() { userHidden.clear(); syncTwinVisibility(); refreshBrowserSelection(); }

export function selectSimilarTo(hit: RVTHit, by: GroupBy, mode: "replace" | "add" = "replace") {
  const same = selectSimilar(itemsOf(hit.root), hit.info, by);
  selectRVTElements(same.filter((x) => !userHidden.has(x.key)).map((x) => x.hit), mode);
  notify("info", `Selected ${same.length} element(s) with the same ${by === "category" ? "IFC class" : by}.`);
}

export function exportScheduleCsv(hits?: RVTHit[]) {
  const items = hits?.length ? hits.map((h) => ({ key: keyOf(h), entityIndex: h.entityIndex, info: h.info })) : allRVTItems();
  if (!items.length) { notify("warn", "No RVT elements to export."); return; }
  const blob = new Blob([elementsCsv(items, { bom: true })], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(items.length === 1 ? items[0].info.name : "rvt-elements").replace(/[^a-z0-9._-]+/gi, "_")}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  notify("success", `Exported ${items.length} element(s) to CSV (opens in Excel; lengths in metres).`);
}

/* ── Native Twin ── */
export function twinFor(hit: Pick<RVTHit, "root" | "entityIndex">) {
  const sid = SOURCE_PREFIX + hit.root.name;
  return getElements().find((el: any) => el.properties?.sourceModelId === sid && el.properties?.sourceLocalId === hit.entityIndex) ?? null;
}

export async function makeNativeTwin(hit: RVTHit): Promise<string | null> {
  const existing = twinFor(hit);
  if (existing) { setSelectedAuthored([existing.id], "replace"); notify("info", `“${hit.info.name}” already has an editable twin; selected it.`); return existing.id; }
  const parts = elementMeshes(hit.root, hit.entityIndex).map((m) => {
    m.updateWorldMatrix(true, false);
    const g = m.geometry as THREE.BufferGeometry;
    return { positions: g.getAttribute("position")?.array ?? [], index: g.index?.array ?? null, matrix: m.matrixWorld.elements };
  });
  const geo = buildTwinGeometry(parts);
  if (!geo) { notify("error", `“${hit.info.name}” has no usable geometry to make editable.`); return null; }
  const info = hit.info;
  const sourceFile = hit.root.name.replace(/ \(RVT view\)\.glb$/i, "");
  // Deterministic creation input, captured so REDO can re-run the exact
  // same creation (addNativeGeometryElement is a pure function of input;
  // it allocates a fresh id per call, tracked in currentId below).
  const twinInput = {
    name: info.name,
    entity: ifcClassName(info.ifcType),
    globalId: info.globalId,
    sourceGlobalId: info.globalId,
    predefinedType: info.predefinedType,
    tag: info.elementId,
    sourceModelId: SOURCE_PREFIX + hit.root.name,
    sourceLocalId: hit.entityIndex,
    sourceModelName: `${sourceFile}.rvt`,
    propertySets: twinPropertySets(info, sourceFile),
    quantities: { Width: geo.size[0], Height: geo.size[1], Depth: geo.size[2] },
    positions: geo.positions,
    position: geo.center,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    dimensions: { width: geo.size[0], height: geo.size[1], depth: geo.size[2] },
    sourceRawItem: { source: "rvt-view", entityIndex: hit.entityIndex, info },
    geometryProvenance: {
      extractionPath: "rvt-view-glb", triangleCount: geo.triangleCount, meshCount: parts.length, vertexCount: geo.triangleCount * 3,
      bounds: { min: geo.min, max: geo.max, center: geo.center },
    },
  } as Parameters<typeof addNativeGeometryElement>[0];
  let created: ReturnType<typeof addNativeGeometryElement>;
  try {
    created = addNativeGeometryElement(twinInput);
  } catch (err) {
    console.error("[rvt-view] native twin failed", err);
    notify("error", `Could not make “${info.name}” editable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  syncTwinVisibility();
  const id = created.id;
  setSelectedAuthored([id], "replace");
  selectRVTElement(null);
  notify("success", `Editable native twin created: ${info.name}. The RVT source is hidden while the twin exists.`);
  // Deterministic command: undo removes the twin, redo re-creates it from
  // the captured input. Each redo allocates a fresh element id, tracked in
  // currentId so repeated undo/redo cycles always target the right twin.
  let currentId = id;
  history.push({
    label: `Make native twin · ${info.name}`,
    apply: () => {
      const el = addNativeGeometryElement(twinInput);
      currentId = el.id;
      syncTwinVisibility();
    },
    revert: () => {
      removeElementById(currentId);
      syncTwinVisibility();
    },
  });
  return id;
}

export async function makeNativeTwins(hits: RVTHit[]): Promise<number> {
  let made = 0;
  for (const h of hits) { if (!twinFor(h) && (await makeNativeTwin(h))) made++; }
  if (hits.length > 1) notify(made ? "success" : "warn", `${made} of ${hits.length} element(s) made editable.`);
  return made;
}

/** Hide RVT meshes that have a twin or were hidden by the user; show the rest. Safe to call any time (idempotent). */
export function syncTwinVisibility() {
  const twinned = new Set<string>();
  for (const el of getElements() as any[]) {
    const sid = el.properties?.sourceModelId;
    if (typeof sid === "string" && sid.startsWith(SOURCE_PREFIX)) twinned.add(`${sid}::${el.properties.sourceLocalId}`);
  }
  for (const root of auxRoots()) {
    root.traverse((o: any) => {
      if (!o.isMesh || !isRVTNodeData(o.userData)) return;
      o.visible = !twinned.has(`${SOURCE_PREFIX}${root.name}::${o.userData.entityIndex}`) && !userHidden.has(`${root.name}::${o.userData.entityIndex}`);
    });
  }
}

/* ── properties panel ── */
function rows(title: string, items: [string, string | undefined][]) {
  const r = items.filter(([, v]) => v !== undefined && v !== "");
  if (!r.length) return "";
  return `<div style="margin:10px 0 4px;font-size:10px;letter-spacing:.6px;text-transform:uppercase;opacity:.55">${escapeHtml(title)}</div>` +
    r.map(([k, v]) => `<div style="display:flex;gap:10px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.06)"><span style="flex:0 0 42%;opacity:.7">${escapeHtml(k)}</span><span style="flex:1;word-break:break-word">${escapeHtml(String(v))}</span></div>`).join("");
}

const BTN = "padding:6px 10px;border-radius:6px;border:1px solid #3a3a4a;background:#2a2c36;color:inherit;cursor:pointer";
const BTN_P = "padding:7px 10px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer";

function showPanel() {
  hidePanel();
  const hits = selection;
  if (!hits.length) return;
  const hit = hits[0], i = hit.info;
  const multi = hits.length > 1;
  const twinCount = hits.filter((h) => twinFor(h)).length;
  const el = document.createElement("div");
  el.setAttribute("data-obs-ui", "1");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "RVT element properties");
  el.style.cssText = "position:fixed;right:14px;top:96px;z-index:9000;width:330px;max-height:72vh;overflow:auto;background:var(--bg-floating,#1e1f26);color:var(--text-primary,#e2e8f0);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif;padding:10px 12px";
  const m = (n?: number) => (n === undefined ? undefined : `${n} m`);
  const ext = i.extentsM;
  const byClass = new Map<string, number>(); for (const h of hits) byClass.set(h.info.ifcType, (byClass.get(h.info.ifcType) ?? 0) + 1);
  const head = multi
    ? `<div style="font-weight:700;font-size:13px">${hits.length} RVT elements selected</div><div style="opacity:.65">${[...byClass].map(([k, n]) => `${escapeHtml(k)} × ${n}`).join(" · ")}</div>`
    : `<div style="font-weight:700;font-size:13px;word-break:break-word">${escapeHtml(i.name)}</div><div style="opacity:.65">${escapeHtml(i.ifcType)} · from RVT model, read-only</div>`;
  el.innerHTML =
    `<div style="display:flex;align-items:flex-start;gap:8px"><div style="flex:1">${head}</div><button data-x aria-label="Close" style="background:none;border:0;color:inherit;cursor:pointer;font-size:16px">✕</button></div>` +
    `<div style="display:flex;gap:6px;margin:10px 0 6px"><button data-twin style="flex:1;${BTN_P}">${twinCount === hits.length ? "Select editable twin" + (multi ? "s" : "") : multi ? `Make ${hits.length - twinCount} editable native twin(s)` : "Make editable native twin"}</button><button data-zoom style="${BTN}">Zoom</button></div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px"><button data-hide style="${BTN}">Hide</button><button data-iso style="${BTN}">Isolate</button><button data-all style="${BTN}">Show all</button><button data-csv style="${BTN}">Export CSV</button><button data-browser style="${BTN}">Browser</button></div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0 2px"><span style="opacity:.6">Select same:</span><button data-sim="category" style="${BTN}">class</button><button data-sim="level" style="${BTN}">level</button><button data-sim="material" style="${BTN}">material</button></div>` +
    (multi ? "" :
      rows("Identity", [["RVT element id", i.elementId], ["GlobalId", i.globalId], ["Predefined type", i.predefinedType], ["Level", i.storey ? (i.storeyElevationM !== undefined ? `${i.storey} (${i.storeyElevationM} m)` : i.storey) : undefined], ["Material", i.material]]) +
      rows("Placement and size (file frame, metres)", [
        ["Location", i.locationM ? i.locationM.join(", ") : undefined], ["Rotation", i.rotationDeg !== undefined ? `${i.rotationDeg}°` : undefined],
        ["Length / width", m(ext?.width)], ["Thickness / depth", m(ext?.depth)], ["Height", m(ext?.height)],
      ]) + i.groups.map((g) => rows(g.name, g.rows)).join("")) +
    `<div style="margin-top:10px;opacity:.55;line-height:1.4">${multi ? "Shift-click adds or removes elements. " : "Shift-click another element to add it. "}Shows what the decoder could read from the file; RVT parameters it cannot decode are not listed.</div>`;
  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  q("[data-x]").onclick = () => selectRVTElements([]);
  q("[data-zoom]").onclick = () => zoomTo(hits);
  q("[data-twin]").onclick = () => { void makeNativeTwins(hits); };
  q("[data-hide]").onclick = () => hideElements(hits);
  q("[data-iso]").onclick = () => isolateElements(hits);
  q("[data-all]").onclick = () => showAllRVT();
  q("[data-csv]").onclick = () => exportScheduleCsv(hits);
  q("[data-browser]").onclick = () => openRVTBrowser();
  el.querySelectorAll<HTMLButtonElement>("[data-sim]").forEach((b) => b.onclick = () => selectSimilarTo(hit, b.dataset.sim as GroupBy));
  document.body.appendChild(el);
  panel = el;
}
function hidePanel() { panel?.remove(); panel = null; }

export function zoomTo(hit: RVTHit | RVTHit[]) {
  try {
    const box = new THREE.Box3();
    for (const h of Array.isArray(hit) ? hit : [hit]) for (const m of elementMeshes(h.root, h.entityIndex)) box.expandByObject(m);
    if (!box.isEmpty()) (ctx.features as any).camera?.focusOnBox?.(box);
  } catch { /* viewing aid only */ }
}

/* ── context menu items (consumed by context-menu.ts) ── */
type MenuEntry = { type: "label"; text: string } | { type: "action"; icon?: string; text: string; onclick: () => void } | { type: "sep" };
export function rvtMenuItems(hit: RVTHit): MenuEntry[] {
  const group = selection.some((x) => keyOf(x) === keyOf(hit)) ? selection : [hit];
  const n = group.length;
  const allTwinned = group.every((h) => twinFor(h));
  return [
    { type: "label", text: (n > 1 ? `RVT · ${n} elements` : `RVT · ${hit.info.name}`).slice(0, 60) },
    { type: "action", icon: "🧩", text: allTwinned ? "Select editable native twin" + (n > 1 ? "s" : "") : n > 1 ? `Make ${n} editable native twins` : "Make editable native twin", onclick: () => { void makeNativeTwins(group); } },
    { type: "action", icon: "ℹ️", text: "Properties", onclick: () => selectRVTElements(group) },
    { type: "action", icon: "🔍", text: "Zoom to element" + (n > 1 ? "s" : ""), onclick: () => zoomTo(group) },
    { type: "sep" },
    { type: "action", icon: "🙈", text: "Hide", onclick: () => hideElements(group) },
    { type: "action", icon: "🎯", text: "Isolate", onclick: () => isolateElements(group) },
    { type: "action", icon: "👁", text: "Show all RVT elements", onclick: () => showAllRVT() },
    { type: "sep" },
    { type: "action", icon: "≈", text: "Select same IFC class", onclick: () => selectSimilarTo(hit, "category") },
    { type: "action", icon: "≈", text: "Select same level", onclick: () => selectSimilarTo(hit, "level") },
    { type: "action", icon: "≈", text: "Select same material", onclick: () => selectSimilarTo(hit, "material") },
    { type: "sep" },
    { type: "action", icon: "📋", text: "RVT browser…", onclick: () => openRVTBrowser() },
    { type: "action", icon: "⬇", text: n > 1 ? "Export selected to CSV" : "Export this element to CSV", onclick: () => exportScheduleCsv(group) },
  ];
}

/* ── RVT browser: tree of every element with search, grouping, visibility and selection ── */
let browserBy: GroupBy = "category";
let browserQuery = "";

function refreshBrowserSelection() {
  if (!browser) return;
  const sel = new Set(selection.map(keyOf));
  browser.querySelectorAll<HTMLElement>("[data-k]").forEach((r) => { r.style.background = sel.has(r.dataset.k!) ? "rgba(37,99,235,.35)" : "transparent"; });
  const c = browser.querySelector<HTMLElement>("[data-count]"); if (c) c.textContent = `${selection.length} selected`;
}

export function openRVTBrowser() {
  if (browser) { browser.remove(); browser = null; return; }
  if (!rvtRoots().length) { notify("info", "Open a RVT model first (File tab → View RVT File)."); return; }
  const el = document.createElement("div");
  el.setAttribute("data-obs-ui", "1");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "RVT browser");
  el.style.cssText = "position:fixed;left:14px;top:96px;z-index:9000;width:310px;max-height:76vh;display:flex;flex-direction:column;background:var(--bg-floating,#1e1f26);color:var(--text-primary,#e2e8f0);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif";
  el.innerHTML =
    `<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #3a3a4a"><b style="flex:1">RVT browser</b><span data-count style="opacity:.6"></span><button data-x aria-label="Close" style="background:none;border:0;color:inherit;cursor:pointer;font-size:16px">✕</button></div>` +
    `<div style="display:flex;gap:6px;padding:8px 10px"><input data-q type="search" placeholder="Search name, class, level, material, property…" aria-label="Search RVT elements" style="flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid #3a3a4a;background:#15161c;color:inherit"><select data-by aria-label="Group by" style="padding:6px;border-radius:6px;border:1px solid #3a3a4a;background:#15161c;color:inherit"><option value="category">Class</option><option value="level">Level</option><option value="material">Material</option></select></div>` +
    `<div data-tree style="flex:1;overflow:auto;padding:0 6px 8px"></div>` +
    `<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px;border-top:1px solid #3a3a4a"><button data-twins style="${BTN_P}">Make twins of selection</button><button data-all style="${BTN}">Show all</button><button data-csv style="${BTN}">Export all CSV</button></div>`;
  const tree = el.querySelector<HTMLElement>("[data-tree]")!;
  const input = el.querySelector<HTMLInputElement>("[data-q]")!;
  const by = el.querySelector<HTMLSelectElement>("[data-by]")!;
  input.value = browserQuery; by.value = browserBy;
  const MAX_ROWS = 400;
  const render = () => {
    const items = filterItems(allRVTItems(), browserQuery);
    const groups = groupItems(items, browserBy);
    tree.innerHTML = items.length ? "" : `<div style="padding:10px;opacity:.6">No elements match.</div>`;
    let budget = MAX_ROWS;
    for (const g of groups) {
      const d = document.createElement("details");
      d.open = groups.length === 1 || !!browserQuery;
      const hiddenCount = g.items.filter((x) => userHidden.has(x.key)).length;
      const sum = document.createElement("summary");
      sum.style.cssText = "cursor:pointer;padding:5px 4px;display:flex;align-items:center;gap:6px;list-style:none";
      sum.innerHTML = `<span style="flex:1;font-weight:600">${escapeHtml(g.label)} <span style="opacity:.55;font-weight:400">(${g.items.length})</span></span>` +
        `<button data-sel title="Select all in this group" style="${BTN};padding:2px 6px">select</button><button data-eye title="${hiddenCount === g.items.length ? "Show group" : "Hide group"}" style="${BTN};padding:2px 6px">${hiddenCount === g.items.length ? "👁" : "🙈"}</button>`;
      sum.querySelector<HTMLButtonElement>("[data-sel]")!.onclick = (ev) => { ev.preventDefault(); selectRVTElements(g.items.map((x) => x.hit)); };
      sum.querySelector<HTMLButtonElement>("[data-eye]")!.onclick = (ev) => { ev.preventDefault(); setHiddenKeys(g.items.map((x) => x.key), hiddenCount !== g.items.length); render(); };
      d.appendChild(sum);
      for (const it of g.items) {
        if (budget-- <= 0) break;
        const r = document.createElement("div");
        r.dataset.k = it.key;
        r.style.cssText = `padding:3px 6px 3px 18px;cursor:pointer;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis${userHidden.has(it.key) ? ";opacity:.4;text-decoration:line-through" : ""}`;
        r.title = `${it.info.name} · ${it.info.ifcType}${it.info.storey ? " · " + it.info.storey : ""}`;
        r.textContent = it.info.name;
        r.onclick = (ev) => selectRVTElements([it.hit], ev.shiftKey || ev.ctrlKey || ev.metaKey ? "toggle" : "replace");
        r.ondblclick = () => zoomTo(it.hit);
        d.appendChild(r);
      }
      tree.appendChild(d);
    }
    if (items.length > MAX_ROWS) { const n = document.createElement("div"); n.style.cssText = "padding:6px 10px;opacity:.6"; n.textContent = `Showing the first ${MAX_ROWS} of ${items.length} matches; refine the search to see the rest.`; tree.appendChild(n); }
    refreshBrowserSelection();
  };
  let timer: number | undefined;
  input.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { browserQuery = input.value; render(); }, 150); };
  by.onchange = () => { browserBy = by.value as GroupBy; render(); };
  el.querySelector<HTMLButtonElement>("[data-x]")!.onclick = () => { el.remove(); browser = null; };
  el.querySelector<HTMLButtonElement>("[data-twins]")!.onclick = () => { if (selection.length) void makeNativeTwins(selection); else notify("info", "Select elements in the list or the model first."); };
  el.querySelector<HTMLButtonElement>("[data-all]")!.onclick = () => { showAllRVT(); render(); };
  el.querySelector<HTMLButtonElement>("[data-csv]")!.onclick = () => exportScheduleCsv();
  document.body.appendChild(el);
  browser = el;
  render();
}

/* ── wiring ── */
let installed = false;
export function installRVTView() {
  if (installed) return;
  installed = true;
  const host = ctx.rightHost ?? document.body;
  let down: { x: number; y: number } | null = null;
  host.addEventListener("pointerdown", (e: PointerEvent) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; }, true);
  host.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 4) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.(".obs-ribbon, .obs-panel, .obs-modal, [data-obs-ui]")) return;
    if (isDrawingActive()) return;                   // never steal a click from a drawing / modify tool
    const hit = pickRVTAt(e);
    if (hit) {
      const a = pickAuthoredHitAt(e);               // a closer authored element (e.g. a twin) wins
      if (a && a.distance < hit.distance) return;
      selectRVTElements([hit], e.shiftKey || e.ctrlKey || e.metaKey ? "toggle" : "replace");
    } else if (selection.length && !(e.shiftKey || e.ctrlKey || e.metaKey)) selectRVTElements([]);
  }, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && selection.length) selectRVTElements([]); });
  try { (ctx.features.authoring as any).onAuthoringChange?.(() => syncTwinVisibility()); } catch { /* authoring not ready: sync also runs after each import */ }
}
