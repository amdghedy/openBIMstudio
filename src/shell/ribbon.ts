/** Top ribbon — pyRevit-style density, icon + label buttons.
 *
 * 16 tabs. File · Architecture · Structure · Mechanical · Electrical ·
 * Insert · Annotate · Analyze · Massing & Site · Coordinate ·
 * Clash Detective · Edit · View · Manage · 5D Cost.
 *
 * Every button action is async-aware: the strip re-renders after the action
 * resolves, so badges, counters, and active states stay in sync. */
import * as THREE from "three";
import { ctx } from "../core/context";
import { onNotify, __dispatchToSubscribers } from "../core/notify";
import { pickFiles, loadIfcFiles, loadFragFiles } from "../features/importer";
import {
  setProjection, getProjection, fitAll, gotoDir, goHome, takeScreenshot,
  recenterSceneNow, resetOffsets, showBoundsHelpers, alignOriginToOrigin,
  getScreenshotPreset, setScreenshotPreset, type ScreenshotPreset,
} from "../features/camera-tools";
import { toggleMeasure, isMeasureEnabled } from "../features/measure";
import { toggleSection, isSectionOn } from "../features/section";
import {
  runElementClashDetection, clearClash, refreshModelSelectionUI,
  changeCropMargin, resetCropMargin, removeCropBox,
  createScenario, exportClashCsv, cancelClash,
  exportScenariosJson, importScenariosJson, listScenarios, loadScenario,
  swapSelections, clearSelectionA, clearSelectionB,
  addSelectionToA, addSelectionToB,
  isolateSelectionA, isolateSelectionB, showAllElements,
  focusNextClash, focusPreviousClash, focusActiveClash,
  setStatusForAll, cycleActiveClashStatus,
  changeTolerance, changeClearance,
  getTolerance, getClearance, getClashCount,
} from "../features/clash";
import {
  exportClashReportHtml,
  exportClashReportXls,
  previewClashReportHtml,
} from "../features/clash-report";
import { cubeHost } from "../features/viewcube";
import {
  setAuthoringTool, getActiveTool, deleteSelectedElement, clearAllElements,
  setLevel, getLevel, getLastCommand, pinSelected,
} from "../features/authoring";
import {
  getCurrentProject, saveProject, isDirty, onProjectChanged,
} from "../modules/projects/projects";
import { showHome } from "./home-screen";
import { toggleIssuesPanel, isIssuesPanelVisible } from "../features/issues-panel";
import { toggleCostPanel, isCostPanelVisible, recalculateTakeoff, exportCostCsv } from "../features/cost-panel";
import { toggleIdsPanel, isIdsPanelVisible } from "../features/ids-panel";
import { toggleModelTreePanel, isModelTreePanelVisible } from "../features/model-tree-panel";
import { togglePlanView, isPlanViewVisible } from "../features/plan-view-panel";
import {
  toggleOptionsBar, isOptionsBarVisible,
  toggleContextualBar, isContextualBarVisible,
  toggleViewBar, isViewBarVisible,
} from "../features/revit-experience";
import { toggleSchedules, isSchedulesVisible } from "../features/schedules-panel";
import { toggleWalkMode, isWalkModeEnabled } from "../features/walk-mode";
import { togglePalette } from "../features/command-palette";
import {
  toggleSavedViewsPanel, isSavedViewsPanelVisible,
  saveCurrentView, listSavedViews,
} from "../features/saved-views";
import { toggleFileMenu, isFileMenuVisible } from "./file-menu";
import { pickAndImport } from "../features/file-interop";
import { svgIcon, type IconName } from "../features/icon-set";
import { openProjectInfo } from "../features/project-info";
import { toggleBimToolbox, isBimToolboxVisible } from "../features/bim-toolbox";

// ── MEP category coloring ──────────────────────────────────────────────
import { toggleMepColors, isMepColoringActive } from "../features/mep-coloring";

// ── Unified select-all ─────────────────────────────────────────────────
import { selectAllObjects, clearAllSelection } from "../features/select-all";

// ── AI chat ────────────────────────────────────────────────────────────
import { toggleAiChat, isAiChatVisible } from "../features/ai-chat";

// ── 4D Construction Simulation (Navisworks TimeLiner competitor) ───────
import { toggleTimelinePanel, isTimelinePanelVisible } from "../features/timeline-panel";

// ── Sheets / Production + Automation ───────────────────────────────────
import { toggleSheetsPanel, isSheetsPanelVisible } from "../features/sheets-panel";
import { toggleAutomationPanel, isAutomationPanelVisible } from "../features/automation-panel";

// ── Object snaps (all modes) ───────────────────────────────────────────
import { toggleSnapSettings, isSnapSettingsVisible, snapping } from "../features/snapping";

// ── Insert / Link tools (all activated) ────────────────────────────────
import {
  linkIfc, linkFrag, linkCad, linkRevit, linkPointCloud, linkTopography,
  openFamilyLibrary, openComponentLibrary, linkAutodesk,
} from "../features/link-tools";

// ── Project Browser + Properties (Revit-class) ─────────────────────────
import {
  toggleProjectBrowser, isProjectBrowserVisible,
} from "../features/project-browser";
import {
  togglePropertyPalette, isPropertyPaletteVisible, openPropertyPalette,
} from "../features/property-palette";

// ── M14 — FRAG element editing ─────────────────────────────────────────
import {
  beginEditFromSelection, clearAllEdits, getEditCount, getSelectedEditId,
  removeEdit, focusEdit, toggleFragEditPanel, isFragEditPanelVisible,
} from "../features/frag-edit";
import { toggleBimObjectStudio, isBimObjectStudioVisible } from "../features/bim-object-studio";
import { gizmo as _gizmoForEdit } from "../features/gizmo";
const gizmo_setMode = (m: "move" | "rotate" | "scale" | "none") => _gizmoForEdit.setMode(m);
const gizmo_getMode = () => _gizmoForEdit.getMode();

/* ═════════════════════════════════════════════════════════════════════════
   Toast
   ═════════════════════════════════════════════════════════════════════════ */
type ToastKind = "info" | "warn" | "success" | "error";
let toastHost: HTMLDivElement | null = null;

function ensureToastHost(): HTMLDivElement {
  if (toastHost) return toastHost;
  const h = document.createElement("div");
  h.className = "obs-toast-host";
  document.body.appendChild(h);
  toastHost = h;
  return h;
}

function toast(message: string, kind: ToastKind = "info", ms = 2400): void {
  const host = ensureToastHost();
  const el = document.createElement("div");
  el.className = "obs-toast";
  el.dataset.kind = kind;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add("obs-toast--out");
    setTimeout(() => el.remove(), 250);
  }, ms);
}

/* ═════════════════════════════════════════════════════════════════════════
   Optional feature resolution
   ═════════════════════════════════════════════════════════════════════════ */
function tryIds(): { toggle?: () => void; isVisible?: () => boolean } | null {
  return (ctx.features as any).idsPanel ?? null;
}
function tryTree(): { toggle?: () => void; isVisible?: () => boolean } | null {
  return (ctx.features as any).modelTreePanel ?? null;
}
function tryPropertyPalette(): { open?: () => void; close?: () => void; isVisible?: () => boolean } | null {
  return (ctx.features as any).propertyPalette ?? null;
}

/* ═════════════════════════════════════════════════════════════════════════
   Left tools panel toggle
   ═════════════════════════════════════════════════════════════════════════ */
let leftPanelVisible = true;
function toggleLeftPanel() {
  leftPanelVisible = !leftPanelVisible;
  ctx.leftHost.style.display = leftPanelVisible ? "" : "none";
  window.dispatchEvent(new Event("resize"));
}

/* ═════════════════════════════════════════════════════════════════════════
   Root DOM
   ═════════════════════════════════════════════════════════════════════════ */
const root = document.createElement("div");
root.className = "obs-ribbon";

const tabsRow = document.createElement("div");
tabsRow.className = "obs-ribbon__tabs";

const strip = document.createElement("div");
strip.className = "obs-ribbon__strip";

const pill = document.createElement("div");
pill.className = "obs-ribbon__pill";

/** Revit-style ribbon minimize: double-click a tab (or tabs row) to collapse the strip
 *  so only the tab buttons remain (flat / shrunk). Double-click again to restore. */
let ribbonMinimized = false;
try {
  ribbonMinimized = localStorage.getItem("obs.ribbon.minimized") === "1";
} catch { /* */ }

function applyRibbonMinimize(min: boolean) {
  ribbonMinimized = min;
  if (min) {
    root.classList.add("obs-ribbon--minimized");
    strip.style.display = "none";
  } else {
    root.classList.remove("obs-ribbon--minimized");
    strip.style.display = "";
  }
  try { localStorage.setItem("obs.ribbon.minimized", min ? "1" : "0"); } catch { /* */ }
  // Notify plan view / others that ribbon height changed
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new CustomEvent("obs-ribbon-resize"));
}

function toggleRibbonMinimize() {
  applyRibbonMinimize(!ribbonMinimized);
}

/* ═════════════════════════════════════════════════════════════════════════
   Helpers
   ═════════════════════════════════════════════════════════════════════════ */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

interface BtnOpts {
  active?: boolean;
  title?: string;
  planned?: boolean;
  kbd?: string;
}

type Action = () => void | Promise<void>;

function b(
  icon: IconName,
  label: string,
  onclick: Action,
  activeOrOpts: boolean | BtnOpts = false,
  title = "",
): HTMLButtonElement {
  const opts: BtnOpts =
    typeof activeOrOpts === "boolean" ? { active: activeOrOpts, title } : activeOrOpts;
  const el = document.createElement("button");
  el.className = "obs-rb";
  const tip = opts.kbd ? `${label}  (${opts.kbd})` : (opts.title || label);
  el.title = tip;
  el.setAttribute("aria-label", label);
  if (opts.active) el.dataset.active = "1";
  if (opts.planned) el.dataset.planned = "1";
  el.innerHTML =
    `<span class="obs-rb__icon">${svgIcon(icon)}</span>` +
    `<span class="obs-rb__label">${esc(label)}</span>`;
  el.onclick = async () => {
    try {
      await onclick();
    } catch (err) {
      console.error("[ribbon] action failed", err);
      toast("Action failed — see console.", "warn", 3000);
    }
    renderStrip();
  };
  return el;
}

function planned(
  icon: IconName,
  label: string,
  hint = "This tool is planned for a future release.",
): HTMLButtonElement {
  return b(icon, label, () => toast(hint, "info"), { planned: true, title: `${label} — planned` });
}

