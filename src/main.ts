import { APP_VERSION } from "./version";
import "./features/usage-boot";
import { setupManageLinks } from "./features/manage-links";
import { setupCadQueryPanel } from "./features/cad-query-panel";
import { setupIfcToFrag } from "./features/ifc-to-frag";
import "./critical-gaps-boot";
import "./critical-gaps-boot-strength";
import { setupPluginSystem } from "./plugins/boot";
/**
 * Open BIM Studio — main entry point.
 *
 * Open BIM Studio entry point: creates the viewer, then runs the named boot
 * steps below. See docs/ARCHITECTURE.md for how the code is organised.
 */
import { setupViewer } from "./core/setup";
import { installEscapeAll } from "./core/escape-all";
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
import { setupSectionPlanePanel } from "./features/section-plane-panel";
import { setupSectionArrowCameraSync } from "./features/section-arrow-camera-sync";
import { setupSchedulesUI } from "./features/schedules-ui";
import { setupPlanAuthoringBridge } from "./features/plan-authoring-bridge";

import { setupClash } from "./features/clash";
import { setupClashCategories } from "./features/clash-categories";
import { setupClashReview } from "./features/clash-review";
import { setupModelAlign } from "./features/model-align";

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
import { setupLocale } from "./core/locale-boot";
import { setupDomTranslate, registerSwitcherLocales } from "./core/dom-translate";
import { buildPanel } from "./features/panel";
import { setupToolWindows } from "./features/tool-windows";

import { history } from "./features/history";
import { setupRVTTrustGates } from "./features/rvt-trust-gates";
import { selection, setupClickToSelect } from "./features/selection";
import { snapping } from "./features/snapping";
import { setupSelectionSnappingPalette } from "./features/selection-snapping-palette";
import { gizmo } from "./features/gizmo";
import { shortcuts } from "./features/shortcuts";
import { setupShortcutEditor } from "./features/shortcut-editor";
import { setupCommandAliases } from "./features/command-aliases";
import { setupViewportToolbar } from "./shell/viewport-toolbar";
import { registerDefaultShortcuts } from "./shell/default-shortcuts";
import { setupUserInterfaceMenu } from "./features/user-interface-menu";
import { setupNavigationBar } from "./features/navigation-bar";
import { setupOrthoHook } from "./features/ortho-hook";
import { setupNewFeatureBadges } from "./features/new-feature-badges";
import { setupViewCube } from "./features/viewcube";
import { setupSystemBrowser } from "./features/system-browser";
import { setupMepFabrication } from "./features/mep-fabrication";
import { setupParametricTools } from "./features/parametric-tools";
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
import { setupCollaborationPanel } from "./features/collaboration-panel";
import { setupWorkshareLocks } from "./modules/collaboration/workshare-locks";
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
import { refreshViewGraphics, setupViewGraphics } from "./features/view-graphics";
import { setupBimExperience } from "./features/bim-experience";
import { setupBimObjectStudio } from "./features/bim-object-studio";
import { setupLevelChip } from "./features/level-chip";
import { setupWorkspaceLayout } from "./features/workspace-boot";
import { setupRibbonPersist } from "./features/ribbon-persist";
import { setupStatusBarExtras } from "./features/status-bar-extras";

import type { Dispatch } from 'react';
import { Command } from './commands/CommandBase';
import { installGlobalErrorHandlers, renderBootFailure, logError, setWindowErrorSurface, isBenignErrorMessage } from "./core/errors";
import { dumpServiceRegistry } from "./core/services";
import { createBootStepper } from "./core/boot-runner";
import { bootTheme } from "./core/theme";
import { setupExtras } from "./features/_extras";

// Install global error handlers before anything else boots. This is the ONLY
// place window error/unhandledrejection listeners are registered — their UI
// surface (the overlay below) is plugged in through setWindowErrorSurface,
// so detection and display share one BENIGN filter instead of two drifting
// copies.
installGlobalErrorHandlers();


const errOverlay = document.createElement("div");
errOverlay.style.cssText =
  "position:fixed;inset:auto 12px 12px 12px;z-index:99999;display:none;" +
  "background:#3b0d0d;color:#ffd7d7;border:1px solid #ef4444;border-radius:8px;" +
  "padding:10px 14px;font:12px/1.5 monospace;white-space:pre-wrap;max-height:45vh;overflow:auto";
document.body.appendChild(errOverlay);

