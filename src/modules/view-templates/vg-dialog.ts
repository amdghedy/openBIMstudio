/**
 * Visibility/Graphics dialog – Fluent light UI (Revit VG parity).
 * Opens via Command Center, palette, or Ctrl+Shift+V.
 */

import {
  STANDARD_CATEGORIES,
  defaultCategoryOverride,
  type CategoryGraphicOverride,
  type VisibilityGraphicsState,
  type ViewTemplate,
  createDefaultVg,
} from "./types";
import { viewTemplatesStore } from "./view-templates-store";

type Any = Record<string, any>;

const TOKENS = {
  BgBrush: "#F3F3F3",
  SurfaceBrush: "#FFFFFF",
  AccentBrush: "#0078D4",
  AccentHover: "#106EBE",
  TextBrush: "#201F1E",
  TextMutedBrush: "#605E5C",
  BorderBrush: "#E1DFDD",
  SuccessBrush: "#107C10",
  WarningBrush: "#FFB900",
  ErrorBrush: "#D13438",
  Radius: "8px",
  Font: '"Segoe UI", system-ui, -apple-system, sans-serif',
};

let root: HTMLDivElement | null = null;
let styleInjected = false;
let currentViewId: string | null = null;
let editingTemplateId: string | null = null;
let draftVg: VisibilityGraphicsState = createDefaultVg();
let activeTab: "model" | "annotation" | "filters" | "options" = "model";