function sep(): HTMLElement {
  const d = document.createElement("span");
  d.dataset.obsSep = "1";
  d.style.display = "none";
  return d;
}

function groupLabel(text: string): HTMLElement {
  const d = document.createElement("span");
  d.dataset.obsGroup = text;
  d.style.display = "none";
  return d;
}

function hint(text: string): HTMLElement {
  const s = document.createElement("span");
  s.dataset.obsHint = "1";
  s.textContent = text;
  return s;
}

function toolBtn(icon: IconName, label: string, tool: string, kbd = ""): HTMLButtonElement {
  let active = false;
  try {
    // Match internal tool or ribbon preset name
    const current = getActiveTool() as string | null;
    active = current === tool || (current != null && label.length > 0 && current === tool);
    try {
      const preset = (window as any).__obsAuthoring?.getActivePreset?.();
      if (preset === tool) active = true;
    } catch { /* */ }
  } catch { /* */ }
  return b(
    icon,
    label,
    safe(() => {
      try {
        const cur = getActiveTool() as string | null;
        let preset: string | null = null;
        try { preset = (window as any).__obsAuthoring?.getActivePreset?.() ?? null; } catch { /* */ }
        if (cur === tool || preset === tool) {
          setAuthoringTool(null);
          toast(`${label} off`, "info", 1200);
        } else {
          setAuthoringTool(tool as any);
          // If Floor Plan is open, route tool into 2D plan (Revit behaviour)
          try {
            const pv = (ctx.features as any).planView;
            if (pv?.isVisible?.()) {
              pv.setTool?.(tool);
              toast(`${label} — draw in Floor Plan (also creates 3D)`, "success", 2000);
            } else {
              toast(`${label} — click in the viewport to place`, "success", 1800);
            }
          } catch {
            toast(`${label} — click in the viewport to place`, "success", 1800);
          }
        }
      } catch (e) {
        toast(`Tool "${label}" failed — see console.`, "warn");
        console.warn("[ribbon] tool failed", tool, e);
      }
    }, label),
    { active, kbd, title: `${label} modeling tool` },
  );
}

