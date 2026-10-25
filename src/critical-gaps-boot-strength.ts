/**
 * OpenBIMStudio Strengthening — P0 boot (Transaction, ParametricRegen, Properties)
 * Reduces Revit depth gap: undo/redo transactions, dirty regen, multi-select properties.
 */

import { getTransactionService } from "./modules/transaction";
import { getParametricRegenService } from "./modules/parametric-regen";
import { getPropertiesPanelService } from "./modules/properties-panel";

declare global {
  interface Window {
    __obsTransaction?: ReturnType<typeof getTransactionService>;
    __obsParametricRegen?: ReturnType<typeof getParametricRegenService>;
    __obsProperties?: ReturnType<typeof getPropertiesPanelService>;
  }
}

export function bootStrengtheningModules(): void {
  const txn = getTransactionService();
  const regen = getParametricRegenService();
  const props = getPropertiesPanelService();

  if (typeof window !== "undefined") {
    window.__obsTransaction = txn;
    window.__obsParametricRegen = regen;
    window.__obsProperties = props;

    // Keyboard: Ctrl+Z / Ctrl+Y when not typing in an input
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (txn.canUndo()) {
          e.preventDefault();
          txn.undo();
        }
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        if (txn.canRedo()) {
          e.preventDefault();
          txn.redo();
        }
      }
    });
  }

  console.info("[Strengthening] P0 modules booted: Transaction, ParametricRegen, PropertiesPanel");
}

bootStrengtheningModules();

export { getTransactionService, getParametricRegenService, getPropertiesPanelService };