function injectCss(): void {
  if (styleInjected) return;
  styleInjected = true;
  const s = document.createElement("style");
  s.id = "obs-vg-dialog-css";
  s.textContent = `
#obs-vg-dialog-overlay {
  position: fixed; inset: 0; z-index: 9200;
  background: rgba(0,0,0,.28);
  display: none; align-items: center; justify-content: center;
  font-family: ${TOKENS.Font};
}
#obs-vg-dialog-overlay.is-open { display: flex; }
#obs-vg-dialog {
  width: min(920px, 96vw); max-height: min(780px, 92vh);
  background: ${TOKENS.SurfaceBrush}; color: ${TOKENS.TextBrush};
  border-radius: 12px; border: 1px solid ${TOKENS.BorderBrush};
  box-shadow: 0 16px 48px rgba(0,0,0,.18), 0 2px 8px rgba(0,0,0,.08);
  display: flex; flex-direction: column; overflow: hidden;
}
#obs-vg-dialog .vg-hdr {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 18px; border-bottom: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.BgBrush};
}
#obs-vg-dialog .vg-hdr h2 {
  margin: 0; font-size: 16px; font-weight: 600; flex: 1;
  letter-spacing: -0.01em;
}
#obs-vg-dialog .vg-hdr .vg-sub {
  font-size: 12px; color: ${TOKENS.TextMutedBrush}; font-weight: 400;
}
#obs-vg-dialog .vg-close {
  width: 32px; height: 32px; border-radius: 6px; border: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.SurfaceBrush}; color: ${TOKENS.TextMutedBrush};
  cursor: pointer; font-size: 16px; display: flex; align-items: center; justify-content: center;
}
#obs-vg-dialog .vg-close:hover { background: #EDEBE9; color: ${TOKENS.TextBrush}; }
#obs-vg-dialog .vg-tabs {
  display: flex; gap: 0; padding: 0 18px;
  border-bottom: 1px solid ${TOKENS.BorderBrush}; background: ${TOKENS.SurfaceBrush};
}
#obs-vg-dialog .vg-tab {
  padding: 10px 16px; border: none; background: transparent;
  font: 600 13px ${TOKENS.Font}; color: ${TOKENS.TextMutedBrush};
  cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
#obs-vg-dialog .vg-tab:hover { color: ${TOKENS.TextBrush}; }
#obs-vg-dialog .vg-tab.active {
  color: ${TOKENS.AccentBrush}; border-bottom-color: ${TOKENS.AccentBrush};
}
#obs-vg-dialog .vg-body {
  flex: 1; overflow: auto; padding: 16px 18px; background: ${TOKENS.BgBrush};
}
#obs-vg-dialog .vg-toolbar {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin-bottom: 12px;
}
#obs-vg-dialog .vg-btn {
  height: 32px; padding: 0 14px; border-radius: 6px;
  border: 1px solid ${TOKENS.BorderBrush}; background: ${TOKENS.SurfaceBrush};
  font: 600 12px ${TOKENS.Font}; color: ${TOKENS.TextBrush}; cursor: pointer;
}
#obs-vg-dialog .vg-btn:hover { background: #EDEBE9; }
#obs-vg-dialog .vg-btn.primary {
  background: ${TOKENS.AccentBrush}; color: #fff; border-color: ${TOKENS.AccentBrush};
}
#obs-vg-dialog .vg-btn.primary:hover { background: ${TOKENS.AccentHover}; }
#obs-vg-dialog .vg-btn.danger { color: ${TOKENS.ErrorBrush}; }
#obs-vg-dialog select, #obs-vg-dialog input[type="text"] {
  height: 32px; padding: 0 10px; border-radius: 6px;
  border: 1px solid ${TOKENS.BorderBrush}; background: ${TOKENS.SurfaceBrush};
  font: 400 12px ${TOKENS.Font}; color: ${TOKENS.TextBrush};
}
#obs-vg-dialog table.vg-table {
  width: 100%; border-collapse: collapse; background: ${TOKENS.SurfaceBrush};
  border: 1px solid ${TOKENS.BorderBrush}; border-radius: 8px; overflow: hidden;
}
#obs-vg-dialog table.vg-table th {
  text-align: left; padding: 8px 10px; font: 600 11px ${TOKENS.Font};
  color: ${TOKENS.TextMutedBrush}; background: #FAF9F8;
  border-bottom: 1px solid ${TOKENS.BorderBrush}; text-transform: uppercase;
  letter-spacing: 0.04em;
}
#obs-vg-dialog table.vg-table td {
  padding: 6px 10px; border-bottom: 1px solid ${TOKENS.BorderBrush};
  font: 400 12px ${TOKENS.Font}; vertical-align: middle;
}
#obs-vg-dialog table.vg-table tr:last-child td { border-bottom: none; }
#obs-vg-dialog table.vg-table tr:hover td { background: #F9F9F8; }
#obs-vg-dialog .vg-check {
  width: 16px; height: 16px; accent-color: ${TOKENS.AccentBrush}; cursor: pointer;
}
#obs-vg-dialog .vg-group-hdr {
  font: 700 11px ${TOKENS.Font}; color: ${TOKENS.TextMutedBrush};
  text-transform: uppercase; letter-spacing: 0.05em;
  padding: 10px 0 6px; margin-top: 4px;
}
#obs-vg-dialog .vg-footer {
  display: flex; gap: 8px; justify-content: flex-end; align-items: center;
  padding: 12px 18px; border-top: 1px solid ${TOKENS.BorderBrush};
  background: ${TOKENS.SurfaceBrush};
}
#obs-vg-dialog .vg-card {
  background: ${TOKENS.SurfaceBrush}; border: 1px solid ${TOKENS.BorderBrush};
  border-radius: ${TOKENS.Radius}; padding: 14px; margin-bottom: 12px;
}
#obs-vg-dialog .vg-row {
  display: flex; gap: 12px; align-items: center; margin-bottom: 10px; flex-wrap: wrap;
}
#obs-vg-dialog .vg-row label { font: 600 12px ${TOKENS.Font}; min-width: 110px; }
#obs-vg-dialog .vg-hint {
  font-size: 11px; color: ${TOKENS.TextMutedBrush}; margin-top: 4px;
}
`;
  document.head.appendChild(s);
}

function ensureRoot(): HTMLDivElement {
  if (root) return root;
  injectCss();
  root = document.createElement("div");
  root.id = "obs-vg-dialog-overlay";
  root.innerHTML = `<div id="obs-vg-dialog" role="dialog" aria-modal="true" aria-label="Visibility Graphics"></div>`;
  root.addEventListener("click", (e) => {
    if (e.target === root) closeVgDialog();
  });
  document.body.appendChild(root);
  return root;
}

function notify(kind: "info" | "success" | "warning" | "error", message: string): void {
  try {
    const n = (window as Any).__obsNotify ?? (window as Any).notify;
    if (typeof n === "function") {
      n(kind, message, { timeout: 3200 });
      return;
    }
  } catch { /* */ }
  console.log(`[vg-dialog] ${kind}: ${message}`);
}

function getCategoryOverride(cat: string): CategoryGraphicOverride {
  return (
    draftVg.categoryOverrides[cat] ?? defaultCategoryOverride()
  );
}

function setCategoryOverride(cat: string, patch: Partial<CategoryGraphicOverride>): void {
  const cur = getCategoryOverride(cat);
  draftVg.categoryOverrides[cat] = { ...cur, ...patch };
}

