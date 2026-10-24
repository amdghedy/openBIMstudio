/** Project lifecycle: create/open/save/close + import persistence hook.
 *
 *  Offsets
 *  ───────
 *  Each model has an offset stored in the doc at `models[].position`.
 *  On save we read the live offset from importer; on open we restore it.
 *  If the doc has no offsets (fresh project, or pre-migration), the
 *  saved positioning mode is applied instead.
 */
import { ctx } from "../../core/context";
import { services } from "../../core/services";
import * as store from "./store";
import type { ProjectDoc, ProjectTemplate, ProjectStatus, ProjectUnits } from "./types";
import {
  establishSceneOffset, computeSceneBounds, fitAll,
  resetPlacementState, updateClipping,
} from "../../features/camera-tools";
import {
  setElements, getElements, clearElements,
  getGrids, setGrids, getLevels, setLevels,
} from "../../features/authoring";
import { refreshModelSelectionUI, clearClash } from "../../features/clash";
import { getIssues, setIssues, onIssuesChanged } from "../issues/issues";
import { getCostData, setCostData, onCostChanged } from "../cost/cost";

let current: ProjectDoc | null = null;
let dirty = false;
let detachedModels = 0;
const listeners = new Set<() => void>();

export function getCurrentProject() { return current; }
export function isDirty() { return dirty; }
export function getDetachedModelCount() { return detachedModels; }
export function onProjectChanged(cb: () => void) { listeners.add(cb); }
function notify() {
  for (const cb of listeners) {
    try { cb(); } catch { /* */ }
  }
}
export function markDirty() { dirty = true; notify(); }

export type ProjectMetaPatch = Partial<Pick<
  ProjectDoc,
  "name" | "projectNumber" | "client" | "phase" | "description" | "status" | "units" | "owner"
>>;

export function updateProjectMeta(patch: ProjectMetaPatch): void {
  if (!current) return;
  const next = patch.name !== undefined ? String(patch.name).trim() : undefined;
  if (next !== undefined) current.name = next || "Untitled project";
  if (patch.projectNumber !== undefined) current.projectNumber = String(patch.projectNumber).trim() || undefined;
  if (patch.client !== undefined) current.client = String(patch.client).trim() || undefined;
  if (patch.phase !== undefined) current.phase = String(patch.phase).trim() || undefined;
  if (patch.description !== undefined) current.description = String(patch.description).trim() || undefined;
  if (patch.owner !== undefined) current.owner = String(patch.owner).trim() || undefined;
  if (patch.status !== undefined) current.status = patch.status as ProjectStatus;
  if (patch.units !== undefined) current.units = patch.units as ProjectUnits;
  markDirty();
}

