/**
 * View Tools Manager — unified panel listing all scope boxes + view filters
 * + crop regions with edit / delete / apply-to-view buttons.
 *
 * Replaces the previous "List Boxes" button that just dumped to console.
 * Single panel, three tabs, live refresh after every action.
 */

import {
  listScopeBoxes, getScopeBox, deleteScopeBox, updateScopeBox, applyToView, removeFromView,
} from "../modules/scope-box/scope-box";
import {
  listViewFilters, getViewFilter, deleteViewFilter,
} from "../modules/view-filters/view-filters";
import {
  listCropRegions, setCropRegion, deleteCropRegion,
} from "./crop-region";
import { openFormModal, confirmDialog } from "./form-modal";

let panelEl: HTMLDivElement | null = null;
let overlayEl: HTMLDivElement | null = null;
let activeTab: "scope" | "filters" | "crop" = "scope";

function ensureOverlay(): HTMLDivElement {
  if (overlayEl && overlayEl.isConnected) return overlayEl;
  overlayEl = document.createElement("div");
  overlayEl.className = "obs-view-tools-overlay";
  overlayEl.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(2px);
    display: none;
    align-items: center; justify-content: center;
    font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  `;
  overlayEl.addEventListener("pointerdown", (e) => {
    if (e.target === overlayEl) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayEl && overlayEl.style.display !== "none") close();
  });
  document.body.appendChild(overlayEl);
  return overlayEl;
}

function close(): void {
  if (overlayEl) overlayEl.style.display = "none";
}

/** Open the View Tools Manager panel. */
export async function openViewToolsManager(): Promise<void> {
  const ov = ensureOverlay();
  ov.innerHTML = "";
  ov.style.display = "flex";

  const card = document.createElement("div");
  card.className = "obs-view-tools-panel";
  card.style.cssText = `
    width: min(720px, 94vw); max-height: 86vh;
    background: #1c1e28; color: #e8eaf0;
    border: 1px solid #2a2e3a; border-radius: 10px;
    box-shadow: 0 24px 60px rgba(0,0,0,.65);
    display: flex; flex-direction: column; overflow: hidden;
  `;

  // ── Header ──────────────────────────────────────────────────────────
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex; align-items: center; gap: 12px; padding: 14px 18px;
    border-bottom: 1px solid #2a2e3a; background: #181a23;
  `;
  const titleWrap = document.createElement("div");
  titleWrap.style.flex = "1";
  titleWrap.innerHTML = `
    <div style="font-weight:700;font-size:15px">View Tools Manager</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:2px">Scope boxes · View filters · Crop regions</div>
  `;
  header.appendChild(titleWrap);
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `
    width:28px;height:28px;border-radius:4px;background:transparent;
    color:#94a3b8;border:1px solid #2a2e3a;cursor:pointer;font-size:13px;
  `;
  closeBtn.onclick = close;
  header.appendChild(closeBtn);
  card.appendChild(header);

  // ── Tabs ─────────────────────────────────────────────────────────────
  const tabs = document.createElement("div");
  tabs.style.cssText = "display:flex;padding:8px 12px 0;gap:4px;border-bottom:1px solid #2a2e3a;background:#181a23";
  const tabDefs: Array<{ id: typeof activeTab; label: string; count: () => number }> = [
    { id: "scope", label: "Scope Boxes", count: () => listScopeBoxes().length },
    { id: "filters", label: "View Filters", count: () => listViewFilters().length },
    { id: "crop", label: "Crop Regions", count: () => listCropRegions().length },
  ];
  for (const td of tabDefs) {
    const tab = document.createElement("button");
    tab.textContent = `${td.label} (${td.count()})`;
    tab.dataset.tab = td.id;
    tab.style.cssText = `
      padding:6px 12px;border-radius:5px 5px 0 0;cursor:pointer;font-size:12px;font-weight:600;
      background:${td.id === activeTab ? "#0e7490" : "transparent"};
      color:${td.id === activeTab ? "#fff" : "#94a3b8"};
      border:1px solid ${td.id === activeTab ? "#0e7490" : "transparent"};
      border-bottom:none;
    `;
    tab.onclick = () => {
      activeTab = td.id;
      openViewToolsManager();
    };
    tabs.appendChild(tab);
  }
  card.appendChild(tabs);

  // ── Content ───────────────────────────────────────────────────────────
  const content = document.createElement("div");
  content.style.cssText = "flex:1;overflow-y:auto;padding:12px 18px";
  if (activeTab === "scope") renderScopeBoxes(content);
  else if (activeTab === "filters") renderFilters(content);
  else renderCropRegions(content);
  card.appendChild(content);

  ov.appendChild(card);
  ov.style.display = "flex";
}

