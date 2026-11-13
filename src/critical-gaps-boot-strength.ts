/**
 * OpenBIMStudio Strengthening Package — Full boot (P0–P2)
 * Authoring depth, stability, enterprise collaboration, and documentation modules.
 */

import { getTransactionService } from "./modules/transaction";
import { isCadHotkeyOwnerActive } from "./core/cad-hotkey-ownership";
import { getParametricRegenService } from "./modules/parametric-regen";
import { getPropertiesPanelService } from "./modules/properties-panel";
import { getJoinsCleanupService } from "./modules/joins-cleanup";
import { getLODPerformanceService } from "./modules/lod-performance";
import { getViewTemplatesService } from "./modules/view-templates";
import { getSiteTopoService } from "./modules/site-topo";
import { getDetailingService } from "./modules/detailing";
import { getValidationService } from "./modules/validation";
import { getWorksharingEngine } from "./modules/collaboration/worksharing-engine";
import { getMemoryBudgetManager } from "./modules/streaming/memory-budget-manager";
import { generateBatchPlotPdf, downloadBatchPlotPdf } from "./modules/export/batch-plotter";
import * as HatchPatterns from "./modules/detail-patterns/hatch-patterns";
import * as ArcWall from "./modules/parametric/arc-wall";
import * as GltfNativeTwin from "./modules/export/gltf-native-twin";
import * as ModifyGroup2 from "./modules/modify/group2";
import "./features/worksharing-panel";
import "./features/streaming-panel";
import "./features/batch-plot-panel";
import { setupExportCadViews } from "./features/export-cad-views";
import { setupPdfToDwg } from "./features/pdf-to-dwg";
import { setupNavLowRes } from "./features/nav-lowres";
import "./features/hatch-panel";
import "./features/arc-wall-tool";
import "./features/gltf-export-tool";
import "./features/modify-group2-tool";
import { bootHealth, setupBootHealth, trackedBootStep } from "./core/boot-health";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsTransaction: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsParametricRegen: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsJoins: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsLOD: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsSiteTopo: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsDetailing: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsValidation: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsWorksharing: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsStreamingBudget: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsBatchPlot: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsDetailHatch: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsArcWall: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsGltfExporter: any;
// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsModifyGroup2: any;

declare global {
  interface Window {
    __obsTransaction?: ReturnType<typeof getTransactionService>;
    __obsParametricRegen?: ReturnType<typeof getParametricRegenService>;
    __obsProperties?: ReturnType<typeof getPropertiesPanelService>;
    __obsJoins?: ReturnType<typeof getJoinsCleanupService>;
    __obsLOD?: ReturnType<typeof getLODPerformanceService>;
    __obsViewTemplates?: ReturnType<typeof getViewTemplatesService>;
    __obsSiteTopo?: ReturnType<typeof getSiteTopoService>;
    __obsDetailing?: ReturnType<typeof getDetailingService>;
    __obsValidation?: ReturnType<typeof getValidationService>;
    __obsWorksharing?: ReturnType<typeof getWorksharingEngine>;
    __obsStreamingBudget?: ReturnType<typeof getMemoryBudgetManager>;
    __obsBatchPlot?: {
      generateBatchPlotPdf: typeof generateBatchPlotPdf;
      downloadBatchPlotPdf: typeof downloadBatchPlotPdf;
    };
    __obsDetailHatch?: typeof HatchPatterns;
    __obsArcWall?: typeof ArcWall;
    __obsGltfExporter?: typeof GltfNativeTwin;
    __obsModifyGroup2?: typeof ModifyGroup2;
  }
}

async function safeStep(label: string, fn: () => unknown): Promise<void> {
  // Tracked + retryable via the Startup health panel. Previously one throw in
  // any of these killed every module after it, silently.
  trackedBootStep(label, fn);
  await bootHealth.runStep(label, fn);
}

