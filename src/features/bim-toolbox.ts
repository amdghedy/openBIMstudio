/**
 * BIM Command Center — cross-discipline Revit-style behavior layer.
 *
 * This is deliberately broader than a single discipline ribbon: it groups
 * the command order users expect while authoring and documenting BIM:
 * selection -> placement -> constraints -> modify -> annotation -> graphics.
 * Actions call the native Open BIM Studio authoring / view services so the
 * panel stays consistent with ribbon and keyboard workflows.
 */
import { ctx } from "../core/context";
import { makeDockable, type DockHandle } from "./dockable";
import {
  setAuthoringTool,
  getActiveTool,
  getLastCommand,
  getSelectedIds,
  getElementById,
  createSimilarFromSelection,
  pinSelected,
  splitSelectedAtMidpoint,
  alignSelectedAxis,
  joinSelectedWalls,
  getWallLocationLine,
  setWallLocationLine,
  getWallChain,
  setWallChain,
  getWallOffset,
  setWallOffset,
  getWallJoinStatus,
  setWallJoinStatus,
  onAuthoringChange,
} from "./authoring";
import { selection } from "./selection";
import { clearAllSelection, selectAllObjects } from "./select-all";
import { togglePlanView, isPlanViewVisible } from "./plan-view-panel";
import { togglePropertyPalette, isPropertyPaletteVisible } from "./property-palette";
import { toggleProjectBrowser, isProjectBrowserVisible } from "./project-browser";
import { toggleModelTreePanel, isModelTreePanelVisible } from "./model-tree-panel";
import { toggleSchedules, isSchedulesVisible } from "./schedules-panel";
import { toggleSheetsPanel, isSheetsPanelVisible } from "./sheets-panel";
import { toggleSavedViewsPanel, isSavedViewsPanelVisible } from "./saved-views";
import { toggleIssuesPanel, isIssuesPanelVisible } from "./issues-panel";
import { toggleTimelinePanel, isTimelinePanelVisible } from "./timeline-panel";
import { toggleIdsPanel, isIdsPanelVisible } from "./ids-panel";
import { toggleMepColors, isMepColoringActive } from "./mep-coloring";
import {
  getVisualPreset,
  setVisualPreset,
  setSceneTransparency,
  getSceneTransparency,
  setSunEnabled,
  isSunEnabled,
  setSceneBackground,
  getSceneBackground,
  type VisualPreset,
} from "./view-graphics";

const panel = document.createElement("div");
panel.id = "obs-bim-toolbox";
panel.style.cssText =
  "display:none;flex-direction:column;z-index:58;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 16px 50px rgba(0,0,0,.5);color:var(--text-primary,#e8eaf0);" +
  "font:12px system-ui,sans-serif;overflow:hidden";
panel.addEventListener("mousedown", (e) => e.stopPropagation());

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--border-subtle);" +
  "background:var(--bg-elevated);cursor:move;user-select:none";

const title = document.createElement("div");
title.style.cssText = "font-weight:700;flex:1;letter-spacing:.1px";
title.textContent = "BIM Command Center";

const statePill = document.createElement("span");
statePill.style.cssText =
  "font:700 9px ui-monospace,monospace;letter-spacing:.4px;color:var(--accent);" +
  "border:1px solid var(--accent-dim);background:var(--accent-dim);border-radius:999px;padding:3px 6px";

const body = document.createElement("div");
body.style.cssText = "overflow:auto;padding:8px 8px 12px;display:flex;flex-direction:column;gap:8px";

header.append(title, statePill);
panel.append(header, body);

type SectionState = { root: HTMLElement; content: HTMLElement; button: HTMLButtonElement };
const sections = new Map<string, SectionState>();