function renderScopeBoxes(host: HTMLElement): void {
  const list = listScopeBoxes();
  if (!list.length) {
    host.innerHTML = `<div style="color:#64748b;text-align:center;padding:30px">No scope boxes yet. Click "Scope Box" in the View tab to create one.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const sb of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #242734";
    const info = document.createElement("div");
    info.style.flex = "1";
    info.innerHTML = `
      <div style="font-weight:600;color:#e8eaf0">${escapeHtml(sb.name)}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">
        ${sb.id} ·
        ${(sb.max.x - sb.min.x).toFixed(1)}×${(sb.max.y - sb.min.y).toFixed(1)}×${(sb.max.z - sb.min.z).toFixed(1)} m ·
        applied to ${sb.appliedToViews.length} view(s)
      </div>
    `;
    row.appendChild(info);
    // Edit button
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.style.cssText = btnStyle(false);
    edit.onclick = async () => {
      const r = await openFormModal({
        title: "Edit Scope Box",
        subtitle: sb.id,
        fields: [
          { kind: "text", key: "name", label: "Name", default: sb.name },
          { kind: "number", key: "minX", label: "Min X", default: sb.min.x, unit: "m", step: 0.1 },
          { kind: "number", key: "minY", label: "Min Y", default: sb.min.y, unit: "m", step: 0.1 },
          { kind: "number", key: "minZ", label: "Min Z", default: sb.min.z, unit: "m", step: 0.1 },
          { kind: "number", key: "maxX", label: "Max X", default: sb.max.x, unit: "m", step: 0.1 },
          { kind: "number", key: "maxY", label: "Max Y", default: sb.max.y, unit: "m", step: 0.1 },
          { kind: "number", key: "maxZ", label: "Max Z", default: sb.max.z, unit: "m", step: 0.1 },
        ],
      });
      if (!r) return;
      updateScopeBox(sb.id, {
        name: String(r.name),
        min: { x: r.minX, y: r.minY, z: r.minZ },
        max: { x: r.maxX, y: r.maxY, z: r.maxZ },
      });
      (window as any).__obsScopeBoxViz?.refresh?.();
      openViewToolsManager();
    };
    row.appendChild(edit);
    // Delete button
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.style.cssText = btnStyle(true, true);
    del.onclick = async () => {
      if (await confirmDialog("Delete scope box", `Delete "${sb.name}"? This cannot be undone.`)) {
        deleteScopeBox(sb.id);
        (window as any).__obsScopeBoxViz?.refresh?.();
        openViewToolsManager();
      }
    };
    row.appendChild(del);
    host.appendChild(row);
  }
}

function renderFilters(host: HTMLElement): void {
  const list = listViewFilters();
  if (!list.length) {
    host.innerHTML = `<div style="color:#64748b;text-align:center;padding:30px">No view filters yet. Use "Create Filter" in the View tab to add one.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const vf of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #242734";
    const info = document.createElement("div");
    info.style.flex = "1";
    const colorChip = `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#${(vf.overrides.projectionColor ?? 0).toString(16).padStart(6, "0")};vertical-align:middle;margin-right:4px"></span>`;
    info.innerHTML = `
      <div style="font-weight:600;color:#e8eaf0">${colorChip}${escapeHtml(vf.name)}</div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">
        ${vf.id} · categories: ${vf.categories.join(", ") || "(any)"} ·
        ${vf.rules.length} rule(s)
      </div>
    `;
    row.appendChild(info);
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.style.cssText = btnStyle(true, true);
    del.onclick = async () => {
      if (await confirmDialog("Delete filter", `Delete "${vf.name}"?`)) {
        deleteViewFilter(vf.id);
        openViewToolsManager();
      }
    };
    row.appendChild(del);
    host.appendChild(row);
  }
}

