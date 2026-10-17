/**
 * Project Browser — Industry-standard project organization panel.
 *
 * Hierarchy:
 *   Views (all)          → 3D, Plan, Saved views
 *   Schedules/Quantities → schedule templates
 *   Sheets (all)         → production sheets
 *   Families             → materials / types
 *   Models & Links       → federated IFC / FRAG / aux
 *   Groups               → selection sets
 *   4D Phases            → construction phases
 *
 * Professional dark UI, expandable tree, double-click to open,
 * right-click actions. Competes with BIM Project Browser presentation.
 */
import { ctx } from "../core/context";
import { listSheets, createSheet, createDefaultSheetSet } from "../modules/sheets/sheets";
import { listMaterials, ensureDefaultMaterials } from "../modules/materials/materials";
import { listPhases, createDefaultPhases } from "../modules/timeline/timeline";
import { listSavedViews, restoreView, saveCurrentView } from "./saved-views";
import { selection } from "./selection";
import { togglePlanView } from "./plan-view-panel";
import { toggleSchedules } from "./schedules-panel";
import { toggleSheetsPanel } from "./sheets-panel";
import { toggleTimelinePanel } from "./timeline-panel";
import { togglePropertyPalette, isPropertyPaletteVisible } from "./property-palette";
import { toggleModelTreePanel } from "./model-tree-panel";
import { fitAll, goHome } from "./camera-tools";

type NodeKind =
  | "root" | "views" | "view-3d" | "view-plan" | "view-saved"
  | "schedules" | "schedule"
  | "sheets" | "sheet"
  | "families" | "material"
  | "links" | "link"
  | "groups" | "group"
  | "phases" | "phase";

interface BrowserNode {
  id: string;
  kind: NodeKind;
  label: string;
  icon: string;
  count?: number;
  children?: BrowserNode[];
  meta?: Record<string, unknown>;
}

let panel: HTMLElement | null = null;
let visible = false;
let expanded = new Set<string>(["views", "sheets", "links", "schedules"]);
let selectedNodeId: string | null = null;

function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);
}