function safe(fn: Action, label = "action"): Action {
  return async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[ribbon] ${label}`, err);
      toast(`${label} failed — see console.`, "warn", 3000);
    }
  };
}

function levelInput(): HTMLElement {
  const w = document.createElement("label");
  w.className = "obs-level-input";
  const caption = document.createElement("span");
  caption.textContent = "Level";
  const i = document.createElement("input");
  i.type = "number";
  i.step = "0.1";
  try {
    i.value = String(getLevel());
  } catch {
    i.value = "0";
  }
  i.title = "Current level elevation (m)";
  i.onchange = () => setLevel(Number(i.value) || 0);
  w.append(caption, i);
  return w;
}

function screenshotPresetInput(): HTMLElement {
  const w = document.createElement("label");
  w.className = "obs-level-input";
  const caption = document.createElement("span");
  caption.textContent = "Shot";
  const sel = document.createElement("select");
  sel.title = "Screenshot resolution";
  sel.style.cssText =
    "background:var(--bg-inset,#0e1017);border:1px solid var(--border-default,#2a2e3a);" +
    "color:var(--text-primary,#e8eaf0);font:500 10px var(--font-mono,monospace);" +
    "padding:3px 4px;border-radius:3px;cursor:pointer;min-width:64px;outline:none";
  sel.innerHTML =
    `<option value="current">Native</option>` +
    `<option value="hd">HD 1080p</option>` +
    `<option value="4k">4K UHD</option>` +
    `<option value="8k">8K UHD</option>`;
  try { sel.value = getScreenshotPreset(); } catch { sel.value = "hd"; }
  sel.onchange = () => {
    setScreenshotPreset(sel.value as ScreenshotPreset);
    toast(`Screenshot preset: ${sel.value.toUpperCase()}`, "info", 1500);
  };
  w.append(caption, sel);
  return w;
}

function idsButton(): HTMLButtonElement {
  const api = tryIds();
  return b(
    "ids",
    "IDS validation",
    safe(() => {
      if (api?.toggle) api.toggle();
      else toast("IDS panel not loaded.", "warn");
    }, "IDS panel"),
    { active: api?.isVisible?.() ?? false },
  );
}

function treeButton(): HTMLButtonElement {
  const api = tryTree();
  return b(
    "tree",
    "Model tree",
    safe(() => {
      if (api?.toggle) api.toggle();
      else toast("Model tree not loaded.", "warn");
    }, "Model tree"),
    { active: api?.isVisible?.() ?? false },
  );
}

function userInterfaceButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "User Interface — toggle panels and status bars";
  btn.style.cssText = "min-width:78px;max-width:96px;";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("tools-panel" as IconName)}</span>` +
    `<span class="obs-rb__label">User Interface` +
      `<span style="margin-left:3px;font-size:8px;opacity:.75">\u25BE</span>` +
    `</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const menu = (ctx.features as any).userInterfaceMenu;
    if (menu) menu.toggle(btn);
  };
  return btn;
}

function standardsButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "Standards - run compliance rule packs";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("check" as IconName)}</span>` +
    `<span class="obs-rb__label">Standards</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).standardsPanel;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function cdeButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "Common Data Environment - cloud storage";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("folder" as IconName)}</span>` +
    `<span class="obs-rb__label">CDE</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).cdePanel;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function modelHealthButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "Model Health - QA dashboard";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("check" as IconName)}</span>` +
    `<span class="obs-rb__label">Health</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).modelHealthPanel;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function systemBrowserButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "System Browser - MEP systems tree";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("tree" as IconName)}</span>` +
    `<span class="obs-rb__label">Systems</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).systemBrowser;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function mepFabButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "MEP Fabrication Parts catalog";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("tools-panel" as IconName)}</span>` +
    `<span class="obs-rb__label">Fab Parts</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).mepFabrication;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function pidModelerButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "P&ID Modeler - 2D process diagram";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("tools-panel" as IconName)}</span>` +
    `<span class="obs-rb__label">P&ID</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).pidModeler;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function sheets2dButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "Sheets - production drawing sheets";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("new-sheet" as IconName)}</span>` +
    `<span class="obs-rb__label">Sheets 2D</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).sheets2dPanel;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function bimObjectStudioButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "BIM Object Studio - parametric family browser";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("component" as IconName)}</span>` +
    `<span class="obs-rb__label">Objects</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    const svc = (ctx.features as any).bimObjectStudio;
    if (svc?.toggle) svc.toggle();
  };
  return btn;
}

function propertiesButton(): HTMLButtonElement {
  return b(
    "component",
    "Properties",
    safe(() => togglePropertyPalette(), "Properties"),
    {
      active: isPropertyPaletteVisible(),
      title: "Element & view properties (Revit-style)",
    },
  );
}

function projectBrowserButton(): HTMLButtonElement {
  return b(
    "tree",
    "Browser",
    safe(() => toggleProjectBrowser(), "Project Browser"),
    {
      active: isProjectBrowserVisible(),
      title: "Project Browser — Views, Sheets, Schedules, Families, Links",
    },
  );
}

/** AI chat toggle. Two ribbon tabs share this — File → AI, View → Panels. */
function aiChatButton(): HTMLButtonElement {
  return b(
    "system",
    "AI chat",
    safe(() => toggleAiChat(), "AI chat"),
    {
      active: isAiChatVisible(),
      title: "Open the AI assistant — ask questions or give orders",
    },
  );
}

function planButton(): HTMLButtonElement {
  return b("plan", "Plan", safe(() => togglePlanView(), "Plan view"), {
    active: isPlanViewVisible(),
  });
}

function schedulesButton(): HTMLButtonElement {
  return b("schedules", "Schedules", safe(() => toggleSchedules(), "Schedules"), {
    active: isSchedulesVisible(),
  });
}

/* ═════════════════════════════════════════════════════════════════════════
   State
   ═════════════════════════════════════════════════════════════════════════ */
let activeTab = "file";
let boundsOn = false;

/* ═════════════════════════════════════════════════════════════════════════
   BIM workspaces — focused command sets for production delivery.
   ═════════════════════════════════════════════════════════════════════════ */
const WORKSPACES = [
  { id: "authoring", label: "Authoring", caption: "Model + families", tab: "architecture" },
  { id: "mep", label: "MEP Delivery", caption: "Systems + coordination", tab: "mechanical" },
  { id: "coordination", label: "Coordination", caption: "Federation + alignment", tab: "coordinate" },
  { id: "qa", label: "QA / QC", caption: "Clash + IDS + issues", tab: "clash" },
  { id: "documentation", label: "Documentation", caption: "Sheets + views", tab: "view" },
  { id: "construction", label: "Construction", caption: "4D + 5D + automation", tab: "cost" },
] as const;
type WorkspaceId = typeof WORKSPACES[number]["id"];
let activeWorkspace: WorkspaceId = "coordination";
try {
  const saved = localStorage.getItem("obs.workspace");
  if (WORKSPACES.some((w) => w.id === saved)) activeWorkspace = saved as WorkspaceId;
} catch { /* private browsing / storage blocked */ }
function getWorkspaceDefinition(id: WorkspaceId) {
  return WORKSPACES.find((w) => w.id === id) ?? WORKSPACES[2];
}
function setActiveWorkspace(id: string) {
  if (!WORKSPACES.some((w) => w.id === id)) return;
  activeWorkspace = id as WorkspaceId;
  try { localStorage.setItem("obs.workspace", activeWorkspace); } catch { /* */ }
}

/* ═════════════════════════════════════════════════════════════════════════
   Tabs
   ═════════════════════════════════════════════════════════════════════════ */
const TABS: { id: string; label: string; items: () => HTMLElement[] }[] = [
  // ════════════════════════════════ FILE ═══════════════════════════════
  {
    id: "file",
    label: "File",
    items: () => [
      groupLabel("App"),
      b("menu", "Menu", safe(() => toggleFileMenu(), "File menu"), { active: isFileMenuVisible() }),
      b("home", "Home", safe(() => showHome(), "Home")),
      b("save", "Save", safe(() => void saveProject(), "Save"), { kbd: "^S" }),
      sep(),
      groupLabel("New"),
      b("home", "New Project", safe(() => showHome(), "New project")),
      b("new-sheet", "New Sheet", safe(() => {
        toggleSheetsPanel();
        toast("Sheets panel open — create production sheets", "info");
      }, "New sheet")),
      sep(),
      groupLabel("Open"),
      b("file", "IFC", safe(() => pickFiles(".ifc", true, loadIfcFiles), "IFC")),
      b("file-frag", "FRAG", safe(() => pickFiles(".frag", true, loadFragFiles), "FRAG")),
      b("folder", "Any file", safe(() => void pickAndImport(), "Import")),
      cdeButton(),
      sep(),
      groupLabel("Export"),
      b("cost-takeoff", "Cost", safe(() => recalculateTakeoff(), "Cost")),
      b("issues", "Issues", safe(() => toggleIssuesPanel(), "Issues"), { active: isIssuesPanelVisible() }),
      sep(),
      groupLabel("Doc"),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Sheets"), { active: isSheetsPanelVisible() }),
      b("plan", "Plan + CAD", safe(() => togglePlanView(), "Plan view with CAD link"), { active: isPlanViewVisible() }),
      sep(),
      groupLabel("AI"),
      aiChatButton(),
    ],
  },

  // ══════════════════════════ ARCHITECTURE ═════════════════════════════
  {
    id: "architecture",
    label: "Architecture",
    items: () => [
      groupLabel("Build"),
      toolBtn("wall", "Wall", "wall", "WA"),
      toolBtn("floor", "Floor", "slab", "SL"),
      toolBtn("roof", "Roof", "roof"),
      toolBtn("column", "Column", "column", "CM"),
      toolBtn("beam", "Beam", "beam", "BM"),
      toolBtn("component", "Comp", "equipment"),
      bimObjectStudioButton(),
      toolBtn("ceiling", "Ceiling", "ceiling"),
      sep(),
      groupLabel("Openings"),
      toolBtn("door", "Door", "door", "DR"),
      toolBtn("window", "Window", "window", "WN"),
      toolBtn("opening", "Opening", "opening"),
      toolBtn("shaft", "Shaft", "shaft"),
      sep(),
      groupLabel("Datum"),
      toolBtn("grid", "Grid", "grid", "GR"),
      toolBtn("level", "Level", "level", "LV"),
      toolBtn("ref-plane", "Ref plane", "ref-plane"),
      levelInput(),
      sep(),
      groupLabel("Direct Modeling"),
      b("move", "Push/Pull", safe(() => {
        const pp = (ctx.features as any).pushPull;
        if (pp?.isEnabled?.()) pp.disable(); else pp?.enable?.();
      }, "Push/Pull"), { kbd: "PU", title: "Push or pull a face (SketchUp-style)" }),
      b("slab", "Rectangle", safe(() => (ctx.features as any).primitives?.activateRectangle?.(), "Rectangle"), { title: "Rectangle - drag a floor" }),
      b("circle", "Circle", safe(() => (ctx.features as any).primitives?.activateCircle?.(), "Circle"), { title: "Circle - click center then radius" }),
      sep(),
      groupLabel("Modify"),
      toolBtn("select-all", "Select", "select", "Esc"),
      toolBtn("move", "Move", "move", "G"),
      toolBtn("copy", "Copy", "copy"),
      toolBtn("rotate", "Rotate", "rotate", "R"),
      toolBtn("mirror", "Mirror", "mirror"),
      toolBtn("array", "Array", "array"),
      toolBtn("offset", "Offset", "offset"),
      sep(),
      b("delete", "Delete", safe(() => deleteSelectedElement(), "Delete"), { kbd: "Del" }),
      b("clear", "Clear", safe(() => clearAllElements(), "Clear")),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ════════════════════════════ STRUCTURE ══════════════════════════════
  {
    id: "structure",
    label: "Structure",
    items: () => [
      groupLabel("Framing"),
      toolBtn("beam", "Beam", "beam", "BM"),
      toolBtn("column", "Column", "column", "CM"),
      toolBtn("brace", "Brace", "brace", "BR"),
      toolBtn("truss", "Truss", "truss", "TR"),
      toolBtn("wall", "Wall", "wall"),
      toolBtn("floor", "Floor", "slab"),
      sep(),
      groupLabel("Found"),
      toolBtn("footing", "Pad", "footing", "FT"),
      toolBtn("strip", "Strip", "strip", "SF"),
      toolBtn("slab", "Mat", "slab"),
      toolBtn("pile", "Pile", "pile"),
      sep(),
      groupLabel("Datum"),
      toolBtn("grid", "Grid", "grid", "GR"),
      toolBtn("level", "Level", "level", "LV"),
      levelInput(),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ════════════════════════════ MECHANICAL ═════════════════════════════
  {
    id: "mechanical",
    label: "Mechanical",
    items: () => [
      groupLabel("HVAC"),
      toolBtn("duct", "Duct", "duct", "DU"),
      toolBtn("duct-fitting", "Fitting", "duct-fitting"),
      toolBtn("air-terminal", "Terminal", "air-terminal"),
      toolBtn("flex-duct", "Flex", "flex-duct"),
      toolBtn("duct-accessory", "Accessory", "duct-accessory"),
      toolBtn("equipment", "Equip", "equipment"),
      sep(),
      groupLabel("Plumbing"),
      toolBtn("pipe", "Pipe", "pipe", "PP"),
      toolBtn("pipe-fitting", "Fitting", "pipe-fitting"),
      toolBtn("pipe-accessory", "Accessory", "pipe-accessory"),
      toolBtn("plumbing-fixture", "Fixture", "plumbing-fixture"),
      sep(),
      groupLabel("Fire"),
      toolBtn("sprinkler", "Sprinkler", "sprinkler"),
      toolBtn("sprinkler-main", "Main", "sprinkler-main"),
      toolBtn("fire-pump", "Pump", "fire-pump"),
      groupLabel("Systems"),
      systemBrowserButton(),
      mepFabButton(),
      pidModelerButton(),
      sep(),
      sep(),
      groupLabel("Display"),
      b("system", "MEP colors", safe(() => toggleMepColors(), "MEP colors"),
        { active: isMepColoringActive(),
          title: "Color MEP categories so fittings match the runs they belong to" }),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ════════════════════════════ ELECTRICAL ═════════════════════════════
  {
    id: "electrical",
    label: "Electrical",
    items: () => [
      groupLabel("Containment"),
      toolBtn("cable-tray", "Cable tray", "cable-tray"),
      toolBtn("cable-tray-fitting", "Tray Ftg", "cable-tray-fitting"),
      toolBtn("conduit", "Conduit", "conduit"),
      toolBtn("conduit-fitting", "Cond Ftg", "conduit-fitting"),
      sep(),
      groupLabel("Power"),
      toolBtn("wire", "Wire", "wire"),
      toolBtn("panel", "Panel", "panel"),
      toolBtn("switch", "Switch", "switch"),
      toolBtn("outlet", "Outlet", "outlet"),
      toolBtn("junction-box", "Box", "junction-box"),
      sep(),
      groupLabel("Lighting"),
      toolBtn("lighting-fixture", "Fixture", "lighting-fixture"),
      toolBtn("emergency-light", "Emergency", "emergency-light"),
      toolBtn("lighting-switch", "Switch", "lighting-switch"),
      sep(),
      groupLabel("Equipment"),
      toolBtn("equipment", "Equip", "equipment"),
      toolBtn("transformer", "Transformer", "transformer"),
      toolBtn("generator", "Generator", "generator"),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ══════════════════════════════ INSERT ═══════════════════════════════
  {
    id: "insert",
    label: "Insert",
    items: () => [
      // Order matches Old OpenBIMStudio Insert tab: Link / Import first
      groupLabel("Link / Import"),
      b("file", "IFC", safe(() => linkIfc(), "Link IFC"), {
        title: "Link IFC models — origin-to-origin federation (same as old OpenBIMStudio)",
      }),
      b("file-frag", "FRAG", safe(() => linkFrag(), "Link FRAG"), {
        title: "Load FRAG as-is — coordinates preserved (old FRAG linker)",
      }),
      b("folder", "Any model…", safe(() => void pickAndImport(), "Import any model"), {
        title: "Universal import (IFC / FRAG / OBJ / GLB / …)",
      }),
      sep(),
      groupLabel("Link CAD / Revit"),
      b("system", "Link CAD", safe(() => linkCad(), "Link CAD underlay"), {
        title: "DXF / SVG / PNG underlay for plan tracing, or 3D CAD reference",
      }),
      b("file", "Link Revit", safe(() => linkRevit(), "Link Revit via IFC"), {
        title: "Export IFC from Revit, then link here",
      }),
      b("component", "Point cloud", safe(() => linkPointCloud(), "Point cloud"), {
        title: "PLY / XYZ / PTS / PCD (multi-file)",
      }),
      b("toposurface", "Topography", safe(() => linkTopography(), "Topography"), {
        title: "Site mesh (OBJ / STL / PLY / GLB)",
      }),
      sep(),
      groupLabel("Load from Library"),
      b("new-family", "Family", safe(() => openFamilyLibrary(), "Types & materials"), {
        title: "Element types and materials library",
      }),
      b("component", "Autodesk", safe(() => linkAutodesk(), "Autodesk via IFC"), {
        title: "RVT / NWD / DWG — export open formats then import",
      }),
      b("new-sheet", "Library", safe(() => openComponentLibrary(), "Component library"), {
        title: "Materials, types and production library",
      }),
      sep(),
      groupLabel("Placement"),
      b("home", "Origin↔Origin", safe(() => alignOriginToOrigin(), "Origin to origin"), {
        title: "Force all linked models to identity (0,0,0) — Revit link style",
      }),
      b("fit", "Recenter", safe(() => recenterSceneNow(), "Recenter scene"), {
        title: "Recenter first model to origin (optional)",
      }),
      b("undo", "Reset offsets", safe(() => resetOffsets(), "Reset offsets"), {
        title: "Clear all placement offsets",
      }),
      sep(),
      groupLabel("Ext"),
      b("issues", "Issues", safe(() => toggleIssuesPanel(), "Issues"), { active: isIssuesPanelVisible() }),
      b("clash", "Clash", safe(() => {
        void refreshModelSelectionUI();
        try { ctx.leftHost.style.display = ""; } catch { /* */ }
        const tab = document.querySelector('[data-tab="clash"]') as HTMLElement | null;
        tab?.click();
      }, "Clash Detective"), { title: "Open Clash Detective" }),
      b("cost", "Cost", safe(() => toggleCostPanel(), "Cost"), { active: isCostPanelVisible() }),
      idsButton(),
      treeButton(),
      sep(),
      groupLabel("Views"),
      planButton(),
      schedulesButton(),
    ],
  },

  // ═════════════════════════════ ANNOTATE ══════════════════════════════
  {
    id: "annotate",
    label: "Annotate",
    items: () => [
      groupLabel("Dimension"),
      b("dim-aligned", "Aligned", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-aligned"), 40);
      }, "Aligned dimension"), {
        kbd: "DI", title: "Revit Aligned: pick two model boundaries",
      }),
      b("dim-linear", "Linear", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-linear"), 40);
      }, "Linear dimension"), {
        title: "Revit Linear: horizontal / vertical between two boundaries",
      }),
      b("dim-angular", "Angular", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-angular"), 40);
      }, "Angular dimension"), {
        title: "Revit Angular: pick two edges — interior angle",
      }),
      b("dim-radial", "Radial", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-radial"), 40);
      }, "Radial dimension"), {
        title: "Revit Radial: pick center then edge — R =",
      }),
      b("arc-length", "Arc", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-arc"), 40);
      }, "Arc length"), {
        title: "Revit Arc Length: two points along an edge",
      }),
      b("spot-elev", "Elevation", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("spot-elev"), 40);
      }, "Spot elevation"), {
        title: "Revit Spot Elevation: click a point",
      }),
      b("spot-coord", "Coordinate", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("spot-coord"), 40);
      }, "Spot coordinate"), {
        title: "Revit Spot Coordinate: click for X / Z",
      }),
      b("dim-radial", "Diameter", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-radial"), 40);
        toast("Diameter: pick a circle or arc", "info");
      }, "Diameter dimension")),
      b("spot-elev", "Slope", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("spot-elev"), 40);
        toast("Spot Slope: click a sloping edge", "info");
      }, "Spot slope")),      sep(),
      groupLabel("Detail"),
      b("detail-line", "Detail", safe(() => {
        setAuthoringTool("mline");
        toast("Detail line — click points to draw", "success");
      }, "Detail line")),
      b("detail-component", "Component", safe(() => {
        setAuthoringTool("equipment");
        toast("Detail component — place reference equipment", "success");
      }, "Detail component")),
      b("filled-region", "Filled", safe(() => {
        setAuthoringTool("slab");
        toast("Filled region — click polygon points, Enter to finish", "success");
      }, "Filled region")),
      b("masking-region", "Masking", safe(() => {
        setAuthoringTool("slab");
        toast("Masking region — draw polygon to mask", "success");
      }, "Masking region")),
      b("insulation", "Insulation", safe(() => {
        setAuthoringTool("mline");
        toast("Insulation line — draw along hosts", "success");
      }, "Insulation")),
      b("section", "Section Line", safe(() => {
        const pv = (ctx.features as any).viewsPanel;
        if (pv && !pv.isVisible()) pv.open();
        import("../modules/views/tools").then((m) => {
          m.toolState.setTool("section-line");
          window.dispatchEvent(new CustomEvent("obs-toast", {
            detail: { message: "Section Line - click two points in the plan view", kind: "info" },
          }));
        });
      }, "Section Line"), { title: "Draw a section cut line in the plan view" }),
      b("revision-cloud", "Cloud", safe(() => {
        setAuthoringTool("mline");
        toast("Revision cloud — sketch cloud outline", "success");
      }, "Revision cloud")),
      sep(),
      groupLabel("Text"),
      b("text", "Text", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("text"); return; }
        const t = prompt("Annotation text:", "Note");
        if (t != null && t.trim()) toast(`Text note saved: “${t.trim()}”`, "success");
      }, "Text note")),
      b("model-text", "3D text", safe(() => {
        const t = prompt("3D model text:", "ROOM");
        if (t != null && t.trim()) {
          setAuthoringTool("equipment");
          toast(`3D text “${t.trim()}” — place equipment marker as host`, "info");
        }
      }, "3D text")),
      b("tag", "Tag", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Tag: select an element — properties show category / type / id", "info");
        try { (ctx.features as any).propertyPalette?.show?.(); } catch { /* */ }
      }, "Tag")),
      b("tag-all", "Tag all", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Tag all: open Schedules for bulk element tagging", "info");
        try { toggleSchedules(); } catch { /* */ }
      }, "Tag all")),
      b("material-tag", "Material", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        openFamilyLibrary();
        toast("Material tags — assign from materials library", "info");
      }, "Material tag")),
      b("room-tag", "Room tag", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        setAuthoringTool("equipment");
        toast("Room tag — place a marker; name it in Properties", "success");
      }, "Room tag")),
      b("tag", "Multi-Cat", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Multi-Category tag: click elements", "info");
      }, "Multi-Category tag")),
      b("area", "Area", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Area tag: place an area marker", "info");
      }, "Area tag")),
      b("room-tag", "Space", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Space tag: place a space marker", "info");
      }, "Space tag")),
      b("view", "View Ref", safe(() => {
        toast("View Reference: pick a callout to link", "info");
      }, "View Reference")),
      b("stairs", "Tread", safe(() => {
        toast("Tread Number: annotate stair treads", "info");
      }, "Tread Number")),
      b("component", "Group", safe(() => {
        toast("Detail Group: group selected annotations", "info");
      }, "Detail Group")),
      b("check", "Spell", safe(() => {
        toast("Check Spelling: scan text annotations", "info");
      }, "Check Spelling")),
      b("report", "Find", safe(() => {
        toast("Find / Replace across text annotations", "info");
      }, "Find / Replace")),
      sep(),
      groupLabel("Legend"),
      b("text", "Keynote", safe(() => {
        toast("Keynote legend: pick a keynote file", "info");
      }, "Keynote")),
      b("duct", "Duct", safe(() => {
        toast("Duct Legend: place a duct system legend", "info");
      }, "Duct Legend")),
      b("pipe", "Pipe", safe(() => {
        toast("Pipe Legend: place a pipe system legend", "info");
      }, "Pipe Legend")),
      b("color-legend", "Color Fill", safe(() => {
        toast("Color Fill Legend: choose a color scheme", "info");
      }, "Color Fill Legend")),
      b("symbol", "Symbol", safe(() => {
        toast("Symbol: place a legend symbol", "info");
      }, "Symbol")),      sep(),
      b("clear", "Clear", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("clear-annotations"); return; }
        try { ctx.features.measure?.clear?.(); } catch { /* */ }
        toast("Annotations / measures cleared", "info");
      }, "Clear")),
    ],
  },

  // ════════════════════════════ BIM TOOLS ═════════════════════════════
  {
    id: "bim-tools",
    label: "BIM Tools",
    items: () => [
      groupLabel("Command Order"),
      b("tools-panel", "BIM Center", safe(() => toggleBimToolbox(), "BIM Command Center"), { active: isBimToolboxVisible() }),
      toolBtn("select-all", "Select", "select", "Esc"),
      b("settings", "Repeat", safe(() => {
        const cmd = getLastCommand();
        if (cmd) setAuthoringTool(cmd); else toast("No previous command to repeat.", "info");
      }, "Repeat last command"), { title: "Repeat the last authoring order" }),
      b("close", "Cancel", safe(() => setAuthoringTool(null), "Cancel current order"), { title: "Cancel active command and return to Select" }),
      sep(),
      groupLabel("Modify"),
      toolBtn("move", "Move", "move", "G"),
      toolBtn("copy", "Copy", "copy"),
      toolBtn("rotate", "Rotate", "rotate", "R"),
      toolBtn("mirror", "Mirror", "mirror"),
      toolBtn("array", "Array", "array"),
      toolBtn("offset", "Offset", "offset"),
      b("anchor", "Pin", safe(() => { const n = pinSelected(true); toast(n ? `Pinned ${n} element(s).` : "Select authored elements.", n ? "success" : "warn"); }, "Pin selected elements")),
      b("anchor", "Unpin", safe(() => { const n = pinSelected(false); toast(n ? `Unpinned ${n} element(s).` : "No authored selection.", n ? "success" : "warn"); }, "Unpin selected elements")),
      sep(),
      groupLabel("Annotation"),
      b("dim-aligned", "Aligned Dim", safe(() => { if (!isPlanViewVisible()) togglePlanView(); (ctx.features as any).planView?.setTool?.("dim-aligned"); }, "Aligned dimension")),
      b("dim-linear", "Linear Dim", safe(() => { if (!isPlanViewVisible()) togglePlanView(); (ctx.features as any).planView?.setTool?.("dim-linear"); }, "Linear dimension")),
      b("tag", "Tag", safe(() => { if (!isPlanViewVisible()) togglePlanView(); (ctx.features as any).planView?.setTool?.("tag"); }, "Tag")),
      b("text", "Text", safe(() => { if (!isPlanViewVisible()) togglePlanView(); (ctx.features as any).planView?.setTool?.("text"); }, "Text note")),
      sep(),
      groupLabel("Graphics"),
      b("tools-panel", "Graphics", safe(() => toggleBimToolbox(), "View & Visual Appearance"), { active: isBimToolboxVisible() }),
      b("system", "MEP Colors", safe(() => toggleMepColors(), "MEP discipline colors"), { active: isMepColoringActive() }),
      b("plan", "Plan", safe(() => togglePlanView(), "Plan workspace"), { active: isPlanViewVisible() }),
      sep(),
      groupLabel("Delivery"),
      b("folder", "Browser", safe(() => { toggleProjectBrowser(); }, "Project Browser"), { active: isProjectBrowserVisible() }),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Sheets"), { active: isSheetsPanelVisible() }),
      b("folder-recent", "Views", safe(() => toggleSavedViewsPanel(), "Saved views"), { active: isSavedViewsPanelVisible() }),
    ],
  },

  // ════════════════════════════ ANALYZE ════════════════════════════════
  {
    id: "analyze",
    label: "Analyze",
    items: () => [
      groupLabel("Validation"),
      idsButton(),
      b("cost", "Quantities", safe(() => toggleCostPanel(), "Quantities"), { active: isCostPanelVisible() }),
      modelHealthButton(),
      schedulesButton(),
      sep(),
      groupLabel("4D / Time"),
      b("schedule", "4D Sim", safe(() => toggleTimelinePanel(), "4D construction simulation"), {
        active: isTimelinePanelVisible(),
      }),
      sep(),
      groupLabel("Clash"),
      b("clash", "Clash Detective", safe(() => {
        // Jump to dedicated Clash Detective tab instead of duplicating controls
        const tab = document.querySelector('[data-tab="clash"]') as HTMLElement | null;
        tab?.click();
        void runElementClashDetection();
      }, "Open Clash Detective")),
    ],
  },

  // ═════════════════════════ MASSING & SITE ════════════════════════════
  {
    id: "site",
    label: "Massing & Site",
    items: () => [
      groupLabel("Mass"),
      b("mass", "In-place", safe(() => { setAuthoringTool("slab"); toast("Concept Mass: sketch a closed volume footprint", "success"); }, "In-place Mass")),
      b("mass", "Load Mass", safe(() => { openComponentLibrary(); toast("Mass / component library opened", "info"); }, "Load Mass")),
      b("mass-floor", "Floor", safe(() => { setAuthoringTool("slab"); toast("Mass Floor: sketch the mass footprint", "success"); }, "Mass Floor")),
      b("opening", "Opening", safe(() => { setAuthoringTool("door"); toast("Mass Opening: place on the mass host", "success"); }, "Mass Opening")),
      sep(),
      groupLabel("Topography"),
      b("toposurface", "Toposurface", safe(() => void linkTopography(), "Toposurface")),
      b("building-pad", "Pad", safe(() => { setAuthoringTool("footing"); toast("Building Pad: place a site foundation footprint", "success"); }, "Building Pad")),
      b("property-line", "Property", safe(() => { setAuthoringTool("mline"); toast("Property Line: draw a closed site boundary", "success"); }, "Property Line")),
      b("site-component", "Component", safe(() => void openComponentLibrary(), "Site Component")),
      b("parking", "Parking", safe(() => { setAuthoringTool("equipment"); toast("Parking Component: place and edit in Properties", "success"); }, "Parking")),
      sep(),
      groupLabel("Site"),
      b("graded-region", "Region", safe(() => { setAuthoringTool("slab"); toast("Graded Region: sketch the site region", "success"); }, "Graded Region")),
      b("subregion", "Subregion", safe(() => { setAuthoringTool("mline"); toast("Subregion boundary: draw within the topography", "success"); }, "Subregion")),
      b("split-surface", "Split", safe(() => { setAuthoringTool("mline"); toast("Split Surface: sketch the split line", "success"); }, "Split Surface")),
      b("site-settings", "Settings", safe(() => void openProjectInfo(), "Site Settings")),
    ],
  },

  // ════════════════════════════ COORDINATE ═════════════════════════════
  {
    id: "coordinate",
    label: "Coordinate",
    items: () => [
      groupLabel("Review"),
      b("measure", "Measure", safe(() => toggleMeasure(), "Measure"), { active: isMeasureEnabled() }),
      b("section", "Section", safe(() => toggleSection(), "Section"), { active: isSectionOn() }),
      sep(),
      groupLabel("Placement"),
      b("origin", "Origin↔Origin", safe(() => alignOriginToOrigin(), "Origin")),
      b("recenter", "Recenter", safe(() => recenterSceneNow(), "Recenter")),
      b("reset-offsets", "Reset", safe(() => resetOffsets(), "Reset offsets")),
      b("refresh", "Refresh", safe(() => void refreshModelSelectionUI(), "Refresh models")),
    ],
  },

  // ══════════════════════════ CLASH DETECTIVE ══════════════════════════
  {
    id: "clash",
    label: "Clash Detective",
    items: () => [
      groupLabel("Tests"),
      b("save", "Save", safe(() => {
        const name = prompt("Scenario name:", "Scenario");
        if (name == null) return;
        createScenario(name.trim() || "Scenario");
      }, "Save scenario"), { title: "Save current A/B + scope + rules + statuses as a scenario" }),
      b("folder-recent", "Load", safe(() => {
        const list = listScenarios();
        if (!list.length) { toast("No saved scenarios.", "info"); return; }
        const names = list.map((s, i) => `${i + 1}. ${s.name}`).join("\n");
        const pick = prompt(`Load scenario (1-${list.length}):\n${names}`, "1");
        if (!pick) return;
        const idx = Math.max(0, Math.min(list.length - 1, parseInt(pick, 10) - 1));
        void loadScenario(list[idx].id);
      }, "Load scenario"), { title: "Load a saved clash scenario" }),
      b("csv", "Export", safe(() => exportScenariosJson(), "Export scenarios"),
        { title: "Export all saved scenarios to a JSON file" }),
      b("folder", "Import", safe(() => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "application/json,.json";
        input.onchange = () => {
          if (input.files?.[0]) void importScenariosJson(input.files[0]);
        };
        input.click();
      }, "Import scenarios"), { title: "Import scenarios from a JSON file" }),
      sep(),

      groupLabel("Select"),
      b("select-all", "→ A", safe(() => addSelectionToA(), "Add to A"),
        { title: "Add the current viewport selection's categories to Selection A" }),
      b("show-all", "→ B", safe(() => addSelectionToB(), "Add to B"),
        { title: "Add the current viewport selection's categories to Selection B" }),
      b("mirror", "Swap", safe(() => swapSelections(), "Swap"),
        { title: "Swap Selection A ↔ B" }),
      b("delete", "Clear A", safe(() => clearSelectionA(), "Clear A"),
        { title: "Clear Selection A" }),
      b("clear", "Clear B", safe(() => clearSelectionB(), "Clear B"),
        { title: "Clear Selection B" }),
      sep(),

      groupLabel("Rules"),
      b("crop-shrink", "Tol −", safe(() => changeTolerance(-0.005), "Tolerance −"),
        { title: "Reduce the contact tolerance by 5 mm" }),
      b("crop-expand", "Tol +", safe(() => changeTolerance(0.005), "Tolerance +"),
        { title: "Increase the contact tolerance by 5 mm" }),
      b("clearance", "Clr −", safe(() => changeClearance(-0.1), "Clearance −"),
        { title: "Reduce the clearance band by 10 cm" }),
      b("interference", "Clr +", safe(() => changeClearance(0.1), "Clearance +"),
        { title: "Increase the clearance band by 10 cm" }),
      b("settings", "Rules…", safe(() => {
        alert(
          `Clash rules:\n\n` +
          `Tolerance:      ${(getTolerance() * 1000).toFixed(0)} mm\n` +
          `Clearance band: ${(getClearance() * 100).toFixed(0)} cm\n\n` +
          `Full editor: left panel → Clash Detection.`,
        );
      }, "Rules"), { title: "Show the current tolerance and clearance settings" }),
      sep(),

      groupLabel("Run"),
      b("clash", "Run Test", safe(() => runElementClashDetection(), "Run clash"),
        { kbd: "F5", title: "Execute the current clash test — Selection A vs Selection B" }),
      b("refresh", "Refresh", safe(() => refreshModelSelectionUI(), "Refresh sets"),
        { title: "Reload the A / B category tree from the loaded models" }),
      b("close", "Cancel", safe(() => cancelClash(), "Cancel"),
        { title: "Stop the currently running clash engine" }),
      b("clear", "Reset", safe(() => clearClash(), "Clear results"),
        { title: "Remove all clash results and highlights" }),
      sep(),

      groupLabel("Review"),
      b("back", "Prev", safe(() => focusPreviousClash(), "Previous"),
        { kbd: "[", title: "Focus the previous clash" }),
      b("front", "Next", safe(() => focusNextClash(), "Next"),
        { kbd: "]", title: "Focus the next clash" }),
      b("origin", "Re-focus", safe(() => focusActiveClash(), "Focus"),
        { title: "Re-highlight and re-crop the active clash" }),
      b("crop-expand", "Crop +", safe(() => changeCropMargin(0.1), "Crop +"),
        { title: "Enlarge the crop box by 10 cm" }),
      b("crop-shrink", "Crop −", safe(() => changeCropMargin(-0.1), "Crop −"),
        { title: "Shrink the crop box by 10 cm" }),
      b("crop-remove", "Crop ✕", safe(() => { removeCropBox(); fitAll(); }, "Remove crop"),
        { title: "Remove the crop box" }),
      sep(),

      groupLabel("Status"),
      b("new-file", "New", safe(() => setStatusForAll("new"), "All New"),
        { title: "Mark every clash as New" }),
      b("energy", "Active", safe(() => setStatusForAll("active"), "All Active"),
        { title: "Mark every clash as Active" }),
      b("check", "Reviewed", safe(() => setStatusForAll("reviewed"), "All Reviewed"),
        { title: "Mark every clash as Reviewed" }),
      b("symbol", "Approved", safe(() => setStatusForAll("approved"), "All Approved"),
        { title: "Mark every clash as Approved" }),
      b("ids", "Resolved", safe(() => setStatusForAll("resolved"), "All Resolved"),
        { title: "Mark every clash as Resolved" }),
      b("refresh", "Cycle", safe(() => cycleActiveClashStatus(), "Cycle status"),
        { title: "Cycle the focused clash through New → Active → Reviewed → Approved → Resolved" }),
      sep(),

      groupLabel("Isolate"),
      b("isolate", "Only A", safe(() => isolateSelectionA(), "Isolate A"),
        { title: "Hide everything except Selection A" }),
      b("bounds", "Only B", safe(() => isolateSelectionB(), "Isolate B"),
        { title: "Hide everything except Selection B" }),
      b("show-all", "Show All", safe(() => showAllElements(), "Show all"),
        { title: "Undo any isolate / hide operation" }),
      sep(),

      groupLabel("Report"),
      b("report", "Preview", safe(() => previewClashReportHtml(), "Preview report"),
        { title: "Open the clash report in a new tab" }),
      b("save", "HTML", safe(() => exportClashReportHtml(), "HTML report"),
        { title: "Download the report as a self-contained HTML file" }),
      b("csv", "CSV", safe(() => exportClashCsv(), "CSV report"),
        { title: "Export the clash table as CSV (Excel-ready)" }),
      b("new-sheet", "XLS", safe(() => exportClashReportXls(), "XLS report"),
        { title: "Export the clash table as an Excel spreadsheet" }),
      sep(),

      groupLabel("Coordinates"),
      b("origin", "Origin↔Origin", safe(() => alignOriginToOrigin(), "Origin"),
        { title: "Keep shared project coordinates (Revit-style)" }),
      b("recenter", "Recenter", safe(() => recenterSceneNow(), "Recenter"),
        { title: "Move the first model to the scene origin" }),
      b("reset-offsets", "Reset", safe(() => resetOffsets(), "Reset"),
        { title: "Place models as authored" }),
      b("origin", "Publish", safe(() => { void alignOriginToOrigin(); toast("Shared Coordinates: publish current project origin relationship", "success"); }, "Publish Coordinates")),
      b("origin", "Acquire", safe(() => { void alignOriginToOrigin(); toast("Shared Coordinates: acquire alignment from linked context", "success"); }, "Acquire Coordinates")),
      b("origin", "Specify", safe(() => void openProjectInfo(), "Specify Coordinates")),
      sep(),

      hint(`Navisworks-style · ${getClashCount()} result(s) · A vs B · F5 runs · [ ] navigates`),
    ],
  },

  // ══════════════════════════════ EDIT ═════════════════════════════════
  {
    id: "edit",
    label: "Edit",
    items: () => [
      groupLabel("BIM Authoring"),
      b("component", "BIM Objects", safe(() => toggleBimObjectStudio(), "BIM Object Studio"), {
        active: isBimObjectStudioVisible(),
        title: "Open the professional BIM Object Studio: searchable Architecture, Structure, MEP, Fire, Electrical, ELV, Site and Generic families",
      }),
      sep(),
      groupLabel("Element"),
      b("move", "Make Editable", safe(async () => {
        const n = await beginEditFromSelection();
        if (!n) toast("Nothing selected — pick elements in the viewport first.", "warn");
        else toast(`Editing ${n} element(s). Drag the gizmo.`, "success");
      }, "Edit selected"), {
        title: "Create professional Native Twins from linked IFC/FRAG elements while preserving the source object, exact geometry, dimensions and BIM metadata",
      }),
      b("folder-recent", "Edits", safe(() => toggleFragEditPanel(), "FRAG edits panel"), {
        active: isFragEditPanelVisible(),
        title: "Show the FRAG edits panel",
      }),
      b("close", "Cancel", safe(async () => {
        const id = getSelectedEditId();
        if (!id) { toast("No edit selected.", "warn"); return; }
        await removeEdit(id);
        toast("Edit reverted.", "info");
      }, "Revert edit"), {
        title: "Revert the currently selected edit — restores the original element",
      }),
      b("clear", "Clear All", safe(async () => {
        if (!getEditCount()) { toast("No edits to clear.", "info"); return; }
        if (!confirm(`Revert all ${getEditCount()} edit(s)?`)) return;
        await clearAllEdits();
        toast("All edits reverted.", "success");
      }, "Clear all edits"), {
        title: "Revert every FRAG edit and restore all originals",
      }),
      sep(),

      groupLabel("Gizmo"),
      b("move", "Move", safe(() => gizmo_setMode("move"), "Move"), {
        active: gizmo_getMode() === "move",
        title: "Move mode — drag the coloured arrows",
      }),
      b("rotate", "Rotate", safe(() => gizmo_setMode("rotate"), "Rotate"), {
        active: gizmo_getMode() === "rotate",
        title: "Rotate mode — drag the coloured rings",
      }),
      b("component", "Scale", safe(() => gizmo_setMode("scale"), "Scale"), {
        active: gizmo_getMode() === "scale",
        title: "Scale mode — drag the coloured handles",
      }),
      b("close", "Off", safe(() => gizmo_setMode("none"), "Off"), {
        active: gizmo_getMode() === "none",
        title: "Turn the gizmo off",
      }),
      sep(),
      groupLabel("Snaps"),
      b("origin", "Snap settings", safe(() => toggleSnapSettings(), "Object snaps"), {
        active: isSnapSettingsVisible(),
        title: "Endpoint, midpoint, center, grid, intersection, perpendicular, nearest, vertex…",
      }),
      b("grid", "All snaps", safe(() => { snapping.enableAllTypes(); snapping.setEnabled(true); toast("All object snaps ON", "success"); }, "Enable all snaps")),
      b("clear", "Snaps off", safe(() => { snapping.setEnabled(false); toast("Snaps OFF", "info"); }, "Disable snaps")),
      sep(),

      groupLabel("Focus"),
      b("origin", "Focus", safe(() => {
        const id = getSelectedEditId();
        if (!id) { toast("No edit selected.", "warn"); return; }
        focusEdit(id);
      }, "Focus"), {
        title: "Zoom the camera to the selected edit",
      }),
      b("show-all", "Revert All", safe(async () => {
        if (!getEditCount()) { toast("No edits.", "info"); return; }
        if (!confirm(`Revert all ${getEditCount()} edit(s)?`)) return;
        await clearAllEdits();
      }, "Revert all"), {
        title: "Revert every edit and unhide all originals",
      }),
      sep(),

      hint(`${getEditCount()} element(s) edited · changes persist in the project`),
    ],
  },

  // ══════════════════════════════ VIEW ═════════════════════════════════
  // Revit-class View ribbon: Graphics · Presentation · Create · Sheets · Windows
  {
    id: "view",
    label: "View",
    items: () => [
      // ── Select ──────────────────────────────────────────────────────
      groupLabel("Select"),
      toolBtn("select-all", "Modify", "select", "Esc"),
      sep(),

      // ── Graphics (VVG / Thin Lines / Hidden) ────────────────────────
      groupLabel("Graphics"),
      b("tree", "Visibility", safe(() => {
        try { toggleModelTreePanel(); } catch { /* */ }
        toast("Visibility/Graphics — use Model Tree eye icons to hide categories", "info");
      }, "Visibility/Graphics"), {
        title: "Visibility/Graphics overrides — Model Tree category visibility",
      }),
      b("system", "Filters", safe(() => {
        try { toggleModelTreePanel(); } catch { /* */ }
        toast("Filters — filter by category in Model Tree / search", "info");
      }, "View filters"), { title: "View filters by category" }),
      b("mline", "Thin Lines", safe(() => {
        const on = !(window as any).__obsThinLines;
        (window as any).__obsThinLines = on;
        try {
          ctx.world.scene.three.traverse((o: any) => {
            if (o?.isLine || o?.isLineSegments) {
              if (o.material) {
                o.material.linewidth = on ? 1 : 2;
                o.material.needsUpdate = true;
              }
            }
          });
        } catch { /* */ }
        toast(on ? "Thin lines ON" : "Thin lines OFF", "info");
        refreshRibbon();
      }, "Thin lines"), {
        active: !!(window as any).__obsThinLines,
        title: "Thin lines — consistent line weight in model views",
      }),
      b("section", "Hidden", safe(() => {
        const on = !(window as any).__obsShowHidden;
        (window as any).__obsShowHidden = on;
        try {
          const hider = (ctx as any).hider;
          if (on) hider?.showAll?.();
          toast(on ? "Show hidden elements" : "Hidden elements restored", "info");
        } catch {
          toast("Hidden lines toggle", "info");
        }
        refreshRibbon();
      }, "Show hidden"), {
        active: !!(window as any).__obsShowHidden,
        title: "Show / restore hidden elements",
      }),
      b("system", "MEP colors", safe(() => toggleMepColors(), "MEP colors"), {
        active: isMepColoringActive(),
        title: "Color MEP categories (ducts, pipes, trays)",
      }),
      b("bounds", "Bounds", safe(() => { boundsOn = !boundsOn; showBoundsHelpers(boundsOn); }, "Bounds"),
        { active: boundsOn }),
      sep(),

      // ── Presentation ────────────────────────────────────────────────
      groupLabel("Presentation"),
      b("camera", "Render", safe(() => takeScreenshot(), "Render / screenshot"), {
        title: `Capture view (${getScreenshotPreset().toUpperCase()})`,
      }),
      screenshotPresetInput(),
      b("folder-recent", "Gallery", safe(() => toggleSavedViewsPanel(), "Render gallery / saved views"), {
        active: isSavedViewsPanelVisible(),
        title: "Saved views & capture gallery",
      }),
      b("walk", "Walk", safe(() => toggleWalkMode(), "Walk mode"), {
        active: isWalkModeEnabled(),
        title: "First-person walk (WASD + mouse)",
      }),
      sep(),

      // ── Create views ────────────────────────────────────────────────
      groupLabel("Create"),
      b("viewcube", "3D View", safe(() => {
        goHome();
        fitAll();
        toast("3D View — default perspective", "success");
      }, "3D View"), { title: "Default 3D view" }),
      planButton(),
      b("section", "Section", safe(() => toggleSection(), "Section"), {
        active: isSectionOn(),
        title: "Section plane",
      }),
      b("iso-ne", "Elevation", safe(() => {
        gotoDir(new THREE.Vector3(0, 0, 1));
        toast("Elevation — Front", "success");
      }, "Elevation"), { title: "Elevation view (Front)" }),
      b("folder-recent", "Duplicate", safe(() => {
        saveCurrentView(`Copy ${listSavedViews().length + 1}`);
        toast("View duplicated to Saved Views", "success");
      }, "Duplicate view"), { title: "Duplicate current camera to Saved Views" }),
      b("new-sheet", "Legends", safe(() => {
        toggleSchedules();
        toast("Legends / schedules panel", "info");
      }, "Legends"), { title: "Legends via Schedules panel" }),
      sep(),

      // ── Schedules ───────────────────────────────────────────────────
      groupLabel("Schedules"),
      schedulesButton(),
      b("cost", "Quantities", safe(() => toggleCostPanel(), "Quantities"), {
        active: isCostPanelVisible(),
      }),
      sep(),

      // ── Sheet composition ───────────────────────────────────────────
      groupLabel("Sheets"),
      b("new-sheet", "Sheet", safe(async () => {
        try {
          const m = await import("../modules/sheets/sheets");
          m.createSheet();
        } catch { /* */ }
        toggleSheetsPanel();
      }, "Sheet"), { title: "Create / manage drawing sheets" }),
      b("new-sheet", "Title blk", safe(() => {
        toggleSheetsPanel();
        toast("Title blocks — edit in Sheets panel", "info");
      }, "Title block"), { title: "Title block on sheets" }),
      b("issues", "Revisions", safe(() => toggleIssuesPanel(), "Revisions"), {
        active: isIssuesPanelVisible(),
        title: "Issues / revision clouds",
      }),
      b("grid", "Guide grid", safe(() => {
        try {
          setAuthoringTool("grid");
          toast("Guide grid — click start → end", "success");
        } catch { /* */ }
      }, "Guide grid"), { title: "Draw a guide grid line" }),
      sep(),

      // ── Orient ──────────────────────────────────────────────────────
      groupLabel("Orient"),
      b(getProjection() === "orthographic" ? "orthographic" : "perspective",
        getProjection() === "orthographic" ? "Ortho" : "Persp",
        safe(() => {
          const next = getProjection() === "orthographic" ? "perspective" : "orthographic";
          setProjection(next);
          toast(next === "orthographic" ? "Orthographic view" : "Perspective view", "success", 1200);
          refreshRibbon();
        }, "Toggle Perspective / Orthographic"), {
          title: "Toggle Perspective ↔ Orthographic projection",
        }),
      b("fit", "Fit", safe(() => fitAll(), "Fit"), { kbd: "F" }),
      b("home", "Home", safe(() => goHome(), "Home")),
      b("top", "Top", safe(() => gotoDir(new THREE.Vector3(0, 1, 0)), "Top")),
      b("front", "Front", safe(() => gotoDir(new THREE.Vector3(0, 0, 1)), "Front")),
      b("right", "Right", safe(() => gotoDir(new THREE.Vector3(1, 0, 0)), "Right")),
      b("iso-ne", "NE", safe(() => gotoDir(new THREE.Vector3(1, 0.7, -1)), "Iso NE")),
      b("iso-nw", "NW", safe(() => gotoDir(new THREE.Vector3(-1, 0.7, -1)), "Iso NW")),
      b("iso-se", "SE", safe(() => gotoDir(new THREE.Vector3(1, 0.7, 1)), "Iso SE")),
      b("iso-sw", "SW", safe(() => gotoDir(new THREE.Vector3(-1, 0.7, 1)), "Iso SW")),
      // ViewCube removed from platform
      sep(),

      // ── Windows / UI ────────────────────────────────────────────────
      groupLabel("Windows"),
      projectBrowserButton(),
      treeButton(),
      propertiesButton(),
      userInterfaceButton(),
      sheets2dButton(),
      b("folder-recent", "Views", safe(() => toggleSavedViewsPanel(), "Saved views"), {
        active: isSavedViewsPanelVisible(),
      }),
      groupLabel("Bars"),
      b("settings", "Options", safe(() => {
        const on = toggleOptionsBar();
        toast(on ? "Options Bar shown" : "Options Bar hidden", "info", 1200);
        refreshRibbon();
      }, "Options Bar"), {
        active: isOptionsBarVisible(),
        title: "Show / hide the Options Bar under the ribbon (Revit Options Bar)",
      }),
      b("modify", "Modify bar", safe(() => {
        const on = toggleContextualBar();
        toast(on ? "Modify bar shown" : "Modify bar hidden", "info", 1200);
        refreshRibbon();
      }, "Modify / contextual bar"), {
        active: isContextualBarVisible(),
        title: "Show / hide the Modify contextual bar under the ribbon",
      }),
      b("view", "View bar", safe(() => {
        const on = toggleViewBar();
        toast(on ? "View control bar shown" : "View control bar hidden", "info", 1200);
        refreshRibbon();
      }, "View control bar"), {
        active: isViewBarVisible(),
        title: "Show / hide the bottom view control bar (scale, detail, discipline)",
      }),
      sep(),
      groupLabel("Windows"),
      b("tools-panel", "Tools", safe(() => toggleLeftPanel(), "Tools panel"), { active: leftPanelVisible }),
      aiChatButton(),
      b("tools-panel", "BIM Center", safe(() => toggleBimToolbox(), "BIM Command Center"), {
        active: isBimToolboxVisible(),
        title: "Revit-style modeling order, modify, annotation, dimensioning, visibility and graphics controls",
      }),
      b("right", "Tile L", safe(() => {
        const api = (ctx.features as any).leftPanel;
        if (!api) { toast("Left panel not loaded.", "warn"); return; }
        api.dockLeft();
        toast("Panel tiled left", "info", 1200);
      }, "Tile left"), { title: "Dock tools panel left" }),
      b("left", "Tile R", safe(() => {
        const api = (ctx.features as any).leftPanel;
        if (!api) { toast("Left panel not loaded.", "warn"); return; }
        api.dockRight();
        toast("Panel tiled right", "info", 1200);
      }, "Tile right"), { title: "Dock tools panel right" }),
      b("crop-reset", "Close all", safe(() => {
        try { toggleOptionsBar(false); } catch { /* */ }
        try { toggleContextualBar(false); } catch { /* */ }
        try { toggleProjectBrowser(); } catch { /* */ }
        try {
          const api = (ctx.features as any).leftPanel;
          if (leftPanelVisible) api?.toggle?.();
        } catch { /* */ }
        try {
          if (isPropertyPaletteVisible()) togglePropertyPalette();
        } catch { /* */ }
        toast("Bars and floating panels closed", "info");
        refreshRibbon();
      }, "Close inactive"), { title: "Close options/modify bars and floating panels" }),
      b("settings", "Cmd", safe(() => togglePalette(), "Command palette"), {
        kbd: "^P",
        title: "Command palette (Ctrl+P)",
      }),
      b("fit", "Recover", safe(() => {
        (ctx.cam as any)?.recoverView?.();
      }, "Recover view"), {
        title: "Recompute bounds and fit all",
      }),
    ],
  },

  // ════════════════════════════ MANAGE ═════════════════════════════════
  {
    id: "manage",
    label: "Manage",
    items: () => [
      groupLabel("Project"),
      b("settings", "Info", safe(() => openProjectInfo(), "Project information"), {
        title: "Project Control Center — identity, status, units and delivery metadata",
      }),
      b("dim-linear", "Units", safe(() => openProjectInfo(), "Project units"), {
        title: "Project units and delivery settings",
      }),
      b("new-file", "Parameters", safe(() => {
        togglePropertyPalette();
        toast("Parameters are managed from the Properties panel", "info");
      }, "Project parameters"), {
        title: "Open the Properties panel for project and shared parameters",
      }),
      b("component", "Materials", safe(() => {
        toggleProjectBrowser();
        toast("Materials are available from Project Browser → Materials", "info");
      }, "Materials library"), {
        title: "Open Project Browser and manage materials",
      }),
      b("wall", "Styles", safe(() => void openFamilyLibrary(), "Styles / Type Library"), { title: "Open element type and family-style library" }),
      sep(),
      // Position / Project North / True North removed — world north only.
      groupLabel("Production"),
            standardsButton(),
      sep(),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Drawing sheets"), {
        active: isSheetsPanelVisible(),
      }),
      b("tools-panel", "Automate", safe(() => toggleAutomationPanel(), "Automation rules"), {
        active: isAutomationPanelVisible(),
      }),
      b("tools-panel", "BIM Center", safe(() => toggleBimToolbox(), "BIM Command Center"), {
        active: isBimToolboxVisible(),
        title: "Cross-discipline Revit-style BIM command order and graphics controls",
      }),
      sep(),
      groupLabel("Selection"),
      b("select-all", "All", safe(async () => {
        const r = await selectAllObjects();
        toast(
          `Selected ${r.fragments} model element(s) + ${r.authored} authored element(s)`,
          "success",
          2200,
        );
      }, "Select all"), { kbd: "^A", title: "Select every element in every loaded model plus every authored element" }),
      b("clear", "Clear", safe(() => void clearAllSelection(), "Clear all"),
        { title: "Clear both model and authored selection" }),
      b("isolate", "Isolate", safe(() => {
        try {
          const sel = (ctx.features as any).selection;
          const snap = sel?.snapshot?.();
          if (snap && Object.keys(snap).length && ctx.hider) {
            (ctx.hider as any).isolate?.(snap);
          } else toast("Nothing selected.", "warn");
        } catch { /* */ }
      }, "Isolate")),
      b("show-all", "Show", safe(() => {
        try { (ctx.hider as any).show?.(); } catch { /* */ }
      }, "Show all")),
      sep(),
      groupLabel("Reset"),
      b("measure", "Measure", safe(() => { try { ctx.features.measure?.clear?.(); } catch { /* */ } }, "Clear measure")),
      b("section", "Planes", safe(() => { try { ctx.clipper.deleteAll(); } catch { /* */ } }, "Planes")),
      sep(),
      groupLabel("Panels"),
      projectBrowserButton(),
      b("cost", "Cost", safe(() => toggleCostPanel(), "Cost"), { active: isCostPanelVisible() }),
      b("issues", "Issues", safe(() => toggleIssuesPanel(), "Issues"), { active: isIssuesPanelVisible() }),
      treeButton(),
      idsButton(),
      planButton(),
      schedulesButton(),
      propertiesButton(),
      aiChatButton(),
      b("folder-recent", "Views", safe(() => toggleSavedViewsPanel(), "Saved views"), {
        active: isSavedViewsPanelVisible(),
        title: "Saved views — capture named camera positions (Ctrl+Shift+V)",
      }),
      b("folder-recent", "Edits", safe(() => toggleFragEditPanel(), "FRAG edits panel"), {
        active: isFragEditPanelVisible(),
        title: "Show the FRAG edits panel",
      }),
    ],
  },

  // ═══════════════════════════ 5D COST ═════════════════════════════════
  {
    id: "cost",
    label: "5D Cost",
    items: () => [
      groupLabel("Takeoff"),
      b("cost", "Panel", safe(() => toggleCostPanel(), "Cost"), { active: isCostPanelVisible() }),
      b("reset-offsets", "Recalc", safe(() => recalculateTakeoff(), "Recalc")),
      schedulesButton(),
      sep(),
      groupLabel("Cost items"),
      b("new-file", "Item", safe(() => toggleCostPanel(), "Cost Item"), { title: "Open cost item management" }),
      b("cost-takeoff", "Rates", safe(() => toggleCostPanel(), "Cost Rates"), { title: "Open rates and assignments" }),
      b("tag", "Categories", safe(() => toggleSchedules(), "Cost Categories"), { title: "Open schedule/category workflow" }),
      sep(),
      groupLabel("Reports"),
      b("report", "Summary", safe(() => toggleCostPanel(), "Cost Summary")),
      b("csv", "CSV", safe(() => void exportCostCsv(), "Cost CSV")),
      b("print", "BOQ", safe(() => void exportCostCsv(), "BOQ Export")),
    ],
  },
];

/* ═════════════════════════════════════════════════════════════════════════
   Rendering
   ═════════════════════════════════════════════════════════════════════════ */
function refreshRibbon() {
  renderTabs();
  renderStrip();
}

function renderTabs() {
  tabsRow.innerHTML = "";

  const brand = document.createElement("div");
  brand.className = "obs-ribbon__brand";
  brand.append(document.createTextNode("Open BIM Studio"));
  const version = document.createElement("span");
  version.className = "obs-ribbon__version";
  version.textContent = "v54";
  brand.appendChild(version);
  tabsRow.appendChild(brand);

  for (const t of TABS) {
    // Removed tabs: BIM Tools, Analyze, Massing & Site
    if (t.id === "bim-tools" || t.id === "analyze" || t.id === "site") continue;
    const btn = document.createElement("button");
    btn.className = "obs-ribbon__tab" + (t.id === "file" ? " obs-ribbon__tab--file" : "");
    btn.textContent = t.label;
    if (t.id === activeTab) btn.dataset.active = "1";
    btn.dataset.tab = t.id;
    btn.onclick = () => {
      // Single click: if minimized, expand and switch; if already expanded, just switch tab
      if (ribbonMinimized) {
        applyRibbonMinimize(false);
      }
      activeTab = t.id;
      renderTabs();
      renderStrip();
    };
    // Double-click on tab → toggle minimize (Revit behavior: shrink ribbon so only tabs show)
    btn.ondblclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleRibbonMinimize();
    };
    tabsRow.appendChild(btn);
  }

  // Double-click empty area of tabs row also toggles minimize
  tabsRow.ondblclick = (e) => {
    if ((e.target as HTMLElement).classList.contains("obs-ribbon__tab")) return;
    toggleRibbonMinimize();
  };

  tabsRow.appendChild(pill);
  updatePill();
}

function renderStrip() {
  try {
    renderStripImpl();
  } catch (err) {
    console.error(`[ribbon] renderStrip failed for tab "${activeTab}":`, err);
    strip.innerHTML =
      `<div style="color:#fca5a5;padding:20px;font:12px/1.5 monospace;white-space:pre-wrap">` +
      `⚠ Ribbon failed to render tab "${activeTab}".\n` +
      `${err instanceof Error ? err.message : String(err)}\n\n` +
      `Open the browser console (F12) for the full trace.</div>`;
  }
}

function renderStripImpl() {
  strip.innerHTML = "";

  const tab = TABS.find((t) => t.id === activeTab) ?? TABS[0];
  let items: HTMLElement[] = [];
  try {
    items = tab.items();
  } catch (err) {
    console.error(`[ribbon] items() threw for tab "${tab.id}":`, err);
    strip.innerHTML =
      `<div style="color:#fca5a5;padding:20px;font:12px/1.5 monospace;white-space:pre-wrap">` +
      `⚠ Tab "${tab.id}" threw during build:\n` +
      `${err instanceof Error ? err.message : String(err)}\n\n` +
      `Open the browser console (F12) for the full trace.</div>`;
    return;
  }
  if (!Array.isArray(items)) return;

  const groups: { label: string; items: HTMLElement[] }[] = [];
  const hints: HTMLElement[] = [];
  let cur: { label: string; items: HTMLElement[] } = { label: "", items: [] };

  for (const it of items) {
    if (!it || !(it instanceof HTMLElement)) continue;
    if (it.dataset.obsSep === "1") {
      if (cur.items.length) groups.push(cur);
      cur = { label: "", items: [] };
      continue;
    }
    if (it.dataset.obsGroup) {
      cur.label = it.dataset.obsGroup;
      continue;
    }
    if (it.dataset.obsHint === "1") {
      hints.push(it);
      continue;
    }
    cur.items.push(it);
  }
  if (cur.items.length) groups.push(cur);

  if (!groups.length && !hints.length) {
    const fallback = document.createElement("div");
    fallback.style.cssText =
      "padding:20px;color:var(--text-tertiary,#6b7280);font:12px system-ui";
    fallback.textContent = `Tab "${tab.label}" has no commands yet.`;
    strip.appendChild(fallback);
    return;
  }

  for (const g of groups) {
    const wrap = document.createElement("div");
    wrap.className = "obs-ribbon-group";
    const bodyEl = document.createElement("div");
    bodyEl.className = "obs-ribbon-group__body";
    for (const el of g.items) bodyEl.appendChild(el);
    wrap.appendChild(bodyEl);
    if (g.label) {
      const lbl = document.createElement("div");
      lbl.className = "obs-ribbon-group__label";
      lbl.textContent = g.label;
      wrap.appendChild(lbl);
    }
    strip.appendChild(wrap);
  }

  for (const h of hints) {
    h.className = "obs-ribbon-hint";
    strip.appendChild(h);
  }
}

function updatePill() {
  try {
    const p = getCurrentProject();
    const workspace = getWorkspaceDefinition(activeWorkspace);
    pill.innerHTML = "";

    const status = document.createElement("span");
    status.className = `obs-ribbon__project-status ${isDirty() ? "is-dirty" : "is-saved"}`;
    status.textContent = isDirty() ? "UNSAVED" : "SAVED";
    status.title = isDirty() ? "Project has unsaved changes" : "Project saved";

    const name = document.createElement("span");
    name.className = "obs-ribbon__project-name";
    name.textContent = p?.name ?? "No project";
    name.title = p?.name ?? "Open or create a project";

    const divider = document.createElement("span");
    divider.className = "obs-ribbon__pill-divider";

    const select = document.createElement("select");
    select.className = "obs-workspace-select";
    select.title = "Switch BIM workspace";
    select.setAttribute("aria-label", "BIM workspace");
    for (const item of WORKSPACES) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      option.selected = item.id === activeWorkspace;
      select.appendChild(option);
    }
    select.onchange = () => {
      setActiveWorkspace(select.value);
      const next = getWorkspaceDefinition(activeWorkspace);
      activeTab = next.tab;
      renderTabs();
      renderStrip();
    };

    const descriptor = document.createElement("span");
    descriptor.className = "obs-ribbon__workspace-hint";
    descriptor.textContent = workspace.caption;

    pill.append(status, name, divider, select, descriptor);
  } catch (err) {
    console.warn("[ribbon] updatePill failed", err);
    pill.textContent = "";
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Left dock — resizable + dockable tools panel
   ═════════════════════════════════════════════════════════════════════════ */
function setupLeftDock(mainRow: HTMLElement) {
  const leftWidthKey = "obs.leftPanel.width";
  const dockKey = "obs.leftPanel.dock";
  const minW = 320;
  const maxW = 700;

  mainRow.style.position = "relative";

  let width = 400;
  try {
    width = Math.max(
      minW,
      Math.min(maxW, Number(localStorage.getItem(leftWidthKey)) || 400),
    );
  } catch { /* */ }
  ctx.leftHost.style.width = `${width}px`;
  ctx.leftHost.style.minWidth = `${minW}px`;
  ctx.leftHost.style.maxWidth = `${maxW}px`;
  ctx.leftHost.style.flex = "0 0 auto";
  ctx.leftHost.style.position = "relative";

  const handle = document.createElement("div");
  handle.style.cssText =
    "position:absolute;top:0;bottom:0;right:-3px;width:6px;cursor:ew-resize;" +
    "background:transparent;z-index:20";
  handle.title = "Drag to resize · Double-click to reset";
  ctx.leftHost.appendChild(handle);

  let resizing = false;
  let startX = 0;
  let startW = 0;

  handle.addEventListener("pointerdown", (e) => {
    resizing = true;
    startX = e.clientX;
    startW = ctx.leftHost.getBoundingClientRect().width;
    (e.target as Element).setPointerCapture(e.pointerId);
    document.body.style.cursor = "ew-resize";
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!resizing) return;
    const dx = e.clientX - startX;
    const w = Math.max(minW, Math.min(maxW, startW + dx));
    ctx.leftHost.style.width = `${w}px`;
    window.dispatchEvent(new Event("resize"));
  });
  handle.addEventListener("pointerup", (e) => {
    if (!resizing) return;
    resizing = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
    document.body.style.cursor = "";
    try {
      localStorage.setItem(
        leftWidthKey,
        String(Math.round(ctx.leftHost.getBoundingClientRect().width)),
      );
    } catch { /* */ }
  });
  handle.addEventListener("dblclick", () => {
    ctx.leftHost.style.width = "400px";
    window.dispatchEvent(new Event("resize"));
    try { localStorage.setItem(leftWidthKey, "400"); } catch { /* */ }
  });

  function applyDock(side: "left" | "right") {
    if (side === "right") {
      mainRow.style.flexDirection = "row-reverse";
      ctx.leftHost.style.borderRight = "none";
      ctx.leftHost.style.borderLeft = "1px solid var(--border-default)";
    } else {
      mainRow.style.flexDirection = "row";
      ctx.leftHost.style.borderLeft = "none";
      ctx.leftHost.style.borderRight = "1px solid var(--border-default)";
    }
    window.dispatchEvent(new Event("resize"));
  }
  try {
    const dock = (localStorage.getItem(dockKey) as "left" | "right") || "left";
    applyDock(dock);
  } catch { /* */ }

  (ctx.features as any).leftPanel = {
    setWidth: (w: number) => {
      const clamped = Math.max(minW, Math.min(maxW, w));
      ctx.leftHost.style.width = `${clamped}px`;
      window.dispatchEvent(new Event("resize"));
      try { localStorage.setItem(leftWidthKey, String(Math.round(clamped))); } catch { /* */ }
    },
    getWidth: () => ctx.leftHost.getBoundingClientRect().width,
    dockLeft: () => {
      applyDock("left");
      try { localStorage.setItem(dockKey, "left"); } catch { /* */ }
    },
    dockRight: () => {
      applyDock("right");
      try { localStorage.setItem(dockKey, "right"); } catch { /* */ }
    },
    toggle: () => toggleLeftPanel(),
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupRibbon() {
  const app = document.getElementById("app") as HTMLElement;
  app.style.flexDirection = "column";

  ctx.leftHost.style.cssText =
    "height:100%;overflow-y:auto;overflow-x:hidden;" +
    "background:var(--bg-base);border-right:1px solid var(--border-default);" +
    "display:flex;flex-direction:column;";
  // Wheel over left dock scrolls the panel — never zooms 3D
  ctx.leftHost.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });


  const mainRow = document.createElement("div");
  mainRow.style.cssText =
    "display:flex;flex:1;min-height:0;width:100%;overflow:hidden";
  mainRow.append(ctx.leftHost, ctx.rightHost);

  app.append(root, mainRow);
  root.append(tabsRow, strip);

  setupLeftDock(mainRow);

  onProjectChanged(updatePill);
  updatePill();
  activeTab = getWorkspaceDefinition(activeWorkspace).tab;
  renderTabs();
  renderStrip();
  // Restore minimized state (Revit-style flat ribbon)
  applyRibbonMinimize(ribbonMinimized);

  window.addEventListener("obs-workspace", ((e: CustomEvent) => {
    const id = String(e.detail?.id ?? "");
    setActiveWorkspace(id);
    activeTab = getWorkspaceDefinition(activeWorkspace).tab;
    renderTabs();
    renderStrip();
    toast(`${getWorkspaceDefinition(activeWorkspace).label} workspace`, "success", 1600);
  }) as EventListener);

  // Bridge notify + legacy obs-toast → ribbon toast (single path, no double-fire)
  window.addEventListener("obs-toast", ((e: CustomEvent) => {
    const d = e.detail ?? {};
    const kind = d.kind ?? "info";
    const message = String(d.message ?? "");
    const timeout = d.timeout ?? d.ms ?? (kind === "error" ? 6000 : 2400);
    toast(message, kind, timeout);
  }) as EventListener);
}