function renderCategoryTable(groups: string[]): string {
  const byGroup = new Map<string, typeof STANDARD_CATEGORIES>();
  for (const c of STANDARD_CATEGORIES) {
    if (!groups.includes(c.group)) continue;
    if (!byGroup.has(c.group)) byGroup.set(c.group, []);
    byGroup.get(c.group)!.push(c);
  }
  let html = "";
  for (const [group, cats] of byGroup) {
    html += `<div class="vg-group-hdr">${group}</div>`;
    html += `<table class="vg-table"><thead><tr>
      <th style="width:28px">Vis</th>
      <th>Category</th>
      <th style="width:70px">Halftone</th>
      <th style="width:80px">Transparent</th>
    </tr></thead><tbody>`;
    for (const c of cats) {
      const ov = getCategoryOverride(c.id);
      html += `<tr data-cat="${c.id}">
        <td><input class="vg-check" type="checkbox" data-field="visible" ${ov.visible ? "checked" : ""}/></td>
        <td>${c.label}</td>
        <td><input class="vg-check" type="checkbox" data-field="halftone" ${ov.halftone ? "checked" : ""}/></td>
        <td><input class="vg-check" type="checkbox" data-field="transparent" ${ov.transparent ? "checked" : ""}/></td>
      </tr>`;
    }
    html += `</tbody></table>`;
  }
  return html;
}

function renderFiltersTab(): string {
  const rows = (draftVg.filters || [])
    .map(
      (f, i) => `<tr data-filter-idx="${i}">
      <td><input class="vg-check" type="checkbox" data-ffield="enabled" ${f.enabled ? "checked" : ""}/></td>
      <td>${escapeHtml(f.name)}</td>
      <td>${escapeHtml(f.category)}</td>
      <td>${escapeHtml(f.parameter)} ${f.operator} ${escapeHtml(String(f.value))}</td>
      <td>${f.hide ? "Hide" : "Override"}</td>
      <td><button class="vg-btn" data-act="del-filter" style="height:26px;padding:0 8px">✕</button></td>
    </tr>`
    )
    .join("");
  return `
    <div class="vg-toolbar">
      <button class="vg-btn primary" data-act="add-filter">+ Add Filter</button>
      <span class="vg-hint">Filters run after category visibility. Order = top to bottom.</span>
    </div>
    <table class="vg-table">
      <thead><tr>
        <th style="width:28px">On</th><th>Name</th><th>Category</th><th>Rule</th><th>Action</th><th style="width:40px"></th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="6" style="color:${TOKENS.TextMutedBrush};padding:16px">No filters defined.</td></tr>`}</tbody>
    </table>`;
}

function renderOptionsTab(): string {
  return `
    <div class="vg-card">
      <div class="vg-row">
        <label>Detail Level</label>
        <select data-opt="detailLevel">
          <option value="coarse" ${draftVg.detailLevel === "coarse" ? "selected" : ""}>Coarse</option>
          <option value="medium" ${draftVg.detailLevel === "medium" ? "selected" : ""}>Medium</option>
          <option value="fine" ${draftVg.detailLevel === "fine" ? "selected" : ""}>Fine</option>
        </select>
      </div>
      <div class="vg-row">
        <label>Model Display</label>
        <select data-opt="modelDisplay">
          <option value="wireframe" ${draftVg.modelDisplay === "wireframe" ? "selected" : ""}>Wireframe</option>
          <option value="hiddenLine" ${draftVg.modelDisplay === "hiddenLine" ? "selected" : ""}>Hidden Line</option>
          <option value="shaded" ${draftVg.modelDisplay === "shaded" ? "selected" : ""}>Shaded</option>
          <option value="realistic" ${draftVg.modelDisplay === "realistic" ? "selected" : ""}>Realistic</option>
        </select>
      </div>
      <div class="vg-row">
        <label>Show Model</label>
        <input class="vg-check" type="checkbox" data-opt="showModel" ${draftVg.showModel ? "checked" : ""}/>
      </div>
      <div class="vg-row">
        <label>Show Annotations</label>
        <input class="vg-check" type="checkbox" data-opt="showAnnotations" ${draftVg.showAnnotations ? "checked" : ""}/>
      </div>
    </div>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBody(): void {
  const dialog = document.getElementById("obs-vg-dialog");
  if (!dialog) return;

  const templates = viewTemplatesStore.listTemplates();
  const tmplOptions = templates
    .map(
      (t) =>
        `<option value="${t.id}" ${editingTemplateId === t.id ? "selected" : ""}>${escapeHtml(t.name)}</option>`
    )
    .join("");

  let tabContent = "";
  if (activeTab === "model") {
    tabContent = renderCategoryTable(["Architecture", "Structure", "MEP", "Spatial", "Model"]);
  } else if (activeTab === "annotation") {
    tabContent = renderCategoryTable(["Annotation"]);
  } else if (activeTab === "filters") {
    tabContent = renderFiltersTab();
  } else {
    tabContent = renderOptionsTab();
  }

  const title = editingTemplateId
    ? `Edit Template`
    : currentViewId
      ? `Visibility/Graphics — View`
      : `Visibility/Graphics`;

  dialog.innerHTML = `
    <div class="vg-hdr">
      <div style="flex:1">
        <h2>${title}</h2>
        <div class="vg-sub">${editingTemplateId ? "Changes save to the template" : currentViewId ? `View: ${escapeHtml(currentViewId)}` : "Local overrides"}</div>
      </div>
      <button class="vg-close" data-act="close" title="Close">✕</button>
    </div>
    <div class="vg-toolbar" style="padding:10px 18px 0;background:${TOKENS.SurfaceBrush};border-bottom:1px solid ${TOKENS.BorderBrush}">
      <label style="font:600 12px ${TOKENS.Font}">Template</label>
      <select id="vg-template-select" style="min-width:180px">
        <option value="">— None —</option>
        ${tmplOptions}
      </select>
      <button class="vg-btn" data-act="apply-template">Apply to View</button>
      <button class="vg-btn" data-act="save-as-template">Save as Template…</button>
      <button class="vg-btn" data-act="edit-template">Edit Selected Template</button>
      <button class="vg-btn danger" data-act="delete-template">Delete Template</button>
    </div>
    <div class="vg-tabs">
      <button class="vg-tab ${activeTab === "model" ? "active" : ""}" data-tab="model">Model Categories</button>
      <button class="vg-tab ${activeTab === "annotation" ? "active" : ""}" data-tab="annotation">Annotation</button>
      <button class="vg-tab ${activeTab === "filters" ? "active" : ""}" data-tab="filters">Filters</button>
      <button class="vg-tab ${activeTab === "options" ? "active" : ""}" data-tab="options">Options</button>
    </div>
    <div class="vg-body">${tabContent}</div>
    <div class="vg-footer">
      <button class="vg-btn" data-act="reset">Reset to Defaults</button>
      <div style="flex:1"></div>
      <button class="vg-btn" data-act="close">Cancel</button>
      <button class="vg-btn primary" data-act="apply">Apply</button>
      <button class="vg-btn primary" data-act="ok">OK</button>
    </div>`;

  wireEvents(dialog);
}

