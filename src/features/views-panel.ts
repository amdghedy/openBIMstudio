/**
 * Views panel — Revit-style dockable views browser.
 *
 * Lists ViewDefs on the left and renders the selected view on the right.
 * Includes interactive tools for dimensions, tags, and section lines.
 * The panel is draggable by its header and resizeable from all 8 edges.
 */

import { ctx } from "../core/context";
import {
  bootViewsStore, listViews, getView, createView, deleteView, onViewsChange,
} from "../modules/views/store";
import type { ViewDef, ViewKind } from "../modules/views/types";
import { generatePlanScene } from "../modules/views/generators/plan";
import { generateSectionScene } from "../modules/views/generators/section";
import { generateElevationScene } from "../modules/views/generators/elevation";
import { renderSceneToSvg } from "../modules/views/renderers/svg";
import { emptyScene, type Scene2D } from "../modules/views/scene";
import { buildAnnotationLayer } from "../modules/views/annotation-layer";
import { toolState, type ActiveTool } from "../modules/views/tools";
import { attachAnnotationInteractions } from "../modules/views/annotation-interactions";
import { bootAnnotationStore, onAnnotationChange } from "../modules/views/annotation-store";
import { makeDockable, type DockHandle } from "./dockable";

let panel: HTMLDivElement | null = null;
let sidebar: HTMLDivElement | null = null;
let canvasHost: HTMLDivElement | null = null;
let dock: DockHandle | null = null;
let currentViewId: string | null = null;
let visible = false;

const toolButtonEls = new Map<ActiveTool, HTMLButtonElement>();
let toolbarHint: HTMLSpanElement | null = null;
let statusLine: HTMLSpanElement | null = null;

function refreshToolbar(): void {
  for (const [id, el] of toolButtonEls) {
    const active = toolState.active === id;
    el.style.background = active ? "#38bdf8" : "transparent";
    el.style.color = active ? "#0b0d12" : "#cbd5e1";
    el.style.borderColor = active ? "#38bdf8" : "#2a2e3a";
  }
  if (toolbarHint) toolbarHint.textContent = toolState.getHint();
}

function setStatus(msg: string, kind: "info" | "success" | "warn" = "info"): void {
  if (!statusLine) return;
  statusLine.textContent = msg;
  statusLine.style.color =
    kind === "success" ? "#22c55e" :
    kind === "warn" ? "#f59e0b" : "#94a3b8";
}

function mkButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "padding:4px 10px;border-radius:4px;cursor:pointer;font:600 11px system-ui;" +
    (primary
      ? "background:#38bdf8;color:#0b0d12;border:1px solid #38bdf8;"
      : "background:transparent;color:#cbd5e1;border:1px solid #2a2e3a;");
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

export function setupViewsPanel(): void {
  bootViewsStore();

  panel = document.createElement("div");
  panel.id = "obs-views-panel";
  panel.style.cssText =
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
    "overflow:hidden;z-index:34";
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:8px 10px;" +
    "border-bottom:1px solid #2a2e3a;background:#12141b;flex-shrink:0;" +
    "cursor:grab;user-select:none";

  const title = document.createElement("div");
  title.textContent = "Views";
  title.style.cssText = "font-weight:700;flex:1;pointer-events:none";

  const typeSelect = document.createElement("select");
  typeSelect.style.cssText =
    "padding:4px 8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;" +
    "color:#e8eaf0;font:11px system-ui;cursor:pointer";
  const kinds: ViewKind[] = ["plan", "section", "elevation", "detail", "3d"];
  for (const k of kinds) {
    const opt = document.createElement("option");
    opt.value = k;
    opt.textContent = k.charAt(0).toUpperCase() + k.slice(1);
    typeSelect.appendChild(opt);
  }

  const newBtn = mkButton("+ New View", () => {
    const kind = typeSelect.value as ViewKind;
    const name = prompt("New " + kind + " view name:", "New " + kind);
    if (!name) return;
    const v = createView(kind, name);
    currentViewId = v.id;
    render();
  }, true);

  header.append(title, typeSelect, newBtn);

  const toolbar = document.createElement("div");
  toolbar.style.cssText =
    "display:flex;align-items:center;gap:4px;padding:6px 10px;flex-wrap:wrap;" +
    "border-bottom:1px solid #2a2e3a;background:#0e1017;flex-shrink:0";

  const toolDefs: Array<{ id: ActiveTool; label: string }> = [
    { id: "select", label: "Select" },
    { id: "dim-aligned", label: "Dim Aligned" },
    { id: "dim-linear", label: "Dim Linear" },
    { id: "tag-category", label: "Tag" },
    { id: "section-line", label: "Section Line" },
  ];
  for (const t of toolDefs) {
    const b = document.createElement("button");
    b.textContent = t.label;
    b.style.cssText =
      "padding:3px 10px;background:transparent;color:#cbd5e1;border:1px solid #2a2e3a;" +
      "border-radius:4px;cursor:pointer;font:11px system-ui";
    b.onclick = () => {
      toolState.setTool(t.id);
      refreshToolbar();
      setStatus(toolState.getHint());
    };
    toolButtonEls.set(t.id, b);
    toolbar.appendChild(b);
  }
  toolbarHint = document.createElement("span");
  toolbarHint.style.cssText =
    "font:11px system-ui;color:#94a3b8;margin-left:auto;white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;max-width:60%";
  toolbar.appendChild(toolbarHint);

  const body = document.createElement("div");
  body.style.cssText = "flex:1;display:flex;min-height:0";

  sidebar = document.createElement("div");
  sidebar.style.cssText =
    "width:220px;flex:none;border-right:1px solid #2a2e3a;overflow-y:auto;background:#0e1017";

  canvasHost = document.createElement("div");
  canvasHost.style.cssText =
    "flex:1;overflow:auto;background:#f3f4f6;position:relative";

  body.append(sidebar, canvasHost);

  const footer = document.createElement("div");
  footer.style.cssText =
    "padding:6px 10px;border-top:1px solid #2a2e3a;background:#12141b;flex-shrink:0;" +
    "display:flex;justify-content:space-between;align-items:center;gap:10px";
  statusLine = document.createElement("span");
  statusLine.style.cssText = "font:11px system-ui;color:#94a3b8;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  statusLine.textContent = "Pick a view on the left, then click inside the drawing area.";
  const hintText = document.createElement("span");
  hintText.style.cssText = "font:10.5px system-ui;color:#6b7280;white-space:nowrap";
  hintText.textContent = "Drag the title bar to move";
  footer.append(statusLine, hintText);

  panel.append(header, toolbar, body, footer);
  ctx.rightHost.appendChild(panel);

  dock = makeDockable(panel, {
    id: "obs-views-panel",
    host: ctx.rightHost,
    header,
    minWidth: 500,
    minHeight: 380,
    defaultDock: "right",
    defaultWidth: 720,
    defaultHeight: 640,
  });

  onViewsChange(() => { if (visible) render(); });
  onAnnotationChange(() => { if (visible) void renderCurrent(); });

  refreshToolbar();

  (ctx.features as any).viewsPanel = {
    toggle: toggleViewsPanel,
    open: openViewsPanel,
    close: closeViewsPanel,
    isVisible: () => visible,
  };
}