function makeSection(id: string, label: string, subtitle?: string, open = true): SectionState {
  const root = document.createElement("section");
  root.style.cssText =
    "border:1px solid var(--border-subtle);border-radius:8px;background:rgba(255,255,255,.015);overflow:hidden";
  const button = document.createElement("button");
  button.style.cssText =
    "width:100%;display:flex;align-items:center;gap:7px;padding:7px 9px;text-align:left;" +
    "background:var(--bg-elevated);color:var(--text-primary);border-bottom:1px solid var(--border-subtle);" +
    "font-weight:700;cursor:pointer";
  const caret = document.createElement("span");
  caret.style.width = "11px";
  const name = document.createElement("span");
  name.textContent = label;
  const note = document.createElement("span");
  note.textContent = subtitle ?? "";
  note.style.cssText = "margin-left:auto;font-size:9px;color:var(--text-tertiary);font-weight:500";
  button.append(caret, name, note);
  const content = document.createElement("div");
  content.style.cssText = "padding:7px;display:grid;gap:6px";
  const state = { root, content, button };
  function apply() {
    const isOpen = root.dataset.open !== "0";
    content.style.display = isOpen ? "grid" : "none";
    caret.textContent = isOpen ? "▾" : "▸";
  }
  root.dataset.open = open ? "1" : "0";
  button.onclick = () => { root.dataset.open = root.dataset.open === "0" ? "1" : "0"; apply(); };
  root.append(button, content);
  body.appendChild(root);
  apply();
  sections.set(id, state);
  return state;
}

function action(label: string, run: () => void | Promise<void>, accent = false): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText =
    "min-height:28px;padding:5px 8px;border:1px solid var(--border-default);border-radius:6px;" +
    `background:${accent ? "var(--accent-dim)" : "var(--bg-inset)"};` +
    `color:${accent ? "var(--accent)" : "var(--text-secondary)"};` +
    "font-weight:650;font-size:10.5px;cursor:pointer;text-align:left;transition:.14s ease";
  b.onmouseenter = () => { b.style.background = accent ? "var(--accent-glow)" : "var(--bg-hover)"; b.style.color = "var(--text-primary)"; };
  b.onmouseleave = () => { b.style.background = accent ? "var(--accent-dim)" : "var(--bg-inset)"; b.style.color = accent ? "var(--accent)" : "var(--text-secondary)"; };
  b.onclick = async () => {
    try { await run(); refresh(); }
    catch (err) { console.error("[bim-toolbox] action failed", err); toast("Action failed — see console.", "warn"); }
  };
  return b;
}

function row(...children: HTMLElement[]): HTMLElement {
  const r = document.createElement("div");
  r.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px";
  r.append(...children);
  return r;
}

function select<T extends string>(label: string, value: T, options: { v: T; label: string }[], on: (v: T) => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:grid;gap:3px;font-size:9px;color:var(--text-tertiary)";
  const l = document.createElement("span"); l.textContent = label;
  const s = document.createElement("select");
  s.style.cssText =
    "width:100%;padding:5px 6px;background:var(--bg-inset);border:1px solid var(--border-default);" +
    "border-radius:6px;color:var(--text-primary);font-size:10.5px";
  for (const o of options) {
    const op = document.createElement("option"); op.value = o.v; op.textContent = o.label; s.appendChild(op);
  }
  s.value = value;
  s.onchange = () => on(s.value as T);
  wrap.append(l, s);
  return wrap;
}

function numberField(label: string, value: number, step: number, on: (v: number) => void): HTMLElement {
  const wrap = document.createElement("label");
  wrap.style.cssText = "display:grid;gap:3px;font-size:9px;color:var(--text-tertiary)";
  const l = document.createElement("span"); l.textContent = label;
  const i = document.createElement("input"); i.type = "number"; i.step = String(step); i.value = String(value);
  i.style.cssText = "width:100%;padding:5px 6px;background:var(--bg-inset);border:1px solid var(--border-default);border-radius:6px;color:var(--text-primary);font-size:10.5px";
  i.onchange = () => on(Number(i.value) || 0);
  wrap.append(l, i);
  return wrap;
}

function toast(message: string, kind: "info" | "success" | "warn" = "info") {
  window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message, kind } }));
}

function selectedAuthored() {
  return getSelectedIds().map((id) => getElementById(id)).filter((el): el is NonNullable<ReturnType<typeof getElementById>> => Boolean(el));
}

function setPlanTool(tool: string): void {
  if (!isPlanViewVisible()) togglePlanView();
  const pv = (ctx.features as any).planView;
  pv?.setTool?.(tool);
}