function wireEvents(dialog: HTMLElement): void {
  dialog.querySelectorAll("[data-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      activeTab = (el as HTMLElement).dataset.tab as typeof activeTab;
      renderBody();
    });
  });

  dialog.querySelectorAll("tr[data-cat]").forEach((tr) => {
    const cat = (tr as HTMLElement).dataset.cat!;
    tr.querySelectorAll("input[data-field]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const field = (inp as HTMLInputElement).dataset.field!;
        const checked = (inp as HTMLInputElement).checked;
        setCategoryOverride(cat, { [field]: checked } as any);
      });
    });
  });

  dialog.querySelectorAll("[data-opt]").forEach((el) => {
    el.addEventListener("change", () => {
      const key = (el as HTMLElement).dataset.opt!;
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        (draftVg as any)[key] = el.checked;
      } else if (el instanceof HTMLSelectElement) {
        (draftVg as any)[key] = el.value;
      }
    });
  });

  dialog.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const act = (btn as HTMLElement).dataset.act;
      handleAction(act || "");
    });
  });

  dialog.querySelectorAll("[data-act=del-filter]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const tr = (btn as HTMLElement).closest("tr[data-filter-idx]");
      if (!tr) return;
      const idx = Number((tr as HTMLElement).dataset.filterIdx);
      draftVg.filters.splice(idx, 1);
      renderBody();
    });
  });

  const sel = dialog.querySelector("#vg-template-select") as HTMLSelectElement | null;
  if (sel) {
    sel.addEventListener("change", () => {
      // selection only; apply is explicit
    });
  }
}

