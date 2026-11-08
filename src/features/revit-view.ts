/**
 * Selecting elements of an opened Revit file, reading their properties, and turning
 * one into an editable Native Twin.
 *
 * The decoder embeds each element's properties in its glTF node (see rvt-core
 * embedElementInfo), so everything here works on the loaded meshes alone: it keeps
 * working after the project is saved and reopened, or opened on another device.
 *
 *  - left click       : select + properties panel
 *  - right click      : menu with "Make editable native twin"
 *  - the twin         : a real authored element carrying the element's triangles and properties
 *                       (same path as IFC Native Twins); the Revit source mesh is hidden while
 *                       the twin exists and shown again if the twin is deleted.
 *
 * Properties are what the decoder could read from the file; parameters it cannot decode are absent.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { notify } from "../core/notify";
import { escapeHtml } from "../core/html-escape";
import { buildTwinGeometry, ifcClassName, isRevitNodeData, twinPropertySets, type RvtElementInfo } from "../modules/rvt/rvt-core";
import { addNativeGeometryElement, getElements, isDrawingActive, pickAuthoredHitAt, removeElementById, setSelectedAuthored } from "./authoring";
import { history } from "./history";

export interface RevitHit {
  mesh: THREE.Mesh;
  root: THREE.Object3D;
  entityIndex: number;
  info: RvtElementInfo;
  distance: number;
}

const SOURCE_PREFIX = "revit:";
const origMaterial = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
let selected: RevitHit | null = null;
let panel: HTMLDivElement | null = null;

function auxRoots(): THREE.Object3D[] {
  try { return (ctx.features as any).fileInterop?.getAuxObjects?.() ?? []; } catch { return []; }
}
const visibleChain = (o: THREE.Object3D | null) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true; };
const rootOf = (o: THREE.Object3D): THREE.Object3D => { let x = o; const roots = new Set(auxRoots()); while (x.parent && !roots.has(x)) x = x.parent; return x; };

/** Does this scene object tree contain Revit element nodes? */
export function hasRevitElements(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((o) => { if (!found && isRevitNodeData(o.userData)) found = true; });
  return found;
}

function elementMeshes(root: THREE.Object3D, entityIndex: number): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o: any) => { if (o.isMesh && isRevitNodeData(o.userData) && o.userData.entityIndex === entityIndex) out.push(o); });
  return out;
}

/** Nearest visible Revit element under the pointer. */
export function pickRevitAt(e: MouseEvent): RevitHit | null {
  const cam = ctx.world?.camera?.three;
  if (!cam) return null;
  const targets: THREE.Mesh[] = [];
  for (const r of auxRoots()) r.traverse((o: any) => { if (o.isMesh && isRevitNodeData(o.userData) && visibleChain(o)) targets.push(o); });
  if (!targets.length) return null;
  const rect = ctx.rightHost.getBoundingClientRect();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), cam);
  const hit = ray.intersectObjects(targets, false)[0];
  if (!hit) return null;
  const mesh = hit.object as THREE.Mesh;
  const data = mesh.userData as { entityIndex: number; revit: RvtElementInfo };
  return { mesh, root: rootOf(mesh), entityIndex: data.entityIndex, info: data.revit, distance: hit.distance };
}

/* ── highlight ── */
function clearHighlight() {
  if (!selected) return;
  for (const m of elementMeshes(selected.root, selected.entityIndex)) {
    const o = origMaterial.get(m);
    if (o) { const cur = m.material; m.material = o; origMaterial.delete(m); for (const c of Array.isArray(cur) ? cur : [cur]) c.dispose?.(); }
  }
}
function applyHighlight(hit: RevitHit) {
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
  }
}

export function selectRevitElement(hit: RevitHit | null) {
  clearHighlight();
  selected = hit;
  if (hit) { applyHighlight(hit); showPanel(hit); } else hidePanel();
}
export const getSelectedRevitElement = () => selected;

/* ── Native Twin ── */
export function twinFor(hit: Pick<RevitHit, "root" | "entityIndex">) {
  const sid = SOURCE_PREFIX + hit.root.name;
  return getElements().find((el: any) => el.properties?.sourceModelId === sid && el.properties?.sourceLocalId === hit.entityIndex) ?? null;
}

