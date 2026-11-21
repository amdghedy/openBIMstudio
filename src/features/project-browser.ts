/**
 * Project Browser — Industry-standard project organization panel.
 *
 * Hierarchy (Revit order, audit G11):
 *   Views (all)          → Floor Plans / Ceiling Plans / Elevations /
 *                           Sections / 3D Views / … / Saved Views
 *   Sheets (all)         → production sheets
 *   Schedules/Quantities → schedule templates (+ schedule-kind views)
 *   Families             → family types + Materials
 *   Groups               → selection sets
 *   Models & Links       → federated IFC / FRAG / aux
 *   4D Phases            → construction phases
 *
 * The tree itself lives in ./project-browser-tree (pure, DOM-free, node
 * tested); this file gathers the data and owns the panel DOM, including
 * the as-you-type filter textbox.
 *
 * Professional dark UI, expandable tree, double-click to open,
 * right-click actions. Competes with BIM Project Browser presentation.
 */
import { ctx } from "../core/context";
import { listSheets, createSheet, createDefaultSheetSet } from "../modules/sheets/sheets";
import { listMaterials, ensureDefaultMaterials } from "../modules/materials/materials";
import { listPhases, createDefaultPhases } from "../modules/timeline/timeline";
import { listSavedViews, restoreView, saveCurrentView } from "./saved-views";
import { bootViewsStore, listViews } from "../modules/views/store";
import {
  buildProjectBrowserTree,
  filterProjectBrowserTree,
  type ProjectBrowserNode,
  type ProjectBrowserNodeKind,
  type ProjectBrowserTreeInput,
} from "./project-browser-tree";
import { selection } from "./selection";
import { togglePlanView } from "./plan-view-panel";
import { toggleSchedules } from "./schedules-panel";
import { toggleSheetsPanel } from "./sheets-panel";
import { toggleTimelinePanel } from "./timeline-panel";
import { togglePropertyPalette, isPropertyPaletteVisible } from "./property-palette";
import { toggleModelTreePanel } from "./model-tree-panel";
import { openViewInPanel } from "./views-panel";
import { fitAll, goHome } from "./camera-tools";

type NodeKind = ProjectBrowserNodeKind;
type BrowserNode = ProjectBrowserNode;

let panel: HTMLElement | null = null;
let visible = false;
let expanded = new Set<string>(["views", "views-plan", "views-3d", "sheets", "schedules"]);
let selectedNodeId: string | null = null;
/** As-you-type filter text; empty means no filtering. */
let filterQuery = "";

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function buildTree(): BrowserNode[] {
  // Models / links
  const links: { id: string; label: string }[] = [];
  try {
    if (ctx.fragments?.list) {
      for (const [id, model] of ctx.fragments.list) {
        const name = (model as any)?.object?.name || (model as any)?.name || id;
        links.push({ id, label: String(name).split("/").pop() || id });
      }
    }
  } catch { /* */ }

  // Stored views (views module) — subgrouped by kind in the tree model.
  // bootViewsStore() is idempotent: it seeds the default plan / elevation /
  // section views on first run and re-reads persistence afterwards.
  try { bootViewsStore(); } catch { /* */ }
  let views: { id: string; kind: string; name: string }[] = [];
  try {
    views = listViews().map((v) => ({ id: v.id, kind: v.kind, name: v.name }));
  } catch { /* */ }

  // Family definitions + their types, via the family service installed at
  // boot (main.ts step "families"). If the service is not ready the
  // Families node still lists materials below.
  let families: ProjectBrowserTreeInput["families"] = [];
  try {
    const svc = (ctx.features as any)?.family;
    const defs = svc?.list?.() ?? [];
    families = defs.map((f: any) => ({
      id: String(f.id),
      name: String(f.name),
      types: (f.types ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name) })),
    }));
  } catch { /* */ }

  // Materials / families
  ensureDefaultMaterials();
  const mats = listMaterials().map((m) => ({ id: m.id, name: m.name }));

  // Selection sets as groups
  const groups: { id: string; name: string }[] = [];
  try {
    const sets = selection.listSets() ?? [];
    for (const s of sets) groups.push({ id: s.id, name: s.name });
  } catch { /* */ }

  // 4D phases
  const phases = listPhases().map((p) => ({
    id: p.id,
    name: p.name,
    elementCount: p.elementIds.length,
  }));

  return buildProjectBrowserTree({
    links,
    savedViews: listSavedViews().map((v) => ({ id: v.id, name: v.name })),
    sheets: listSheets().map((s) => ({ id: s.id, number: s.number, name: s.name })),
    materials: mats,
    families,
    groups,
    phases,
    views,
  });
}

