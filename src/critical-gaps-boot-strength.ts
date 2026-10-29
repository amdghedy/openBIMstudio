/**
 * OpenBIMStudio Strengthening Package — Full boot (P0–P2)
 * Authoring depth, stability, enterprise collaboration, and documentation modules.
 */

import { getTransactionService } from "./modules/transaction";
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
import "./features/hatch-panel";
import "./features/arc-wall-tool";
import "./features/gltf-export-tool";
import "./features/modify-group2-tool";

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

export function bootStrengtheningModules(): void {
  const txn = getTransactionService();
  const regen = getParametricRegenService();
  const props = getPropertiesPanelService();
  const joins = getJoinsCleanupService();
  const lod = getLODPerformanceService();
  const views = getViewTemplatesService();
  const site = getSiteTopoService();
  const detail = getDetailingService();
  const validation = getValidationService();
  const worksharing = getWorksharingEngine();
  const streaming = getMemoryBudgetManager();

  if (typeof window !== "undefined") {
    window.__obsTransaction = txn;
    window.__obsParametricRegen = regen;
    window.__obsProperties = props;
    window.__obsJoins = joins;
    window.__obsLOD = lod;
    window.__obsViewTemplates = views;
    window.__obsSiteTopo = site;
    window.__obsDetailing = detail;
    window.__obsValidation = validation;
    window.__obsWorksharing = worksharing;
    window.__obsStreamingBudget = streaming;
    window.__obsBatchPlot = {
      generateBatchPlotPdf,
      downloadBatchPlotPdf,
    };
    window.__obsDetailHatch = HatchPatterns;
    window.__obsArcWall = ArcWall;
    window.__obsGltfExporter = GltfNativeTwin;
    window.__obsModifyGroup2 = ModifyGroup2;

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
        e.preventDefault();
        const issues = validation.runAll();
        console.info("[Validation]", issues.length, "issue(s)", issues);
      }
    });
  }

  console.info(
    "[Strengthening] P0–P2 enterprise modules booted:",
    "Transaction, ParametricRegen, Properties, Joins, LOD, ViewTemplates, SiteTopo, Detailing, Validation, Worksharing, StreamingBudget, BatchPlot"
  );
}

bootStrengtheningModules();

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