const modeling = makeSection("modeling", "1 · Modeling Orders", "place → constrain → modify");
modeling.content.append(
  row(
    action("Select / Esc", () => setAuthoringTool("select"), true),
    action("Repeat Last", () => { const cmd = getLastCommand(); if (cmd) setAuthoringTool(cmd); else toast("No previous command to repeat."); }),
  ),
  row(
    action("Create Similar", () => { const type = createSimilarFromSelection(); if (!type) toast("Select one authored element first.", "warn"); else toast(`Create Similar → ${type}`, "success"); }),
    action("Finish / Cancel", () => setAuthoringTool(null)),
  ),
  row(
    action("Move", () => setAuthoringTool("move")),
    action("Copy", () => setAuthoringTool("copy")),
  ),
  row(
    action("Rotate", () => setAuthoringTool("rotate")),
    action("Mirror", () => setAuthoringTool("mirror")),
  ),
  row(
    action("Array", () => setAuthoringTool("array")),
    action("Offset", () => setAuthoringTool("offset")),
  ),
  row(
    action("Wall", () => setAuthoringTool("wall"), true),
    action("Floor / Roof", () => setAuthoringTool("slab")),
  ),
  row(
    action("Beam / Brace", () => setAuthoringTool("beam")),
    action("Column", () => setAuthoringTool("column")),
  ),
  row(
    action("Duct", () => setAuthoringTool("duct")),
    action("Pipe", () => setAuthoringTool("pipe")),
  ),
  row(
    action("Cable Tray", () => setAuthoringTool("cable-tray")),
    action("Conduit", () => setAuthoringTool("conduit")),
  ),
  row(
    action("Door", () => setAuthoringTool("door")),
    action("Window", () => setAuthoringTool("window")),
  ),
);

const constraints = makeSection("constraints", "2 · Constraints & Hosts", "Revit-style placement behavior");
constraints.content.append(
  row(
    select("Wall Location Line", getWallLocationLine(), [
      { v: "wall-centerline", label: "Wall Centerline" },
      { v: "core-centerline", label: "Core Centerline" },
      { v: "finish-exterior", label: "Finish Exterior" },
      { v: "finish-interior", label: "Finish Interior" },
      { v: "core-exterior", label: "Core Exterior" },
      { v: "core-interior", label: "Core Interior" },
    ], (v) => setWallLocationLine(v as any)),
    select("Join Behavior", getWallJoinStatus(), [
      { v: "allow", label: "Allow Join" },
      { v: "disallow", label: "Disallow Join" },
      { v: "butt", label: "Butt" },
      { v: "chamfer", label: "Chamfer" },
      { v: "extended", label: "Extended" },
    ], (v) => setWallJoinStatus(v as any)),
  ),
  row(
    action("Chain: ON / OFF", () => { setWallChain(!getWallChain()); toast(`Wall chain ${getWallChain() ? "enabled" : "disabled"}.`, "success"); }),
    numberField("Wall Offset (m)", getWallOffset(), 0.01, (v) => setWallOffset(v)),
  ),
  row(
    action("Join Selected Walls", () => { const n = joinSelectedWalls(); toast(n ? `Joined ${n} wall run(s).` : "Select authored walls near a corner.", n ? "success" : "warn"); }),
    action("Pick Work Plane", () => toast("Work Plane order: select a face or datum, then start placement. The active ground plane remains the default reference.")),
  ),
  row(
    action("Level / Datum", () => setAuthoringTool("level")),
    action("Grid / Datum", () => setAuthoringTool("grid")),
  ),
);

const modify = makeSection("modify", "3 · Modify & Constraints", "selection aware");
modify.content.append(
  row(
    action("Pin Selected", () => { const n = pinSelected(true); toast(n ? `Pinned ${n} element(s).` : "Select authored element(s).", n ? "success" : "warn"); }),
    action("Unpin Selected", () => { const n = pinSelected(false); toast(n ? `Unpinned ${n} element(s).` : "No authored selection.", n ? "success" : "warn"); }),
  ),
  row(
    action("Split @ Midpoint", () => { const n = splitSelectedAtMidpoint(); toast(n ? `Split ${n} line-based element(s).` : "Select wall / beam / MEP run(s) first.", n ? "success" : "warn"); }),
    action("Join / Heal Walls", () => { const n = joinSelectedWalls(); toast(n ? `Processed ${n} wall join(s).` : "No joinable authored walls found.", n ? "success" : "warn"); }),
  ),
  row(
    action("Align X", () => { const n = alignSelectedAxis("x"); toast(n ? `Aligned ${n} element(s) to the first selection.` : "Select at least two authored elements.", n ? "success" : "warn"); }),
    action("Align Z", () => { const n = alignSelectedAxis("z"); toast(n ? `Aligned ${n} element(s) to the first selection.` : "Select at least two authored elements.", n ? "success" : "warn"); }),
  ),
  row(
    action("Properties", () => { if (!isPropertyPaletteVisible()) togglePropertyPalette(); }),
    action("Project Browser", () => { if (!isProjectBrowserVisible()) toggleProjectBrowser(); }),
  ),
);

