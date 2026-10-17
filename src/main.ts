import { setupManageLinks } from "./features/manage-links";
import "./critical-gaps-boot";
/**
 * Open BIM Studio v52 — main entry point.
 *
 * Heavy-duty open BIM production platform:
 * parametric-ready authoring, sheets/production docs, 4D simulation,
 * clash detective, IDS, schedules, 5D cost, automation rules, materials,
 * BCF, AI — engineered to compete with Revit, Navisworks, Bentley,
 * BricsCAD BIM, Forma and Renga as the open standards monster of AEC.
 */
import { setupViewer } from "./core/setup";
import { setupInputRouter } from "./core/input-router";
import { setupDiagnostics } from "./core/diagnostics";
import { setupOptions } from "./core/options-registry";
import { setupNavigation } from "./features/navigation";
import { setupSelectionOrbit } from "./features/selection-orbit";
import { setupDblclickFit } from "./features/dblclick-fit";
import { setupCameraTools, computeSceneBounds } from "./features/camera-tools";
import { setupMeasure } from "./features/measure";
import { setupDrawing } from "./features/drawing";
import { setupSection } from "./features/section";
import { setupImporter } from "./features/importer";
import { ctx } from "./core/context";
import { setupSectionModal } from "./features/section-modal";
import { setupSchedulesUI } from "./features/schedules-ui";
import { setupPlanAuthoringBridge } from "./features/plan-authoring-bridge";

import { setupClash } from "./features/clash";
import { setupClashCategories } from "./features/clash-categories";
import { setupClashReview } from "./features/clash-review";
import { setupModelAlign } from "./features/model-align";
import { setupViewCube } from "./features/viewcube";
import { setupContextMenu } from "./features/context-menu";
import { setupProjects } from "./modules/projects/projects";
import { setupAuthoring } from "./features/authoring";
import { setupPlanGridTool } from "./features/plan-grid-tool";
import { setupFamilies } from "./modules/families";
import { setupFamilyBrowser } from "./features/family-browser";
import { setupIssues } from "./modules/issues/issues";
import { setupBcf } from "./modules/issues/bcf";
import { setupIssuesPanel } from "./features/issues-panel";
import { setupCost } from "./modules/cost/cost";
import { setupCostPanel } from "./features/cost-panel";
import { setupCdePanel } from "./features/cde-panel";
import { setupStandardsPanel } from "./features/standards-panel";
import { setupPanelWiring } from "./features/panel-wiring";
import { setupFileInterop } from "./features/file-interop";
import { setupFileMenu } from "./shell/file-menu";
import { setupViewsPanel } from "./features/views-panel";
import { setupSheets2dPanel } from "./features/sheets-2d-panel";
import { setupShell } from "./shell/shell";
import { buildPanel } from "./features/panel";

import { history } from "./features/history";
import { selection, setupClickToSelect } from "./features/selection";
import { snapping } from "./features/snapping";
import { gizmo } from "./features/gizmo";
import { shortcuts } from "./features/shortcuts";
import { setupViewportToolbar } from "./shell/viewport-toolbar";
import { registerDefaultShortcuts } from "./shell/default-shortcuts";
import { setupUserInterfaceMenu } from "./features/user-interface-menu";
import { setupNavigationBar } from "./features/navigation-bar";
import { setupSystemBrowser } from "./features/system-browser";
import { setupMepFabrication } from "./features/mep-fabrication";
import { setupPidModeler } from "./features/pid-modeler";
import { registerUiItems } from "./features/ui-items-register";

