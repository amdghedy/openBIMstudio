// openbim-fix:workspace-boot
//
// Wires every dockable panel in ctx.features into the workspace-layout
// store, plus the Advanced / Critical Gaps toolbar which uses a
// window global. Runs as the very last boot step in main.ts, after
// every panel's setup function has already populated ctx.features.

import { ctx } from "../core/context";
import {
  registerWorkspacePanel,
  restoreWorkspace,
  saveWorkspace,
  resetWorkspace,
  showAllWorkspace,
  installWorkspaceUnloadHook,
  listWorkspacePanels,
} from "../modules/workspace-layout";
import { registerCommand } from "./command-palette";

interface PanelFeature {
  isVisible?: () => boolean;
  open?: () => void;
  close?: () => void;
  toggle?: () => void;
}

function asVisible(F: PanelFeature): boolean {
  try { return typeof F.isVisible === "function" && !!F.isVisible(); }
  catch { return false; }
}

function setVisible(F: PanelFeature, on: boolean): void {
  const now = asVisible(F);
  if (now === on) return;
  if (on && typeof F.open === "function") { F.open(); return; }
  if (!on && typeof F.close === "function") { F.close(); return; }
  if (typeof F.toggle === "function") F.toggle();
}

function reg(featureKey: string, label: string, defaultOpen = false): boolean {
  const F = (ctx.features as any)[featureKey] as PanelFeature | undefined;
  if (!F) return false;
  registerWorkspacePanel({
    key: featureKey,
    label,
    defaultOpen,
    isVisible: () => asVisible(F),
    setVisible: (on: boolean) => setVisible(F, on),
  });
  return true;
}


function hideStartupFloaters(): void {
  for (const id of ["obs-rcc-launch", "obs-dwg-launch", "obs-param-launch"]) {
    try {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    } catch { /* */ }
  }
  try { (window as any).__obsBIMCC?.close?.(); } catch { /* */ }
  try { (window as any).__obsBimCommandCenter?.close?.(); } catch { /* */ }
  try {
    const feat = (window as any).__obsFeatures ?? {};
    feat.bimToolbox?.close?.();
    feat.propertyPalette?.close?.();
  } catch { /* */ }
  try {
    const ctxFeat = (globalThis as any).ctx?.features;
    ctxFeat?.bimToolbox?.close?.();
    ctxFeat?.propertyPalette?.close?.();
  } catch { /* */ }
}

export function setupWorkspaceLayout(): void {
  // Dockable panels -- all closed by default. Panels without a
  // ctx.features handle are silently skipped; the workspace system is
  // best-effort and never throws on a missing panel.
  reg("projectBrowser",   "Project Browser");
  reg("propertyPalette",  "Properties");
  reg("modelTreePanel",   "Model Categories");
  reg("familyBrowser",    "Family Browser");
  reg("bimToolbox",       "BIM Command Center");
  reg("bimObjectStudio",  "BIM Object Studio");
  reg("schedulesPanel",   "Schedules");
  reg("sheetsPanel",      "Sheets");
  reg("sheets2dPanel",    "Sheets (2D)");
  reg("issuesPanel",      "Issues / BCF");
  reg("idsPanel",         "IDS Validation");
  reg("timelinePanel",    "Timeline 4D");
  reg("costPanel",        "5D Cost");
  reg("savedViews",       "Saved Views");
  reg("modelHealthPanel", "Model Health");
  reg("cdePanel",         "Common Data Environment");
  reg("standardsPanel",   "Standards");
  reg("planView",         "Floor Plan");
  reg("viewsPanel",       "Views");
  reg("navigationBar",    "Navigation Bar");
  reg("systemBrowser",    "System Browser");
  reg("mepFabrication",   "MEP Fabrication Parts");
  reg("pidModeler",       "P&ID Modeler");
  reg("aiChat",           "AI Assistant");

  // Critical Gaps / Advanced toolbar (window global, not ctx.features).
  registerWorkspacePanel({
    key: "criticalGapsToolbar",
    label: "Advanced Toolbar",
    defaultOpen: false,
    isVisible: () => {
      try { return !!(window as any).__obsCriticalGapsUI?.isVisible?.(); }
      catch { return false; }
    },
    setVisible: (on: boolean) => {
      const api = (window as any).__obsCriticalGapsUI;
      if (!api) return;
      if (on) { api.show?.(); } else { api.hide?.(); }
    },
  });

  installWorkspaceUnloadHook();
  restoreWorkspace();
  hideStartupFloaters();

  // Expose the API for tests and DevTools.
  (window as any).__obsWorkspace = {
    save: saveWorkspace,
    restore: restoreWorkspace,
    reset: resetWorkspace,
    showAll: showAllWorkspace,
    list: () => listWorkspacePanels().map((p) => ({
      key: p.key, label: p.label, visible: p.isVisible(),
    })),
  };

  // Command palette entries.
  try {
    registerCommand({
      id: "workspace.reset",
      label: "Reset Workspace Layout",
      category: "View",
      hint: "Close every panel and return to the clean default",
      run: () => resetWorkspace(),
    });
    registerCommand({
      id: "workspace.save",
      label: "Save Workspace Layout",
      category: "View",
      hint: "Persist the current panel layout",
      run: () => {
        saveWorkspace();
        try {
          window.dispatchEvent(new CustomEvent("obs-toast", {
            detail: { message: "Workspace saved", kind: "success" },
          }));
        } catch { /* */ }
      },
    });
    registerCommand({
      id: "workspace.showAll",
      label: "Show All Panels",
      category: "View",
      hint: "Open every registered panel",
      run: () => showAllWorkspace(),
    });
  } catch (err) {
    console.warn("[workspace-boot] command registration failed", err);
  }

  console.log(
    "[workspace-boot] ready - " +
    listWorkspacePanels().length + " panel(s) registered",
  );
}