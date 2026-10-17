/**
 * Sheets panel — production documentation UI.
 * Create sheets, place viewports, export SVG for print/PDF workflows.
 */
import {
  listSheets,
  createSheet,
  updateSheet,
  deleteSheet,
  addViewport,
  removeViewport,
  exportSheetSvg,
  createDefaultSheetSet,
  ensureDefaultTitleblock,
  onSheetsChange,
  getSheetSizeMm,
} from "../modules/sheets/sheets";
import type { SheetDef } from "../modules/projects/types";

let panel: HTMLElement | null = null;
let visible = false;
let activeId: string | null = null;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function render() {
  if (!panel) return;
  const sheets = listSheets();
  const active = sheets.find((s) => s.id === activeId) ?? sheets[0] ?? null;
  if (active) activeId = active.id;

  panel.innerHTML = `
    <div class="obs-panel-header">
      <span>Sheets · Production</span>
      <button type="button" class="obs-icon-btn" data-act="close">×</button>
    </div>
    <div class="obs-panel-body obs-sheets">
      <div class="obs-sheets__hint">
        Professional drawing sheets with titleblocks. Place plans, export SVG for print or PDF.
        Competes with BIM / Bentley sheet production.
      </div>
      <div class="obs-sheets__toolbar">
        <button type="button" data-act="new">+ Sheet</button>
        <button type="button" data-act="defaults">Default set</button>
        <button type="button" data-act="export" ${active ? "" : "disabled"}>Export SVG</button>
      </div>
      <div class="obs-sheets__list">
        ${sheets.length === 0
          ? `<div class="obs-sheets__empty">No sheets. Create one or load the default set.</div>`
          : sheets.map((s) => `
            <div class="obs-sheets__row ${s.id === activeId ? "is-active" : ""}" data-id="${esc(s.id)}" data-act="select">
              <span class="obs-sheets__no">${esc(s.number)}</span>
              <span class="obs-sheets__name">${esc(s.name)}</span>
              <span class="obs-sheets__meta">${s.size} · ${s.viewports.length} vp</span>
              <button type="button" data-act="del" data-id="${esc(s.id)}" title="Delete">×</button>
            </div>`).join("")}
      </div>
      ${active ? renderActive(active) : ""}
    </div>
  `;

  panel.querySelectorAll("[data-act]").forEach((el) => {
    const act = (el as HTMLElement).dataset.act!;
    const id = (el as HTMLElement).dataset.id;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (act === "close") { setVisible(false); return; }
      if (act === "new") {
        const s = createSheet();
        activeId = s.id;
        render();
        return;
      }
      if (act === "defaults") { createDefaultSheetSet(); render(); return; }
      if (act === "export" && activeId) { exportSheetSvg(activeId); return; }
      if (act === "select" && id) { activeId = id; render(); return; }
      if (act === "del" && id) {
        if (confirm("Delete this sheet?")) {
          deleteSheet(id);
          if (activeId === id) activeId = null;
          render();
        }
        return;
      }
      if (act === "add-vp" && activeId) {
        const size = getSheetSizeMm(active!.size, active!.orientation);
        addViewport(activeId, {
          viewId: "plan-current",
          viewType: "plan",
          x: 20,
          y: 20,
          width: Math.min(400, size.w - 40),
          height: Math.min(280, size.h - 80),
          scale: "1:100",
          title: "Plan View",
        });
        render();
        return;
      }
      if (act === "rename" && activeId) {
        const name = prompt("Sheet name", active!.name);
        if (name != null) updateSheet(activeId, { name: name.trim() || active!.name });
        render();
        return;
      }
      if (act === "renumber" && activeId) {
        const number = prompt("Sheet number", active!.number);
        if (number != null) updateSheet(activeId, { number: number.trim() || active!.number });
        render();
        return;
      }
    });
  });
}