export async function makeNativeTwin(hit: RevitHit): Promise<string | null> {
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
  const sourceFile = hit.root.name.replace(/ \(Revit view\)\.glb$/i, "");
  let created: ReturnType<typeof addNativeGeometryElement>;
  try {
    created = addNativeGeometryElement({
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
      sourceRawItem: { source: "revit-view", entityIndex: hit.entityIndex, info },
      geometryProvenance: {
        extractionPath: "revit-view-glb", triangleCount: geo.triangleCount, meshCount: parts.length, vertexCount: geo.triangleCount * 3,
        bounds: { min: geo.min, max: geo.max, center: geo.center },
      },
    });
  } catch (err) {
    console.error("[revit-view] native twin failed", err);
    notify("error", `Could not make “${info.name}” editable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  syncTwinVisibility();
  const id = created.id;
  setSelectedAuthored([id], "replace");
  selectRevitElement(null);
  notify("success", `Editable native twin created: ${info.name}. The Revit source is hidden while the twin exists.`);
  history.push({
    label: `Make native twin · ${info.name}`,
    apply: () => { /* redo is not offered: run Make editable native twin again */ },
    revert: () => { removeElementById(id); syncTwinVisibility(); },
  } as any);
  return id;
}

/** Hide Revit meshes that have a twin; show the rest. Safe to call any time (idempotent). */
export function syncTwinVisibility() {
  const twinned = new Set<string>();
  for (const el of getElements() as any[]) {
    const sid = el.properties?.sourceModelId;
    if (typeof sid === "string" && sid.startsWith(SOURCE_PREFIX)) twinned.add(`${sid}::${el.properties.sourceLocalId}`);
  }
  for (const root of auxRoots()) {
    root.traverse((o: any) => {
      if (!o.isMesh || !isRevitNodeData(o.userData)) return;
      o.visible = !twinned.has(`${SOURCE_PREFIX}${root.name}::${o.userData.entityIndex}`);
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

function showPanel(hit: RevitHit) {
  hidePanel();
  const i = hit.info;
  const twin = twinFor(hit);
  const el = document.createElement("div");
  el.setAttribute("data-obs-ui", "1");
  el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Revit element properties");
  el.style.cssText = "position:fixed;right:14px;top:96px;z-index:9000;width:320px;max-height:70vh;overflow:auto;background:var(--bg-floating,#1e1f26);color:var(--text-primary,#e2e8f0);border:1px solid var(--border-default,#3a3a4a);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.55);font:12px system-ui,sans-serif;padding:10px 12px";
  const m = (n?: number) => (n === undefined ? undefined : `${n} m`);
  const ext = i.extentsM;
  el.innerHTML =
    `<div style="display:flex;align-items:flex-start;gap:8px"><div style="flex:1"><div style="font-weight:700;font-size:13px;word-break:break-word">${escapeHtml(i.name)}</div><div style="opacity:.65">${escapeHtml(i.ifcType)} · from Revit file, view only</div></div><button data-x aria-label="Close" style="background:none;border:0;color:inherit;cursor:pointer;font-size:16px">✕</button></div>` +
    `<div style="display:flex;gap:6px;margin:10px 0 2px"><button data-twin style="flex:1;padding:7px 10px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer">${twin ? "Select editable twin" : "Make editable native twin"}</button><button data-zoom style="padding:7px 10px;border-radius:6px;border:1px solid #3a3a4a;background:#2a2c36;color:inherit;cursor:pointer">Zoom</button></div>` +
    rows("Identity", [["Revit element id", i.elementId], ["GlobalId", i.globalId], ["Predefined type", i.predefinedType], ["Level", i.storey ? (i.storeyElevationM !== undefined ? `${i.storey} (${i.storeyElevationM} m)` : i.storey) : undefined], ["Material", i.material]]) +
    rows("Placement and size (file frame, metres)", [
      ["Location", i.locationM ? i.locationM.join(", ") : undefined], ["Rotation", i.rotationDeg !== undefined ? `${i.rotationDeg}°` : undefined],
      ["Length / width", m(ext?.width)], ["Thickness / depth", m(ext?.depth)], ["Height", m(ext?.height)],
    ]) +
    i.groups.map((g) => rows(g.name, g.rows)).join("") +
    `<div style="margin-top:10px;opacity:.55;line-height:1.4">Shows what the decoder could read from the file. Revit parameters it cannot decode are not listed. Right-click the element for more.</div>`;
  el.querySelector<HTMLButtonElement>("[data-x]")!.onclick = () => selectRevitElement(null);
  el.querySelector<HTMLButtonElement>("[data-zoom]")!.onclick = () => zoomTo(hit);
  el.querySelector<HTMLButtonElement>("[data-twin]")!.onclick = () => { void makeNativeTwin(hit); };
  document.body.appendChild(el);
  panel = el;
}
function hidePanel() { panel?.remove(); panel = null; }

export function zoomTo(hit: RevitHit) {
  try {
    const box = new THREE.Box3();
    for (const m of elementMeshes(hit.root, hit.entityIndex)) box.expandByObject(m);
    if (!box.isEmpty()) (ctx.features as any).camera?.focusOnBox?.(box);
  } catch { /* viewing aid only */ }
}

/* ── context menu items (consumed by context-menu.ts) ── */
export function revitMenuItems(hit: RevitHit): Array<{ type: "label"; text: string } | { type: "action"; icon?: string; text: string; onclick: () => void } | { type: "sep" }> {
  const twin = twinFor(hit);
  return [
    { type: "label", text: `REVIT · ${hit.info.name}`.slice(0, 60) },
    { type: "action", icon: "🧩", text: twin ? "Select editable native twin" : "Make editable native twin", onclick: () => { void makeNativeTwin(hit); } },
    { type: "action", icon: "ℹ️", text: "Properties", onclick: () => selectRevitElement(hit) },
    { type: "action", icon: "🔍", text: "Zoom to element", onclick: () => zoomTo(hit) },
  ];
}

/* ── wiring ── */
let installed = false;
export function installRevitView() {
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
    const hit = pickRevitAt(e);
    if (hit) {
      const a = pickAuthoredHitAt(e);               // a closer authored element (e.g. a twin) wins
      if (a && a.distance < hit.distance) return;
      selectRevitElement(hit);
    } else if (selected) selectRevitElement(null);
  }, true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && selected) selectRevitElement(null); });
  try { (ctx.features.authoring as any).onAuthoringChange?.(() => syncTwinVisibility()); } catch { /* authoring not ready: sync also runs after each import */ }
}
