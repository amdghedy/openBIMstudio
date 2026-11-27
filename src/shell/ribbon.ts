/** Top ribbon — pyBIM-style density, icon + label buttons.
 *
 * 16 tabs. File · Architecture · Structure · Mechanical · Electrical ·
 * Insert · Annotate · Analyze · Massing & Site · Coordinate ·
 * Clash Detective · Edit · View · Manage · X Dim.
 *
 * Every button action is async-aware: the strip re-renders after the action
 * resolves, so badges, counters, and active states stay in sync. */
import { getNorthState, onNorthChanged } from "../modules/north/north";
import * as THREE from "three";
import { confirmDialog } from "../features/form-modal";
import { ctx } from "../core/context";
import { getVisualPreset } from "../features/view-graphics";
import { onNotify, __dispatchToSubscribers, uiAlert } from "../core/notify";
import { pickFiles, loadIfcFiles, loadFragFiles } from "../features/importer";
import {
  setProjection, getProjection, fitAll, gotoDir, goHome, takeScreenshot,
  recenterSceneNow, resetOffsets, showBoundsHelpers, alignOriginToOrigin,
  getScreenshotPreset, setScreenshotPreset, type ScreenshotPreset,
} from "../features/camera-tools";
import { toggleMeasure, isMeasureEnabled, clearMeasurements } from "../features/measure";
import { generateLegend as keynoteLegend, legendToCSV as keynoteLegendCSV } from "../modules/keynotes/types";
import { toggleToolWindow, openToolWindow, isToolWindowOpen } from "../features/tool-windows";
import { toggleAlign } from "../features/model-align";
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

import {
  setAuthoringTool, getActiveTool, deleteSelectedElement, clearAllElements,
  setLevel, getLevel, getLastCommand, pinSelected, setNextMlineLineStyle,
  onAuthoringChange, getWallChain, setWallChain, reverseSelected, addWallSweepToSelected, clearWallSweepsSelected, cycleMepSelection, selectAllAuthored, getElements,
} from "../features/authoring";
import { selectedAuthored, selectedLinked } from "../features/modify-options";
import { PLACE_TOOLS } from "../features/place-options";
import { runModifyAction, type ModifyActionId } from "../features/modify-actions";
import { getModifyCommandDefinition } from "../modules/modify/registry";
import {
  buildModifyTabModel,
  type ModifyTabButton,
  type ModifyTabElement,
  type ModifyTabModel,
} from "./modify-tab-model";
import { openSelectionFilterDialog, selectPreviousCombined } from "../features/selection-filter-dialog";
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
} from "../features/bim-experience";
import { toggleSchedules, isSchedulesVisible } from "../features/schedules-panel";
import { toggleWalkMode, isWalkModeEnabled } from "../features/walk-mode";
import { togglePalette } from "../features/command-palette";
import {
  toggleSavedViewsPanel, isSavedViewsPanelVisible,
  saveCurrentView, listSavedViews,
} from "../features/saved-views";
import { toggleFileMenu, isFileMenuVisible, printView } from "./file-menu";
import { history } from "../features/history";
import { pickAndImport } from "../features/file-interop";
import { svgIcon, type IconName } from "../features/icon-set";
import { mountLanguageButton } from "../features/language-button";
import { mountAccountButton } from "../features/cloud-account";
import { openProjectInfo } from "../features/project-info";
import { toggleBimToolbox, isBimToolboxVisible } from "../features/bim-toolbox";
import { resolveCropViewId } from "../modules/views/plan-view-controls";

// ── MEP category coloring ──────────────────────────────────────────────
import { toggleMepColors, isMepColoringActive } from "../features/mep-coloring";
// ── MEP parametric design toolkit ──────────────────────────────────────
import { openMepDesignToolkit, showResultDialog, type ResultRow } from "../features/mep-fabrication";
import { openParametricToolkit } from "../features/parametric-tools";
import { openFamilyCreatorEngine, openParamFamilyPanel } from "../features/parametric-family-panel";

// ── Selection prefs (Edit-tab toggles — real engine gating) ───────────
import { getSelectionPrefs, setSelectionPref } from "../core/selection-prefs";

// ── Orphan-panel wiring: previously-built UI that had no entry point ───
import { toggleModelHealth } from "../features/model-health";
import { openModelQADialog } from "../features/model-qa-summary";
import { openMepBalancePanel } from "../features/mep-balance-panel";
import { openMepLifecyclePanel } from "../features/mep-lifecycle-panel";
import { openNLQueryModal } from "../features/nl-query-bar";
import { openRebarClashReview } from "../features/rebar-clash-review";
import { openDrawingRegisterPanel } from "../features/drawing-register-panel";
import { previewCoordinationReportHtml, exportCoordinationReportHtml } from "../features/standards-report";
import { openTrayFillDialog, openHangerSpacingDialog } from "../features/mep-engineering-dialogs";
import { exportCobie } from "../modules/export/cobie";
import { exportClashesBcf } from "../modules/export/bcf21";

// ── Unified select-all ─────────────────────────────────────────────────
import { selectAllObjects, clearAllSelection } from "../features/select-all";

// ── AI chat ────────────────────────────────────────────────────────────
import { toggleAiChat, isAiChatVisible } from "../features/ai-chat";

// ── 4D Construction Simulation (Navisworks TimeLiner competitor) ───────
import { toggleTimelinePanel, isTimelinePanelVisible, openTimelineTab, pickAndImportP6, openCurvesView, pickAndImportFactors } from "../features/timeline-panel";

// ── Sheets / Production + Automation ───────────────────────────────────
import { toggleSheetsPanel, isSheetsPanelVisible } from "../features/sheets-panel";
import { toggleAutomationPanel, isAutomationPanelVisible } from "../features/automation-panel";
import { toggleFamilyCreatorPanel, isFamilyCreatorPanelVisible } from "../features/family-creator-panel";

// ── Object snaps (all modes) ───────────────────────────────────────────
import { toggleSnapSettings, isSnapSettingsVisible, snapping } from "../features/snapping";
import { toggleSelectionSnappingPalette, isSelectionSnappingPaletteVisible } from "../features/selection-snapping-palette";
import { resolveDblClick } from "./ribbon-collapse";
import { toggleAppFullScreen, isAppFullScreen } from "./fullscreen-chrome";

// ── Insert / Link tools (all activated) ────────────────────────────────
import {
  linkIfc, linkFrag, linkCad, linkBIM, linkPointCloud, linkTopography,
  openFamilyLibrary, openComponentLibrary, linkAutodesk,
} from "../features/link-tools";

// ── Project Browser + Properties (Industry-standard) ─────────────────────────
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
import {
  openAnalyzeBuildingDialog, openFrameSolverDialog, openSteelCheckDialog, openRcBeamDialog,
  openDuctPressureDialog, openPipePressureDialog, openWorstPathDialog,
  openAdaptiveSweepDialog, openAdaptiveRepeatDialog, openAdaptiveEditDialog,
  openExtrudeDialog, openRevolveDialog, openSolidSweepDialog, openBlendDialog,
  openBooleanDialog, openVoidDialog, validateLastSolid,
  openGeneralBooleanDialog, openShellDialog, openLoftDialog, openFuseDialog,
  openModifyMoveDialog, openModifyRotateDialog, openModifyArrayDialog, openModifyMirrorDialog,
  openGroup1MoveDialog, openGroup1RotateDialog, openGroup1MirrorDialog,
  openSelectionInspectorDialog, openReferencePickerDialog, group1Undo, group1Redo,
  openHostedOpeningDialog, openHostFamilyDialog, openParameterManagerDialog, openModelIntelligencePanel,
} from "../features/engine-ui";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsShowHidden: any;
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

/**
 * Render one toast into the ribbon toast host. Render-only: it does NOT
 * touch the obs-toast bus. The bridge in setupRibbon calls this
 * directly — it must NOT call `toast()` below, whose dispatch would put
 * the same toast on the bus a second time (every notify()-originated
 * toast was observed twice, which broke the family-hosting-ribbon
 * spec's toast count; the bus is the single observation path, so each
 * toast may cross it exactly once).
 */
function renderToast(message: string, kind: ToastKind = "info", ms = 2400): void {
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

function toast(message: string, kind: ToastKind = "info", ms = 2400): void {
  renderToast(message, kind, ms);
  // Ribbon toasts used to render only — they never reached the obs-toast
  // bus, so event listeners (the toast log a browser test reads, the
  // toolbox/browser refresh triggers) never saw them. Dispatch the event
  // too, marked fromRibbon so the bridge below does not render a second
  // copy; the bus is the single observation path for every toast.
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { kind, message, timeout: ms, fromRibbon: true },
    }));
  } catch { /* non-browser env */ }
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
let leftPanelVisible = false; // the Tools panel is gone: its groups are tool windows opened from the tabs
function toggleLeftPanel() {
  // The left Tools panel no longer exists (its groups are tool windows); keep the dock hidden.
  leftPanelVisible = false;
  ctx.leftHost.style.display = "none";
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

/** BIM-style ribbon minimize: double-click a tab (or tabs row) to collapse the strip
 *  so only the tab buttons remain (flat / shrunk). Double-click again to restore. */
let ribbonMinimized = false;
try {
  const migrated = localStorage.getItem("obs.ribbon.ux-migrated-v1") === "1";
  if (!migrated) {
    localStorage.setItem("obs.ribbon.minimized", "0");
    localStorage.setItem("obs.ribbon.ux-migrated-v1", "1");
    ribbonMinimized = false;
  } else {
    ribbonMinimized = localStorage.getItem("obs.ribbon.minimized") === "1";
  }
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

/** Date.now() of the last auto-expand (single click on a tab while minimized).
 *  A dblclick landing right after such an expand is the tail of the SAME
 *  gesture — swallowing it keeps the just-expanded ribbon open. */
let lastAutoExpandAt = 0;

// Double-click a tab (or the empty tabs row) → collapse the strip so only the
// tab buttons remain. Delegated on the PERSISTENT tabs row: renderTabs()
// rebuilds every tab button on each click, and a rebuilt button never sees the
// browser's dblclick (its node was replaced between the two clicks) — this
// delegation is what makes the gesture work on Home / Annotate / View / … .
tabsRow.addEventListener("dblclick", (e) => {
  const target = e.target as HTMLElement | null;
  const onTab = !!target?.closest?.(".obs-ribbon__tab");
  const decision = resolveDblClick({
    minimized: ribbonMinimized,
    lastAutoExpandAt,
    now: Date.now(),
    onTab,
  });
  lastAutoExpandAt = decision.lastAutoExpandAt;
  if (decision.minimize !== ribbonMinimized) applyRibbonMinimize(decision.minimize);
});

/* ═════════════════════════════════════════════════════════════════════════
   Helpers
   ═════════════════════════════════════════════════════════════════════════ */
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any)[c]);