function renderActive(s: SheetDef) {
  return `
    <div class="obs-sheets__detail">
      <div class="obs-sheets__detail-head">
        <strong>${esc(s.number)}</strong>
        <button type="button" data-act="renumber">No.</button>
        <button type="button" data-act="rename">Name</button>
      </div>
      <div class="obs-sheets__detail-name">${esc(s.name)}</div>
      <div class="obs-sheets__detail-meta">${s.size} · ${s.orientation} · ${s.viewports.length} viewports</div>
      <button type="button" data-act="add-vp" class="obs-sheets__add-vp">+ Place plan viewport</button>
      <ul class="obs-sheets__vps">
        ${s.viewports.map((v) => `
          <li>${esc(v.title ?? v.viewType)} · ${esc(v.scale)}
            <button type="button" data-act="rm-vp" data-vpid="${esc(v.id)}">×</button>
          </li>`).join("")}
      </ul>
    </div>
  `;
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-side-panel obs-sheets-panel";
  panel.style.cssText =
    "position:fixed;top:48px;right:12px;width:360px;max-height:calc(100vh - 80px);" +
    "background:#1e2430;color:#e2e8f0;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.45);z-index:8000;display:none;overflow:auto;" +
    "font:13px/1.4 system-ui,sans-serif;";
  document.body.appendChild(panel);

  const style = document.createElement("style");
  style.textContent = `
    .obs-sheets__hint { font-size:11px; color:#94a3b8; margin-bottom:10px; }
    .obs-sheets__toolbar { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
    .obs-sheets__toolbar button {
      background:#334155; border:1px solid #475569; color:#e2e8f0; border-radius:6px;
      padding:5px 10px; cursor:pointer; font-size:12px;
    }
    .obs-sheets__toolbar button:hover { background:#475569; }
    .obs-sheets__toolbar button:disabled { opacity:.4; cursor:default; }
    .obs-sheets__row {
      display:flex; align-items:center; gap:8px; padding:8px 10px; border-radius:6px;
      cursor:pointer; border:1px solid transparent;
    }
    .obs-sheets__row:hover { background:#0f172a; }
    .obs-sheets__row.is-active { background:#0f172a; border-color:#3b82f6; }
    .obs-sheets__no { font-weight:600; min-width:52px; color:#93c5fd; }
    .obs-sheets__name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .obs-sheets__meta { font-size:11px; color:#64748b; }
    .obs-sheets__empty { color:#64748b; text-align:center; padding:16px 0; font-size:12px; }
    .obs-sheets__detail {
      margin-top:12px; padding:12px; background:#0f172a; border-radius:8px; border:1px solid #334155;
    }
    .obs-sheets__detail-head { display:flex; gap:6px; align-items:center; margin-bottom:4px; }
    .obs-sheets__detail-head button {
      background:#1e293b; border:1px solid #334155; color:#94a3b8; border-radius:4px;
      padding:2px 6px; font-size:11px; cursor:pointer;
    }
    .obs-sheets__detail-name { font-size:14px; margin-bottom:2px; }
    .obs-sheets__detail-meta { font-size:11px; color:#64748b; margin-bottom:10px; }
    .obs-sheets__add-vp {
      width:100%; background:#1d4ed8; border:none; color:#fff; border-radius:6px;
      padding:7px; cursor:pointer; font-size:12px; margin-bottom:8px;
    }
    .obs-sheets__add-vp:hover { background:#2563eb; }
    .obs-sheets__vps { list-style:none; margin:0; padding:0; font-size:12px; }
    .obs-sheets__vps li { display:flex; justify-content:space-between; padding:4px 0; color:#cbd5e1; }
    .obs-panel-header {
      display:flex; justify-content:space-between; align-items:center;
      padding:10px 12px; border-bottom:1px solid #334155; font-weight:600;
    }
    .obs-panel-body { padding:12px; }
    .obs-icon-btn { background:none; border:none; color:#94a3b8; font-size:18px; cursor:pointer; }
  `;
  document.head.appendChild(style);
  onSheetsChange(render);
  ensureDefaultTitleblock();
  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  const el = ensurePanel();
  el.style.display = on ? "block" : "none";
  if (on) render();
}

export function toggleSheetsPanel() {
  setVisible(!visible);
}

export function isSheetsPanelVisible() {
  return visible;
}

export function setupSheetsPanel() {
  ensurePanel();
}
