/**
 * Saved views — named camera positions, persisted per project.
 *
 * A floating panel lists saved views. Each row shows the name, creation date,
 * and buttons to restore or delete. Saving captures the current camera
 * position, orbit target, and projection mode.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { getProjection, setProjection, updateClipping } from "./camera-tools";
import { getCurrentProject, onProjectChanged } from "../modules/projects/projects";

/* ═════════════════════════════════════════════════════════════════════════
   Types + storage
   ═════════════════════════════════════════════════════════════════════════ */
export interface SavedView {
  id: string;
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
  projection: "perspective" | "orthographic";
  createdAt: number;
}

const STORAGE_PREFIX = "obs.saved-views.";

function storageKey(): string {
  const p = getCurrentProject();
  return STORAGE_PREFIX + (p?.id ?? "__global__");
}

function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function persistViews(list: SavedView[]): void {
  try { localStorage.setItem(storageKey(), JSON.stringify(list)); } catch { /* */ }
}

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
export function listSavedViews(): SavedView[] {
  return loadViews();
}

export function saveCurrentView(name?: string): SavedView | null {
  const cam = ctx.world.camera.three;
  const controls: any = ctx.world.camera.controls;
  const target = new THREE.Vector3();
  if (controls?.target?.isVector3) target.copy(controls.target);
  else {
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    target.copy(cam.position).add(d.multiplyScalar(5));
  }

  const autoName = name?.trim() ||
    `View ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;

  const view: SavedView = {
    id: (crypto as any).randomUUID?.() ?? `v-${Date.now()}`,
    name: autoName,
    pos: [cam.position.x, cam.position.y, cam.position.z],
    target: [target.x, target.y, target.z],
    projection: getProjection(),
    createdAt: Date.now(),
  };

  const list = loadViews();
  list.unshift(view);
  persistViews(list.slice(0, 64));
  renderPanel();
  return view;
}

export function restoreView(id: string): void {
  const view = loadViews().find((v) => v.id === id);
  if (!view) return;

  if (view.projection !== getProjection()) {
    try { setProjection(view.projection); } catch { /* */ }
  }

  const controls: any = ctx.world.camera.controls;
  if (controls && typeof controls.setLookAt === "function") {
    try {
      controls.setLookAt(
        view.pos[0], view.pos[1], view.pos[2],
        view.target[0], view.target[1], view.target[2],
        true,   // smooth transition
      );
    } catch { /* */ }
  } else {
    const cam = ctx.world.camera.three;
    cam.position.set(view.pos[0], view.pos[1], view.pos[2]);
    cam.lookAt(new THREE.Vector3(...view.target));
  }

  updateClipping();
  try { ctx.fragments.core.update(true); } catch { /* */ }
}

export function deleteView(id: string): void {
  const list = loadViews().filter((v) => v.id !== id);
  persistViews(list);
  renderPanel();
}

/* ═════════════════════════════════════════════════════════════════════════
   Panel
   ═════════════════════════════════════════════════════════════════════════ */
let panelEl: HTMLDivElement | null = null;
let listContainer: HTMLDivElement | null = null;

function ensurePanel(): HTMLDivElement {
  if (panelEl) return panelEl;

  panelEl = document.createElement("div");
  panelEl.id = "obs-saved-views";
  panelEl.style.cssText =
    "position:absolute;right:14px;top:210px;width:270px;max-height:60vh;z-index:34;" +
    "display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
    "color:var(--text-primary,#e8eaf0);overflow:hidden";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:9px 10px;" +
    "border-bottom:1px solid var(--border-subtle,#1e2029);" +
    "background:var(--bg-elevated,#181a23)";
  header.innerHTML = `<span style="font-weight:700;flex:1">📌 Saved Views</span>`;

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save current";
  saveBtn.style.cssText =
    "padding:4px 10px;background:var(--accent,#38bdf8);color:#0b0d12;" +
    "border:none;border-radius:5px;cursor:pointer;font:600 11px system-ui";
  saveBtn.onclick = () => {
    const name = prompt("View name:", `View ${listSavedViews().length + 1}`);
    if (name == null) return;
    saveCurrentView(name);
  };

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText =
    "padding:4px 8px;background:transparent;color:var(--text-secondary);" +
    "border:1px solid var(--border-default);border-radius:5px;cursor:pointer;font-size:11px";
  closeBtn.onclick = () => closeSavedViewsPanel();

  header.append(saveBtn, closeBtn);

  listContainer = document.createElement("div");
  listContainer.style.cssText = "overflow-y:auto;padding:6px";

  panelEl.append(header, listContainer);
  ctx.rightHost.appendChild(panelEl);
  return panelEl;
}

function renderPanel(): void {
  if (!listContainer) return;
  listContainer.innerHTML = "";

  const list = loadViews();
  if (!list.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:18px;text-align:center;color:var(--text-tertiary,#6b7280);" +
      "font:11.5px/1.5 system-ui;border:1px dashed var(--border-default);" +
      "border-radius:6px";
    empty.textContent = "No saved views. Click Save current to capture the camera.";
    listContainer.appendChild(empty);
    return;
  }

  for (const v of list) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:6px;" +
      "margin:2px 0;cursor:pointer;transition:background .12s";
    row.onmouseenter = () => (row.style.background = "rgba(255,255,255,.04)");
    row.onmouseleave = () => (row.style.background = "transparent");
    row.onclick = () => restoreView(v.id);

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0";
    const name = document.createElement("div");
    name.style.cssText = "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    name.textContent = v.name;
    name.title = v.name;
    const meta = document.createElement("div");
    meta.style.cssText = "font-size:10px;color:var(--text-tertiary);margin-top:1px";
    meta.textContent = `${v.projection === "orthographic" ? "Ortho" : "Persp"} · ${new Date(v.createdAt).toLocaleString()}`;
    info.append(name, meta);

    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete this view";
    del.style.cssText =
      "padding:3px 7px;background:transparent;color:var(--text-secondary);" +
      "border:1px solid var(--border-default);border-radius:4px;cursor:pointer;font-size:10px;flex:none";
    del.onclick = (e) => { e.stopPropagation(); deleteView(v.id); };

    row.append(info, del);
    listContainer.appendChild(row);
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Panel visibility
   ═════════════════════════════════════════════════════════════════════════ */
export function isSavedViewsPanelVisible(): boolean {
  return !!panelEl && panelEl.style.display === "flex";
}

export function openSavedViewsPanel(): void {
  ensurePanel();
  if (!panelEl) return;
  panelEl.style.display = "flex";
  renderPanel();
}

export function closeSavedViewsPanel(): void {
  if (panelEl) panelEl.style.display = "none";
}

export function toggleSavedViewsPanel(): void {
  isSavedViewsPanelVisible() ? closeSavedViewsPanel() : openSavedViewsPanel();
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupSavedViews(): void {
  onProjectChanged(() => {
    if (isSavedViewsPanelVisible()) renderPanel();
  });

  // Ctrl+Shift+V to toggle
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleSavedViewsPanel();
      }
    },
    true,
  );

  ctx.features.savedViews = {
    open: openSavedViewsPanel,
    close: closeSavedViewsPanel,
    toggle: toggleSavedViewsPanel,
    isVisible: isSavedViewsPanelVisible,
    list: listSavedViews,
    save: saveCurrentView,
    restore: restoreView,
    remove: deleteView,
  };
}