function handleAction(act: string): void {
  const sel = document.getElementById("vg-template-select") as HTMLSelectElement | null;
  const selectedTmpl = sel?.value || null;

  switch (act) {
    case "close":
      closeVgDialog();
      break;
    case "reset":
      draftVg = createDefaultVg();
      renderBody();
      notify("info", "Reset to default Visibility/Graphics");
      break;
    case "apply":
    case "ok":
      commitDraft();
      if (act === "ok") closeVgDialog();
      else notify("success", "Visibility/Graphics applied");
      break;
    case "apply-template":
      if (!selectedTmpl) {
        notify("warning", "Select a template first");
        return;
      }
      if (!currentViewId) {
        notify("warning", "No active view to apply template to");
        return;
      }
      viewTemplatesStore.applyTemplateToViews(selectedTmpl, [currentViewId], true);
      draftVg = viewTemplatesStore.getEffectiveVg(currentViewId);
      viewTemplatesStore.syncToVisibilityFilter(currentViewId);
      renderBody();
      notify("success", "Template applied to view");
      break;
    case "save-as-template": {
      const name = window.prompt("Template name", "New View Template");
      if (!name) return;
      const t = viewTemplatesStore.createTemplate({
        name: name.trim(),
        vg: draftVg,
        appliesTo: ["plan", "section", "elevation", "3d", "ceiling"],
      });
      editingTemplateId = t.id;
      notify("success", `Template “${t.name}” created`);
      renderBody();
      break;
    }
    case "edit-template":
      if (!selectedTmpl) {
        notify("warning", "Select a template first");
        return;
      }
      editingTemplateId = selectedTmpl;
      const tmpl = viewTemplatesStore.getTemplate(selectedTmpl);
      if (tmpl) draftVg = JSON.parse(JSON.stringify(tmpl.vg));
      renderBody();
      break;
    case "delete-template":
      if (!selectedTmpl) {
        notify("warning", "Select a template first");
        return;
      }
      if (!window.confirm("Delete this view template?")) return;
      viewTemplatesStore.deleteTemplate(selectedTmpl);
      if (editingTemplateId === selectedTmpl) editingTemplateId = null;
      notify("info", "Template deleted");
      renderBody();
      break;
    case "add-filter": {
      const name = window.prompt("Filter name", "New Filter");
      if (!name) return;
      draftVg.filters.push({
        id: `flt_${Date.now().toString(36)}`,
        name: name.trim(),
        category: "Walls",
        parameter: "Type Name",
        operator: "contains",
        value: "",
        hide: true,
        enabled: true,
      });
      renderBody();
      break;
    }
    default:
      break;
  }
}

function commitDraft(): void {
  if (editingTemplateId) {
    viewTemplatesStore.updateTemplate(editingTemplateId, { vg: draftVg });
    notify("success", "Template updated");
  }
  if (currentViewId) {
    if (editingTemplateId) {
      // already updated template; re-sync view if it uses this template
      const b = viewTemplatesStore.getViewBinding(currentViewId);
      if (b.templateId === editingTemplateId) {
        viewTemplatesStore.setViewLocalVg(currentViewId, null);
      }
    } else {
      viewTemplatesStore.setViewLocalVg(currentViewId, draftVg);
    }
    viewTemplatesStore.syncToVisibilityFilter(currentViewId);
  }
  // Broadcast so views / 3D can refresh
  try {
    window.dispatchEvent(
      new CustomEvent("obs:vg-changed", {
        detail: { viewId: currentViewId, templateId: editingTemplateId },
      })
    );
  } catch { /* */ }
}

export function openVgDialog(opts?: {
  viewId?: string | null;
  templateId?: string | null;
}): void {
  ensureRoot();
  currentViewId = opts?.viewId ?? detectActiveViewId();
  editingTemplateId = opts?.templateId ?? null;

  if (editingTemplateId) {
    const t = viewTemplatesStore.getTemplate(editingTemplateId);
    draftVg = t ? JSON.parse(JSON.stringify(t.vg)) : createDefaultVg();
  } else if (currentViewId) {
    draftVg = viewTemplatesStore.getEffectiveVg(currentViewId);
  } else {
    draftVg = createDefaultVg();
  }

  activeTab = "model";
  renderBody();
  root!.classList.add("is-open");
}

export function closeVgDialog(): void {
  if (root) root.classList.remove("is-open");
}

function detectActiveViewId(): string | null {
  try {
    const c = (window as Any).__OBS_CTX__ ?? (window as Any).ctx;
    const v = c?.views?.active ?? c?.activeView ?? c?.view;
    if (v?.id) return String(v.id);
    if (typeof v === "string") return v;
  } catch { /* */ }
  return "default";
}

export function setupVgDialog(): void {
  ensureRoot();
  // Keyboard: Ctrl+Shift+V
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
      e.preventDefault();
      openVgDialog();
    }
  });
  (window as Any).__obsOpenVgDialog = openVgDialog;
  console.log("[view-templates] VG dialog ready — Ctrl+Shift+V");
}
