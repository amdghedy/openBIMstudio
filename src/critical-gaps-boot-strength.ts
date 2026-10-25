/**
 * OpenBIMStudio Strengthening Package — Boot Wire
 * Import this from main.ts (or after existing critical-gaps-boot).
 *
 * Usage:
 *   import "./critical-gaps-boot-strength";
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
  }

  console.info(
    "[Strengthening] P0–P2 modules booted:",
    "Transaction, ParametricRegen, Properties, Joins, LOD, ViewTemplates, SiteTopo, Detailing, Validation"
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
};