const annotation = makeSection("annotation", "4 · Annotation & Dimensioning", "document the model");
annotation.content.append(
  row(
    action("Aligned Dimension", () => setPlanTool("dim-aligned"), true),
    action("Linear Dimension", () => setPlanTool("dim-linear")),
  ),
  row(
    action("Angular Dimension", () => { setPlanTool("dim-angular"); }),
    action("Spot Elevation", () => { setPlanTool("spot-elevation"); }),
  ),
  row(
    action("Tag Element", () => setPlanTool("tag")),
    action("Room / Space Tag", () => setPlanTool("room-tag")),
  ),
  row(
    action("Material Tag", () => setPlanTool("material-tag")),
    action("Text Note", () => setPlanTool("text")),
  ),
  row(
    action("Revision Cloud", () => { void import("./revision-cloud").then((m) => m.beginCloudPlacement()); }),
    action("Keynote / Label", () => { if (!isPropertyPaletteVisible()) togglePropertyPalette(); toast("Keynote/label data is driven from element properties and schedules."); }),
  ),
  row(
    action("Schedules", () => { if (!isSchedulesVisible()) toggleSchedules(); }),
    action("Sheets", () => { if (!isSheetsPanelVisible()) toggleSheetsPanel(); }),
  ),
);

const graphics = makeSection("graphics", "5 · View & Visual Appearance", "presentation / QA");
graphics.content.append(
  row(
    select<VisualPreset>("Visual Style", getVisualPreset(), [
      { v: "shaded", label: "Shaded" },
      { v: "shaded-edges", label: "Shaded + Edges" },
      { v: "wireframe", label: "Wireframe" },
      { v: "hidden-line", label: "Hidden Line" },
    ], (v) => setVisualPreset(v)),
    select("Background", getSceneBackground(), [
      { v: "studio", label: "Studio" },
      { v: "paper", label: "Paper" },
      { v: "night", label: "Night" },
    ], (v) => setSceneBackground(v as any)),
  ),
  row(
    numberField("Transparency %", getSceneTransparency(), 5, (v) => setSceneTransparency(Math.max(0, Math.min(90, v)))),
    action("Sun / Shadows", () => { setSunEnabled(!isSunEnabled()); toast(`Sun ${isSunEnabled() ? "enabled" : "disabled"}.`); }),
  ),
  row(
    action("MEP Discipline Colors", () => { toggleMepColors(); toast(`MEP colors ${isMepColoringActive() ? "enabled" : "disabled"}.`); }),
    action("Saved Views / Gallery", () => { if (!isSavedViewsPanelVisible()) toggleSavedViewsPanel(); }),
  ),
  row(
    action("Category Visibility", () => { if (!isModelTreePanelVisible()) toggleModelTreePanel(); toast("Use the Model Tree eye controls for category/object visibility and review."); }),
    action("Reveal / Show All", () => { try { (ctx.hider as any)?.show?.(); } catch {} }),
  ),
  row(
    action("Section Box / Cut", () => { void import("./section-box").then((m) => m.toggleSectionBox()); }),
    action("View Template Concept", () => toast("Use Saved Views as the current view-standard layer; view templates remain a longer-term standards engine.")),
  ),
);

const visibility = makeSection("visibility", "6 · Visibility & Selection", "temporary review controls");
visibility.content.append(
  row(
    action("Select All", async () => { const r = await selectAllObjects(); toast(`Selected ${r.fragments + r.authored} objects.`, "success"); }),
    action("Clear Selection", () => { void clearAllSelection(); }),
  ),
  row(
    action("Isolate Selection", () => { const snap = selection.snapshot(); if (Object.keys(snap).length) { try { (ctx.hider as any)?.isolate?.(snap); } catch {} } else toast("Nothing selected.", "warn"); }),
    action("Show All", () => { try { (ctx.hider as any)?.show?.(); } catch {} }),
  ),
  row(
    action("Properties", () => { if (!isPropertyPaletteVisible()) togglePropertyPalette(); }),
    action("Category / Filters", () => { if (!isModelTreePanelVisible()) toggleModelTreePanel(); }),
  ),
  row(
    action("Issues / BCF", () => { if (!isIssuesPanelVisible()) toggleIssuesPanel(); }),
    action("Project Browser", () => { if (!isProjectBrowserVisible()) toggleProjectBrowser(); }),
  ),
  row(
    action("IDS Validation", () => { if (!isIdsPanelVisible()) toggleIdsPanel(); }),
    action("4D Simulation", () => { if (!isTimelinePanelVisible()) toggleTimelinePanel(); }),
  ),
);

