/**
 * Auto-Dimensions module entry.
 */

import { autoDimensionsEngine, exposeAutoDimensionsGlobal } from "./auto-dimensions-engine";
import { setupAutoDimensionsUI, openAutoDimsPanel } from "./auto-dimensions-ui";

type Any = Record<string, any>;

function registerPaletteCommands(): void {
  try {
    const cmds = [
      {
        id: "annotate.autoDimensions",
        title: "Auto Dimension Plan",
        category: "Annotate",
        keywords: ["dimension", "auto dim", "aligned"],
        run: () => {
          const created = autoDimensionsEngine.autoDimensionPlan({ axis: "both" });
          try {
            const n = (window as Any).__obsNotify ?? (window as Any).notify;
            if (typeof n === "function") {
              n("success", `Created ${created.length} dimension string(s)`, { timeout: 3000 });
            }
          } catch { /* */ }
        },
      },
      {
        id: "annotate.autoDimensionsPanel",
        title: "Auto Dimensions Panel",
        category: "Annotate",
        keywords: ["dimension panel"],
        run: () => openAutoDimsPanel(),
      },
      {
        id: "annotate.promoteTempDims",
        title: "Promote Temporary Dimensions",
        category: "Annotate",
        run: () => {
          const n = autoDimensionsEngine.promoteTemporary();
          try {
            const notify = (window as Any).__obsNotify ?? (window as Any).notify;
            if (typeof notify === "function") {
              notify("info", n ? `Promoted ${n}` : "No temporary dimensions", { timeout: 2500 });
            }
          } catch { /* */ }
        },
      },
      {
        id: "annotate.clearAutoDims",
        title: "Clear Auto Dimensions",
        category: "Annotate",
        run: () => {
          for (const d of autoDimensionsEngine.listDimensions()) {
            if (d.source === "auto") autoDimensionsEngine.removeDimension(d.id);
          }
        },
      },
    ];

    const palette =
      (window as Any).__obsCommandPalette ??
      (window as Any).commandPalette;
    const register = palette?.register ?? palette?.add ?? (window as Any).registerCommand;
    if (typeof register === "function") {
      for (const c of cmds) {
        try {
          register(c);
        } catch {
          try {
            register(c.id, c);
          } catch { /* */ }
        }
      }
    }

    const map = ((window as Any).__obsPaletteCommands ??= {});
    for (const c of cmds) map[c.id] = c;

    (window as Any).__obsAutoDimActions = {
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