function renderCropRegions(host: HTMLElement): void {
  const list = listCropRegions();
  if (!list.length) {
    host.innerHTML = `<div style="color:#64748b;text-align:center;padding:30px">No crop regions yet. Use "Toggle" in the View tab → Crop View group to create one.</div>`;
    return;
  }
  host.innerHTML = "";
  for (const cr of list) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #242734";
    const info = document.createElement("div");
    info.style.flex = "1";
    const sizeX = (cr.maxX - cr.minX).toFixed(1);
    const sizeY = (cr.maxY - cr.minY).toFixed(1);
    info.innerHTML = `
      <div style="font-weight:600;color:#e8eaf0">${escapeHtml(cr.viewId)}
        <span style="font-size:11px;color:${cr.enabled ? "#22c55e" : "#94a3b8"};font-weight:normal;margin-left:8px">${cr.enabled ? "● enabled" : "○ disabled"}</span>
      </div>
      <div style="font-size:11px;color:#94a3b8;margin-top:2px">
        ${sizeX}×${sizeY} m · center (${(cr.minX + cr.maxX) / 2}, ${(cr.minY + cr.maxY) / 2})
      </div>
    `;
    row.appendChild(info);
    const edit = document.createElement("button");
    edit.textContent = "Edit";
    edit.style.cssText = btnStyle(false);
    edit.onclick = async () => {
      const r = await openFormModal({
        title: "Edit Crop Region",
        subtitle: cr.viewId,
        fields: [
          { kind: "number", key: "minX", label: "Min X", default: cr.minX, unit: "m", step: 0.1 },
          { kind: "number", key: "maxX", label: "Max X", default: cr.maxX, unit: "m", step: 0.1 },
          { kind: "number", key: "minY", label: "Min Y", default: cr.minY, unit: "m", step: 0.1 },
          { kind: "number", key: "maxY", label: "Max Y", default: cr.maxY, unit: "m", step: 0.1 },
          { kind: "checkbox", key: "enabled", label: "Enabled", default: cr.enabled },
        ],
      });
      if (!r) return;
      setCropRegion(cr.viewId, { minX: r.minX, maxX: r.maxX, minY: r.minY, maxY: r.maxY, enabled: r.enabled });
      openViewToolsManager();
    };
    row.appendChild(edit);
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.style.cssText = btnStyle(true, true);
    del.onclick = async () => {
      if (await confirmDialog("Delete crop region", `Delete crop region for "${cr.viewId}"?`)) {
        deleteCropRegion(cr.viewId);
        openViewToolsManager();
      }
    };
    row.appendChild(del);
    host.appendChild(row);
  }
}

function btnStyle(primary: boolean, danger = false): string {
  if (danger) {
    return `
      padding:5px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;
      background:transparent;color:#f87171;border:1px solid #7f1d1d;
    `;
  }
  return `
    padding:5px 12px;border-radius:5px;cursor:pointer;font-size:12px;font-weight:600;
    background:${primary ? "#0e7490" : "transparent"};
    color:${primary ? "#fff" : "#94a3b8"};
    border:1px solid ${primary ? "#0e7490" : "#2a2e3a"};
  `;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function setupViewToolsManager(): void {
  (window as any).__obsOpenViewToolsManager = openViewToolsManager;
  console.log("[view-tools-manager] ready — accessible via window.__obsOpenViewToolsManager()");
}