const production = makeSection("production", "7 · BIM Delivery", "information → sheets → handover", false);
production.content.append(
  row(
    action("Project Browser", () => { if (!isProjectBrowserVisible()) toggleProjectBrowser(); }),
    action("Schedules", () => { if (!isSchedulesVisible()) toggleSchedules(); }),
  ),
  row(
    action("Sheets / Documentation", () => { if (!isSheetsPanelVisible()) toggleSheetsPanel(); }),
    action("Saved Views", () => { if (!isSavedViewsPanelVisible()) toggleSavedViewsPanel(); }),
  ),
  row(
    action("Issues / BCF", () => { if (!isIssuesPanelVisible()) toggleIssuesPanel(); }),
    action("IDS", () => { if (!isIdsPanelVisible()) toggleIdsPanel(); }),
  ),
  row(
    action("Plan Workspace", () => { if (!isPlanViewVisible()) togglePlanView(); }, true),
    action("Model Browser", () => { if (!isProjectBrowserVisible()) toggleProjectBrowser(); }),
  ),
);

const selectionInfo = document.createElement("div");
selectionInfo.style.cssText =
  "padding:7px 9px;border:1px dashed var(--border-default);border-radius:8px;color:var(--text-tertiary);" +
  "font:10px/1.45 ui-monospace,monospace;background:rgba(255,255,255,.012)";
body.appendChild(selectionInfo);

let dock: DockHandle | null = null;
let visible = false;

function refresh(): void {
  const authored = selectedAuthored().filter(Boolean);
  const tool = getActiveTool();
  statePill.textContent = authored.length
    ? `${authored.length} authored selected`
    : selection.size()
      ? `${selection.size()} model objects selected`
      : tool ? `Order: ${tool}` : "Ready";

  const first = authored[0];
  selectionInfo.textContent = first
    ? `Selection: ${first.name} · category=${first.type} · ${first.properties?.pinned ? "PINNED" : "editable"}`
    : selection.size()
      ? `Selection: ${selection.size()} federated object(s) across ${selection.modelCount()} model(s)`
      : "Selection: none · Start with Select, then place / modify / annotate in order.";
}

export function toggleBimToolbox(): void {
  visible ? hideBimToolbox() : showBimToolbox();
}

export function showBimToolbox(): void {
  visible = true;
  if (!panel.parentElement) ctx.rightHost.appendChild(panel);
  panel.style.display = "flex";
  if (!dock) {
    dock = makeDockable(panel, { id: "bim-toolbox", host: ctx.rightHost, header, minWidth: 330, minHeight: 360, defaultDock: "right", defaultWidth: 370, defaultHeight: 690 });
  }
  dock.show();
  refresh();
}

export function hideBimToolbox(): void {
  visible = false;
  dock?.hide();
  panel.style.display = "none";
}

export function isBimToolboxVisible(): boolean { return visible; }

export function setupBimToolbox(): void {
  if (panel.parentElement !== ctx.rightHost) ctx.rightHost.appendChild(panel);
  dock = makeDockable(panel, { id: "bim-toolbox", host: ctx.rightHost, header, minWidth: 330, minHeight: 360, defaultDock: "right", defaultWidth: 370, defaultHeight: 690 });
  panel.style.display = "none";
  selection.onChange(refresh);
  window.addEventListener("obs-toast", refresh as EventListener);
  onAuthoringChange(refresh);
  refresh();
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  (ctx.features as any).bimToolbox = {
    open: showBimToolbox,
    close: hideBimToolbox,
    toggle: toggleBimToolbox,
    isVisible: isBimToolboxVisible,
  };
  // openbim-fix:workspace-layout -- expose the panel via the feature
  // registry so workspace-layout can save/restore its open state.
  ctx.features.bimToolbox = {
    open: showBimToolbox,
    close: hideBimToolbox,
    toggle: toggleBimToolbox,
    isVisible: isBimToolboxVisible,
  };
}