function onActivate(node: BrowserNode) {
  selectedNodeId = node.id;
  try {
    switch (node.kind) {
      case "view-3d":
        goHome();
        fitAll();
        break;
      case "view-plan":
        togglePlanView();
        break;
      case "view-def":
        // Stored view (plan / section / elevation / …): open it in the
        // Views panel, selected and rendered.
        if (node.meta?.viewId) openViewInPanel(String(node.meta.viewId));
        break;
      case "view-group":
        // Intermediate subgroup: single click expands / collapses.
        if (expanded.has(node.id)) expanded.delete(node.id);
        else expanded.add(node.id);
        break;
      case "view-saved":
        if (node.meta?.viewId) restoreView(String(node.meta.viewId));
        break;
      case "schedule":
        if (node.id === "sch-cost") {
          import("./cost-panel").then((m) => m.toggleCostPanel()).catch(() => {});
        } else {
          toggleSchedules();
        }
        break;
      case "schedules":
        toggleSchedules();
        break;
      case "sheets":
      case "sheet":
        if (node.id === "sheet-empty") {
          createDefaultSheetSet();
          render();
        }
        toggleSheetsPanel();
        break;
      case "families":
      case "material":
        ensureDefaultMaterials();
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
        break;
      case "family":
        // A family with types expands / collapses; a typeless family
        // behaves like the old Families node and opens Properties.
        if (node.children?.length) {
          if (expanded.has(node.id)) expanded.delete(node.id);
          else expanded.add(node.id);
        } else {
          ensureDefaultMaterials();
          if (!isPropertyPaletteVisible()) togglePropertyPalette();
        }
        break;
      case "family-type":
        ensureDefaultMaterials();
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
        break;
      case "materials":
        // Materials subgroup: single click expands / collapses.
        if (expanded.has(node.id)) expanded.delete(node.id);
        else expanded.add(node.id);
        break;
      case "links":
      case "link":
        toggleModelTreePanel();
        break;
      case "groups":
      case "group":
        if (node.meta?.setId) {
          void selection.loadSet(String(node.meta.setId));
        }
        break;
      case "phases":
      case "phase":
        if (node.id === "phase-empty") {
          createDefaultPhases();
          render();
        }
        toggleTimelinePanel();
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn("[project-browser] activate", e);
  }
  render();
}

function renderNode(node: BrowserNode, depth: number, forceExpand = false): string {
  const hasKids = !!(node.children && node.children.length);
  const isExp = forceExpand || expanded.has(node.id);
  const isSel = selectedNodeId === node.id;
  const pad = 8 + depth * 14;
  const chevron = hasKids ? (isExp ? "▼" : "▶") : "·";
  const count = node.count != null ? `<span class="pb-count">${node.count}</span>` : "";

  let html = `
    <div class="pb-row ${isSel ? "is-sel" : ""}" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}"
         style="padding-inline-start:${pad}px" title="${esc(node.label)}">
      <span class="pb-chev" data-toggle="${esc(node.id)}">${chevron}</span>
      <span class="pb-icon">${node.icon}</span>
      <span class="pb-label">${esc(node.label)}</span>
      ${count}
    </div>`;

  if (hasKids && isExp) {
    for (const c of node.children!) html += renderNode(c, depth + 1, forceExpand);
  }
  return html;
}

function render() {
  if (!panel) return;
  // While a filter is active every matching branch is shown expanded, so a
  // match is never hidden inside a collapsed subgroup.
  const filtering = filterQuery.trim().length > 0;
  const tree = filtering ? filterProjectBrowserTree(buildTree(), filterQuery) : buildTree();
  const body = panel.querySelector(".pb-body");
  if (!body) return;
  body.innerHTML = tree.map((n) => renderNode(n, 0, filtering)).join("");

  body.querySelectorAll(".pb-row").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id!;
      const kind = (el as HTMLElement).dataset.kind as NodeKind;
      // Toggle expand on chevron
      const t = (e.target as HTMLElement).closest("[data-toggle]") as HTMLElement | null;
      if (t) {
        const tid = t.dataset.toggle!;
        if (expanded.has(tid)) expanded.delete(tid);
        else expanded.add(tid);
        render();
        return;
      }
      // Find node
      const find = (nodes: BrowserNode[]): BrowserNode | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.children) {
            const f = find(n.children);
            if (f) return f;
          }
        }
        return null;
      };
      const node = find(tree);
      if (node) onActivate(node);
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const id = (el as HTMLElement).dataset.id!;
      const find = (nodes: BrowserNode[]): BrowserNode | null => {
        for (const n of nodes) {
          if (n.id === id) return n;
          if (n.children) {
            const f = find(n.children);
            if (f) return f;
          }
        }
        return null;
      };
      const node = find(tree);
      if (node) onActivate(node);
    });
  });
}