function render(): void {
  if (!panel || !sidebar) return;
  const views = listViews();
  sidebar.innerHTML = "";
  for (const v of views) {
    const row = document.createElement("div");
    const active = v.id === currentViewId;
    row.style.cssText =
      "padding:7px 10px;cursor:pointer;border-bottom:1px solid #1a1d27;" +
      (active ? "background:#16233a;color:#38bdf8;" : "color:#cbd5e1;");
    row.textContent = v.name + "  (" + v.kind + ")";
    row.onclick = () => { currentViewId = v.id; void renderCurrent(); render(); };

    const del = document.createElement("button");
    del.textContent = "x";
    del.style.cssText =
      "float:right;background:transparent;color:#fca5a5;border:none;cursor:pointer;font-size:13px;padding:0 4px";
    del.onclick = (e) => {
      e.stopPropagation();
      if (confirm('Delete "' + v.name + '"?')) {
        deleteView(v.id);
        if (currentViewId === v.id) currentViewId = null;
        render();
      }
    };
    row.appendChild(del);
    sidebar.appendChild(row);
  }
  if (!currentViewId && views.length) {
    currentViewId = views[0].id;
    void renderCurrent();
  } else if (currentViewId) {
    void renderCurrent();
  }
}

async function renderCurrent(): Promise<void> {
  if (!canvasHost || !currentViewId) return;
  const view: ViewDef | null = getView(currentViewId);
  if (!view) return;

  let scene: Scene2D;
  if (view.kind === "plan" || view.kind === "rcp") scene = await generatePlanScene(view);
  else if (view.kind === "section") scene = await generateSectionScene(view);
  else if (view.kind === "elevation") scene = await generateElevationScene(view);
  else scene = emptyScene();

  const annotation = buildAnnotationLayer(view.id, view.scale);
  scene.layers.annotation = annotation.entities;

  canvasHost.innerHTML = "";
  const svg = renderSceneToSvg(scene, {
    scale: view.scale,
    padding: 3,
    widthPx: canvasHost.clientWidth || 800,
    heightPx: canvasHost.clientHeight || 600,
  });
  svg.style.cssText =
    "width:100%;height:100%;background:#f8fafc;display:block;cursor:crosshair";
  canvasHost.appendChild(svg);

  svg.addEventListener("click", (ev) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!rect.width || !rect.height || !vb.width) return;
    const px = ((ev.clientX - rect.left) / rect.width) * vb.width + vb.x;
    const py = ((ev.clientY - rect.top) / rect.height) * vb.height + vb.y;
    const worldX = px;
    const worldZ = -py;
    const worldTol = (vb.width / rect.width) * 8;
    const result = toolState.click(worldX, worldZ, view.id, view.scale, worldTol, view.kind);
    if (result.newSectionViewId) {
      currentViewId = result.newSectionViewId;
      toolState.setTool("select");
      render();
      return;
    }
    if (result.created) {
      void renderCurrent();
    }
    if (result.feedback) {
      setStatus(result.feedback, result.created ? "success" : "info");
    }
    refreshToolbar();
  });

  svg.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    if (!rect.width || !vb.width) return;
    const px = ((ev.clientX - rect.left) / rect.width) * vb.width + vb.x;
    const py = ((ev.clientY - rect.top) / rect.height) * vb.height + vb.y;
    const z = -py;
    setStatus(
      "Cursor: X " + px.toFixed(2) + "  Z " + z.toFixed(2) + " m  -  " + toolState.getHint(),
      "info",
    );
  });
}

export function toggleViewsPanel(): void {
  visible = !visible;
  if (dock) {
    if (visible) dock.show(); else dock.hide();
  } else if (panel) {
    panel.style.display = visible ? "flex" : "none";
  }
  if (visible) render();
}

export function openViewsPanel(): void {
  visible = true;
  if (dock) dock.show();
  else if (panel) panel.style.display = "flex";
  render();
}

export function closeViewsPanel(): void {
  visible = false;
  if (dock) dock.hide();
  else if (panel) panel.style.display = "none";
}

export function isViewsPanelVisible(): boolean {
  return visible;
}