function esc(s: string) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function snapshotAppState() {
  const cam = ctx.world.camera.three;
  const t: any = (ctx.world.camera.controls as any).target;
  return {
    cam: [cam.position.x, cam.position.y, cam.position.z] as [number, number, number],
    target: t?.isVector3 ? ([t.x, t.y, t.z] as [number, number, number]) : undefined,
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   Save
   ═════════════════════════════════════════════════════════════════════════ */
export async function saveProject(silent = false) {
  if (!current) {
    if (!silent) alert("No project is open.");
    return;
  }
  current.elements = getElements();
  current.grids = getGrids();
  current.levels = getLevels();
  current.issues = getIssues();
  current.cost = getCostData();
  current.appState = snapshotAppState();

  // Persist per-model offset from importer.
  try {
    const importer: any = (ctx.features as any).importer;
    for (const meta of current.models ?? []) {
      const off = importer?.getModelOffset?.(meta.id);
      if (off) meta.position = [off[0], off[1], off[2]];
    }
  } catch (e) {
    console.warn("[projects] offset persistence failed", e);
  }

  try {
    const m = (ctx.features as any).importer?.getPositioningMode?.();
    if (m) (current as any).positioningMode = m;
  } catch { /* */ }


  // openbim-levels:ui-wired:projects

  try {

    const activeId = (ctx.features as any).authoring?.getActiveLevelId?.() ?? null;

    (current as any).activeLevelId = activeId;

  } catch { /* */ }

  try {
    const serialize = (ctx.features as any).fragEdit?.serialize;
    if (typeof serialize === "function") {
      const edits = serialize();
      (current as any).fragEdits = edits; // v48 legacy compatibility
      (current as any).nativeTwins = edits; // rich Native Twin payload
    }
  } catch { /* */ }

  try {
    const clash = services.tryUse("clash");
    (current as any).clashStates = clash?.serializeStates?.() ?? [];
  } catch { /* */ }

  try {
    const annot = await import("../views/annotation-store");
    current.annotations = annot.serializeAll();
  } catch { /* annotations store optional */ }

  try {
    const pd = (window as any).__obsPlanDims?.serialize?.();
    if (Array.isArray(pd)) current.planDimensions = pd;
    const pa = (window as any).__obsPlanAnno?.serialize?.();
    if (pa) current.planAnnotations = pa;
  } catch { /* plan dimensions optional */ }

  current.updatedAt = Date.now();
  await store.putProject(current);
  dirty = false;
  notify();
  try { window.dispatchEvent(new CustomEvent("obs:project-saved", { detail: { silent } })); } catch { /* */ }
}

/* ═════════════════════════════════════════════════════════════════════════
   Scene teardown
   ═════════════════════════════════════════════════════════════════════════ */
async function clearScene() {
  try { await (ctx.highlighter as any).clear?.(); } catch { /* */ }
  try { ctx.clipper.deleteAll(); } catch { /* */ }
  try { await clearClash(); } catch { /* */ }

  try { (ctx.features as any).importer?.clearAllOffsets?.(); } catch { /* */ }

  const ids = Array.from(ctx.fragments.list.keys());
  for (const id of ids) {
    try { await (ctx.fragments.list.get(id) as any)?.dispose?.(); } catch { /* */ }
    try { (ctx.fragments.list as any).delete?.(id); } catch { /* */ }
  }
  try { (ctx.fragments.list as any).clear?.(); } catch { /* */ }

  clearElements();
  try { (ctx.features as any).fileInterop?.clearAux?.(); } catch { /* */ }
  try { (ctx.features as any).fragEdit?.clearAll?.(); } catch { /* */ }
  resetPlacementState();
}

/* ═════════════════════════════════════════════════════════════════════════
   Viewpoint pruning
   ═════════════════════════════════════════════════════════════════════════ */
function pruneViewpoint(vp: any, missing: Set<string>) {
  if (!vp || typeof vp !== "object") return;
  if (vp.selection && typeof vp.selection === "object") {
    for (const k of Object.keys(vp.selection)) if (missing.has(k)) delete vp.selection[k];
  }
  if (vp.hidden && typeof vp.hidden === "object") {
    for (const k of Object.keys(vp.hidden)) if (missing.has(k)) delete vp.hidden[k];
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Worker-probe verification
   ═════════════════════════════════════════════════════════════════════════ */
async function verifyLoadedModels(loadedIds: Set<string>): Promise<string[]> {
  const stale: string[] = [];
  for (const id of Array.from(loadedIds)) {
    if (id.startsWith("aux-")) continue;
    const model: any = ctx.fragments.list.get(id);
    if (!model) { stale.push(id); continue; }
    try {
      const probe = await model.getItemsIdsWithGeometry?.();
      if (!Array.isArray(probe) || probe.length === 0) { stale.push(id); continue; }
    } catch { stale.push(id); }
  }
  for (const id of stale) {
    try { (ctx.fragments.list as any).delete?.(id); } catch { /* */ }
    loadedIds.delete(id);
  }
  return stale;
}

/* ═════════════════════════════════════════════════════════════════════════
   New project
   ═════════════════════════════════════════════════════════════════════════ */
export interface CreateProjectOptions {
  template?: ProjectTemplate;
  projectNumber?: string;
  client?: string;
  phase?: string;
  units?: ProjectUnits;
  owner?: string;
  description?: string;
}

export async function createProject(name: string, options: CreateProjectOptions = {}) {
  const loader = (ctx.features as any).appLoader;
  loader?.begin?.(`Creating project · ${name || "Untitled"}`, { cancellable: false });
  try {
    loader?.set?.("Clearing current scene…", 0.2);
    await clearScene();
    loader?.set?.("Preparing document…", 0.6);

    const now = Date.now();
    current = {
      id: (crypto as any).randomUUID?.() ?? `p-${now}`,
      name: name || "Untitled project",
      createdAt: now,
      updatedAt: now,
      projectNumber: options.projectNumber?.trim() || undefined,
      client: options.client?.trim() || undefined,
      phase: options.phase?.trim() || undefined,
      description: options.description?.trim() || undefined,
      owner: options.owner?.trim() || undefined,
      status: "active",
      units: options.units ?? "metric",
      template: options.template ?? "blank",
      elements: [], models: [], issues: [], cost: undefined,
      grids: [], levels: [], appState: {},
      positioningMode: "origin-to-origin",
    } as ProjectDoc;
    detachedModels = 0;
    setIssues([]); setCostData(null);
    setGrids([]); setLevels([]);
    dirty = false;

    // openbim-levels:ui-wired:projects
    try {
      const levelsMod: any = await import("../levels/levels");
      const seeded = levelsMod.levels.ensureSeed();
      if (seeded.length) levelsMod.levels.setActiveId(seeded[0].id);
    } catch (e) {
      console.warn("[projects] level seed failed", e);
    }

    loader?.set?.("Writing to storage…", 0.85);
    await store.putProject(current);

    computeSceneBounds();
    try { void refreshModelSelectionUI(); } catch { /* */ }
    fitAll();
    loader?.set?.("Done.", 1);
    notify();
  } finally {
    setTimeout(() => loader?.finish?.(), 150);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Open project
   ═════════════════════════════════════════════════════════════════════════ */
export async function openProject(id: string) {
  const loader = (ctx.features as any).appLoader;
  if (loader?.isActive?.()) return;

  const doc = await store.getProject(id);
  if (!doc) { alert("Project not found."); return; }

  loader?.begin?.(`Opening ${doc.name}…`, { cancellable: false });

  try {
    loader?.set?.("Clearing current scene…", 0.05);
    await clearScene();

    current = doc;
    dirty = false;
    detachedModels = 0;

    loader?.set?.("Reading stored blobs…", 0.12);
    const blobs = await store.getModelBlobs(id);
    const loadedIds = new Set<string>();
    const missingModels: string[] = [];
    const importer = (ctx.features as any).importer;

    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      const pct = 0.15 + 0.6 * ((i + 1) / Math.max(1, blobs.length));
      loader?.set?.(`Loading model ${i + 1} / ${blobs.length} · ${b.name}`, pct);
      try {
        if (b.modelId.startsWith("aux-")) {
          await (ctx.features as any).fileInterop?.restoreAux?.(b.blob, b.name, b.modelId);
          loadedIds.add(b.modelId);
          continue;
        }
        const buf = await b.blob.arrayBuffer();
        await ctx.fragments.core.load(new Uint8Array(buf), { modelId: b.modelId });

        // Register (default offset 0,0,0) and immediately apply saved offset.
        importer?.registerModel?.(b.modelId);
        const meta = doc.models?.find((m) => m.id === b.modelId);
        if (meta?.position) {
          importer?.setModelOffset?.(b.modelId, meta.position);
          console.log(
            `[projects] applied offset for "${b.modelId}" → ` +
              `(${meta.position[0].toFixed(3)}, ${meta.position[1].toFixed(3)}, ${meta.position[2].toFixed(3)})`,
          );
        }
        establishSceneOffset(b.modelId);
        loadedIds.add(b.modelId);
      } catch (e) {
        console.error("[projects] model load failed:", b.name, e);
        try { (ctx.fragments.list as any).delete?.(b.modelId); } catch { /* */ }
        missingModels.push(b.modelId);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    for (const m of doc.models ?? []) {
      if (!loadedIds.has(m.id) && !missingModels.includes(m.id)) {
        missingModels.push(m.id);
        try { (ctx.fragments.list as any).delete?.(m.id); } catch { /* */ }
      }
    }

    loader?.set?.("Verifying loaded models…", 0.78);
    const stale = await verifyLoadedModels(loadedIds);
    for (const sid of stale) if (!missingModels.includes(sid)) missingModels.push(sid);

    if (missingModels.length) {
      const missing = new Set(missingModels);
      for (const m of doc.models ?? []) if (missing.has(m.id)) (m as any).missing = true;
      for (const issue of doc.issues ?? []) {
        pruneViewpoint(issue.viewpoint, missing);
        for (const c of issue.comments ?? []) if (c.viewpoint) pruneViewpoint(c.viewpoint, missing);
      }
    }

    loader?.set?.("Restoring project data…", 0.82);
    setIssues(doc.issues ?? []);
    setCostData(doc.cost ?? null);
    setGrids(doc.grids ?? []);
    setLevels(doc.levels ?? []);
    setElements(doc.elements ?? []);

    // openbim-levels:ui-wired:projects
    try {
      const levelsMod: any = await import("../levels/levels");
      const seeded = levelsMod.levels.ensureSeed();
      const savedActive = (doc as any).activeLevelId;
      if (savedActive && seeded.some((l: any) => l.id === savedActive)) {
        levelsMod.levels.setActiveId(savedActive);
      } else if (seeded.length) {
        levelsMod.levels.setActiveId(seeded[0].id);
      }
    } catch (e) {
      console.warn("[projects] level restore failed", e);
    }
    try {
      const annot = await import("../views/annotation-store");
      annot.deserializeAll((doc.annotations as any) ?? null);
    } catch { /* */ }
    try {
      const pdApi = (window as any).__obsPlanDims;
      if (pdApi?.load) pdApi.load(doc.planDimensions ?? []);
      else (window as any).__obsPendingPlanDims = doc.planDimensions ?? [];
      const paApi = (window as any).__obsPlanAnno;
      if (paApi?.load) paApi.load(doc.planAnnotations ?? null);
      else (window as any).__obsPendingPlanAnno = doc.planAnnotations ?? null;
    } catch { /* */ }

    // If no saved offsets, apply the saved positioning mode instead.
    const hasSavedOffsets = (doc.models ?? []).some(
      (m) => m.position && (Math.abs(m.position[0]) > 1e-6 || Math.abs(m.position[1]) > 1e-6 || Math.abs(m.position[2]) > 1e-6),
    );
    if (!hasSavedOffsets && importer?.applyPositioningMode) {
      const mode = (doc as any).positioningMode ?? "origin-to-origin";
      try { await importer.applyPositioningMode(mode); } catch (e) { console.warn(e); }
    }

    computeSceneBounds();

    const nativeTwins = Array.isArray((doc as any).nativeTwins)
      ? (doc as any).nativeTwins
      : ((doc as any).fragEdits ?? []);
    if (Array.isArray(nativeTwins) && nativeTwins.length) {
      loader?.set?.(`Restoring ${nativeTwins.length} native twin(s)…`, 0.9);
      try { await (ctx.features as any).fragEdit?.deserializeNativeTwins?.(nativeTwins); } catch {
        try { await (ctx.features as any).fragEdit?.deserialize?.(nativeTwins); } catch { /* */ }
      }
    }

    try {
      const clash = services.tryUse("clash");
      clash?.deserializeStates?.((doc as any).clashStates ?? []);
    } catch { /* */ }

    loader?.set?.("Rebuilding panels…", 0.96);
    setTimeout(() => { try { void refreshModelSelectionUI(); } catch { /* */ } }, 300);

    const st = doc.appState;
    if (st?.cam && st?.target) {
      ctx.world.camera.controls.setLookAt(
        st.cam[0], st.cam[1], st.cam[2],
        st.target[0], st.target[1], st.target[2], true,
      );
      updateClipping();
    } else fitAll();

    setTimeout(() => {
      try { (ctx.cam as any)?.recoverView?.(); } catch { /* */ }
    }, 600);

    if (missingModels.length) showMissingModelsBanner(missingModels);

    loader?.set?.("Done.", 1);
    notify();
  } catch (err) {
    console.error("[projects] openProject failed", err);
    alert(`Could not open project: ${err instanceof Error ? err.message : err}`);
  } finally {
    setTimeout(() => loader?.finish?.(), 180);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Banners
   ═════════════════════════════════════════════════════════════════════════ */
function showMissingModelsBanner(models: string[]) {
  const id = "obs-missing-models-banner";
  document.getElementById(id)?.remove();
  const banner = document.createElement("div");
  banner.id = id;
  banner.style.cssText =
    "position:fixed;right:16px;bottom:52px;z-index:9000;max-width:420px;" +
    "background:var(--bg-floating,#1c1e28);color:var(--text-primary,#e8eaf0);" +
    "border:1px solid var(--warning,#f59e0b);border-left:3px solid var(--warning,#f59e0b);" +
    "border-radius:6px;padding:12px 14px;font:12px/1.5 system-ui,sans-serif;" +
    "box-shadow:0 12px 32px rgba(0,0,0,.45)";
  banner.innerHTML =
    `<div style="font-weight:700;margin-bottom:6px;color:var(--warning,#f59e0b)">⚠ ${models.length} linked model(s) not loaded</div>` +
    `<div style="font-size:11px;opacity:.85;margin-bottom:8px;max-height:140px;overflow:auto">` +
      models.map((m) => `<div style="font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">· ${esc(m)}</div>`).join("") +
    `</div>`;
  const close = document.createElement("button");
  close.textContent = "Dismiss";
  close.style.cssText = "padding:4px 12px;background:var(--bg-hover,#232633);color:inherit;" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer;font-size:11px";
  close.onclick = () => banner.remove();
  banner.appendChild(close);
  document.body.appendChild(banner);
  setTimeout(() => { if (banner.isConnected) banner.remove(); }, 20_000);
}

/* ═════════════════════════════════════════════════════════════════════════
   Delete
   ═════════════════════════════════════════════════════════════════════════ */
export async function deleteProjectById(id: string) {
  await store.deleteProjectRecord(id);
  await store.deleteModelBlobs(id);
  if (current?.id === id) { current = null; notify(); }
}

/* ═════════════════════════════════════════════════════════════════════════
   Import persistence hook
   ═════════════════════════════════════════════════════════════════════════ */
export function onModelImported(modelId: string, name: string, bytes: Uint8Array | null) {
  if (!current) {
    detachedModels++;
    notify();
    return;
  }
  if (!bytes || !bytes.byteLength) {
    const meta = current.models.find((m) => m.id === modelId);
    if (meta) meta.name = name;
    else current.models.push({ id: modelId, name, bytes: 0 });
    markDirty();
    return;
  }
  const blob = new Blob([bytes as unknown as BlobPart]);
  const sizeMB = blob.size / (1024 * 1024);
  store.putModelBlob(current.id, modelId, name, blob)
    .then(async () => {
      const meta = current!.models.find((m) => m.id === modelId);
      if (meta) { meta.name = name; meta.bytes = blob.size; (meta as any).missing = false; }
      else current!.models.push({ id: modelId, name, bytes: blob.size });
      try { await store.putProject(current!); } catch { /* */ }
    })
    .catch((e) => console.error(`[projects] blob save FAILED for "${name}"`, e));
  markDirty();
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupProjects() {
  ctx.features.projects = {
    getCurrentProject, isDirty, createProject, openProject,
    deleteProjectById, saveProject, onModelImported, markDirty,
  };
  onIssuesChanged(() => markDirty());
  onCostChanged(() => markDirty());
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void saveProject();
    }
  });
  setInterval(() => { if (dirty && current) void saveProject(true); }, 25_000);
}