function ensurePanel() {
  if (panel) return panel;
  panel = document.createElement("div");
  panel.className = "obs-project-browser";
  panel.style.cssText =
    "position:fixed;left:12px;top:52px;width:280px;bottom:48px;z-index:8200;" +
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.5);" +
    "font:12px/1.35 system-ui,Segoe UI,sans-serif;overflow:hidden";

  panel.innerHTML = `
    <div class="pb-header">
      <span class="pb-title">Project Browser</span>
      <div class="pb-actions">
        <button type="button" data-act="refresh" title="Refresh">⟲</button>
        <button type="button" data-act="props" title="Properties">☰</button>
        <button type="button" data-act="close" title="Close">✕</button>
      </div>
    </div>
    <div class="pb-toolbar">
      <button type="button" data-act="new-view">+ View</button>
      <button type="button" data-act="new-sheet">+ Sheet</button>
      <button type="button" data-act="expand">Expand</button>
    </div>
    <div class="pb-filter">
      <input type="text" class="pb-filter-input" placeholder="Filter…" aria-label="Filter browser" autocomplete="off" />
    </div>
    <div class="pb-body"></div>
    <div class="pb-footer">Open BIM Studio · Project</div>
  `;

  const style = document.createElement("style");
  style.textContent = `
    .obs-project-browser .pb-header {
      display:flex;align-items:center;justify-content:space-between;
      padding:8px 10px;background:#12141b;border-bottom:1px solid #2a2e3a;
      font-weight:600;font-size:12px;user-select:none;
    }
    .obs-project-browser .pb-actions button {
      background:transparent;border:none;color:#94a3b8;cursor:pointer;
      font-size:13px;padding:2px 6px;border-radius:4px;
    }
    .obs-project-browser .pb-actions button:hover { background:#2a2e3a;color:#e2e8f0; }
    .obs-project-browser .pb-toolbar {
      display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #1e2029;
    }
    .obs-project-browser .pb-toolbar button {
      flex:1;background:#252836;border:1px solid #2a2e3a;color:#cbd5e1;
      border-radius:4px;padding:4px 6px;font-size:11px;cursor:pointer;
    }
    .obs-project-browser .pb-toolbar button:hover { background:#2f3344; }
    .obs-project-browser .pb-filter {
      padding:6px 8px;border-bottom:1px solid #1e2029;
    }
    .obs-project-browser .pb-filter-input {
      width:100%;box-sizing:border-box;background:#12141b;border:1px solid #2a2e3a;
      color:#e8eaf0;border-radius:4px;padding:5px 8px;font-size:12px;outline:none;
    }
    .obs-project-browser .pb-filter-input:focus { border-color:#38bdf8; }
    .obs-project-browser .pb-filter-input::placeholder { color:#64748b; }
    .obs-project-browser .pb-body {
      flex:1;overflow-y:auto;padding:4px 0;
    }
    .obs-project-browser .pb-row {
      display:flex;align-items:center;gap:6px;padding:4px 8px 4px 8px;
      cursor:pointer;border-inline-start:2px solid transparent;
    }
    .obs-project-browser .pb-row:hover { background:#222533; }
    .obs-project-browser .pb-row.is-sel {
      background:#1e3a5f;border-inline-start-color:#38bdf8;
    }
    .obs-project-browser .pb-chev {
      width:12px;font-size:9px;color:#64748b;text-align:center;flex-shrink:0;
    }
    /* RTL (#141): the expand chevron "▶" points the other way (scaleX of "▼" is still "▼"). */
    html[dir="rtl"] .obs-project-browser .pb-chev { display:inline-block;transform:scaleX(-1); }
    .obs-project-browser .pb-icon { flex-shrink:0;font-size:12px; }
    .obs-project-browser .pb-label {
      flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    }
    .obs-project-browser .pb-count {
      font-size:10px;color:#64748b;background:#12141b;padding:1px 5px;border-radius:8px;
    }
    .obs-project-browser .pb-footer {
      padding:5px 10px;font-size:10px;color:#64748b;border-top:1px solid #1e2029;
      background:#12141b;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  panel.querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      const act = (el as HTMLElement).dataset.act;
      if (act === "close") setVisible(false);
      if (act === "refresh") render();
      if (act === "props") {
        if (!isPropertyPaletteVisible()) togglePropertyPalette();
      }
      if (act === "new-view") {
        saveCurrentView();
        render();
      }
      if (act === "new-sheet") {
        createSheet();
        toggleSheetsPanel();
        render();
      }
      if (act === "expand") {
        // Expand every node in the tree, including view-kind subgroups.
        const walk = (nodes: BrowserNode[]) => {
          for (const n of nodes) {
            expanded.add(n.id);
            if (n.children) walk(n.children);
          }
        };
        walk(buildTree());
        render();
      }
    });
  });

  // As-you-type filter: narrows the tree by node name. The input lives
  // outside .pb-body, so re-rendering the tree never steals focus.
  const filterInput = panel.querySelector(".pb-filter-input") as HTMLInputElement | null;
  filterInput?.addEventListener("input", () => {
    filterQuery = filterInput.value;
    render();
  });

  return panel;
}

export function setVisible(on: boolean) {
  visible = on;
  const el = ensurePanel();
  el.style.display = on ? "flex" : "none";
  if (on) render();
}

export function toggleProjectBrowser() {
  setVisible(!visible);
}

export function isProjectBrowserVisible() {
  return visible;
}

export function setupProjectBrowser() {
  ensurePanel();
  // Refresh when models load
  try {
    window.addEventListener("obs-toast", () => {
      if (visible) setTimeout(render, 200);
    });
  } catch { /* */ }
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  (ctx.features as any).projectBrowser = {
    open: () => setVisible(true),
    close: () => setVisible(false),
    toggle: toggleProjectBrowser,
    isVisible: isProjectBrowserVisible,
  };
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  ctx.features.projectBrowser = {
    open: () => setVisible(true),
    close: () => setVisible(false),
    toggle: toggleProjectBrowser,
    isVisible: isProjectBrowserVisible,
  };
}