import { setupIdsPanel } from "./features/ids-panel";
import { setupModelTree } from "./modules/model-tree/tree";
import { setupModelTreePanel } from "./features/model-tree-panel";
import { setupPlanViewPanel } from "./features/plan-view-panel";
import { setupSchedulesPanel } from "./features/schedules-panel";
import { setupWalkMode } from "./features/walk-mode";
import { setupWalkMinimap } from "./features/walk-minimap";
import { setupCommandPalette } from "./features/command-palette";
import { setupSavedViews } from "./features/saved-views";
import { setupCursorTracker } from "./features/cursor-tracker";
import { setupFragEdit } from "./features/frag-edit";
import { setupAccuDraw } from "./features/accudraw";
import { setupPushPull } from "./features/push-pull";
import { setupPrimitives } from "./features/primitives";
import { setupWallHandles } from "./features/wall-handles";
import { setupAppLoader } from "./features/app-loader";
import { setupPropertyPalette } from "./features/property-palette";
import { setupMepColoring } from "./features/mep-coloring";
import { setupBoxSelection } from "./features/box-selection";
import { setupAiChat } from "./features/ai-chat";
import { setupTimelinePanel } from "./features/timeline-panel";
import { setupSheetsPanel } from "./features/sheets-panel";
import { setupAutomationPanel } from "./features/automation-panel";
import { setupProjectBrowser } from "./features/project-browser";
import { setupBimToolbox } from "./features/bim-toolbox";
import { refreshViewGraphics } from "./features/view-graphics";
import { setupRevitExperience } from "./features/revit-experience";
import { setupBimObjectStudio } from "./features/bim-object-studio";
import { setupLevelChip } from "./features/level-chip";
import { setupWorkspaceLayout } from "./features/workspace-boot";
import { setupRibbonPersist } from "./features/ribbon-persist";
import { setupStatusBarExtras } from "./features/status-bar-extras";

import type { Dispatch } from 'react';
import { Command } from './commands/CommandBase';
import { installGlobalErrorHandlers, renderBootFailure, logError } from "./core/errors";
import { dumpServiceRegistry } from "./core/services";
import { setupExtras } from "./features/_extras";

// Install global error handlers before anything else boots.
installGlobalErrorHandlers();


const errOverlay = document.createElement("div");
errOverlay.style.cssText =
  "position:fixed;inset:auto 12px 12px 12px;z-index:99999;display:none;" +
  "background:#3b0d0d;color:#ffd7d7;border:1px solid #ef4444;border-radius:8px;" +
  "padding:10px 14px;font:12px/1.5 monospace;white-space:pre-wrap;max-height:45vh;overflow:auto";
document.body.appendChild(errOverlay);

const BENIGN = [
  /Fragments\s*:?\s*Model not found/i,
  /ResizeObserver loop/i,
  /Loading CSS chunk/i,
  /Script error\.?/i,
  /cancelled/i,
  /AbortError/i,
];

function isBenign(msg: string) {
  return BENIGN.some((re) => re.test(msg));
}

function showError(title: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  if (isBenign(msg)) {
    console.warn(`[suppressed] ${title}: ${msg.split("\n")[0]}`);
    return;
  }
  console.error(`[OpenBIMStudio] ${title}`, err);
  errOverlay.style.display = "block";
  errOverlay.innerHTML = "";
  const pre = document.createElement("pre");
  pre.style.cssText = "margin:0;white-space:pre-wrap;font:inherit";
  pre.textContent = `✖ ${title}\n${msg}`;
  const dismiss = document.createElement("button");
  dismiss.textContent = "Dismiss";
  dismiss.style.cssText =
    "margin-top:8px;background:#7f1d1d;color:#fecaca;border:1px solid #ef4444;" +
    "border-radius:6px;padding:4px 10px;cursor:pointer;font:12px system-ui";
  dismiss.onclick = () => { errOverlay.style.display = "none"; errOverlay.innerHTML = ""; };
  errOverlay.append(pre, dismiss);
}

window.addEventListener("error", (e) => {
  const msg = String(e.error?.message ?? e.message ?? "");
  if (isBenign(msg)) {
    e.preventDefault();
    return;
  }
  showError("Unhandled error", e.error ?? e.message);
});