function showError(title: string, err: unknown) {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  if (isBenignErrorMessage(msg)) {
    console.warn(`[suppressed] ${title}: ${msg.split("\n")[0]}`);
    return;
  }
  console.error(`[OpenBIMStudio] ${title}`, err);
  // Every surfaced error also lands in the ring buffer — previously boot-step
  // failures shown here were invisible to recentErrors()/diagnostics exports.
  logError(err, title);
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

// Plug the overlay into the single global handler pair from core/errors.
setWindowErrorSurface(showError);

// One boot stepper for the whole chain: every step below is tracked, timed
// and retryable in the Startup health panel, and finalize() is called here
// at the true end of boot — not by whichever side module finishes first.
const boot = createBootStepper({
  onStepError: (title, err) => showError(title, err),
});

function step(name: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  // Tracked + timed + retryable via the Startup health panel; failures are
  // reported once through the overlay with the original error object.
  return boot.step(name, fn).then(() => undefined);
}

await step("secure-store", async () => (await import("./core/secure-store")).initSecureStore());
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
bootTheme();
// escape-all MUST install before the input router: both add window-capture
// keydown listeners, and same-target/same-phase listeners fire in registration
// order. escape-all needs to see bare Escape first so one press cancels ALL
// active orders (router, modify orders, tool previews, modes) and can consume
// the key before the router's first-true-consumes path runs.
await step("escape-all", () => installEscapeAll());
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
await step("collaboration-panel", () => setupCollaborationPanel());
await step("workshare-locks", () => setupWorkshareLocks());
await step("walk-mode", () => setupWalkMode());
await step("walk-minimap", () => setupWalkMinimap());

await step("selection", () => { (ctx.features as any).selection = selection; });
await step("selection-click", () => { setupClickToSelect(); });
await step("box-selection", () => setupBoxSelection());
await step("snapping", () => { (ctx.features as any).snapping = snapping; });
await step("history", () => { (ctx.features as any).history = history; });
await step("trust-gates", () => setupRVTTrustGates());
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
  setupSectionPlanePanel();
  setupSectionArrowCameraSync();
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
await step("agent-bridge", async () => {
  const m = await import("./features/agent-bridge");
  m.setupAgentBridge();
});
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


await step("context-menu", () => setupContextMenu());
await step("viewport-toolbar", () => setupViewportToolbar());

await step("projects", async () => setupProjects());
await step("persistence", async () => (await import("./modules/projects/persistence")).setupProjectPersistence());
await step("cloud-account", async () => (await import("./features/cloud-account")).setupCloudAccount());
await step("pwa", async () => (await import("./core/pwa")).setupPwa());
await step("north-compass", async () => (await import("./features/north-ui")).setupNorthCompass());
await step("project-file", async () => (await import("./modules/projects/project-file-io")).setupProjectFileIO());
await step("project-recovery", async () => (await import("./features/project-recovery")).setupProjectRecovery());
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
await step("cad-query", () => setupCadQueryPanel());
await step("ifc-to-frag", () => setupIfcToFrag());
await step("views-panel", () => setupViewsPanel());
await step("sheets-2d-panel", () => setupSheets2dPanel());

await step("view-graphics", () => { setupViewGraphics(); refreshViewGraphics(); });
await step("bim-experience", () => setupBimExperience());
await step("bim-object-studio", () => setupBimObjectStudio());
await step("level-chip", () => setupLevelChip());
await step("i18n", () => { registerSwitcherLocales(); setupLocale(); setupDomTranslate(); });
await step("shell", () => setupShell());
await step("default-shortcuts", () => registerDefaultShortcuts());
await step("selection-snapping-palette", () => setupSelectionSnappingPalette());
await step("ui-menu", () => setupUserInterfaceMenu());
await step("viewcube", () => setupViewCube());
await step("navigation-bar", () => setupNavigationBar());
await step("system-browser", () => setupSystemBrowser());
await step("mep-fabrication", () => setupMepFabrication());
await step("parametric-tools", () => setupParametricTools());
await step("pid-modeler", () => setupPidModeler());
await step("ui-items", () => registerUiItems());
await step("shortcuts-install", () => shortcuts.install());
await step("shortcut-editor", () => setupShortcutEditor());
await step("command-aliases", () => setupCommandAliases());
await step("panel", () => { buildPanel(); setupToolWindows(); });
await step("workspace-layout", () => setupWorkspaceLayout());
await step("ribbon-persist", () => setupRibbonPersist());
await step("status-bar-extras", () => setupStatusBarExtras());

// Ortho projection hook — re-fits the frustum when the camera switches
// perspective ↔ orthographic so the visible size stays consistent.
await step("ortho-hook", () => setupOrthoHook());
// New-feature discovery badges — green dots on newly shipped controls.
await step("new-feature-badges", () => setupNewFeatureBadges());

// Plugin SDK boots last, after every service is registered and the viewport
// is interactive. Plugins depend on `services.tryUse("authoring")` etc.
// returning non-null. The boot function adds a small delay internally so
// the viewport's initial render completes first.
await step("plugins", () => setupPluginSystem());

window.dispatchEvent(new Event("resize"));
computeSceneBounds();

try { dumpServiceRegistry(); } catch { /* */ }

// THE authoritative "boot finished" event. Every step above is tracked, so
// the Startup health chip now reflects the WHOLE chain (previously only the
// critical-gaps side modules called finalize() — racing ahead of most of
// these steps, so "boot complete" was claimed before the app was ready).
// Idempotent: late side-module finalize calls become no-ops.
const bootSummary = boot.finalize();
if (!bootSummary.ok) {
  console.warn(
    `[Open BIM Studio] boot finished with ${bootSummary.failed.length} failed step(s):`,
    bootSummary.failed.join(", "),
    "— see the Startup health chip for retry.",
  );
}

console.log(`[Open BIM Studio ${APP_VERSION}] ready`);



export type RootState = any;
export type AppDispatch = any;

export function pushCommand(cmd: Command): void {
  history.push(cmd as any);
}
export function undo(): void { void history.undo(); }
export function redo(): void { void history.redo(); }



void ctx;