function buildTree(): BrowserNode[] {
  // Models / links
  const links: BrowserNode[] = [];
  try {
    if (ctx.fragments?.list) {
      for (const [id, model] of ctx.fragments.list) {
        const name = (model as any)?.object?.name || (model as any)?.name || id;
        links.push({
          id: `link-${id}`,
          kind: "link",
          label: String(name).split("/").pop() || id,
          icon: "📦",
          meta: { modelId: id },
        });
      }
    }
  } catch { /* */ }

  // Saved views
  const saved = listSavedViews().map((v) => ({
    id: `view-${v.id}`,
    kind: "view-saved" as const,
    label: v.name,
    icon: "📷",
    meta: { viewId: v.id },
  }));

  // Sheets
  const sheets = listSheets().map((s) => ({
    id: `sheet-${s.id}`,
    kind: "sheet" as const,
    label: `${s.number} — ${s.name}`,
    icon: "📄",
    meta: { sheetId: s.id },
  }));

  // Materials / families
  ensureDefaultMaterials();
  const mats = listMaterials().map((m) => ({
    id: `mat-${m.id}`,
    kind: "material" as const,
    label: m.name,
    icon: "🧱",
    meta: { materialId: m.id },
  }));

  // Selection sets as groups
  const groups: BrowserNode[] = [];
  try {
    const sets = selection.listSets() ?? [];
    for (const s of sets) {
      groups.push({
        id: `grp-${s.id}`,
        kind: "group",
        label: s.name,
        icon: "🧩",
        meta: { setId: s.id },
      });
    }
  } catch { /* */ }

  // 4D phases
  const phases = listPhases().map((p) => ({
    id: `phase-${p.id}`,
    kind: "phase" as const,
    label: p.name,
    icon: "⏱",
    count: p.elementIds.length,
    meta: { phaseId: p.id },
  }));

  return [
    {
      id: "views",
      kind: "views",
      label: "Views (all)",
      icon: "🗂",
      children: [
        { id: "view-3d", kind: "view-3d", label: "3D View", icon: "🔲" },
        { id: "view-plan", kind: "view-plan", label: "Floor Plan", icon: "📐" },
        ...saved,
      ],
    },
    {
      id: "schedules",
      kind: "schedules",
      label: "Schedules/Quantities (all)",
      icon: "📊",
      children: [
        { id: "sch-open", kind: "schedule", label: "Open Schedules panel", icon: "📋" },
        { id: "sch-cost", kind: "schedule", label: "Cost / QTO", icon: "💰" },
      ],
    },
    {
      id: "sheets",
      kind: "sheets",
      label: "Sheets (all)",
      icon: "📑",
      count: sheets.length,
      children: sheets.length
        ? sheets
        : [{ id: "sheet-empty", kind: "sheet", label: "(no sheets — create default set)", icon: "＋" }],
    },
    {
      id: "families",
      kind: "families",
      label: "Families",
      icon: "🏗",
      count: mats.length,
      children: mats.slice(0, 40),
    },
    {
      id: "links",
      kind: "links",
      label: "Models & Links",
      icon: "🔗",
      count: links.length,
      children: links.length
        ? links
        : [{ id: "link-empty", kind: "link", label: "(no models — Insert → Link IFC)", icon: "＋" }],
    },
    {
      id: "groups",
      kind: "groups",
      label: "Groups",
      icon: "📁",
      count: groups.length,
      children: groups.length
        ? groups
        : [{ id: "grp-empty", kind: "group", label: "(save a selection set first)", icon: "＋" }],
    },
    {
      id: "phases",
      kind: "phases",
      label: "4D Phases",
      icon: "📅",
      count: phases.length,
      children: phases.length
        ? phases
        : [{ id: "phase-empty", kind: "phase", label: "(create default phases)", icon: "＋" }],
    },
  ];
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

function renderNode(node: BrowserNode, depth: number): string {
  const hasKids = !!(node.children && node.children.length);
  const isExp = expanded.has(node.id);
  const isSel = selectedNodeId === node.id;
  const pad = 8 + depth * 14;
  const chevron = hasKids ? (isExp ? "▼" : "▶") : "·";
  const count = node.count != null ? `<span class="pb-count">${node.count}</span>` : "";

  let html = `
    <div class="pb-row ${isSel ? "is-sel" : ""}" data-id="${esc(node.id)}" data-kind="${esc(node.kind)}"
         style="padding-left:${pad}px" title="${esc(node.label)}">
      <span class="pb-chev" data-toggle="${esc(node.id)}">${chevron}</span>
      <span class="pb-icon">${node.icon}</span>
      <span class="pb-label">${esc(node.label)}</span>
      ${count}
    </div>`;

  if (hasKids && isExp) {
    for (const c of node.children!) html += renderNode(c, depth + 1);
  }
  return html;
}

function render() {
  if (!panel) return;
  const tree = buildTree();
  const body = panel.querySelector(".pb-body");
  if (!body) return;
  body.innerHTML = tree.map((n) => renderNode(n, 0)).join("");

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
    .obs-project-browser .pb-body {
      flex:1;overflow-y:auto;padding:4px 0;
    }
    .obs-project-browser .pb-row {
      display:flex;align-items:center;gap:6px;padding:4px 8px 4px 8px;
      cursor:pointer;border-left:2px solid transparent;
    }
    .obs-project-browser .pb-row:hover { background:#222533; }
    .obs-project-browser .pb-row.is-sel {
      background:#1e3a5f;border-left-color:#38bdf8;
    }
    .obs-project-browser .pb-chev {
      width:12px;font-size:9px;color:#64748b;text-align:center;flex-shrink:0;
    }
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
        for (const n of buildTree()) expanded.add(n.id);
        render();
      }
    });
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