interface BtnOpts {
  active?: boolean;
  title?: string;
  kbd?: string;
  /** Rendered as a native disabled button (used by the linked-selection
   *  Modify tab: transforms are shown but disabled, with the reason as
   *  the tooltip). */
  disabled?: boolean;
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
  const tip = opts.disabled ? (opts.title || label) : (opts.kbd ? `${label}  (${opts.kbd})` : (opts.title || label));
  el.title = tip;
  el.setAttribute("aria-label", label);
  if (opts.active) el.dataset.active = "1";
  if (opts.disabled) { el.disabled = true; el.dataset.disabled = "1"; }
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

/* ── Shared In-Place Mass flows (Edit tab + Massing & Site tab) ──────────
 * Both tabs expose the same capability; they previously duplicated the
 * logic and the Massing & Site copy targeted a global that never existed
 * (__obsInPlaceMass). One implementation, two call sites. */
async function openInPlaceMassDialog(): Promise<void> {
  const mc = (window as any).__obsMass;
  if (!mc) { toast("Mass module not loaded", "warn"); return; }
  const { openFormModal } = await import("../features/form-modal");
  const r = await openFormModal({
    title: "Create In-Place Mass",
    subtitle: "Conceptual mass element (extruded polygon)",
    fields: [
      { kind: "number", key: "width", label: "Width", default: 5, unit: "m", step: 0.5, min: 0.5 },
      { kind: "number", key: "height", label: "Height", default: 10, unit: "m", step: 0.5, min: 0.5 },
    ],
    submitLabel: "Create Mass",
  });
  if (!r) return;
  const w = parseFloat(r.width);
  const h = parseFloat(r.height);
  if (isNaN(w) || isNaN(h)) { toast("Invalid input", "warn"); return; }
  const poly: Array<[number, number]> = [[0, 0], [w, 0], [w, w], [0, w]];
  const m = mc.create(poly, h, `Mass ${mc.list().length + 1}`);
  toast(`Created "${m.name}": ${w}×${w}×${h}m, area=${w * w}m²`, "success");
}

async function openMassFloorsDialog(): Promise<void> {
  const mc = (window as any).__obsMass;
  if (!mc) { toast("Mass module not loaded", "warn"); return; }
  const masses = mc.list();
  if (!masses.length) { toast("No masses created yet", "info"); return; }
  const { showObjectsDialog } = await import("../features/form-modal");
  const rows: Array<Record<string, unknown>> = [];
  for (const m of masses) {
    const floors = mc.getFloors(m.id);
    if (floors.length) for (const f of floors) rows.push({ mass: m.name ?? m.id, ...f });
    else rows.push({ mass: m.name ?? m.id });
  }
  await showObjectsDialog("Mass floors", rows, `${masses.length} mass(es)`);
}

/** Convert one conceptual mass into native authored elements (Revit parity Rank 6). */
async function openMassToElementsDialog(): Promise<void> {
  const mc = (window as any).__obsMass;
  if (!mc) { toast("Mass module not loaded", "warn"); return; }
  const masses = mc.list();
  if (!masses.length) { toast("No masses created yet", "info"); return; }
  let mass = masses[0];
  if (masses.length > 1) {
    const { openFormModal } = await import("../features/form-modal");
    const r = await openFormModal({
      title: "Mass to Elements",
      subtitle: "Convert one conceptual mass into native walls, floors and roof.",
      fields: [
        { kind: "select", key: "mass", label: "Mass", default: masses[0].id,
          options: masses.map((m: any) => [m.id, m.name ?? m.id] as [string, string]) },
      ],
      submitLabel: "Convert",
    });
    if (!r) return;
    mass = masses.find((m: any) => m.id === String(r.mass)) ?? masses[0];
  }
  const authoring = (window as any).__obsAuthoring;
  if (typeof authoring?.createElementByType !== "function") { toast("Authoring is not ready", "warn"); return; }
  try {
    const { convertMassToElements } = await import("../modules/parametric/mass-to-elements");
    const report = await convertMassToElements(mass, {
      createElement: (type, params) => authoring.createElementByType(type, params),
    });
    const { showObjectsDialog } = await import("../features/form-modal");
    const rows: Array<Record<string, unknown>> = report.created.map((c) => ({
      face: c.faceIndex, classified: c.suggestedType, element: c.elementType,
      area: `${c.areaM2.toFixed(2)} m²`, id: c.elementId,
    }));
    for (const s of report.skipped) {
      rows.push({ face: s.faceIndex, classified: s.suggestedType, element: "— skipped", area: "", id: s.reason });
    }
    await showObjectsDialog(
      `Mass to elements — ${mass.name ?? mass.id}`,
      rows,
      `${report.created.length} element(s) created${report.skipped.length ? `, ${report.skipped.length} skipped` : ""}`,
    );
    toast(`Created ${report.created.length} element(s) from "${mass.name ?? mass.id}"`, "success");
  } catch (e) {
    toast(`Mass conversion failed: ${(e as Error).message}`, "error");
  }
}

function exportKeynoteLegendCsv(count: number): void {
  const csv = keynoteLegendCSV();
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "keynote-legend.csv"; a.click();
  URL.revokeObjectURL(url);
  toast(`Keynote legend exported: ${count} entries`, "success");
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
      const preset = (ctx.features as any).authoring?.getActivePreset?.();
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
        try { preset = (ctx.features as any).authoring?.getActivePreset?.() ?? null; } catch { /* */ }
        if (cur === tool || preset === tool) {
          setAuthoringTool(null);
          toast(`${label} off`, "info", 1200);
        } else {
          setAuthoringTool(tool as any);
          // If Floor Plan is open, route tool into 2D plan (BIM behaviour)
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

/* ── G6: M2 placement buttons ────────────────────────────────────────────
 * Stairs / Railing / Roof / Ceiling are Milestone-2 placement tools
 * (src/modules/bim-gaps/m2-tools.ts): click points in the viewport, Esc
 * cancels. They must be started with startM2Tool directly — NOT with
 * toolBtn. toolBtn calls the module-level setAuthoringTool, which
 * bypasses the M2 redirect installed on ctx.features.authoring
 * (installM2Redirects), and the authoring click handler has no case for
 * these tools, so a toolBtn leaves a dead tool active. Order pinned by
 * src/shell/ribbon-draw-order.ts. */
function m2Btn(
  icon: IconName,
  label: string,
  kind: "stairs" | "railing" | "roof" | "ceiling",
  kbd = "",
  shape: "straight" | "L" | "U" = "straight",
): HTMLButtonElement {
  return b(
    icon,
    label,
    safe(async () => {
      const { startM2Tool } = await import("../modules/bim-gaps/m2-tools");
      startM2Tool(kind, shape);
    }, label),
    { kbd, title: `${label} placement tool — click points in the viewport (Esc cancels)` },
  );
}

/* ── G6: Model Group button ──────────────────────────────────────────────
 * Revit's Model Group creates a group from the current selection (then
 * instances can be placed from it). Same flow as the GP shortcut
 * (bim-input-compatibility.ts): prompt for a name, group the selection. */
function modelGroupButton(): HTMLButtonElement {
  return b(
    "component",
    "Model Group",
    safe(async () => {
      const ids = selectedAuthored().map((e) => e.id);
      if (!ids.length) { toast("Select elements to group first", "info"); return; }
      const { promptLine } = await import("../features/form-modal");
      const name = await promptLine("Create group", "Group name:", "Group");
      if (name == null) return;
      const g = (window as any).__obsGroups?.createFromSelection?.(name, ids, true);
      if (g) toast(`Group "${name}" created`, "success");
      else toast("Groups module not loaded", "warn");
    }, "Model group"),
    { kbd: "GP", title: "Group the selected elements into a model group (Revit: Model Group)" },
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
      `<span style="margin-inline-start:3px;font-size:8px;opacity:.75">\u25BE</span>` +
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

function mepToolkitButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "MEP Design Toolkit — Hunter fixture-unit demand, sprinkler hydraulics, voltage drop, insulation heat loss, duct equivalents, ACH, water hammer and unit conversions";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("calc" as IconName)}</span>` +
    `<span class="obs-rb__label">MEP Toolkit</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    void openMepDesignToolkit();
  };
  return btn;
}

function parametricToolkitButton(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "obs-rb";
  btn.title = "Parametric Modeling Toolkit — wall join doctor, stacked-wall heal across levels, curtain grid editor, constraint store report";
  btn.innerHTML =
    `<span class="obs-rb__icon">${svgIcon("calc" as IconName)}</span>` +
    `<span class="obs-rb__label">Parametric</span>`;
  btn.onclick = (ev) => {
    ev.stopPropagation();
    void openParametricToolkit();
  };
  return btn;
}

/* Shared by the Architecture Constraints group and the Parametric tab:
 * the same buttons, the same handlers — not copies with drift. */
function lockDimensionButton(): HTMLButtonElement {
  return b("dim-aligned", "Lock Dim", safe(async () => {
    const c = (window as any).__obsConstraints;
    if (!c) { toast("Constraints module not loaded", "warn"); return; }
    const auth = (ctx.features as any).authoring;
    const ids = auth?.getSelectedIds?.() ?? [];
    if (ids.length < 2) { toast("Select 2 elements to lock the dimension between them", "warn"); return; }
    const { promptLine } = await import("../features/form-modal");
    const v = await promptLine(
      "Lock Dimension",
      "Distance between elements",
      "3.0",
      "m",
      "Distance in metres (e.g. 3.0 = 3 m)",
    );
    if (v == null) return;
    const val = parseFloat(v);
    if (isNaN(val)) { toast("Invalid number", "warn"); return; }
    c.lock(ids[0], ids[1], val);
    toast(`Dimension locked at ${val}m`, "success");
  }, "Lock dimension"), { title: "Lock the distance between two selected elements" });
}

function equalityButton(): HTMLButtonElement {
  return b("dim-aligned", "Equality", safe(() => {
    const c = (window as any).__obsConstraints;
    if (!c) { toast("Constraints module not loaded", "warn"); return; }
    const auth = (ctx.features as any).authoring;
    const ids = auth?.getSelectedIds?.() ?? [];
    if (ids.length < 3) { toast("Select 3+ elements to set equal spacing", "warn"); return; }
    c.equality(ids, "spacing");
    toast(`Equal spacing applied to ${ids.length} elements`, "success");
  }, "Equality"), { title: "Make spacing between selected elements equal" });
}

/* Global undo/redo (A12) — the real history stack (features/history.ts),
 * not the Group-1 one. Disabled state comes from history.canUndo() /
 * canRedo() at build time and is refreshed in place by
 * updateHistoryButtons() (subscribed to history.onChange), so keyboard
 * undo/redo stays reflected too. */
function historyUndoButton(): HTMLButtonElement {
  const el = b("undo", "Undo", safe(async () => { await history.undo(); }, "Undo"), {
    disabled: !history.canUndo(),
    title: history.undoLabel() ? `Undo ${history.undoLabel()}` : "Nothing to undo",
    kbd: "Ctrl+Z",
  });
  el.dataset.historyUndo = "1";
  return el;
}

function historyRedoButton(): HTMLButtonElement {
  const el = b("undo", "Redo", safe(async () => { await history.redo(); }, "Redo"), {
    disabled: !history.canRedo(),
    title: history.redoLabel() ? `Redo ${history.redoLabel()}` : "Nothing to redo",
    kbd: "Ctrl+Y",
  });
  el.dataset.historyRedo = "1";
  return el;
}

/* Refresh Undo/Redo disabled state in place — Home tab History group and
 * the QAT — after any history change (ribbon action, keyboard, palette).
 * Called from history.onChange and after every strip/tabs re-render. */
function updateHistoryButtons(): void {
  const setBtn = (
    scope: ParentNode,
    sel: string,
    can: boolean,
    label: string | null,
    kbd: string,
    verb: string,
  ) => {
    const el = scope.querySelector(sel) as HTMLButtonElement | null;
    if (!el) return;
    el.disabled = !can;
    el.style.opacity = can ? "1" : "0.35";
    el.title = can && label ? `${verb} ${label} (${kbd})` : can ? `${verb} (${kbd})` : `Nothing to ${verb.toLowerCase()}`;
  };
  setBtn(strip, "[data-history-undo]", history.canUndo(), history.undoLabel(), "Ctrl+Z", "Undo");
  setBtn(strip, "[data-history-redo]", history.canRedo(), history.redoLabel(), "Ctrl+Y", "Redo");
  setBtn(tabsRow, '[data-qat="undo"]', history.canUndo(), history.undoLabel(), "Ctrl+Z", "Undo");
  setBtn(tabsRow, '[data-qat="redo"]', history.canRedo(), history.redoLabel(), "Ctrl+Y", "Redo");
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
      title: "Element & view properties (BIM-style)",
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
let activeTab = "home"; // A12: Home is the default tab (AutoCAD parity).
let boundsOn = false;

/* ═════════════════════════════════════════════════════════════════════════
   BIM workspaces — focused command sets for production delivery.
   ═════════════════════════════════════════════════════════════════════════ */
const WORKSPACES = [
  { id: "authoring", label: "Authoring", caption: "Model + families", tab: "architecture" },
  { id: "mep", label: "MEP Delivery", caption: "Systems + coordination", tab: "systems" },
  { id: "coordination", label: "Coordination", caption: "Federation + alignment", tab: "coordinate" },
  { id: "qa", label: "QA / QC", caption: "Clash + IDS + issues", tab: "clash" },
  { id: "documentation", label: "Documentation", caption: "Sheets + views", tab: "view" },
  { id: "construction", label: "Construction", caption: "4D + 5D + 6D · P6 · X Dim", tab: "cost" },
] as const;
type WorkspaceId = typeof WORKSPACES[number]["id"];
let activeWorkspace: WorkspaceId = "coordination";
// True only when the user explicitly picked a workspace before: a saved
// workspace still lands on its tab at startup; a first boot lands on Home.
let workspaceSaved = false;
try {
  const saved = localStorage.getItem("obs.workspace");
  if (WORKSPACES.some((w) => w.id === saved)) {
    activeWorkspace = saved as WorkspaceId;
    workspaceSaved = true;
  }
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
/* Tab order is Revit order (see src/shell/ribbon-order.ts, the testable
   order model — tests/ribbon-tab-order.test.cjs pins TABS to that model),
   with the AutoCAD-parity tabs from A12: Home first (the default tab),
   Parametric after Annotate, Output after Manage.
   Deviations from Revit, all documented in ribbon-order.ts: File is kept
   as the browser equivalent of the application menu; Edit stays permanent
   because its dialog launchers are selection-independent; Coordinate /
   Clash Detective / X Dim are product tabs kept after Manage. */
const TABS: { id: string; label: string; items: () => HTMLElement[] }[] = [
  // ════════════════════════════════ HOME ═══════════════════════════════
  // AutoCAD parity (A12): the default tab — draw/modify essentials, all
  // reusing the same tool builders as their home tabs (no new tool logic).
  {
    id: "home",
    label: "Home",
    items: () => [
      groupLabel("Draw"),
      toolBtn("wall", "Wall", "wall", "WA"),
      toolBtn("door", "Door", "door", "DR"),
      toolBtn("window", "Window", "window", "WN"),
      toolBtn("column", "Column", "column", "CM"),
      toolBtn("floor", "Floor", "slab", "SL"),
      toolBtn("grid", "Grid", "grid", "GR"),
      toolBtn("level", "Level", "level", "LV"),
      toolBtn("mline", "Model Line", "mline"),
      sep(),
      groupLabel("Modify"),
      toolBtn("select-all", "Select", "select", "Esc"),
      toolBtn("move", "Move", "move", "G"),
      toolBtn("copy", "Copy", "copy"),
      toolBtn("rotate", "Rotate", "rotate", "R"),
      toolBtn("mirror", "Mirror", "mirror"),
      toolBtn("array", "Array", "array"),
      toolBtn("offset", "Offset", "offset"),
      b("delete", "Delete", safe(() => deleteSelectedElement(), "Delete"), { kbd: "Del" }),
      sep(),
      groupLabel("Annotate"),
      b("dim-aligned", "Aligned", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-aligned"), 40);
      }, "Aligned dimension"), {
        kbd: "DI", title: "Aligned Dimension: pick two model boundaries",
      }),
      b("dim-linear", "Linear", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-linear"), 40);
      }, "Linear dimension"), {
        title: "Linear Dimension: horizontal / vertical between two boundaries",
      }),
      b("tag", "Tag", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag"); return; }
        toast("Tag: select an element — properties show category / type / id", "info");
        try { (ctx.features as any).propertyPalette?.show?.(); } catch { /* */ }
      }, "Tag")),
      b("text", "Text", safe(async () => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("text"); return; }
        const { promptLine } = await import("../features/form-modal");
        const t = await promptLine(
          "Text Note",
          "Annotation text",
          "Note",
          "Type your note here",
        );
        if (t != null && t.trim()) toast(`Text note saved: “${t.trim()}”`, "success");
      }, "Text note")),
      sep(),
      groupLabel("History"),
      historyUndoButton(),
      historyRedoButton(),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ════════════════════════════════ FILE ═══════════════════════════════
  {
    id: "file",
    label: "File",
    items: () => [
      groupLabel("App"),
      b("menu", "Menu", safe(() => toggleFileMenu(), "File menu"), { active: isFileMenuVisible() }),
      b("home", "Home", safe(() => showHome(), "Home")),
      b("save", "Save", safe(() => void saveProject(), "Save"), { kbd: "^S" }),
      b("save", "Save to File", safe(async () => { (await import("../modules/projects/project-file-io")).saveProjectToFile(false); }, "Save to file"), {
        title: "Save the whole project (models, dimensions, tags...) to a .obsproj file on your computer. Ctrl+S then keeps that file up to date.",
      }),
      b("save", "Save As File", safe(async () => { (await import("../modules/projects/project-file-io")).saveProjectToFile(true); }, "Save as file"), {
        kbd: "^\u21e7S", title: "Save a copy of the project to a new .obsproj file (also a manual backup)",
      }),
      b("folder", "View RVT Model", safe(async () => { (await import("../features/rvt-viewer")).pickRVTFile(); }, "View RVT model"), {
        title: "Open a .rvt / .rfa file for viewing only. Decoded inside your browser, nothing is uploaded. Geometry is a reconstruction and can be incomplete.",
      }),
      b("folder", "RVT Model Browser", safe(async () => { (await import("../features/rvt-view")).openRVTBrowser(); }, "RVT model browser"), {
        title: "Search, group, select, hide and isolate the elements of an opened RVT model; export them to CSV",
      }),
      b("folder", "Open File", safe(async () => { (await import("../modules/projects/project-file-io")).openProjectFromFile(); }, "Open file"), {
        title: "Open a .obsproj project file from your computer",
      }),
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
      b("settings", "Import Setup", safe(() => toggleToolWindow("import"), "Import setup"), {
        active: isToolWindowOpen("import"),
        title: "Positioning (linking), IFC to FRAG conversion settings, the import queue and status",
      }),
      cdeButton(),
      sep(),
      groupLabel("Export"),
      b("file", "IFC4", safe(async () => {
        const mod = await import("../modules/bim-gaps/bim-gaps-boot");
        await mod.exportIfc("IFC4");
      }, "Export IFC4"), { title: "Export the authored model as IFC4 STEP file" }),
      b("file", "IFC2X3", safe(async () => {
        const mod = await import("../modules/bim-gaps/bim-gaps-boot");
        await mod.exportIfc("IFC2X3");
      }, "Export IFC2X3"), { title: "Export the authored model as IFC2X3 STEP file" }),
      b("file-frag", "FRAG", safe(async () => {
        const mod = await import("../modules/export/frag");
        await mod.exportFragFromMenu();
      }, "Export FRAG"), {
        title: "Export loaded model(s) as ThatOpen Fragments (.frag) — official binary format",
      }),
      b("cost-takeoff", "Cost", safe(() => recalculateTakeoff(), "Cost")),
      b("issues", "Issues", safe(() => toggleIssuesPanel(), "Issues"), { active: isIssuesPanelVisible() }),
      sep(),
      groupLabel("Doc"),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Sheets"), { active: isSheetsPanelVisible() }),
      b("plan", "Plan", safe(() => togglePlanView(), "Plan view"), { active: isPlanViewVisible() }),
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
      // G6 — Revit Build order (src/shell/ribbon-draw-order.ts):
      // Wall, Door, Window, Component, Column, Roof, Ceiling, Floor,
      // Curtain Wall, Railing, Ramp, Stair, Room, Model Line, Model Group.
      // Door/Window moved here from Openings; Beam moved out (Structure
      // only); Roof/Ceiling/Railing/Stair are M2 placement tools (m2Btn).
      toolBtn("wall", "Wall", "wall", "WA"),
      toolBtn("door", "Door", "door", "DR"),
      toolBtn("window", "Window", "window", "WN"),
      toolBtn("component", "Comp", "equipment"),
      bimObjectStudioButton(),
      toolBtn("column", "Column", "column", "CM"),
      m2Btn("roof", "Roof", "roof", "RF"),
      m2Btn("ceiling", "Ceiling", "ceiling", "CL"),
      toolBtn("floor", "Floor", "slab", "SL"),
      toolBtn("wall", "Curtain Wall", "curtain-wall", "CW"),
      m2Btn("railing", "Railing", "railing", "RA"),
      // Ramp has no shortcut: the old "RM" kbd label was wrong, RM is Room.
      toolBtn("ramp", "Ramp", "ramp"),
      m2Btn("stairs", "Stair", "stairs", "ST", "straight"),
      toolBtn("room", "Room", "room", "RM"),
      toolBtn("mline", "Model Line", "mline"),
      modelGroupButton(),
      sep(),
      groupLabel("Openings"),
      toolBtn("opening", "Opening", "opening"),
      toolBtn("shaft", "Shaft", "shaft"),
      b("opening", "Hosted Opening", safe(() => void openHostedOpeningDialog(), "Hosted opening (v68)"), {
        title: "Place a validated opening on a wall via the v68 hosting engine (overlap checks, layer offsets)",
      }),
      b("component", "Host Family", safe(() => void openHostFamilyDialog(), "Host family (Slice 9)"), {
        title: "Host a family instance on a wall or a face — it follows the host when the host moves",
      }),
      sep(),
      groupLabel("Adaptive"),
      b("component", "Adaptive Sweep", safe(() => void openAdaptiveSweepDialog(), "Adaptive sweep"), {
        title: "Sweep an adaptive-family profile along a 3D path (exact volume, watertight mesh)",
      }),
      b("component", "Divide & Repeat", safe(() => void openAdaptiveRepeatDialog(), "Divide path and repeat family"), {
        title: "Divide a line into equal bays and repeat a 2-point adaptive family along it",
      }),
      b("component", "Edit Adaptive", safe(() => void openAdaptiveEditDialog(), "Edit selected adaptive component"), {
        title: "Edit the selected adaptive component's placement points and profile; regenerate its native geometry",
      }),
      sep(),
      groupLabel("Datum"),
      toolBtn("grid", "Grid", "grid", "GR"),
      toolBtn("level", "Level", "level", "LV"),
      toolBtn("ref-plane", "Ref plane", "ref-plane"),
      levelInput(),
      sep(),
      groupLabel("Circulation"),
      // G6 — Stair is a placement tool now: click the run start, then the
      // run end (Shift = orthogonal, Esc = cancel). The straight run sits
      // in Build (Revit order); L/U shapes live here. Winder / Spiral
      // have no placement session (stairs.ts builds at a fixed origin and
      // M2 geometry has no winder/spiral shape), so they stay instant-build
      // rather than being dropped — see ribbon-draw-order.ts deviations.
      m2Btn("stairs", "Stair L-Shape", "stairs", "", "L"),
      m2Btn("stairs", "Stair U-Shape", "stairs", "", "U"),
      b("stairs", "Winder", safe(() => {
        (window as any).__obsStairs?.buildStair?.({ runType: "winder" });
        toast("Winder stair created", "success");
      }, "Winder"), { title: "Build a winder stair" }),
      b("stairs", "Spiral", safe(() => {
        (window as any).__obsStairs?.buildStair?.({ runType: "spiral" });
        toast("Spiral stair created", "success");
      }, "Spiral"), { title: "Build a spiral stair" }),
      sep(),
      groupLabel("Direct Modeling"),
      b("move", "Push/Pull", safe(() => {
        const pp = (ctx.features as any).pushPull;
        if (pp?.isEnabled?.()) pp.disable(); else pp?.enable?.();
      }, "Push/Pull"), { kbd: "PU", title: "Push or pull a face (SketchUp-style)" }),
      b("slab", "Rectangle", safe(() => (ctx.features as any).primitives?.activateRectangle?.(), "Rectangle"), { title: "Rectangle - drag a floor" }),
      b("circle", "Circle", safe(() => (ctx.features as any).primitives?.activateCircle?.(), "Circle"), { title: "Circle - click center then radius" }),
      sep(),
      groupLabel("Sweeps"),
      b("wall", "Baseboard", safe(() => {
        const n = addWallSweepToSelected({ profileId: "baseboard-100", height: 0, face: "both" });
        toast(n ? `Baseboard added to ${n} wall(s)` : "Select one or more walls first", n ? "success" : "warn");
      }, "Baseboard"), { title: "Add a 100 mm baseboard to the selected walls (both faces)" }),
      b("wall", "Cornice", safe(() => {
        const sel = selectedAuthored().filter((e) => e.type === "wall");
        const top = sel.length ? Math.min(...sel.map((e) => Number((e.params as any).height) || 3)) - 0.12 : 0;
        const n = addWallSweepToSelected({ profileId: "cornice-standard", height: Math.max(0, top), face: "both" });
        toast(n ? `Cornice added to ${n} wall(s)` : "Select one or more walls first", n ? "success" : "warn");
      }, "Cornice"), { title: "Add a crown moulding at the top of the selected walls" }),
      b("wall", "Wainscot", safe(() => {
        const n = addWallSweepToSelected({ profileId: "wainscot-1200", height: 0, face: "both" });
        toast(n ? `Wainscot added to ${n} wall(s)` : "Select one or more walls first", n ? "success" : "warn");
      }, "Wainscot"), { title: "Add a 1.2 m wainscot panel to the selected walls" }),
      b("wall", "Reveal", safe(async () => {
        const { promptLine } = await import("../features/form-modal");
        const v = await promptLine("Wall reveal", "Height above the wall base (m)", "1.0", undefined, "A 10 mm groove is cut into both faces of the selected walls.");
        if (v == null) return;
        const h = Number(v.replace(",", "."));
        if (!Number.isFinite(h) || h < 0) { toast("Enter a height of 0 or more", "warn"); return; }
        const n = addWallSweepToSelected({ profileId: "reveal-10", height: h, face: "both" });
        toast(n ? `Reveal cut into ${n} wall(s)` : "Select one or more walls first", n ? "success" : "warn");
      }, "Reveal"), { title: "Cut a 10 mm groove into the selected straight walls" }),
      b("wall", "Clear Sweeps", safe(() => {
        const n = clearWallSweepsSelected();
        toast(n ? `Sweeps removed from ${n} wall(s)` : "Selected walls have no sweeps", n ? "success" : "info");
      }, "Clear sweeps"), { title: "Remove baseboards, cornices, wainscots and reveals from the selected walls" }),
      sep(),
      groupLabel("Constraints"),
      lockDimensionButton(),
      equalityButton(),
      sep(),
      // groupLabel("Modify") REPLACED BY CONTEXTUAL TAB,
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
      groupLabel("Massing"),
      b("mass", "In-Place Mass", safe(async () => {
        await openInPlaceMassDialog();
      }, "In-place mass"), { title: "Create a conceptual mass element (extruded polygon)" }),
      b("mass", "Mass Floors", safe(async () => {
        await openMassFloorsDialog();
      }, "Mass floors"), { title: "Extract mass floor areas from conceptual masses" }),
      b("mass", "Mass to Elements", safe(async () => {
        await openMassToElementsDialog();
      }, "Mass to elements"), { title: "Convert a conceptual mass into native walls, floors and roof" }),
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
      // G6 — Revit Structure panel order: Beam, Brace, Column, Wall, Floor,
      // Truss. Beam System (Revit position 2) does not exist — no engine
      // support; see ribbon-draw-order.ts deviations.
      toolBtn("beam", "Beam", "beam", "BM"),
      toolBtn("brace", "Brace", "brace", "BR"),
      toolBtn("column", "Column", "column", "CM"),
      toolBtn("wall", "Wall", "wall"),
      toolBtn("floor", "Floor", "slab"),
      toolBtn("truss", "Truss", "truss", "TS"),
      sep(),
      // G6 — group renamed to Revit's "Foundations"; buttons renamed to
      // Revit's Isolated / Wall / Slab (same footing / strip / slab tools).
      // Pile is kept after Slab as a product extra (no Revit counterpart).
      groupLabel("Foundations"),
      toolBtn("footing", "Isolated", "footing", "FT"),
      toolBtn("strip", "Wall", "strip", "SF"),
      toolBtn("slab", "Slab", "slab"),
      toolBtn("pile", "Pile", "pile"),
      sep(),
      groupLabel("Connections"),
      b("conn", "Moment", safe(() => {
        (ctx.features as any).structuralConnection?.build?.({ type: "moment-flange-plate", columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4 });
        toast("Moment flange-plate connection placed", "success");
      }, "Moment connection"), { title: "Moment flange-plate connection" }),
      b("conn", "Shear", safe(() => {
        (ctx.features as any).structuralConnection?.build?.({ type: "shear-end-plate", columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4 });
        toast("Shear end-plate connection placed", "success");
      }, "Shear connection"), { title: "Shear end-plate connection" }),
      b("conn", "Base Plate", safe(() => {
        (ctx.features as any).structuralConnection?.build?.({ type: "base-plate", columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4 });
        toast("Base-plate connection placed", "success");
      }, "Base plate"), { title: "Column base-plate connection" }),
      b("conn", "Cap Plate", safe(() => {
        (ctx.features as any).structuralConnection?.build?.({ type: "cap-plate", columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4 });
        toast("Cap-plate connection placed", "success");
      }, "Cap plate"), { title: "Column cap-plate connection" }),
      b("conn", "Splice", safe(() => {
        (ctx.features as any).structuralConnection?.build?.({ type: "splice-plate", columnSize: 0.2, beamSize: 0.2, boltsPerRow: 4 });
        toast("Splice-plate connection placed", "success");
      }, "Splice"), { title: "Column-to-column splice-plate connection" }),
      sep(),
      groupLabel("Truss Builder"),
      b("truss", "Pratt", safe(() => {
        (ctx.features as any).truss?.build?.({ type: "pratt", span: 12, depth: 2, panelCount: 6 });
        toast("Pratt truss built (12 m span, 6 panels)", "success");
      }, "Pratt"), { title: "Build a Pratt truss" }),
      b("truss", "Howe", safe(() => {
        (ctx.features as any).truss?.build?.({ type: "howe", span: 12, depth: 2, panelCount: 6 });
        toast("Howe truss built", "success");
      }, "Howe"), { title: "Build a Howe truss" }),
      b("truss", "Warren", safe(() => {
        (ctx.features as any).truss?.build?.({ type: "warren", span: 12, depth: 2, panelCount: 6 });
        toast("Warren truss built", "success");
      }, "Warren"), { title: "Build a Warren truss" }),
      b("truss", "Fink", safe(() => {
        (ctx.features as any).truss?.build?.({ type: "fink", span: 12, depth: 2, panelCount: 6 });
        toast("Fink truss built", "success");
      }, "Fink"), { title: "Build a Fink truss" }),
      sep(),
      // G6 — group renamed to Revit's "Reinforcement". Area / Path / Fabric
      // reinforcement do not exist (no engine support); the group keeps the
      // working tools: Generate Rebar, Export BBS, Clash Review.
      groupLabel("Reinforcement"),
      b("rebar", "Generate Rebar", safe(() => {
        (window as any).__obsRebarViewport?.generate?.();
      }, "Generate rebar"), { title: "Generate 3D rebar inside the selected beam/column/footing" }),
      b("rebar", "Export BBS", safe(() => {
        (window as any).__obsRebarViewport?.exportBBS?.();
      }, "Export BBS"), { title: "Export Bar Bending Schedule as CSV" }),
      b("check", "Clash Review", safe(() => openRebarClashReview(), "Rebar clash review"), {
        title: "Interactive rebar clash, lap-splice and standards review (EC2 / ACI / BS) for the generated rebar",
      }),
      sep(),
      groupLabel("Properties"),
      propertiesButton(),
    ],
  },

  // ═══════════════════════════ SYSTEMS (Revit) ═══════════════════════════
  // G1a: Mechanical + Electrical merged — every tool kept, regrouped.
  // "Electrical" is one group (was Containment/Power/Lighting/Equipment).
  {
    id: "systems",
    label: "Systems",
    items: () => [
      groupLabel("HVAC"),
      toolBtn("duct", "Duct", "duct", "DU"),
      toolBtn("duct-fitting", "Fitting", "duct-fitting"),
      toolBtn("air-terminal", "Terminal", "air-terminal"),
      toolBtn("flex-duct", "Flex", "flex-duct"),
      toolBtn("duct-accessory", "Accessory", "duct-accessory"),
      toolBtn("equipment", "Equip", "equipment"),
      sep(),
      groupLabel("Auto-Route"),
      b("duct", "Auto-Route…", safe(async () => {
        const mep = (window as any).__obsMep;
        if (!mep) { toast("MEP module not loaded", "warn"); return; }
        // Open a single form modal with all 5 inputs, instead of 5 sequential prompts.
        const { openFormModal } = await import("../features/form-modal");
        const r = await openFormModal({
          title: "MEP Auto-Route",
          subtitle: "Auto-route MEP between two points with ASHRAE sizing",
          fields: [
            { kind: "select", key: "system", label: "System", default: "supply-air",
              options: [
                ["supply-air", "1. Supply Air"], ["return-air", "2. Return Air"],
                ["chilled-water", "3. Chilled Water"], ["hot-water", "4. Hot Water"],
                ["domestic-cold", "5. Domestic Cold"], ["gas", "6. Gas"],
                ["cable-tray", "7. Cable Tray"], ["conduit", "8. Conduit"],
              ],
            },
            { kind: "number", key: "flow", label: "Flow rate", default: 0.5, unit: "m³/s (air) / L/s (water)", step: 0.1, min: 0.01,
              hint: "Air: m³/s · Water: L/s",
            },
            { kind: "number", key: "elev", label: "Elevation", default: 2.7, unit: "m", step: 0.1 },
            { kind: "text", key: "start", label: "Start point", default: "0,0", placeholder: "X,Z", hint: "Comma-separated X,Z (m)" },
            { kind: "text", key: "end", label: "End point", default: "5,0", placeholder: "X,Z", hint: "Comma-separated X,Z (m)" },
          ],
          submitLabel: "Route",
        });
        if (!r) return;
        const sys = String(r.system);
        const flow = parseFloat(r.flow);
        const elev = parseFloat(r.elev);
        const sp = String(r.start).split(",").map(parseFloat);
        const ep = String(r.end).split(",").map(parseFloat);
        if (isNaN(flow) || isNaN(elev) || sp.length < 2 || ep.length < 2) {
          toast("Invalid input — please check the form values", "warn");
          return;
        }
        const result = mep.route({
          start: { x: sp[0], y: elev, z: sp[1] },
          end: { x: ep[0], y: elev, z: ep[1] },
          system: sys,
          flowRate: flow,
        });
        if (result) toast(`Route complete: ${result.legs.length} legs, ${result.bendCount} bends`, "success");
        else toast("No route found", "warn");
      }, "MEP Auto-Route"), { title: "Auto-route MEP between two points with ASHRAE sizing" }),
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
      sep(),
      groupLabel("Electrical"),
      toolBtn("cable-tray", "Cable tray", "cable-tray"),
      toolBtn("cable-tray-fitting", "Tray Ftg", "cable-tray-fitting"),
      toolBtn("conduit", "Conduit", "conduit"),
      toolBtn("conduit-fitting", "Cond Ftg", "conduit-fitting"),
      toolBtn("wire", "Wire", "wire"),
      toolBtn("panel", "Panel", "panel"),
      toolBtn("switch", "Switch", "switch"),
      toolBtn("outlet", "Outlet", "outlet"),
      toolBtn("junction-box", "Box", "junction-box"),
      toolBtn("lighting-fixture", "Fixture", "lighting-fixture"),
      toolBtn("emergency-light", "Emergency", "emergency-light"),
      toolBtn("lighting-switch", "Switch", "lighting-switch"),
      toolBtn("transformer", "Transformer", "transformer"),
      toolBtn("generator", "Generator", "generator"),
      sep(),
      groupLabel("Systems"),
      systemBrowserButton(),
      mepFabButton(),
      mepToolkitButton(),
      pidModelerButton(),
      sep(),
      groupLabel("Display"),
      b("system", "MEP colors", safe(() => toggleMepColors(), "MEP colors"),
        { active: isMepColoringActive(),
          title: "Color MEP categories so fittings match the runs they belong to" }),
      sep(),
      groupLabel("Engineering"),
      b("system", "MEP Systems", safe(() => openMepLifecyclePanel(), "MEP systems diagnostics"), {
        title: "Connector-network + electrical distribution diagnostics, panel schedules and load/circuit management for the native MEP model",
      }),
      b("duct-fitting", "Tray Fill Calc", safe(() => void openTrayFillDialog(), "Cable tray fill calculator"), {
        title: "NEC 392 tray fill ratio + suggested standard width for a cable bundle",
      }),
      b("conn", "Hanger Spacing", safe(() => void openHangerSpacingDialog(), "Hanger spacing calculator"), {
        title: "SMACNA / MSS SP-69 hanger count, spacing and rod sizing for a straight run",
      }),
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
      b("file", "BIM / Navisworks…", safe(() => {
        (window as any).__obsBIMImport?.pickAndConvert?.();
      }, "BIM import"), { title: "Import .rvt / .nwd / .nwc / .nwf — converts to IFC locally with your Navisworks (or via APS)" }),
      b("file", "IFC", safe(() => linkIfc(), "Link IFC"), {
        title: "Link IFC models — origin-to-origin federation (same as old OpenBIMStudio)",
      }),
      b("file-frag", "IFC→FRAG", safe(() => {
        void import("../features/ifc-to-frag").then((m) => m.toggleIfcToFragPanel());
      }, "IFC to FRAG"), {
        title: "Convert IFC / IFCZIP to .frag and download — then Link FRAG (best for large models)",
      }),
      b("file-frag", "FRAG", safe(() => linkFrag(), "Link FRAG"), {
        title: "Load FRAG as-is — coordinates preserved (old FRAG linker)",
      }),
      b("folder", "Any model…", safe(() => void pickAndImport(), "Import any model"), {
        title: "Select many files at once, any mix of formats (IFC, RVT/RFA, DWG/DXF, GLB/OBJ/FBX…): each kind is linked in one step",
      }),
      sep(),
      groupLabel("Link CAD / BIM"),
      b("system", "Link CAD", safe(() => linkCad(), "Link CAD underlay"), {
        title: "DXF / SVG / PNG underlay for plan tracing, or 3D drawing reference",
      }),
      b("folder", "CAD Query", safe(() => {
        void import("../features/cad-query-panel").then((m) => m.toggleCadQueryPanel());
      }, "CAD Query"), {
        title: "Query linked drawings by layer, element type, name / text, colour, linetype",
      }),
      b("file", "Link BIM", safe(() => linkBIM(), "Link BIM via IFC"), {
        title: "Export IFC from BIM, then link here",
      }),
      b("component", "Point cloud", safe(() => linkPointCloud(), "Point cloud"), {
        title: "PLY / XYZ / PTS / PCD (multi-file)",
      }),
      b("toposurface", "Topography", safe(() => linkTopography(), "Topography"), {
        title: "Site mesh (OBJ / STL / PLY / GLB)",
      }),
      b("pdf", "PDF Underlay", safe(() => {
        (ctx.features as any).pdfUnderlay?.load?.();
      }, "PDF underlay"), { title: "Load PDF as plan-view raster underlay (snappable)" }),
      sep(),
      groupLabel("Fabrication"),
      b("duct", "Duct Parts", safe(() => {
        (ctx.features as any).fabricationPart?.build?.({ type: "duct-straight", primarySize: 0.4, length: 1.5 });
      }, "Duct parts"), { title: "Place SMACNA fabrication duct parts" }),
      b("pipe", "Pipe Parts", safe(() => {
        (ctx.features as any).fabricationPart?.build?.({ type: "pipe-straight", primarySize: 0.05, length: 2.0 });
      }, "Pipe parts"), { title: "Place ASTM fabrication pipe parts" }),
      b("pipe", "Fittings", safe(async () => {
        const opts: Array<[string, string]> = [
          ["duct-elbow-90", "Duct Elbow 90°"],
          ["duct-tee", "Duct Tee"],
          ["pipe-elbow-90", "Pipe Elbow 90°"],
          ["pipe-reducer", "Pipe Reducer"],
          ["pipe-valve", "Pipe Valve"],
        ];
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Fabrication Fitting",
          "Pick a fitting type",
          opts.map(([value, label]) => ({ value, label })),
        );
        if (!choice) return;
        (ctx.features as any).fabricationPart?.build?.({ type: choice, primarySize: 0.1 });
      }, "Fittings"), { title: "Pick a fabrication fitting by type" }),
      sep(),
      groupLabel("Load from Library"),
      // Family Creator / Sketch Family / Family Panel moved to the
      // Parametric tab (A12); Family + Materials stay here.
      b("new-family", "Family", safe(() => openFamilyLibrary(), "Types & materials"), {
        title: "Element types and materials library",
      }),
      b("component", "Materials", safe(async () => {
        const m = (window as any).__obsMaterials;
        if (!m) { toast("Materials module not loaded", "warn"); return; }
        const list = m.list();
        const auth = (ctx.features as any).authoring;
        const ids = auth?.getSelectedIds?.() ?? [];
        if (!ids.length) {
          toast(`Available materials: ${list.map((x: any) => x.name).join(", ")}`, "info", 5000);
          return;
        }
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Assign Material",
          `Assign to ${ids.length} element(s)`,
          list.map((x: any) => ({ value: x.id, label: `${x.id} — ${x.name}` })),
          list[0]?.id,
        );
        if (!choice) return;
        for (const id of ids) m.assign(id, choice);
        toast(`Material "${choice}" assigned to ${ids.length} element(s)`, "success");
      }, "Material assign"), { title: "Assign a material to the selected element(s)" }),
      b("component", "Autodesk", safe(() => linkAutodesk(), "Autodesk via IFC"), {
        title: "RVT / NWD / DWG — export open formats then import",
      }),
      b("new-sheet", "Library", safe(() => openComponentLibrary(), "Component library"), {
        title: "Materials, types and production library",
      }),
      sep(),
      groupLabel("Placement"),
      b("home", "Origin↔Origin", safe(() => alignOriginToOrigin(), "Origin to origin"), {
        title: "Force all linked models to identity (0,0,0) — BIM link style",
      }),
      b("fit", "Recenter", safe(() => recenterSceneNow(), "Recenter scene"), {
        title: "Recenter first model to origin (optional)",
      }),
      b("undo", "Reset offsets", safe(() => resetOffsets(), "Reset offsets"), {
        title: "Clear all placement offsets",
      }),
      b("origin", "Align…", safe(() => toggleAlign(), "Model alignment"), {
        title: "Model alignment window: align linked models to each other",
      }),
      b("tree", "Models", safe(() => toggleToolWindow("models"), "Models list"), {
        active: isToolWindowOpen("models"),
        title: "Loaded models: visibility, remove, per-model actions",
      }),
      sep(),
      groupLabel("Ext"),
      b("issues", "Issues", safe(() => toggleIssuesPanel(), "Issues"), { active: isIssuesPanelVisible() }),
      b("clash", "Clash", safe(() => {
        void refreshModelSelectionUI();
        const tab = document.querySelector('[data-tab="clash"]') as HTMLElement | null;
        tab?.click();
        openToolWindow("clash");
      }, "Clash Detective"), { title: "Open Clash Detective" }),
      b("cost", "Cost", safe(() => toggleCostPanel(), "Cost"), { active: isCostPanelVisible() }),
      idsButton(),
      treeButton(),
      sep(),
      groupLabel("Analysis"),
      b("system", "Color Fill", safe(async () => {
        const ap = (window as any).__obsAreaPlans;
        if (!ap) { toast("Area plans module not loaded", "warn"); return; }
        const schemes = ap.list();
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Color Fill Scheme",
          "Color rooms by which scheme?",
          schemes.map((s: any) => ({ value: s.id, label: s.label })),
          "by-department",
        );
        if (!choice) return;
        if (!isPlanViewVisible()) togglePlanView();
        toast(`Color fill enabled: ${choice}. Open Plan View to see rooms colored.`, "success");
      }, "Color fill"), { title: "Color fill plan — color rooms by department/occupancy/area type" }),
      b("sun", "Sun Settings", safe(async () => {
        const sun = (window as any).__obsSun;
        if (!sun) { toast("Sun settings module not loaded", "warn"); return; }
        const s = sun.get();
        const { openFormModal } = await import("../features/form-modal");
        const r = await openFormModal({
          title: "Sun Settings",
          subtitle: "Configure sun position + shadows for solar study",
          fields: [
            { kind: "text", key: "date", label: "Date", default: s.date, placeholder: "YYYY-MM-DD", hint: "ISO date format" },
            { kind: "text", key: "time", label: "Time", default: s.time, placeholder: "HH:MM (24h)", hint: "24-hour format" },
            { kind: "number", key: "lat", label: "Latitude", default: s.latitude, unit: "°", step: 0.1, min: -90, max: 90, hint: "Negative = south hemisphere" },
          ],
          submitLabel: "Apply",
        });
        if (!r) return;
        const date = String(r.date);
        const time = String(r.time);
        const lat = parseFloat(r.lat);
        if (!date || !time || isNaN(lat)) { toast("Invalid input", "warn"); return; }
        sun.set({ date, time, latitude: lat, enabled: true });
        toast(`Sun set to ${date} ${time} at lat ${lat}°`, "success");
      }, "Sun settings"), { title: "Configure sun position + shadows for solar study" }),
      b("sun", "Shadows", safe(() => {
        const sun = (window as any).__obsSun;
        if (!sun) { toast("Sun settings not loaded", "warn"); return; }
        const s = sun.get();
        sun.set({ enabled: !s.enabled });
        toast(`Shadows: ${!s.enabled ? "ON" : "OFF"}`, "success");
      }, "Shadows"), { title: "Toggle sun shadows on/off" }),
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
      groupLabel("Graphics"),
      b("dim-linear", "Line Weights", safe(async () => {
        const lw = (window as any).__obsLineWeights;
        if (!lw) { toast("Line weights module not loaded", "warn"); return; }
        const list = lw.list();
        const { showTableDialog } = await import("../features/form-modal");
        await showTableDialog("Line weights", ["Element type", "Width (mm)", "Colour"],
          list.map((r: any) => [r.elementType, r.widthMm, r.color]), `${list.length} rules`);
      }, "Line weights"), { title: "View line weight assignments per element type" }),
      b("grid", "Grid Bubbles", safe(async () => {
        const gb = (window as any).__obsGridBubbles;
        if (!gb) { toast("Grid bubbles module not loaded", "warn"); return; }
        const grids = gb.getGrids();
        const levels = gb.getLevels();
        const { showObjectsDialog } = await import("../features/form-modal");
        await showObjectsDialog("Grids and levels",
          [...grids.map((g: any) => ({ kind: "grid", ...g })), ...levels.map((l: any) => ({ kind: "level", ...l }))],
          `${grids.length} grid bubble(s), ${levels.length} level marker(s)`);
      }, "Grid bubbles"), { title: "View grid bubbles and level markers" }),
      sep(),
      groupLabel("Dimension"),
      b("dim-aligned", "Aligned", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-aligned"), 40);
      }, "Aligned dimension"), {
        kbd: "DI", title: "Aligned Dimension: pick two model boundaries",
      }),
      b("dim-linear", "Linear", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-linear"), 40);
      }, "Linear dimension"), {
        title: "Linear Dimension: horizontal / vertical between two boundaries",
      }),
      b("dim-auto", "Auto Dim", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("auto-dim"), 40);
      }, "Auto dimension"), {
        title: "Auto Dimension: pick the first edge and the last edge - every wall, column, door and window between them is dimensioned",
      }),
      b("dim-auto", "Dim All", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("auto-dim-all"), 40);
      }, "Dimension all"), {
        title: "Dimension All: X and Y chains for every column and wall, 50 cm outside the model",
      }),
      b("dim-angular", "Angular", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-angular"), 40);
      }, "Angular dimension"), {
        title: "Angular Dimension: pick two edges — interior angle",
      }),
      b("dim-radial", "Radial", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-radial"), 40);
      }, "Radial dimension"), {
        title: "Radial Dimension: pick center then edge — R =",
      }),
      b("arc-length", "Arc", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-arc"), 40);
      }, "Arc length"), {
        title: "Arc Length Dimension: two points along an edge",
      }),
      b("spot-elev", "Elevation", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("spot-elev"), 40);
      }, "Spot elevation"), {
        title: "Spot Elevation: click a point",
      }),
      b("spot-coord", "Coordinate", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("spot-coord"), 40);
      }, "Spot coordinate"), {
        title: "Spot Coordinate: click for X / Z",
      }),
      // G7: Diameter is its own dimension type in the plan engine
      // (style "diameter": Ø = 2R, solid line) — it used to alias Radial.
      b("dim-radial", "Diameter", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-diameter"), 40);
        toast("Diameter: pick a circle or arc", "info");
      }, "Diameter dimension")),
      // G7: Slope is its own dimension type (style "slope"): click a sloped
      // run and it shows the run's slope (% + 1:N) — not a spot elevation.
      b("spot-elev", "Slope", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-slope"), 40);
        toast("Slope: click a sloped duct / pipe / tray / conduit run", "info");
      }, "Spot slope")),
      sep(),
      groupLabel("Chain"),
      // G7: Continuous and Baseline are distinct chain kinds on the aligned
      // dimension tool — Continuous chains segments end-to-end, Baseline
      // measures every target from the first picked boundary. They used to
      // both just activate dim-aligned + a toast.
      b("dim-aligned", "Continuous", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-continuous"), 40);
        toast("Continuous dimension: click multiple points in sequence", "info");
      }, "Continuous dimension"), { title: "Chain of dimensions placed end-to-end" }),
      b("dim-aligned", "Baseline", safe(() => {
        if (!isPlanViewVisible()) togglePlanView();
        setTimeout(() => (ctx.features as any).planView?.setTool?.("dim-baseline"), 40);
        toast("Baseline dimension: pick the origin, then targets — all measured from the origin", "info");
      }, "Baseline dimension"), { title: "Multiple dimensions from a common baseline" }),
      sep(),
      groupLabel("Keynotes"),
      b("text", "Assign Keynote", safe(async () => {
        const k = (window as any).__obsKeynotes;
        if (!k) { toast("Keynotes module not loaded", "warn"); return; }
        const auth = (ctx.features as any).authoring;
        const ids = auth?.getSelectedIds?.() ?? [];
        if (!ids.length) { toast("Select an element first", "warn"); return; }
        const { promptLine } = await import("../features/form-modal");
        const code = await promptLine(
          "Assign Keynote",
          "Keynote code",
          "",
          "e.g. 05 10 00.A",
          "MasterFormat / UniFormat code",
        );
        if (!code) return;
        k.assign({ elementId: ids[0], viewId: null, code, offsetMm: [50, 50], leader: true });
        toast(`Keynote "${code}" assigned to element`, "success");
      }, "Assign keynote"), { title: "Assign a keynote to the selected element" }),
      b("text", "Keynote Legend", safe(() => {
        const legend = keynoteLegend();
        if (!legend.length) { toast("No keynotes assigned yet", "info"); return; }
        exportKeynoteLegendCsv(legend.length);
      }, "Keynote legend"), { title: "Export keynote legend as CSV" }),
      sep(),
      groupLabel("Detail"),
      // G7: Detail Line and Insulation are distinct line styles. In the plan
      // view Insulation draws as batting (sine wave along the run) while a
      // detail line stays a plain line; both are mline runs, distinguished
      // by properties.lineStyle. In 3D the style rides on the next run.
      b("detail-line", "Detail Line", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("mline"); return; }
        setNextMlineLineStyle("detail");
        setAuthoringTool("mline");
        toast("Detail line — click points to draw", "success");
      }, "Detail line")),
      b("detail-component", "Detail Comp…", safe(async () => {
        const dc = (window as any).__obsDetailComponents;
        if (!dc) { toast("Detail components module not loaded", "warn"); return; }
        const list = dc.list();
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Detail Components",
          "Pick a component to place",
          list.map((c: any) => ({ value: c.name, label: `${c.name} (${c.category})` })),
        );
        if (!choice) return;
        toast(`Detail component "${choice}" selected. Click to place.`, "success");
        setAuthoringTool("equipment");
      }, "Detail component"), { title: "Pick a detail component from the library" }),
      b("filled-region", "Filled Region", safe(() => {
        const pv = (ctx.features as any).planView;
        if (!pv?.startRegion) { toast("Plan view engine not loaded", "warn"); return; }
        if (!pv.isVisible?.()) { toast("Filled Region needs a plan view — open one from the 2D zone (Menu → Floor Plan (2D))", "warn"); return; }
        pv.startRegion("filled");
      }, "Filled region"), { title: "Draw a filled region with hatch pattern (plan view)" }),
      b("masking-region", "Masking Region", safe(() => {
        const pv = (ctx.features as any).planView;
        if (!pv?.startRegion) { toast("Plan view engine not loaded", "warn"); return; }
        if (!pv.isVisible?.()) { toast("Masking Region needs a plan view — open one from the 2D zone (Menu → Floor Plan (2D))", "warn"); return; }
        pv.startRegion("masking");
      }, "Masking region"), { title: "Draw a masking region to hide geometry (plan view)" }),
      b("model-curve", "Model Curve", safe(() => {
        const mc = (window as any).__obsModelCurves;
        if (!mc) { toast("Model curves module not loaded", "warn"); return; }
        const auth = (ctx.features as any).authoring;
        const ids = auth?.getSelectedIds?.() ?? [];
        if (!ids.length) { toast("Select an element face first, then draw curves on it", "warn"); return; }
        toast(`Model curve mode: click on face of "${ids[0]}" to draw curves`, "success");
      }, "Model curve"), { title: "Draw 2D curves on element faces for push-pull or hosted placement" }),
      b("insulation", "Insulation", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("insulation"); return; }
        setNextMlineLineStyle("insulation");
        setAuthoringTool("mline");
        toast("Insulation line — draw along hosts (renders as batting in plan)", "success");
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
      b("revision-cloud", "Cloud", safe(async () => {
        // Use the registered revision-cloud workflow; do not silently start MLINE.
        const revisions = (ctx.features as any).revisions;
        if (typeof revisions?.begin === "function") {
          await revisions.begin();
          return;
        }
        const mod = await import("../features/revision-cloud");
        await mod.beginCloudPlacement();
      }, "Revision cloud"), { title: "Place a revision cloud in the active plan view" }),
      sep(),
      groupLabel("Text"),
      b("text", "Text", safe(async () => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("text"); return; }
        const { promptLine } = await import("../features/form-modal");
        const t = await promptLine(
          "Text Note",
          "Annotation text",
          "Note",
          "Type your note here",
        );
        if (t != null && t.trim()) toast(`Text note saved: “${t.trim()}”`, "success");
      }, "Text note")),
      b("model-text", "3D text", safe(async () => {
        const { promptLine } = await import("../features/form-modal");
        const t = await promptLine(
          "3D Model Text",
          "Text content",
          "ROOM",
          "e.g. ROOM, OFFICE, EXIT",
        );
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
        if (pv?.isVisible?.()) { pv.setTool?.("tag-all"); return; }
        toast("Tag all: open the plan view to tag every element, or use Schedules", "info");
        try { toggleSchedules(); } catch { /* */ }
      }, "Tag all")),
      // G7: each tag mode is now its own plan tool — the mode filters which
      // categories the tag accepts and which label it renders. They used to
      // all call setTool("tag").
      b("material-tag", "Material", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag-material"); return; }
        openFamilyLibrary();
        toast("Material tags — assign from materials library", "info");
      }, "Material tag")),
      b("room-tag", "Room tag", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("room-tag"); return; }
        setAuthoringTool("equipment");
        toast("Room tag — place a marker; name it in Properties", "success");
      }, "Room tag")),
      b("tag", "Multi-Cat", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag-multi"); return; }
        toast("Multi-Category tag: click elements", "info");
      }, "Multi-Category tag")),
      b("area", "Area", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("tag-area"); return; }
        toast("Area tag: place an area marker", "info");
      }, "Area tag")),
      sep(),
      groupLabel("Legend"),
      b("text", "Keynote", safe(() => {
        // Same working keynote-legend export as the Keynote Legend button —
        // this duplicate used to be a toast-only stub.
        const legend = keynoteLegend();
        if (!legend.length) { toast("No keynotes assigned yet — assign a keynote to a selected element first", "info"); return; }
        exportKeynoteLegendCsv(legend.length);
      }, "Keynote")),
      sep(),
      b("clear", "Clear", safe(() => {
        const pv = (ctx.features as any).planView;
        if (pv?.isVisible?.()) { pv.setTool?.("clear-annotations"); return; }
        try { ctx.features.measure?.clear?.(); } catch { /* */ }
        toast("Annotations / measures cleared", "info");
      }, "Clear")),
    ],
  },

  // ═══════════════════════════ PARAMETRIC ══════════════════════════════
  // AutoCAD parity (A12): the parametric toolkit moves here from the
  // Architecture Constraints group; the family tools move here from the
  // Insert "Load from Library" group; the constraint tools are shared
  // with Architecture (same builders, same handlers — not copies).
  {
    id: "parametric",
    label: "Parametric",
    items: () => [
      groupLabel("Parametric"),
      parametricToolkitButton(),
      sep(),
      groupLabel("Families"),
      b("new-family", "Family Creator", safe(() => openFamilyCreatorEngine(), "Family Creator engine"), {
        title: "Parametric Family Creator — parameters, constraints, extrusion / revolve / sweep geometry, library save",
      }),
      b("component", "Sketch Family", safe(() => {
        void import("../features/family-sketch-editor").then((m) => m.openFamilySketchEditor());
      }, "Sketch family"), {
        title: "Draw a plan outline and create a parametric family from it",
      }),
      b("component", "Family Panel", safe(() => openParamFamilyPanel(), "Parametric family panel"), {
        title: "Inspect and edit family parameters, rebuild geometry, open sketch",
      }),
      sep(),
      groupLabel("Constraints"),
      lockDimensionButton(),
      equalityButton(),
    ],
  },

  // ════════════════════════════ BIM TOOLS ═════════════════════════════


  // ════════════════════════════ ANALYZE ════════════════════════════════
  {
    id: "analyze",
    label: "Analyze",
    items: () => [
      groupLabel("Model Checker"),
      b("inspect", "Run Check", safe(() => {
        const obs = (window as any).__obs;
        const elements = obs?.elements ?? [];
        if (!elements.length) {
          toast("No loaded model elements to check — load an IFC first", "warn");
          return;
        }
        const report = (ctx.features as any).modelChecker.run(elements);
        const rows: ResultRow[] = [
          { label: "Elements checked", value: String(report.totalElements ?? elements.length) },
          { label: "Errors", value: String(report.summary?.errors ?? 0), strong: true },
          { label: "Warnings", value: String(report.summary?.warnings ?? 0), strong: true },
          { label: "Infos", value: String(report.summary?.infos ?? 0) },
          { label: "Duration", value: `${report.durationMs} ms` },
        ];
        const findings = (report.results ?? []).slice(0, 8).map((f: any) =>
          `${f.ruleName ?? f.ruleId}: ${f.message}${f.elementIds?.length ? ` (elements ${f.elementIds.slice(0, 4).join(", ")})` : ""}`);
        showResultDialog("Model Checker Report", rows, findings.length ? findings : ["No findings — all shipped rules passed."]);
      }, "Run model checker"), { title: "Run QA rules against loaded elements" }),
      b("inspect", "List Rules", safe(() => {
        const rules = (ctx.features as any).modelChecker.listRules();
        toast(`Shipped rules: ${rules.join(", ")}`, "info", 4000);
      }, "List rules"), { title: "List shipped model-checker rule IDs" }),
      sep(),
      groupLabel("Health & QA"),
      b("inspect", "Model Health", safe(() => {
        void toggleModelHealth();
      }, "Model health dashboard"), { title: "BIM QA dashboard — duplicate GlobalIds, missing names/properties, orphan geometry; findings are clickable" }),
      b("inspect", "Model QA", safe(async () => {
        const m = await import("../features/model-qa-summary");
        m.openModelQADialog();
      }, "Model QA dialog"), { title: "Scan for unhosted doors/windows, zero-length beams, unclosed rooms, missing materials" }),
      b("check", "Coordination Report", safe(async () => {
        await previewCoordinationReportHtml();
      }, "Coordination report"), { title: "Combined clashes + standards-compliance report (single HTML, printable / emailable)" }),
      b("check", "Export Report", safe(async () => {
        await exportCoordinationReportHtml();
      }, "Export coordination report"), { title: "Download the combined coordination report as an HTML file" }),
      sep(),
      groupLabel("Daylight"),
      b("sun", "Daylight", safe(() => {
        const r = (ctx.features as any).daylighting.run({
          room: { width: 6, depth: 4, height: 3 },
          windowArea: 4,
          visibleTransmittance: 0.7,
          reflectances: { ceiling: 0.8, walls: 0.5, floor: 0.2 },
          workplaneHeight: 0.8,
          gridResolution: 0.5,
          exteriorIlluminance: 10000,
        });
        showResultDialog("Daylight Factor Analysis — 6 × 4 × 3 m room", [
          { label: "Average daylight factor", value: `${r.averageDF?.toFixed?.(2) ?? r.averageDF}%`, strong: true },
          { label: "sDA (spatial daylight autonomy)", value: String(r.sDA), strong: true },
          { label: "ASE (annual sunlight exposure)", value: String(r.ASE) },
          { label: "Classification", value: String((ctx.features as any).daylighting.classify?.(r.averageDF) ?? "") },
        ], ["Demo room 6 × 4 × 3 m, 4 m² window, VT 0.7. Parametric room studies arrive with the generative design editor."]);
      }, "Daylight"), { title: "Compute daylight factor + sDA + ASE for the default room" }),
      b("sun", "Solar", safe(() => {
        const sun = (window as any).__obsSun;
        if (!sun) { toast("Sun module not loaded", "warn"); return; }
        sun.set({ enabled: true });
        toast("Sun enabled — use Sun panel to set date/time/lat", "info");
      }, "Solar study"), { title: "Open solar study panel" }),
      sep(),
      groupLabel("Energy"),
      b("energy", "Heat Loss", safe(async () => {
        // Runs the real energy engine over authored rooms (see energy-ui.ts).
        // The old handler called __obsEnergyAnalysis — a global that never
        // existed — so this button silently did nothing behind a toast.
        const m = await import("../features/energy-ui");
        await m.runHeatLossReport();
      }, "Heat loss"), { title: "Run steady-state heat loss per room" }),
      b("energy", "gbXML", safe(async () => {
        const m = await import("../features/energy-ui");
        await m.exportGbXmlFile();
      }, "gbXML"), { title: "Export gbXML for external energy simulators" }),
      sep(),
      groupLabel("Loads"),
      b("loads", "Load Cases", safe(() => {
        (ctx.features as any).structuralLoads?.createCase?.({ name: "Dead Load", category: "dead", magnitude: 24, direction: { x: 0, y: -1, z: 0 } });
        (ctx.features as any).structuralLoads?.createCase?.({ name: "Live Load", category: "live", magnitude: 2.5, direction: { x: 0, y: -1, z: 0 } });
        toast("Dead + Live load cases created", "success");
      }, "Load cases"), { title: "Create default dead + live load cases" }),
      b("loads", "ASCE Combos", safe(() => {
        const cases = (ctx.features as any).structuralLoads?.listCases?.() ?? [];
        if (cases.length < 2) { toast("Create load cases first", "warn"); return; }
        const combos = (ctx.features as any).structuralLoads?.generateDefaultLRFDCombinations?.();
        toast(`Generated ${combos.length} LRFD combinations (ASCE 7-22)`, "success");
      }, "Generate combos"), { title: "Generate ASCE 7 LRFD combinations" }),
      sep(),
      groupLabel("Generative"),
      b("generative", "Run Study", safe(() => {
        const result = (ctx.features as any).generativeDesign.run({
          name: "Window-to-Wall Ratio study",
          variables: [
            { name: "wwr", kind: "continuous", min: 0.1, max: 0.6 },
            { name: "depth", kind: "continuous", min: 3, max: 8 },
          ],
          objectives: [
            { name: "daylight", direction: "maximize", evaluate: (s: any) => s.wwr * 100 - s.depth * 2 },
            { name: "energy", direction: "minimize", evaluate: (s: any) => s.depth * 5 + s.wwr * 30 },
          ],
          constraints: [
            { name: "wwr-floor", check: (s: any) => s.wwr > 0.15 },
          ],
        });
        const top = (result.paretoFront ?? []).slice(0, 6).map((p: any) => {
          const s = p.sample ?? {};
          const sc = p.scores ?? {};
          return `wwr ${Number(s.wwr ?? 0).toFixed(2)} · depth ${Number(s.depth ?? 0).toFixed(1)} m · ${Object.entries(sc).map(([k, v]) => `${k} ${Number(v).toFixed(1)}`).join(", ")}${p.feasible ? "" : " (infeasible)"}`;
        });
        showResultDialog("Generative Study — Window-to-Wall Ratio", [
          { label: "Evaluations", value: String(result.evaluated ?? 0) },
          { label: "Pareto-optimal solutions", value: String(result.paretoFront?.length ?? 0), strong: true },
        ], top.length ? top : ["No Pareto candidates returned."]);
      }, "Run generative"), { title: "Run the default generative design study (WWR vs depth trade-off)" }),
      sep(),
      groupLabel("MEP Analysis"),
      b("inspect", "MEP Balance", safe(() => openMepBalancePanel(), "MEP flow balance panel"), {
        title: "Flow balancing, duct/pipe pressure drops and cable-tray fill inspection across authored systems",
      }),
      b("duct-fitting", "Tray Fill Calc", safe(() => void openTrayFillDialog(), "Cable tray fill calculator"), {
        title: "NEC 392 tray fill ratio + suggested standard width for a cable bundle",
      }),
      b("conn", "Hanger Spacing", safe(() => void openHangerSpacingDialog(), "Hanger spacing calculator"), {
        title: "SMACNA / MSS SP-69 hanger count, spacing and rod sizing for a straight run",
      }),
      b("system", "BCF 2.1", safe(() => {
        void exportClashesBcf();
      }, "Export clash topics as BCF 2.1"), {
        title: "Export clash test results as a BCF 2.1 archive for BIMcollab / Bimplus / Revit round-trips",
      }),
      b("folder", "COBie", safe(() => {
        void exportCobie();
      }, "Export COBie workbook"), {
        title: "Export a COBie 2.4 workbook (Facility / Floor / Space / Type / Component worksheets) from the loaded model",
      }),
      sep(),
      groupLabel("AI"),
      b("system", "Ask the Model", safe(() => openNLQueryModal(), "Natural-language BIM query"), {
        title: "Ask questions about the loaded model in plain language — 'show walls thicker than 200mm' — and select the results",
      }),
      sep(),
      groupLabel("Structural FEM"),
      b("column", "Analyze Building (3D)", safe(() => void openAnalyzeBuildingDialog(), "Analyze the authored structural model in 3D"), {
        title: "Auto-generate the analytical model from columns/beams/braces, sweep LRFD load combinations — governing axial, moment and deflection per member",
      }),
      b("beam", "Frame Solver", safe(() => void openFrameSolverDialog(), "Frame FEM solver"), {
        title: "Solve a single-storey frame with the built-in Euler-Bernoulli FEM — reactions, member forces, deflection",
      }),
      b("beam", "Steel Check", safe(() => void openSteelCheckDialog(), "Steel beam check"), {
        title: "AISC-style bending/shear/deflection check against the W/IPE/HEA catalog",
      }),
      b("footing", "RC Beam", safe(() => void openRcBeamDialog(), "RC beam design check"), {
        title: "Size tension reinforcement (As) and stirrup spacing for a rectangular RC beam",
      }),
      sep(),
      groupLabel("Hydraulics"),
      b("duct", "Duct ΔP", safe(() => void openDuctPressureDialog(), "Duct pressure drop"), {
        title: "Darcy-Weisbach + Colebrook-White pressure drop for round/rect ducts",
      }),
      b("pipe", "Pipe ΔP", safe(() => void openPipePressureDialog(), "Pipe pressure drop"), {
        title: "Water pipe pressure drop and head loss",
      }),
      b("duct-fitting", "Worst Path", safe(() => void openWorstPathDialog(), "Critical path search"), {
        title: "Find the highest-loss source→sink branch the fan/pump must be sized for",
      }),
    ],
  },

  // ═════════════════════════ MASSING & SITE ════════════════════════════
  {
    id: "massing-site",
    label: "Massing & Site",
    items: () => [
      groupLabel("Topo"),
      b("topo", "Toposurface", safe(() => {
        const points = [];
        const N = 8;
        for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
          const x = i * 1.0; const z = j * 1.0;
          const y = Math.sin(x * 0.3) * 0.4 + Math.cos(z * 0.4) * 0.3;
          points.push({ x, y, z });
        }
        (ctx.features as any).toposurface.build({ points });
      }, "Toposurface"), { title: "Create TIN toposurface from sample points" }),
      b("topo", "Building Pad", safe(() => {
        (ctx.features as any).buildingPad.build({
          outline: [
            { x: 2, z: 2 }, { x: 6, z: 2 }, { x: 6, z: 6 }, { x: 2, z: 6 },
          ],
          elevation: 0.3,
          slopeAngle: 45,
          maxRun: 4,
        });
      }, "Building pad"), { title: "Create building pad with cut/fill slopes" }),
      sep(),
      groupLabel("Property"),
      b("property", "Property Line", safe(() => {
        (ctx.features as any).propertyLine.build({
          origin: { x: 0, z: 0 },
          segments: [
            { bearing: 90, distance: 30, label: "E 30 m" },
            { bearing: 180, distance: 20, label: "S 20 m" },
            { bearing: 270, distance: 30, label: "W 30 m" },
            { bearing: 0, distance: 20, label: "N 20 m" },
          ],
        });
      }, "Property line"), { title: "Create property line from bearings + distances" }),
      sep(),
      groupLabel("Site"),
      b("parking", "Parking", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "parking", position: { x: 5, z: 5 }, elevation: 0.3 });
      }, "Parking"), { title: "Place parking component" }),
      b("tree", "Planting", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "tree", position: { x: 8, z: 4 }, elevation: 0.3 });
      }, "Tree"), { title: "Place a tree" }),
      b("tree", "Shrub", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "shrub", position: { x: 7, z: 4 }, elevation: 0.3 });
      }, "Shrub"), { title: "Place a shrub" }),
      b("bench", "Bench", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "bench", position: { x: 4, z: 7 }, elevation: 0.3, rotation: Math.PI / 2 });
      }, "Bench"), { title: "Place a bench" }),
      b("lightpole", "Light Pole", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "lightpole", position: { x: 1, z: 1 }, elevation: 0.3 });
      }, "Light pole"), { title: "Place a light pole" }),
      b("fire", "Fire Hydrant", safe(() => {
        (ctx.features as any).siteComponent.build({ type: "firehydrant", position: { x: 0, z: 5 }, elevation: 0.3 });
      }, "Fire hydrant"), { title: "Place a fire hydrant" }),
      sep(),
      groupLabel("Massing"),
      b("mass", "In-Place Mass", safe(async () => {
        // Same flow as the Edit tab's working In-Place Mass button — the old
        // handler called __obsInPlaceMass (a global that never exists).
        await openInPlaceMassDialog();
      }, "In-place mass"), { title: "Create an in-place massing form" }),
      b("mass", "Mass Floors", safe(async () => {
        await openMassFloorsDialog();
      }, "Mass floors"), { title: "Slice mass into mass floors per level" }),
      b("mass", "Mass to Elements", safe(async () => {
        await openMassToElementsDialog();
      }, "Mass to elements"), { title: "Convert a conceptual mass into native walls, floors and roof" }),
    ],
  },

  // ══════════════════════════ COLLABORATE (Revit) ══════════════════════════
  // G1a: Live Sync + Worksets moved here from Manage. Share links do
  // not exist on this base yet (unlanded differentiator branch) —
  // they join this tab when that branch lands.
  {
    id: "collaborate",
    label: "Collaborate",
    items: () => [
      groupLabel("Live Sync"),
      b("system", "Live Sync", safe(() => (ctx.features as any).collaborationPanel?.toggle?.(), "Collaboration"), { title: "Join a real-time collaboration session" }),
      sep(),
      groupLabel("Worksets"),
      b("workset", "Init", safe(() => {
        (ctx.features as any).worksets?.init?.();
      }, "Init worksets"), { title: "Initialise default worksets" }),
      b("workset", "New", safe(async () => {
        const { promptLine } = await import("../features/form-modal");
        const name = await promptLine(
          "Create Workset",
          "Workset name",
          `Workset ${((ctx.features as any).worksets?.list?.() ?? []).length + 1}`,
          "e.g. Walls, Furniture, MEP",
        );
        if (!name) return;
        (ctx.features as any).worksets?.create?.(name);
      }, "New workset"), { title: "Create a new workset" }),
      b("workset", "List", safe(() => {
        const list = (ctx.features as any).worksets?.list?.() ?? [];
        const summary = (ctx.features as any).worksets?.summary?.();
        toast(`${summary.total} worksets, ${summary.totalElements} elements, ${summary.ownedByUser} borrowed by you`, "info", 4000);
        console.table(list.map((w: any) => ({ id: w.id, name: w.name, owner: w.owner, elements: w.elementIds.size })));
      }, "List worksets"), { title: "List all worksets with element counts" }),
      b("workset", "Borrow", safe(() => {
        const ids = (ctx.features as any).authoring?.getSelectedIds?.() ?? [];
        if (!ids.length) { toast("Select an element first", "warn"); return; }
        (ctx.features as any).worksets?.borrow?.(ids[0]);
      }, "Borrow"), { title: "Borrow selected element for editing" }),
      b("workset", "Release", safe(() => {
        const ids = (ctx.features as any).authoring?.getSelectedIds?.() ?? [];
        if (!ids.length) { toast("Select an element first", "warn"); return; }
        (ctx.features as any).worksets?.release?.(ids[0]);
        toast(`Released element ${ids[0]}`, "success");
      }, "Release"), { title: "Release borrowed element back to pool" }),
    ],
  },

  // ══════════════════════════════ VIEW ═════════════════════════════════
  // Industry-standard View ribbon: Graphics · Presentation · Create · Sheets · Windows
  {
    id: "view",
    label: "View",
    items: () => [
      groupLabel("Section"),
      b("section", "Section Cut", () => (window as any).__obsOpenSectionModal?.(), { title: "Open the interactive section cut window" }),
      b("section-box", "Section Box", safe(() => {
        (window as any).__obsSectionBox?.toggle?.();
        refreshRibbon();
      }, "Section box"), {
        kbd: "^B",
        active: !!(window as any).__obsSectionBox?.isActive?.(),
        title: "Toggle the 3D section box — drag cyan face handles to crop live — Ctrl+B",
      }),
      b("section-box", "Reset Box", safe(() => {
        (window as any).__obsSectionBox?.reset?.();
      }, "Reset box"), { title: "Reset section box to model bounds" }),
      b("crop-expand", "Grow +", safe(() => {
        (window as any).__obsSectionBox?.grow?.(0.5);
      }, "Grow"), { title: "Grow section box by 0.5 m on all sides" }),
      b("crop-shrink", "Shrink −", safe(() => {
        (window as any).__obsSectionBox?.shrink?.(0.5);
      }, "Shrink"), { title: "Shrink section box by 0.5 m on all sides" }),
      sep(),
      groupLabel("Crop"),
      b("crop", "Scope Box", safe(() => {
        (window as any).__obsScopeBox?.create?.({ name: `Scope Box ${((window as any).__obsScopeBox?.list?.() ?? []).length + 1}`, min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 4, z: 10 } });
        (window as any).__obsScopeBoxViz?.enable?.();
        toast("Scope box created (10×4×10 m) — visualizer ON, drag handles to resize", "success");
      }, "Scope box"), { title: "Create a scope box + enable 3D visualizer with drag handles" }),
      b("crop", "Show Boxes", safe(() => {
        const on = (window as any).__obsScopeBoxViz?.toggle?.();
        refreshRibbon();
        toast(on ? "Scope Box visualizer ON — drag handles to resize" : "Scope Box visualizer OFF", "success");
      }, "Show boxes"), {
        active: !!(window as any).__obsScopeBoxViz?.isEnabled?.(),
        title: "Toggle 3D visualization of all scope boxes (with corner/face/center handles)",
      }),
      b("crop", "List Boxes", safe(() => {
        const list = (window as any).__obsScopeBox?.list?.() ?? [];
        if (!list.length) { toast("No scope boxes — click Scope Box to create one", "warn"); return; }
        // Open the unified View Tools Manager panel (replaces console.log dump).
        (window as any).__obsOpenViewToolsManager?.();
      }, "List boxes"), { title: "Open the View Tools Manager panel with all scope boxes / filters / crop regions" }),
      b("crop", "Plan Region", safe(() => {
        (window as any).__obsPlanRegion?.build?.({
          outline: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }],
          viewCutPlane: 1.0,
          regionCutPlane: 1.8,
        });
        toast("Plan region created — cut plane raised to 1.8 m inside region", "success");
      }, "Plan region"), { title: "Override cut plane in a 2D region of a plan view" }),
      sep(),
      groupLabel("Crop View"),
      b("crop", "Toggle", safe(() => {
        // G9: crop follows the active view — the plan marks itself active
        // when it opens; the fallback covers "plan never opened yet".
        // No view id is hardcoded at this call site.
        const viewId = resolveCropViewId((window as any).__obsCropRegion?.getActive?.());
        (window as any).__obsCropRegion?.setActive?.(viewId);
        const on = (window as any).__obsCropRegion?.toggle?.(viewId);
        toast(on ? `Crop region ON for "${viewId}" — drag cyan handles to resize` : `Crop region OFF`, "success");
      }, "Crop toggle"), { title: "Toggle the 2D crop region overlay on the active plan view" }),
      b("crop", "Reset", safe(() => {
        const viewId = resolveCropViewId((window as any).__obsCropRegion?.getActive?.());
        (window as any).__obsCropRegion?.reset?.(viewId);
        toast("Crop region reset to 100×100 m default", "info");
      }, "Reset crop"), { title: "Reset crop region to default size" }),
      b("crop", "Size 50m", safe(() => {
        const viewId = resolveCropViewId((window as any).__obsCropRegion?.getActive?.());
        (window as any).__obsCropRegion?.set?.(viewId, { minX: -25, minY: -25, maxX: 25, maxY: 25, enabled: true });
        (window as any).__obsCropRegion?.setActive?.(viewId);
        toast("Crop region set to 50×50 m around origin", "success");
      }, "Size 50m"), { title: "Set crop region to 50×50 m around origin" }),
      b("crop", "Size 100m", safe(() => {
        const viewId = resolveCropViewId((window as any).__obsCropRegion?.getActive?.());
        (window as any).__obsCropRegion?.set?.(viewId, { minX: -50, minY: -50, maxX: 50, maxY: 50, enabled: true });
        (window as any).__obsCropRegion?.setActive?.(viewId);
        toast("Crop region set to 100×100 m around origin", "success");
      }, "Size 100m"), { title: "Set crop region to 100×100 m around origin" }),
      sep(),
      groupLabel("Selection"),
      b("section-box", "Sel. Box", safe(() => {
        (window as any).__obsSelectionBox?.show?.({ padding: 0.5 });
      }, "Selection box"), { kbd: "^⇧B", title: "Wrap a 3D section box tightly around the selected element(s) — Ctrl+Shift+B" }),
      b("crop", "Crop to Sel", safe(() => {
        (window as any).__obsSelectionBox?.cropTo?.({ padding: 1.0 });
      }, "Crop to selection"), { kbd: "^⇧R", title: "Auto-fit the 2D crop region of the active plan view to the selected element(s) — Ctrl+Shift+R" }),
      b("fit", "Zoom Sel", safe(() => {
        (window as any).__obsSelectionBox?.zoom?.();
      }, "Zoom to selection"), { kbd: "^⇧Z", title: "Fit camera frustum to selected element(s) — Ctrl+Shift+Z" }),
      b("isolate", "Isolate", safe(() => {
        (window as any).__obsSelectionBox?.isolate?.();
      }, "Isolate"), { kbd: "^I", title: "Hide everything except the selected element(s) — Ctrl+I" }),
      b("isolate", "Reset Iso", safe(() => {
        (window as any).__obsSelectionBox?.resetIsolation?.();
      }, "Reset isolation"), { kbd: "^⇧I", title: "Restore all hidden elements — Ctrl+Shift+I" }),
      b("view", "Dependent", safe(() => {
        (ctx.features as any).dependentViews?.create?.("primary-view-1", { name: "Dependent View 1" });
        toast("Dependent view created from primary", "success");
      }, "Dependent view"), { title: "Create a dependent view sharing primary geometry" }),
      sep(),
      groupLabel("Filters"),
      b("system", "Create Filter", safe(async () => {
        const vf = (ctx.features as any).viewFilters;
        if (!vf?.create) { toast("View filters not loaded", "warn"); return; }
        const { openFormModal } = await import("../features/form-modal");
        const v = await openFormModal({
          title: "New view filter",
          subtitle: "Elements matching the rule get these graphics overrides",
          fields: [
            { kind: "text", key: "name", label: "Filter name", default: "New Filter", validate: (x) => String(x).trim() ? null : "Name is required" },
            { kind: "select", key: "category", label: "Category", default: "walls", options: [["walls", "Walls"], ["doors", "Doors"], ["windows", "Windows"], ["floors", "Floors"], ["columns", "Columns"], ["beams", "Beams"], ["ducts", "Ducts"], ["pipes", "Pipes"]] },
            { kind: "text", key: "parameter", label: "Parameter", default: "FireRating" },
            { kind: "select", key: "operator", label: "Operator", default: "equals", options: [["equals", "equals"], ["not-equals", "does not equal"], ["greater", "greater than"], ["less", "less than"], ["contains", "contains"]] },
            { kind: "text", key: "value", label: "Value", default: "" },
            { kind: "text", key: "color", label: "Override colour (hex)", default: "#dc2626", validate: (x) => /^#[0-9a-f]{6}$/i.test(String(x)) ? null : "Use a hex colour like #dc2626" },
          ],
          submitLabel: "Create filter",
        });
        if (!v) return;
        vf.create({
          name: String(v.name).trim(),
          categories: [v.category],
          rules: [{ parameter: String(v.parameter).trim(), operator: v.operator, value: v.value }],
          overrides: { projectionColor: parseInt(String(v.color).slice(1), 16), cutColor: parseInt(String(v.color).slice(1), 16), lineWeight: 4, surfacePattern: null, cutPattern: null, transparency: 0, halftone: false, visible: true },
        });
        toast(`Filter "${String(v.name).trim()}" created — apply it from Visibility/Graphics → Filters`, "success", 4000);
      }, "View filter"), { title: "Create a rule-based view graphics filter" }),
      b("system", "Matchline", safe(() => {
        (ctx.features as any).matchline?.build?.({ points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 12, z: 2 }] });
        toast("Matchline created — used when splitting a view across sheets", "success");
      }, "Matchline"), { title: "Draw a matchline for sheet-split views" }),
      sep(),
      groupLabel("Schedules"),
      b("schedules", "Element Schedule", () => (window as any).__obsOpenSchedules?.(), { title: "View quantity takeoffs and schedules" }),
      sep(),
      // ── Select ──────────────────────────────────────────────────────
      groupLabel("Select"),
      toolBtn("select-all", "Modify", "select", "Esc"),
      sep(),

      // ── Graphics (display styles + VVG) ─────────────────────────────
      groupLabel("Graphics"),
      b("system", "Graphic…", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.openGraphicDisplayOptions();
      }, "Graphic Display Options"), {
        title: "Graphic Display Options — style, background, sun, transparency",
      }),
      b("system", "Wireframe", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("wireframe");
        toast("Wireframe", "info");
        refreshRibbon();
      }, "Wireframe"), {
        active: getVisualPreset() === "wireframe",
        title: "Wireframe display",
      }),
      b("system", "Hidden Line", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("hidden-line");
        toast("Hidden Line", "info");
        refreshRibbon();
      }, "Hidden Line"), {
        active: getVisualPreset() === "hidden-line",
        title: "Hidden Line — pale faces + edges",
      }),
      b("system", "Shaded", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("shaded");
        toast("Shaded", "info");
        refreshRibbon();
      }, "Shaded"), {
        active: getVisualPreset() === "shaded",
        title: "Shaded display",
      }),
      b("system", "Consistent", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("consistent-colors");
        toast("Consistent Colors", "info");
        refreshRibbon();
      }, "Consistent Colors"), {
        active: getVisualPreset() === "consistent-colors",
        title: "Consistent Colors — flat shading",
      }),
      b("system", "Realistic", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("realistic");
        toast("Realistic", "info");
        refreshRibbon();
      }, "Realistic"), {
        active: getVisualPreset() === "realistic",
        title: "Realistic materials and soft shadows",
      }),
      b("system", "Ray Trace", safe(async () => {
        const vg = await import("../features/view-graphics");
        vg.setVisualPreset("ray-trace");
        toast("Ray Trace (enhanced realistic)", "info");
        refreshRibbon();
      }, "Ray Trace"), {
        active: getVisualPreset() === "ray-trace",
        title: "Ray Trace approximation — stronger tone mapping & shadows",
      }),
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
      b("mline", "Thin Lines", safe(async () => {
        const vg = await import("../features/view-graphics");
        const on = !vg.isThinLines();
        vg.setThinLines(on);
        toast(on ? "Thin lines ON" : "Thin lines OFF", "info");
        refreshRibbon();
      }, "Thin lines"), {
        active: !!(window as any).__obsThinLines,
        title: "Thin lines — consistent line weight in model views",
      }),
      b("section", "Hidden", safe(() => {
        const on = !obsShowHidden;
        obsShowHidden = on;
        try {
          const hider = (ctx as any).hider;
          if (on) hider?.showAll?.();
          toast(on ? "Show hidden elements" : "Hidden elements restored", "info");
        } catch {
          toast("Hidden lines toggle", "info");
        }
        refreshRibbon();
      }, "Show hidden"), {
        active: !!obsShowHidden,
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
      b("system", "Theme", safe(async () => {
        const m = await import("../core/theme");
        m.toggleTheme();
      }, "Theme"), { title: "Toggle Dark / Light (Paper) Mode" }),
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
      b("fit", "Full Screen", safe(() => {
        toggleAppFullScreen();
      }, "Full screen"), {
        active: isAppFullScreen(),
        title: "Full Screen — hides the command bars; move the mouse to the top edge to reveal the ribbon (F11)",
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
      b("report", "Drawing Register", safe(() => openDrawingRegisterPanel(), "Drawing register" ), {
        title: "Formal sheet register + transmittal table with CSV / HTML export",
      }),
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
        title: "Show / hide the Options Bar under the ribbon (BIM Options Bar)",
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
      b("tree", "Models", safe(() => toggleToolWindow("models"), "Models list"), { active: isToolWindowOpen("models"), title: "Loaded models list" }),
      b("settings", "IFC Props", safe(() => toggleToolWindow("properties"), "IFC properties"), {
        active: isToolWindowOpen("properties"),
        title: "Properties of the selected IFC / FRAG object, with a filter",
      }),
      b("tools-panel", "Controls", safe(() => toggleToolWindow("controls"), "Controls help"), {
        active: isToolWindowOpen("controls"),
        title: "Navigation, authoring and shortcut reference",
      }),
      aiChatButton(),
      b("tools-panel", "BIM Center", safe(() => toggleBimToolbox(), "BIM Command Center"), {
        active: isBimToolboxVisible(),
        title: "BIM-style modeling order, modify, annotation, dimensioning, visibility and graphics controls",
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
      groupLabel("Parameters"),
      b("settings", "Parameter Manager", safe(() => void openParameterManagerDialog(), "Project parameters"), {
        title: "Add document-wide parameters (typed, unit-aware, formula-driven) via the v68 parameter engine",
      }),
      b("tree", "Model Intelligence", safe(() => openModelIntelligencePanel(), "Model intelligence panel"), {
        title: "Registry stats, relationships, MEP connector status and snapping engine state in one panel",
      }),
      sep(),
      groupLabel("View Tools"),
      b("crop", "View Tools", safe(() => {
        (window as any).__obsOpenViewToolsManager?.();
      }, "View tools manager"), { kbd: "^⇧V", title: "Open the View Tools Manager panel (scope boxes + filters + crop regions) — Ctrl+Shift+V" }),
      sep(),
      groupLabel("Plugins"),
      b("component", "Plugin List", safe(async () => {
        const loaded = (window as any).__obsPluginRegistry;
        if (!loaded || loaded.size === 0) { toast("No plugins are loaded.", "info"); return; }
        const { showTableDialog } = await import("../features/form-modal");
        await showTableDialog("Loaded plugins", ["Id", "Name", "Version"],
          [...loaded.entries()].map(([id, v]: any) => [id, v.manifest?.name ?? "", v.manifest?.version ?? ""]), `${loaded.size} active`);
      }, "Plugin list"), { title: "List all loaded plugins" }),
      b("component", "Reload Plugins", safe(async () => {
        try {
          const { reloadPlugins } = await import("../plugins/boot");
          await reloadPlugins();
          toast("Plugins reloaded", "success");
        } catch { toast("Plugin reload failed", "warn"); }
      }, "Reload plugins"), { title: "Unload and reload all plugins" }),
      sep(),
      groupLabel("Performance"),
      b("system", "BVH Accelerate", safe(() => {
        const perf = (window as any).__obsPerf;
        if (!perf) { toast("Performance engine not loaded", "warn"); return; }
        const n = perf.accelerateAllMeshes();
        toast(`BVH built on ${n} mesh(es) — raycast now O(log n)`, "success");
      }, "BVH accelerate"), { title: "Build BVH on all meshes for fast raycasting" }),
      b("system", "Batching", safe(() => {
        const perf = (window as any).__obsPerf;
        if (!perf) { toast("Performance engine not loaded", "warn"); return; }
        const on = !perf.isBatchingEnabled();
        perf.setBatchingEnabled(on);
        toast(`InstancedMesh batching: ${on ? "ON (1 draw call per type)" : "OFF"}`, "success");
      }, "Toggle batching"), { title: "Toggle InstancedMesh batching (1 draw call per element type)" }),
      sep(),
      groupLabel("Analysis"),
      b("connection", "Analytical", safe(async () => {
        const am = (window as any).__obsAnalytical;
        if (!am) { toast("Analytical model not loaded", "warn"); return; }
        const nodes = am.getNodes();
        const members = am.getMembers();
        const { showTableDialog } = await import("../features/form-modal");
        await showTableDialog("Structural analytical model", ["Member", "Type", "From node", "To node", "Area (m²)"],
          members.map((m: any) => [m.id, m.sourceType, m.startNodeId, m.endNodeId, Number(m.area).toFixed(4)]),
          `${nodes.length} nodes, ${members.length} members`);
      }, "Analytical model"), { title: "View structural analytical model (FEM nodes + members)" }),
      // A12: wired to the same real heat-loss report as Analyze ▸ Heat Loss
      // (energy-ui.ts) — zonesFromRooms() builds thermal zones from the
      // authored rooms, so the old stub's claim no longer holds.
      b("energy", "Energy", safe(async () => {
        const m = await import("../features/energy-ui");
        await m.runHeatLossReport();
      }, "Heat loss"), { title: "Run steady-state heat loss per room" }),
      sep(),
      groupLabel("Marketplace"),
      b("component", "Browse Plugins", safe(async () => {
        const mp = (window as any).__obsMarketplace;
        if (!mp) { toast("Marketplace not loaded", "warn"); return; }
        const list = mp.list();
        const { showTableDialog } = await import("../features/form-modal");
        await showTableDialog("Bundled plugins", ["Name", "Version", "Author", "Description"],
          list.map((x: any) => [x.name, x.version, x.author, x.description]), "Plugins shipped with this build");
      }, "Browse marketplace"), { title: "Browse plugin marketplace" }),
      b("component", "Install Plugin", safe(async () => {
        const mp = (window as any).__obsMarketplace;
        if (!mp) { toast("Marketplace not loaded", "warn"); return; }
        const list = mp.list();
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Install Plugin",
          "Pick a plugin to install",
          list.map((p: any) => ({ value: p.id, label: `${p.name} (v${p.version}, ${p.downloads} downloads)` })),
        );
        if (!choice) return;
        const entry = list.find((p: any) => p.id === choice);
        if (!entry) { toast("Invalid selection", "warn"); return; }
        toast(`Installing "${entry.name}"…`, "info");
        const ok = await mp.install(entry.id);
        toast(ok ? `"${entry.name}" installed successfully!` : `Install failed for "${entry.name}"`, ok ? "success" : "error");
      }, "Install plugin"), { title: "Install a plugin from the marketplace" }),
      sep(),
      groupLabel("Links"),
      b("folder-recent", "Manage Links", () => (window as any).__obsManageLinks?.(), { title: "Manage external links (IFC, DWG, BIM)" }),
      sep(),
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
      groupLabel("Position"),
      b("viewcube", "CAD Editor", safe(() => void import("../features/cad-viewer").then((m) => m.openCadViewer()), "CAD Editor"), {
        title: "Open a DWG or DXF in the standalone 2D viewer: layers, measure, snaps, search, markup, export",
      }),
      b("rotate", "True North", safe(() => void import("../features/north-ui").then((m) => m.promptTrueNorth()), "Rotate True North"), {
        title: "Set the angle between Project North (top of the plan) and True North",
      }),
      b("viewcube", "Project North", safe(async () => {
        const n = await import("../modules/north/north");
        n.setNorthState({ planOrientation: "project" });
        toast("Plan views are oriented to Project North", "success");
      }, "Project North orientation"), {
        active: getNorthState().planOrientation === "project",
        title: "Show plan views with Project North up",
      }),
      b("viewcube", "True North view", safe(async () => {
        const n = await import("../modules/north/north");
        n.setNorthState({ planOrientation: "true" });
        toast("Plan views are oriented to True North", "success");
      }, "True North orientation"), {
        active: getNorthState().planOrientation === "true",
        title: "Show plan views turned so True North is up",
      }),
      sep(),
      groupLabel("Production"),
            standardsButton(),
      sep(),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Drawing sheets"), {
        active: isSheetsPanelVisible(),
      }),
      b("tools-panel", "Automate", safe(() => toggleAutomationPanel(), "Automation rules"), {
        active: isAutomationPanelVisible(),
      }),
      b("tools-panel", "Family Creator", safe(() => toggleFamilyCreatorPanel(), "Create an editable family from a product size"), {
        active: isFamilyCreatorPanelVisible(),
      }),
      b("tools-panel", "BIM Center", safe(() => toggleBimToolbox(), "BIM Command Center"), {
        active: isBimToolboxVisible(),
        title: "Cross-discipline BIM-style BIM command order and graphics controls",
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

  // ════════════════════════════════ OUTPUT ══════════════════════════════
  // AutoCAD parity (A12): plot + export + sheets in one tab. Every button
  // reuses an existing handler (File tab export, file-menu Print, batch
  // plot panel, sheets panel) — no new output logic.
  {
    id: "output",
    label: "Output",
    items: () => [
      groupLabel("Plot"),
      b("print", "Print", safe(() => printView(), "Print"), {
        title: "Print the current view",
      }),
      b("print", "Batch Plot", safe(async () => {
        (await import("../features/batch-plot-panel")).openBatchPlotPanel();
      }, "Batch plot"), {
        title: "Batch-plot sheets to PDF",
      }),
      sep(),
      groupLabel("Export"),
      b("file", "IFC4", safe(async () => {
        const mod = await import("../modules/bim-gaps/bim-gaps-boot");
        await mod.exportIfc("IFC4");
      }, "Export IFC4"), { title: "Export the authored model as IFC4 STEP file" }),
      b("file", "IFC2X3", safe(async () => {
        const mod = await import("../modules/bim-gaps/bim-gaps-boot");
        await mod.exportIfc("IFC2X3");
      }, "Export IFC2X3"), { title: "Export the authored model as IFC2X3 STEP file" }),
      b("file-frag", "FRAG", safe(async () => {
        const mod = await import("../modules/export/frag");
        await mod.exportFragFromMenu();
      }, "Export FRAG"), {
        title: "Export loaded model(s) as ThatOpen Fragments (.frag) — official binary format",
      }),
      sep(),
      groupLabel("Sheets"),
      b("new-sheet", "Sheets", safe(() => toggleSheetsPanel(), "Sheets"), { active: isSheetsPanelVisible() }),
      b("new-sheet", "New Sheet", safe(() => {
        toggleSheetsPanel();
        toast("Sheets panel open — create production sheets", "info");
      }, "New sheet")),
      b("report", "Drawing Register", safe(() => openDrawingRegisterPanel(), "Drawing register"), {
        title: "Formal sheet register + transmittal table with CSV / HTML export",
      }),
    ],
  },

  // ── Product tabs (no Revit counterpart) — kept after Manage, see
  // docs/engineering/REVIT_2D_ENVIRONMENT.md gap G1. ──────────────────
  // ════════════════════════════ COORDINATE ═════════════════════════════
  {
    id: "coordinate",
    label: "Coordinate",
    items: () => [
      groupLabel("Review"),
      b("measure", "Measure", safe(() => toggleMeasure(), "Measure"), {
        active: isMeasureEnabled(),
        title: "Double-click point A then point B. Red = X, green = Y, blue = Z, cyan = total",
      }),
      b("clear", "Clear Meas.", safe(() => clearMeasurements(), "Clear measurements"), { title: "Remove every measurement from the view" }),
      b("section", "Section", safe(() => toggleSection(), "Section"), { active: isSectionOn() }),
      sep(),
      groupLabel("Placement"),
      b("origin", "Align…", safe(() => toggleAlign(), "Model alignment"), { title: "Model alignment window" }),
      b("tree", "Models", safe(() => toggleToolWindow("models"), "Models list"), { active: isToolWindowOpen("models"), title: "Loaded models list" }),
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
      groupLabel("Clash Rules"),
      b("clash", "Test Setup", safe(() => { void refreshModelSelectionUI(); toggleToolWindow("clash"); }, "Clash test setup"), {
        active: isToolWindowOpen("clash"),
        title: "Test name, method, scope, Selection A / B, tolerance, run, results and scenarios",
      }),
      b("crop-reset", "Crop Box", safe(() => toggleToolWindow("crop"), "Crop box"), {
        active: isToolWindowOpen("crop"),
        title: "Crop margin around the active clash: -10 cm / +10 cm / reset 30 cm / remove",
      }),
      b("clash", "Categories", () => (window as any).__obsOpenClashCategories?.(), { title: "Category Clash Rules" }),
      sep(),
      groupLabel("Tests"),
      b("save", "Save", safe(async () => {
        const { promptLine } = await import("../features/form-modal");
        const name = await promptLine(
          "Save Clash Scenario",
          "Scenario name",
          "Scenario",
          "e.g. Mechanical-vs-Architecture",
        );
        if (name == null) return;
        createScenario(name.trim() || "Scenario");
      }, "Save scenario"), { title: "Save current A/B + scope + rules + statuses as a scenario" }),
      b("folder-recent", "Load", safe(async () => {
        const list = listScenarios();
        if (!list.length) { toast("No saved scenarios.", "info"); return; }
        const { pickFromList } = await import("../features/form-modal");
        const choice = await pickFromList(
          "Load Clash Scenario",
          "Pick a scenario",
          list.map((s) => ({ value: s.id, label: s.name })),
        );
        if (!choice) return;
        void loadScenario(choice);
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
        uiAlert(
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
        { title: "Keep shared project coordinates (BIM-style)" }),
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
      groupLabel("Select"),
      b("settings", "Selection & Snapping", safe(() => toggleSelectionSnappingPalette(), "Selection and snapping palette"), { active: isSelectionSnappingPaletteVisible(), title: "Configure selection filters, object snap modes, snap priorities and drafting profiles (Ctrl+Shift+P)" }),
      b("modify", "Modify", safe(() => {
        try { (ctx.features as any).selection?.clear?.(); } catch {}
        setAuthoringTool("select");
        toast("Modify: click an element to edit", "info");
      }, "Modify tool"), { kbd: "Esc", title: "Press Esc to exit any active tool" }),
      b("check", "Links", safe(() => {
        const next = !getSelectionPrefs().links;
        setSelectionPref("links", next);
        toast("Select links: " + (next ? "ON — linked models are selectable" : "OFF — linked models are protected from selection"), "info");
      }, "Select links"), { title: "Allow selecting elements in linked federation models" }),
      b("check", "Pinned", safe(() => {
        const next = !getSelectionPrefs().pinned;
        setSelectionPref("pinned", next);
        toast("Select pinned: " + (next ? "ON" : "OFF — pinned elements are skipped by every pick"), "info");
      }, "Select pinned"), { title: "Allow selecting pinned elements (Modify ▸ Pin to pin)" }),
      sep(),

      groupLabel("Clipboard"),
      b("copy", "Copy", safe(() => {
        void import("../features/modify-actions").then((m) => m.copySelectionToClipboard());
      }, "Copy"), { kbd: "Ctrl+C" }),
      b("clear", "Cut", safe(() => {
        void import("../features/modify-actions").then((m) => {
          const n = m.copySelectionToClipboard();
          if (!n) return; // nothing selected — copySelectionToClipboard already warned
          try { deleteSelectedElement(); toast(`Cut ${n} element(s) — Ctrl+V to paste`, "success"); }
          catch { toast("Cut failed while deleting selection", "warn"); }
        });
      }, "Cut"), { kbd: "Ctrl+X", title: "Copy the selection to the clipboard, then delete it" }),
      b("save", "Paste", safe(() => {
        void import("../features/modify-actions").then((m) => m.pasteFromClipboard());
      }, "Paste"), { kbd: "Ctrl+V", title: "Place copies of the clipboard slightly offset from the originals" }),
      b("beam", "Join", safe(async () => {
        try {
          const { getJoinsCleanupService } = await import("../modules/joins-cleanup");
          const svc = getJoinsCleanupService();
          const joins = await svc.autoJoin();
          toast(joins.length ? `Join geometry: ${joins.length} join(s) created/cleaned` : "Join geometry: no joinable element pairs found", joins.length ? "success" : "info");
        } catch (err) {
          toast("Join geometry failed — see console for details", "warn");
        }
      }, "Join geometry"), { title: "Auto-join geometry of authored elements (walls, floors, frames) and clean duplicate overlaps" }),
      sep(),

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
        if (!(await confirmDialog("Revert edits", `Revert all ${getEditCount()} edit(s)?`))) return;
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
      groupLabel("Solid Forms"),
      b("slab", "Extrude", safe(() => void openExtrudeDialog(), "Extrude solid"), {
        title: "Extrude a closed profile into a watertight B-Rep solid (v68 solid kernel)",
      }),
      b("circle", "Revolve", safe(() => void openRevolveDialog(), "Revolve solid"), {
        title: "Revolve an (r,z) profile about an axis — full or partial angle",
      }),
      b("wall", "Sweep", safe(() => void openSolidSweepDialog(), "Sweep solid"), {
        title: "Sweep a profile along a 3D polyline with per-segment frames",
      }),
      b("roof", "Blend", safe(() => void openBlendDialog(), "Blend/loft solid"), {
        title: "Loft between two closed sections",
      }),
      b("clear", "Subtract", safe(() => void openBooleanDialog(), "Boolean subtract"), {
        title: "Boolean A − B on convex operands (exact half-space composition)",
      }),
      b("mass", "Bool (Any)", safe(() => void openGeneralBooleanDialog(), "General boolean"), {
        title: "v70 general boolean: union/intersect/subtract with NON-CONVEX operands and exact coplanar resolution",
      }),
      b("shaft", "Shell", safe(() => void openShellDialog(), "Shell/hollow solid"), {
        title: "Hollow extrusion with miter offset — exact wall thickness (v70)",
      }),
      b("mass-floor", "Loft N", safe(() => void openLoftDialog(), "N-section loft"), {
        title: "Loft through 2–N sections with optional explicit levels (v70)",
      }),
      b("connection", "Fuse", safe(() => void openFuseDialog(), "Fuse solids"), {
        title: "n-ary fuse of solids via the general union (v70)",
      }),
      b("opening", "Cut Voids", safe(() => void openVoidDialog(), "Cut voids"), {
        title: "Cut box/cylinder voids (openings) with the rollback-guaranteed void engine",
      }),
      b("inspect", "Validate Last", safe(() => validateLastSolid(), "Validate last solid"), {
        title: "Full watertightness/manifold diagnostics with recovery actions",
      }),
      sep(),
      groupLabel("Modify Engine"),
      b("move", "Move", safe(() => void openModifyMoveDialog(), "v68 Move"), {
        title: "Move selection through the v68 command pipeline (preview → validate → commit)",
      }),
      b("rotate", "Rotate", safe(() => void openModifyRotateDialog(), "v68 Rotate"), {
        title: "Rodrigues rotation about a plan pivot via the v68 command pipeline",
      }),
      b("array", "Array", safe(() => void openModifyArrayDialog(), "v68 Linear array"), {
        title: "Linear array with cloned authored elements",
      }),
      b("mirror", "Mirror", safe(() => void openModifyMirrorDialog(), "v68 Mirror"), {
        title: "Mirror the selection about an axis; copy keeps originals",
      }),
      sep(),
      groupLabel("Group 1 Tools (v71)"),
      b("move", "Move+", safe(() => void openGroup1MoveDialog(), "v71 Move tool"), {
        title: "Group 1 Move: numeric Δ + axis constraint, hosted rigid follow, undo/redo (spec §4)",
      }),
      b("rotate", "Rotate+", safe(() => void openGroup1RotateDialog(), "v71 Rotate tool"), {
        title: "Group 1 Rotate: pivot + angle + angular snap, hosted co-rotation (spec §5)",
      }),
      b("mirror", "Mirror+", safe(() => void openGroup1MirrorDialog(), "v71 Mirror tool"), {
        title: "Group 1 Mirror: M = 2ddᵀ − I, θ' = 2φ − θ, relationship cloning (spec §6)",
      }),
      b("undo", "Undo G1", safe(() => { const ok = group1Undo(); toast(ok ? "Group 1 undo applied" : "Nothing to undo", ok ? "success" : "warn"); }, "v71 undo"), {
        title: "Undo the last Group 1 transaction (Move/Rotate/Mirror are one unit each)",
      }),
      b("undo", "Redo G1", safe(() => { const ok = group1Redo(); toast(ok ? "Group 1 redo applied" : "Nothing to redo", ok ? "success" : "warn"); }, "v71 redo"), {
        title: "Redo the last undone Group 1 transaction",
      }),
      b("inspect", "Sel Inspector", safe(() => void openSelectionInspectorDialog(), "v71 selection engine"), {
        title: "Hit-testing priority, window/crossing modes, filters, hosted expansion (spec §2)",
      }),
      b("grid", "Ref Picker", safe(() => void openReferencePickerDialog(), "v71 reference service"), {
        title: "Acquire typed references with canonical frames; command eligibility check (spec §3)",
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
        if (!(await confirmDialog("Revert edits", `Revert all ${getEditCount()} edit(s)?`))) return;
        await clearAllEdits();
      }, "Revert all"), {
        title: "Revert every edit and unhide all originals",
      }),
      sep(),

      hint(`${getEditCount()} element(s) edited · changes persist in the project`),
    ],
  },

  // ═══════════════════════════ X DIM (4D / 5D / 6D) ═══════════════════
  {
    id: "cost",
    label: "X Dim",
    items: () => [
      groupLabel("4D Simulation"),
      b("timeline", "Timeline", safe(() => openTimelineTab("4d"), "4D Timeline"), {
        title: "4D construction simulation — Gantt, calendar playback, phases",
        active: isTimelinePanelVisible(),
      }),
      b("walk", "Play / Pause", safe(() => openTimelineTab("4d"), "4D Play"), {
        title: "Open the 4D panel to play or pause the construction sequence",
      }),
      b("grid", "Gantt", safe(() => openTimelineTab("4d"), "Gantt chart"), {
        title: "Open the 4D Gantt chart view of schedule activities",
      }),
      b("level", "Phases", safe(() => openTimelineTab("4d"), "4D Phases"), {
        title: "Manage construction phases and default phase sets",
      }),
      sep(),
      groupLabel("P6 Planning"),
      b("file", "Import P6", safe(() => pickAndImportP6(), "Import P6"), {
        title: "Import Primavera P6 schedule (.xer or PMXML .xml)",
      }),
      b("connection", "Re-import", safe(() => pickAndImportP6(), "Re-import P6"), {
        title: "Replace the current schedule with a new P6 file",
      }),
      b("conn", "Auto-link", safe(() => openTimelineTab("links"), "Auto-link"), {
        title: "Auto-link P6 activities to model elements by name / level / WBS",
      }),
      b("inspect", "Link selection", safe(() => openTimelineTab("links"), "Link selection"), {
        title: "Assign the current model selection to a P6 activity",
      }),
      b("property", "Links panel", safe(() => openTimelineTab("links"), "Links"), {
        title: "Review activity ↔ element links and unlinked tasks",
      }),
      sep(),
      groupLabel("Assign to model"),
      b("select-all", "Assign phase", safe(() => openTimelineTab("4d"), "Assign phase"), {
        title: "Assign selected elements to a 4D construction phase",
      }),
      b("connection", "Assign activity", safe(() => openTimelineTab("links"), "Assign activity"), {
        title: "Link selected elements to a P6 activity (sets activityId / WBS)",
      }),
      b("isolate", "Unlinked", safe(() => openTimelineTab("links"), "Unlinked tasks"), {
        title: "Show P6 activities that are not yet linked to the model",
      }),
      sep(),
      groupLabel("5D Cost"),
      b("cost", "Cost panel", safe(() => toggleCostPanel(), "Cost"), {
        active: isCostPanelVisible(),
        title: "Quantity take-off, rates, and cost items",
      }),
      b("quantification", "5D by activity", safe(() => openTimelineTab("5d"), "5D Cost"), {
        title: "Cost per P6 activity and cumulative cost curve",
      }),
      b("report", "Curves", safe(() => openCurvesView(), "Curves"), {
        title: "Large cost and carbon S-curves; click or drag to move the 4D date",
      }),
      b("reset-offsets", "Recalc takeoff", safe(() => recalculateTakeoff(), "Recalc"), {
        title: "Recalculate model quantities for cost take-off",
      }),
      b("new-file", "Cost items", safe(() => toggleCostPanel(), "Cost items"), {
        title: "Manage cost items and assignments",
      }),
      b("cost-takeoff", "Rates", safe(() => toggleCostPanel(), "Rates"), {
        title: "Unit rates and rate assignments",
      }),
      sep(),
      groupLabel("6D Carbon"),
      b("energy", "Carbon panel", safe(() => openTimelineTab("6d"), "6D Carbon"), {
        title: "Embodied carbon per activity and carbon factor table",
      }),
      b("settings", "Factors", safe(() => openTimelineTab("6d"), "Carbon factors"), {
        title: "Edit or reset generic carbon factors (kgCO₂e)",
      }),
      b("file", "Import EPD", safe(() => pickAndImportFactors(), "Import EPD factors"), {
        title: "Import carbon factors from a CSV or JSON file (type, unit, kgCO2e per unit)",
      }),
      sep(),
      groupLabel("Schedules & BOQ"),
      schedulesButton(),
      b("tag", "Categories", safe(() => toggleSchedules(), "Categories"), {
        title: "Schedule categories and templates",
      }),
      b("report", "Cost summary", safe(() => toggleCostPanel(), "Cost summary"), {
        title: "Open cost summary in the Cost panel",
      }),
      sep(),
      groupLabel("Reports"),
      b("csv", "P6 report CSV", safe(() => openTimelineTab("5d"), "P6 report"), {
        title: "Per-activity cost / carbon report — export CSV from the panel",
      }),
      b("csv", "Cost CSV", safe(() => void exportCostCsv(), "Cost CSV"), {
        title: "Export quantity take-off as CSV",
      }),
      b("print", "BOQ", safe(() => void exportCostCsv(), "BOQ"), {
        title: "Export bill of quantities",
      }),
      b("timeline", "Open X Dim hub", safe(() => toggleTimelinePanel(), "X Dim hub"), {
        title: "Toggle the unified 4D / 5D / 6D / Links panel",
        active: isTimelinePanelVisible(),
      }),
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

// Keep the View ▸ Full Screen button highlight in sync with the real
// fullscreen state (F11, Esc, the CAD viewer's own fullscreen, …).
window.addEventListener("obs-fullscreen-toggle", () => {
  try { refreshRibbon(); } catch { /* ribbon not mounted yet */ }
});

/* ═════════════════════════════════════════════════════════════════════════
   Contextual tab - "Modify | Place Wall" (RVT style). Appears when a placement
   tool starts, so the user can adjust the options and then start modelling; it
   disappears (returning to the previous tab) when the tool ends.
   ═════════════════════════════════════════════════════════════════════════ */
type TabDef = { id: string; label: string; items: () => HTMLElement[]; contextual?: boolean };
let ctxTab: TabDef | null = null;
let ctxTool: string | null = null;
let tabBeforeCtx: string | null = null;
const CTX_LABEL: Record<string, string> = {
  wall: "Wall", "curtain-wall": "Curtain Wall", beam: "Beam", strip: "Wall Foundation", duct: "Duct", pipe: "Pipe",
  "cable-tray": "Cable Tray", conduit: "Conduit", column: "Column", slab: "Floor", footing: "Isolated Foundation", brace: "Brace", door: "Door", window: "Window",
};
function pressKey(key: string) { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); }
function ctxItems(tool: string): HTMLElement[] {
  const act = (id: string) => safe(() => { void runModifyAction(id as ModifyActionId); }, id);
  const mod = (id: ModifyActionId, icon: IconName, label?: string, options: any = {}) => {
    const definition = getModifyCommandDefinition(id);
    const displayLabel = label ?? definition?.label ?? id;
    return b(icon, displayLabel, act(id), {
      ...options,
      kbd: options.kbd ?? definition?.commandAlias,
    });
  };
  const items: HTMLElement[] = [
    groupLabel("Select"),
    b("modify" as IconName, "Modify", safe(() => setAuthoringTool("select"), "Modify"), { kbd: "Esc", title: "Finish placing and return to Modify" }),
    sep(),
    groupLabel("Properties"),
    b("settings", "Properties", safe(() => { try { (ctx.features as any).propertyPalette?.open?.(); } catch { /* */ } }, "Properties")),
    b("settings", "Type Properties", safe(() => { (window as any).__obsBIMExperience?.execute?.("modify.typeProperties"); }, "Type properties")),
    sep(),
    groupLabel("Clipboard"),
    mod("paste", "copy"),
    sep(),
    groupLabel("Modify"),
    mod("move", "move"), mod("copy", "copy"), mod("rotate", "rotate"),
    mod("mirror", "mirror"), mod("array", "array"), mod("offset", "move"),
    mod("scale", "scale"), mod("delete", "delete"),
    sep(),
    groupLabel("Draw"),
    b("check" as IconName, "Finish", safe(() => pressKey("Enter"), "Finish"), { kbd: "Enter", title: "Finish the current chain and keep the tool" }),
    b("close", "Cancel", safe(() => pressKey("Escape"), "Cancel"), { kbd: "Esc", title: "Cancel the current segment / chain" }),
    b("check" as IconName, "Chain", safe(() => setWallChain(!getWallChain()), "Chain"), { active: getWallChain(), title: "Continue drawing from the last end point" }),
    sep(),
    groupLabel("Measure"),
    b("measure", "Measure", safe(() => toggleMeasure(), "Measure"), {
      active: isMeasureEnabled(),
      title: "Double-click point A then point B. Red = X, green = Y, blue = Z, cyan = total",
    }),
    b("clear", "Clear Meas.", safe(() => clearMeasurements(), "Clear measurements"), { title: "Remove every measurement from the view" }),
  ];
  if (tool === "wall") items.push(mod("join-walls", "wall", undefined, { title: "Join the selected walls" }));
  return items;
}
/**
 * RVT "Modify | Walls": every modification tool for the current selection.
 *
 * G2: the panel/button STRUCTURE comes from `buildModifyTabModel`
 * (`src/shell/modify-tab-model.ts`) — this function only maps button ids to
 * their (unchanged) handlers, so the node test pins the real tab contents.
 * Disabled model buttons (linked selection: transforms) render disabled
 * with the model's reason as tooltip; the note line is rendered as a
 * strip hint. `selectionItems` is kept as the authored/mixed entry point;
 * `linkedSelectionItems` renders the linked-only honest subset.
 */
function modifyTabItems(model: ModifyTabModel): HTMLElement[] {
  const act = (id: string) => safe(() => { void runModifyAction(id as ModifyActionId); }, id);
  const mod = (button: ModifyTabButton, id: ModifyActionId, icon: IconName, label?: string, options: any = {}) => {
    const definition = getModifyCommandDefinition(id);
    const displayLabel = label ?? definition?.label ?? id;
    return b(icon, displayLabel, act(id), {
      ...options,
      kbd: options.kbd ?? definition?.commandAlias,
      disabled: !button.enabled,
      title: button.reason ?? options.title,
    });
  };
  const cmd = (id: string) => safe(() => { (window as any).__obsBIMExperience?.execute?.(id); }, id);
  /** Pass-through for enabled buttons; disabled buttons get the model's reason as tooltip. */
  const dis = (button: ModifyTabButton, options: BtnOpts = {}): BtnOpts =>
    button.enabled ? options : { ...options, disabled: true, title: button.reason ?? options.title };
  const handlers: Record<string, (button: ModifyTabButton) => HTMLElement> = {
    "modify": (button) => b("modify" as IconName, "Modify", safe(() => setAuthoringTool("select"), "Modify"), dis(button, { kbd: "Esc" })),
    "select-similar": (button) => mod(button, "select-similar", "select-all", undefined, { title: "Select every element of the same type" }),
    "select-all": (button) => b("select-all", "Select All", safe(() => { try { selectAllAuthored(getElements().map((e: any) => e.id)); } catch { /* */ } }, "Select all"), dis(button, { kbd: "Ctrl+A" })),
    "clear": (button) => b("clear", "Clear", cmd("global.clearSelection"), dis(button)),
    "filter": (button) => b("select-all", "Filter", safe(async () => {
      // G4 convergence: the shared dialog module does the whole flow
      // (dialog + apply + toast) — see selection-filter-dialog.ts.
      await openSelectionFilterDialog();
    }, "Filter"), dis(button, { title: "Keep only the checked categories in the current selection" })),
    // G4: Ctrl+Left is now a real binding (selection.selectPrevious in
    // default-shortcuts.ts); the nudge handler no longer fires on
    // Ctrl+Arrow, so the contested-key note from G2 is retired.
    "select-previous": (button) => b("undo", "Select Previous", safe(async () => { await selectPreviousCombined(); }, "Select previous"), dis(button, { title: "Restore the previous selection (Revit: Ctrl+Left)", kbd: "Ctrl+Left" })),
    "properties": (button) => b("settings", "Properties", safe(() => { try { (ctx.features as any).propertyPalette?.open?.(); } catch { /* */ } }, "Properties"), dis(button)),
    "type-properties": (button) => b("settings", "Type Properties", cmd("modify.typeProperties"), dis(button)),
    "copy": (button) => b("copy", "Copy", safe(() => { void import("../features/modify-actions").then((m) => { const n = m.copySelectionToClipboard(); toast(n ? `Copied ${n} element(s)` : "Nothing to copy", n ? "success" : "warn"); }); }, "Copy"), dis(button, { kbd: "Ctrl+C" })),
    "paste": (button) => mod(button, "paste", "copy", undefined, { kbd: "Ctrl+V" }),
    "move": (button) => mod(button, "move", "move"),
    "copy-move": (button) => mod(button, "copy", "copy", "Copy Move", { title: "Copy: place copies at new points" }),
    "rotate": (button) => mod(button, "rotate", "rotate"),
    "mirror": (button) => mod(button, "mirror", "mirror"),
    "array": (button) => mod(button, "array", "array"),
    "offset": (button) => mod(button, "offset", "move"),
    "scale": (button) => mod(button, "scale", "scale"),
    "align-h": (button) => mod(button, "align-x", "move", "Align H", { title: "Align the selected elements on X" }),
    "align-v": (button) => mod(button, "align-z", "move", "Align V", { title: "Align the selected elements on Z" }),
    "delete": (button) => mod(button, "delete", "delete"),
    "trim-extend": (button) => b("move", "Trim/Extend", cmd("modify.trimExtend"), dis(button, { kbd: "TR", title: "Trim or extend two line elements to a corner" })),
    "split-mid": (button) => mod(button, "split-mid", "move"),
    "flip": (button) => b("move", "Flip", safe(() => { const n = reverseSelected(); toast(n ? `Flipped ${n} element(s)` : "Select linear elements", n ? "success" : "warn"); }, "Flip"), dis(button, { title: "Reverse the drawing direction" })),
    "join-walls": (button) => mod(button, "join-walls", "wall", undefined, { title: "Join walls that meet at a corner" }),
    "branch-network": (button) => b("connection", "Branch / Network", safe(() => { cycleMepSelection(); }, "Select branch"), dis(button, { kbd: "Tab", title: "Tab: select the branch, then the whole network, then back to one run" })),
    "pin": (button) => mod(button, "pin", "origin"),
    "unpin": (button) => mod(button, "unpin", "origin"),
    "create-similar": (button) => mod(button, "create-similar", "component"),
    "match-props": (button) => mod(button, "match-props", "copy"),
    "isolate": (button) => b("isolate", "Isolate", cmd("review.isolate"), dis(button, { title: "Temporary isolate" })),
    "hide": (button) => b("clear", "Hide", cmd("review.hide"), dis(button, { title: "Temporary hide" })),
    "reveal": (button) => b("show-all", "Reveal", cmd("review.reveal"), dis(button)),
    "zoom": (button) => b("fit", "Zoom", cmd("review.focus"), dis(button, { title: "Zoom to selection" })),
    "measure": (button) => b("measure", "Measure", safe(() => toggleMeasure(), "Measure"), dis(button, {
      active: isMeasureEnabled(),
      title: "Double-click point A then point B. Red = X, green = Y, blue = Z, cyan = total",
    })),
    "clear-measurements": (button) => b("clear", "Clear Meas.", safe(() => clearMeasurements(), "Clear measurements"), dis(button, { title: "Remove every measurement from the view" })),
    "make-editable": (button) => b("move", "Make Editable", safe(async () => {
      const n = await beginEditFromSelection();
      if (!n) toast("Nothing selected — pick elements in the viewport first.", "warn");
      else toast(`Editing ${n} element(s). Drag the gizmo.`, "success");
    }, "Edit selected"), dis(button, { title: "Create professional Native Twins from linked IFC/FRAG elements while preserving the source object, exact geometry, dimensions and BIM metadata" })),
  };
  const items: HTMLElement[] = [];
  for (const panel of model.panels) {
    if (items.length) items.push(sep());
    items.push(groupLabel(panel.label));
    for (const button of panel.buttons) {
      const make = handlers[button.id];
      if (make) items.push(make(button));
      else console.warn(`[ribbon] no handler for Modify tab button "${button.id}"`);
    }
  }
  if (model.note) items.push(hint(model.note));
  return items;
}

/** Authored (or mixed authored + linked) selection: the full Modify tab. */
function selectionItems(elements: ModifyTabElement[]): HTMLElement[] {
  return modifyTabItems(buildModifyTabModel(elements));
}

/** Linked / fragment selection only: the view-only honest subset (G2). */
function linkedSelectionItems(elements: ModifyTabElement[]): HTMLElement[] {
  return modifyTabItems(buildModifyTabModel(elements));
}

// Fragment (linked) selection changes do not emit authoring changes, so
// the ribbon subscribes to the fragment selection service directly. The
// service may not be registered when the ribbon first mounts — retry on
// every sync until the subscription lands.
let fragmentSelectionSubscribed = false;
function ensureFragmentSelectionSubscription(): void {
  if (fragmentSelectionSubscribed) return;
  try {
    const sel = (ctx.features as any).selection;
    if (sel?.onChange) {
      sel.onChange(() => { syncContextTab(); });
      fragmentSelectionSubscribed = true;
    }
  } catch { /* retry on the next sync */ }
}

function syncContextTab() {
  ensureFragmentSelectionSubscription();
  // G4: the previous selection is recorded at mutation time by the two
  // stores (authoring.setSelectedAuthored and the selection manager's
  // replace/clear/add/remove), so no ribbon-side recording call is needed
  // here anymore — G2's select-previous.ts store is retired.
  const t = getActiveTool();
  const place = t && PLACE_TOOLS.has(t) ? t : null;
  let key: string | null = null;
  let label = "";
  let build: (() => HTMLElement[]) | null = null;
  if (place) {
    key = `place:${place}`; label = `Modify | Place ${CTX_LABEL[place] ?? place}`; build = () => ctxItems(place);
  } else if (!t || t === "select") {
    const authored = selectedAuthored();
    const linked = selectedLinked();
    if (authored.length || linked.length) {
      const elements: ModifyTabElement[] = [
        ...authored.map((e) => ({ id: e.id, category: e.type, sourceKind: "native" as const })),
        ...linked,
      ];
      const model = buildModifyTabModel(elements);
      const authoredTypes = [...new Set(authored.map((e) => e.type))].sort().join(",");
      key = authored.length ? `sel:${authoredTypes}:L${linked.length}` : `linked:L${linked.length}`;
      label = model.title;
      build = () => (authored.length ? selectionItems(elements) : linkedSelectionItems(elements));
    }
  }
  if (key === ctxTool) return;
  const hadTab = !!ctxTab;
  ctxTool = key;
  if (key && build) {
    if (!hadTab) tabBeforeCtx = activeTab;
    ctxTab = { id: "ctx-place", label, contextual: true, items: build };
    activeTab = "ctx-place";
    if (ribbonMinimized) {
      applyRibbonMinimize(false);
      lastAutoExpandAt = Date.now();
    }
  } else if (ctxTab) {
    ctxTab = null;
    if (activeTab === "ctx-place") activeTab = tabBeforeCtx && TABS.some((x) => x.id === tabBeforeCtx) ? tabBeforeCtx : (TABS[0]?.id ?? "file");
  }
  renderTabs();
  renderStrip();
}

function renderTabs() {
  tabsRow.innerHTML = "";
  mountLanguageButton(tabsRow);

  const brand = document.createElement("div");
  brand.className = "obs-ribbon__brand";
  brand.append(document.createTextNode("Open BIM Studio"));
  const version = document.createElement("span");
  version.className = "obs-ribbon__version";
  version.textContent = "v54";
  brand.appendChild(version);
  tabsRow.appendChild(brand);
  mountAccountButton(tabsRow);

  for (const t of [...TABS, ...(ctxTab ? [ctxTab] : [])] as TabDef[]) {

    const btn = document.createElement("button");
    btn.className = "obs-ribbon__tab" + (t.id === "file" ? " obs-ribbon__tab--file" : "") + (t.contextual ? " obs-ribbon__tab--ctx" : "");
    btn.textContent = t.label;
    if (t.id === activeTab) btn.dataset.active = "1";
    btn.dataset.tab = t.id;
    btn.onclick = () => {
      // Single click: if minimized, expand and switch; if already expanded, just switch tab
      if (ribbonMinimized) {
        applyRibbonMinimize(false);
        lastAutoExpandAt = Date.now();
      }
      // Re-clicking the already-active tab must NOT rebuild the tabs row: the
      // double-click collapse gesture needs both clicks to land on the same
      // node, and renderTabs() replaces every button.
      if (activeTab === t.id && !ribbonMinimized) return;
      activeTab = t.id;
      renderTabs();
      renderStrip();
    };
    tabsRow.appendChild(btn);
  }

  // ── Quick access toolbar (A12) ──────────────────────────────────────
  // New / Open / Save / Undo / Redo, always visible, mirroring the CAD
  // viewer's QAT in its tabs row. Built here — not once at setup — because
  // renderTabs() rebuilds the whole tabs row on every tab switch.
  const qat = document.createElement("div");
  qat.className = "obs-qat";
  const qatBtn = (icon: IconName, action: string, title: string, flip = false): HTMLButtonElement => {
    const el = document.createElement("button");
    el.className = "obs-qat__btn" + (flip ? " obs-qat__btn--flip" : "");
    el.dataset.qat = action;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.innerHTML = svgIcon(icon);
    return el;
  };
  qat.append(
    qatBtn("new-file", "new", "New project (home screen)"),
    qatBtn("folder", "open", "Open a file (any format)"),
    qatBtn("save", "save", "Save project (Ctrl+S)"),
    qatBtn("undo", "undo", "Undo (Ctrl+Z)"),
    qatBtn("undo", "redo", "Redo (Ctrl+Y)", true),
  );
  qat.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement | null)?.closest?.("[data-qat]") as HTMLElement | null;
    const a = t?.dataset.qat;
    if (!a) return;
    if (a === "new") showHome();
    else if (a === "open") void pickAndImport();
    else if (a === "save") void saveProject();
    else if (a === "undo") void history.undo().then(() => updateHistoryButtons());
    else if (a === "redo") void history.redo().then(() => updateHistoryButtons());
  });
  tabsRow.appendChild(qat);

  tabsRow.appendChild(pill);
  updatePill();
  updateHistoryButtons();
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
  updateHistoryButtons();
}

function renderStripImpl() {
  strip.innerHTML = "";

  const tab: TabDef = ([...TABS, ...(ctxTab ? [ctxTab] : [])] as TabDef[]).find((t) => t.id === activeTab) ?? TABS[0];
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
    // Honest save state. With no project open, isDirty() is false (the dirty
    // flag tracks the *current project document*), so the old code rendered a
    // green "SAVED" chip next to "No project" while every authored element
    // lived only in memory and died on reload — the pill claimed the exact
    // opposite of the truth. Report unprojected content as UNSAVED.
    if (!p) {
      const unprojected = (() => {
        try { return getElements().length > 0; } catch { return false; }
      })();
      status.className = `obs-ribbon__project-status ${unprojected ? "is-dirty" : ""}`;
      status.textContent = unprojected ? "NO PROJECT — UNSAVED" : "NO PROJECT";
      status.title = unprojected
        ? "You are modeling without a project — this data lives only in memory and will be lost on reload. Create a project (File → New Project) and save."
        : "No project is open. Create one via File → New Project.";
    } else {
      status.className = `obs-ribbon__project-status ${isDirty() ? "is-dirty" : "is-saved"}`;
      status.textContent = isDirty() ? "UNSAVED" : "SAVED";
      status.title = isDirty() ? "Project has unsaved changes" : "Project saved";
    }

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
    // Logical borders: the divider faces the content on either dock side,
    // in either direction (row-reverse under RTL puts the panel on the
    // opposite visual side, and the inline side follows it).
    if (side === "right") {
      mainRow.style.flexDirection = "row-reverse";
      ctx.leftHost.style.borderInlineEnd = "none";
      ctx.leftHost.style.borderInlineStart = "1px solid var(--border-default)";
    } else {
      mainRow.style.flexDirection = "row";
      ctx.leftHost.style.borderInlineStart = "none";
      ctx.leftHost.style.borderInlineEnd = "1px solid var(--border-default)";
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
    "background:var(--bg-base);border-inline-end:1px solid var(--border-default);" +
    "display:flex;flex-direction:column;";
  // Wheel over left dock scrolls the panel — never zooms 3D
  ctx.leftHost.addEventListener("wheel", (e) => { e.stopPropagation(); }, { passive: true });
  ctx.leftHost.style.display = "none"; // no Tools panel: see features/tool-windows.ts


  const mainRow = document.createElement("div");
  mainRow.style.cssText =
    "display:flex;flex:1;min-height:0;width:100%;overflow:hidden";
  mainRow.append(ctx.leftHost, ctx.rightHost);

  app.append(root, mainRow);
  root.append(tabsRow, strip);

  setupLeftDock(mainRow);

  onProjectChanged(updatePill);
  updatePill();
  // A12: Home is the default tab. A workspace the user explicitly saved
  // still lands on its tab; a first boot lands on Home.
  activeTab = workspaceSaved ? getWorkspaceDefinition(activeWorkspace).tab : "home";
  renderTabs();
  renderStrip();
  // A12: keep Undo/Redo state (Home tab + QAT) fresh when history changes
  // from anywhere — keyboard, palette, or another panel.
  history.onChange(() => updateHistoryButtons());
  onNorthChanged(() => renderStrip());
  onAuthoringChange(syncContextTab);
  syncContextTab();
  // Restore minimized state (BIM-style flat ribbon)
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
    if (d.fromRibbon) return; // already rendered by toast(); the event is for other listeners
    const kind = d.kind ?? "info";
    const message = String(d.message ?? "");
    const timeout = d.timeout ?? d.ms ?? (kind === "error" ? 6000 : 2400);
    renderToast(message, kind, timeout);
  }) as EventListener);
  }