window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
  const reason: any = e.reason;
  const msg =
    reason instanceof Error ? reason.message
    : typeof reason === "string" ? reason
    : String(reason?.message ?? reason ?? "");
  if (isBenign(msg)) {
    console.warn("[suppressed benign] " + msg);
    e.preventDefault();
    return;
  }
  // Production: show once, do not cascade crash the app
  e.preventDefault();
  showError("Background task failed (app continues)", reason);
});

function step(name: string, fn: () => unknown | Promise<unknown>) {
  return (async () => {
    try {
      await fn();
      console.log(`[TOC boot] ✓ ${name}`);
    } catch (err) {
      showError(`Step failed: ${name} (viewer continues without it)`, err);
    }
  })();
}

await step("setupViewer (core)", async () => {
  if (!document.getElementById("app")) {
    throw new Error('index.html has no <div id="app"> — check your HTML entry.');
  }
  try {
    await setupViewer();
    setupExtras();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isWorker = /worker|wasm|fragments/i.test(message);
    renderBootFailure({
      title: "Open BIM Studio failed to start",
      message: "The application could not initialize. This is usually a build or environment problem, not a bug in your models.",
      hint: isWorker
        ? "The Fragments worker failed to load. This is often caused by COEP/CORS headers being missing on the dev server, or by the wasm file being served as HTML (a 404). Restart Vite after `npm install` and check the browser Network tab for `web-ifc.wasm`."
        : "Check the browser console for the full stack trace. If you just pulled new code, run `npm install && npm run dev` again.",
      details: err instanceof Error ? (err.stack ?? message) : message,
    });
    throw err;
  }
});

if (!ctx.world) {
  console.error("[Open BIM Studio] Viewer failed to initialize — aborting remaining boot steps.");
  throw new Error("Boot aborted: viewer is not available.");
}

await step("diagnostics", () => setupDiagnostics());
await step("options", () => setupOptions());
await step("input-router", () => setupInputRouter());
await step("camera-tools", () => setupCameraTools());
await step("navigation", () => setupNavigation());
await step("selection-orbit", () => setupSelectionOrbit());
await step("dblclick-fit", () => setupDblclickFit());
await step("app-loader", () => setupAppLoader());
await step("accudraw", () => setupAccuDraw());
await step("push-pull", () => setupPushPull());
await step("primitives", () => setupPrimitives());
await step("wall-handles", () => setupWallHandles());

await step("saved-views", () => setupSavedViews());
await step("cursor-tracker", () => setupCursorTracker());
await step("command-palette", () => setupCommandPalette());
await step("walk-mode", () => setupWalkMode());
await step("walk-minimap", () => setupWalkMinimap());

await step("selection", () => { (ctx.features as any).selection = selection; });
await step("selection-click", () => { setupClickToSelect(); });
await step("box-selection", () => setupBoxSelection());
await step("snapping", () => { (ctx.features as any).snapping = snapping; });
await step("history", () => { (ctx.features as any).history = history; });
await step("gizmo", () => {
  gizmo.setup(ctx.rightHost);
  (ctx.features as any).gizmo = gizmo;
});

await step("frag-edit", () => setupFragEdit());

await step("measure", () => setupMeasure());
await step("drawing", () => setupDrawing());
await step("section", () => setupSection());
await step("section-modal", () => {
  setupSectionModal();
  import("./features/command-palette").then(m => {
    m.registerCommand({
      id: "section-modal",
      label: "Section Cut",
      category: "View",
      hint: "Open the interactive section cut window",
      run: () => (window as any).__obsOpenSectionModal?.(),
    });
  }).catch(e => console.warn("Failed to register section-modal command", e));
});

await step("property-palette", () => setupPropertyPalette());
await step("ai-chat", () => setupAiChat());
await step("timeline-panel", () => setupTimelinePanel());
await step("sheets-panel", () => setupSheetsPanel());
await step("automation-panel", () => setupAutomationPanel());
await step("project-browser", () => setupProjectBrowser());
await step("bim-toolbox", () => setupBimToolbox());
await step("mep-coloring", () => setupMepColoring());