export async function bootStrengtheningModules(): Promise<void> {
  await safeStep("strength:export-cad-views", () => setupExportCadViews());
  await safeStep("strength:pdf-to-dwg", () => setupPdfToDwg());
  await safeStep("strength:nav-lowres", () => setupNavLowRes());
  const txn = getTransactionService();
  const txnBox: Record<string, any> = { txn };
  await safeStep("strength:parametric-regen", () => { txnBox.regen = getParametricRegenService(); });
  await safeStep("strength:properties-panel", () => { txnBox.props = getPropertiesPanelService(); });
  await safeStep("strength:joins-cleanup", () => { txnBox.joins = getJoinsCleanupService(); });
  await safeStep("strength:lod-performance", () => { txnBox.lod = getLODPerformanceService(); });
  await safeStep("strength:view-templates", () => { txnBox.views = getViewTemplatesService(); });
  await safeStep("strength:site-topo", () => { txnBox.site = getSiteTopoService(); });
  await safeStep("strength:detailing", () => { txnBox.detail = getDetailingService(); });
  await safeStep("strength:validation", () => { txnBox.validation = getValidationService(); });
  await safeStep("strength:worksharing", () => { txnBox.worksharing = getWorksharingEngine(); });
  await safeStep("strength:streaming-budget", () => { txnBox.streaming = getMemoryBudgetManager(); });

  await safeStep("strength:globals-and-hotkeys", () => {
    if (typeof window === "undefined") return;
    const txn = getTransactionService();
    const regen = txnBox.regen ?? getParametricRegenService();
    const props = txnBox.props ?? getPropertiesPanelService();
    const joins = txnBox.joins ?? getJoinsCleanupService();
    const lod = txnBox.lod ?? getLODPerformanceService();
    const views = txnBox.views ?? getViewTemplatesService();
    const site = txnBox.site ?? getSiteTopoService();
    const detail = txnBox.detail ?? getDetailingService();
    const validation = txnBox.validation ?? getValidationService();
    const worksharing = txnBox.worksharing ?? getWorksharingEngine();
    const streaming = txnBox.streaming ?? getMemoryBudgetManager();
    obsTransaction = txn;
    obsParametricRegen = regen;
    window.__obsProperties = props;
    obsJoins = joins;
    obsLOD = lod;
    window.__obsViewTemplates = views;
    obsSiteTopo = site;
    obsDetailing = detail;
    obsValidation = validation;
    obsWorksharing = worksharing;
    obsStreamingBudget = streaming;
    obsBatchPlot = {
      generateBatchPlotPdf,
      downloadBatchPlotPdf,
    };
    obsDetailHatch = HatchPatterns;
    obsArcWall = ArcWall;
    obsGltfExporter = GltfNativeTwin;
    obsModifyGroup2 = ModifyGroup2;

    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
        if (txn.canUndo()) {
          e.preventDefault();
          txn.undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) {
        if (txn.canRedo()) {
          e.preventDefault();
          txn.redo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === "v") {
        // Stands down while a CAD drawing tab is active — the CAD editor owns
        // Ctrl+Shift+V for PASTECLIP / Super Copy.
        if (isCadHotkeyOwnerActive()) return;
        e.preventDefault();
        const issues = validation.runAll();
        console.info("[Validation]", issues.length, "issue(s)", issues);
      }
    });
  });

  console.info(
    "[Strengthening] P0–P2 enterprise modules booted:",
    "Transaction, ParametricRegen, Properties, Joins, LOD, ViewTemplates, SiteTopo, Detailing, Validation, Worksharing, StreamingBudget, BatchPlot",
    bootHealth.status().failed.length
      ? `(with ${bootHealth.status().failed.length} failed step(s) — see Startup health)`
      : "clean",
  );
  setupBootHealth();
  bootHealth.finalize();
}

void bootStrengtheningModules();

export {
  getTransactionService,
  getParametricRegenService,
  getPropertiesPanelService,
  getJoinsCleanupService,
  getLODPerformanceService,
  getViewTemplatesService,
  getSiteTopoService,
  getDetailingService,
  getValidationService,
  getWorksharingEngine,
  getMemoryBudgetManager,
  generateBatchPlotPdf,
  downloadBatchPlotPdf,
};
