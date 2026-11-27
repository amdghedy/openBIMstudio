/**
 * Auto-Dimensions module entry.
 */

import { autoDimensionsEngine, exposeAutoDimensionsGlobal } from "./auto-dimensions-engine";
import { notify as coreNotify } from "../../core/notify";
import { ready } from "../../core/services";
import { setupAutoDimensionsUI, openAutoDimsPanel } from "./auto-dimensions-ui";

// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsAutoDimActions: any;

type Any = Record<string, any>;

function registerPaletteCommands(): void {
  try {
    // Same dead-global fix as view-templates: the window palette globals had
    // no producer, so these commands never registered. Command shape mapped
    // to the palette contract (title → label, keywords → hint); the legacy
    // commands-map stash had no reader and is gone.
    const cmds = [
      {
        id: "annotate.autoDimensions",
        label: "Auto Dimension Plan",
        category: "Annotate",
        hint: "dimension, auto dim, aligned",
        run: () => {
          const created = autoDimensionsEngine.autoDimensionPlan({ axis: "both" });
          coreNotify("success", `Created ${created.length} dimension string(s)`, { timeout: 3000 });
        },
      },
      {
        id: "annotate.autoDimensionsPanel",
        label: "Auto Dimensions Panel",
        category: "Annotate",
        hint: "dimension panel",
        run: () => openAutoDimsPanel(),
      },
      {
        id: "annotate.promoteTempDims",
        label: "Promote Temporary Dimensions",
        category: "Annotate",
        run: () => {
          const n = autoDimensionsEngine.promoteTemporary();
          coreNotify("info", n ? `Promoted ${n}` : "No temporary dimensions", { timeout: 2500 });
        },
      },
      {
        id: "annotate.clearAutoDims",
        label: "Clear Auto Dimensions",
        category: "Annotate",
        run: () => {
          for (const d of autoDimensionsEngine.listDimensions()) {
            if (d.source === "auto") autoDimensionsEngine.removeDimension(d.id);
          }
        },
      },
    ];

    void ready("commandPalette").then((palette) => {
      const register = palette?.register ?? null;
      if (typeof register === "function") {
        for (const c of cmds) {
          try { register(c); } catch { /* */ }
        }
      }
    });

    obsAutoDimActions = {
      openPanel: openAutoDimsPanel,
      autoPlan: () => autoDimensionsEngine.autoDimensionPlan({ axis: "both" }),
      promote: () => autoDimensionsEngine.promoteTemporary(),
    };
  } catch (e) {
    console.warn("[auto-dimensions] palette registration skipped", e);
  }
}

export function setupAutoDimensions(): void {
  exposeAutoDimensionsGlobal();
  setupAutoDimensionsUI();
  registerPaletteCommands();
  console.log("[auto-dimensions] ready — Ctrl+Shift+D");
}

export { openAutoDimsPanel, autoDimensionsEngine };