await step("importer", async () => setupImporter());
await step("model-align", () => setupModelAlign());
await step("clash", () => setupClash());
await step("clash-categories", () => {
  setupClashCategories();
  // Register command palette entry
  import("./features/command-palette").then(m => {
    m.registerCommand({
      id: "clash-categories",
      label: "Category Clash Rules",
      category: "Clash",
      hint: "Run clashes between specific categories (Native vs IFC)",
      run: () => (window as any).__obsOpenClashCategories?.(),
    });
  }).catch(e => console.warn("Failed to register clash-categories command", e));
});
await step("clash-review", () => setupClashReview());

await step("viewcube", () => setupViewCube());
await step("context-menu", () => setupContextMenu());
await step("viewport-toolbar", () => setupViewportToolbar());

await step("projects", async () => setupProjects());
await step("authoring", () => setupAuthoring());
await step("plan-authoring-bridge", () => setupPlanAuthoringBridge());
await step("families", () => setupFamilies());
await step("family-browser", () => setupFamilyBrowser());
await step("issues", () => setupIssues());
await step("bcf", () => setupBcf());
await step("issues-panel", () => setupIssuesPanel());
await step("cost", () => setupCost());
await step("cost-panel", () => setupCostPanel());
await step("cde-panel", () => setupCdePanel());
await step("standards-panel", () => setupStandardsPanel());
await step("panel-wiring", () => setupPanelWiring());

await step("ids-panel", () => setupIdsPanel());
await step("model-tree", () => setupModelTree());
await step("model-tree-panel", () => setupModelTreePanel());
await step("plan-view", () => setupPlanViewPanel());
await step("schedules", () => setupSchedulesPanel());
await step("schedules-ui", () => {
  setupSchedulesUI();
  import("./features/command-palette").then(m => {
    m.registerCommand({
      id: "schedules-ui",
      label: "Element Schedule",
      category: "View",
      hint: "View quantity takeoffs and material schedules",
      run: () => (window as any).__obsOpenSchedules?.(),
    });
  }).catch(e => console.warn("Failed to register schedules-ui command", e));
});

await step("file-interop", () => setupFileInterop());
await step("file-menu", () => setupFileMenu());
await step("manage-links", () => setupManageLinks());
await step("views-panel", () => setupViewsPanel());
await step("sheets-2d-panel", () => setupSheets2dPanel());

await step("view-graphics", () => refreshViewGraphics());
await step("revit-experience", () => setupRevitExperience());
await step("bim-object-studio", () => setupBimObjectStudio());
await step("level-chip", () => setupLevelChip());
await step("shell", () => setupShell());
await step("default-shortcuts", () => registerDefaultShortcuts());
await step("ui-menu", () => setupUserInterfaceMenu());
await step("navigation-bar", () => setupNavigationBar());
await step("system-browser", () => setupSystemBrowser());
await step("mep-fabrication", () => setupMepFabrication());
await step("pid-modeler", () => setupPidModeler());
await step("ui-items", () => registerUiItems());
await step("shortcuts-install", () => shortcuts.install());
await step("panel", () => buildPanel());
await step("workspace-layout", () => setupWorkspaceLayout());
await step("ribbon-persist", () => setupRibbonPersist());
await step("status-bar-extras", () => setupStatusBarExtras());

window.dispatchEvent(new Event("resize"));
computeSceneBounds();

try { dumpServiceRegistry(); } catch { /* */ }

console.log(
  "[Open BIM Studio v52] Professional openBIM delivery platform online � sheets � 4D � automation � clash � IDS � BCF � schedules � 5D � authoring � materials � AI",
);



export type RootState = any;
export type AppDispatch = any;

export function pushCommand(cmd: Command): void {
  history.push(cmd as any);
}
export function undo(): void { void history.undo(); }
export function redo(): void { void history.redo(); }



void ctx;
