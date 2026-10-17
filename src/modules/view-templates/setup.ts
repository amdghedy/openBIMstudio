/**
 * View Templates module entry – call setupViewTemplates() from critical-gaps-boot.
 */

import { viewTemplatesStore, exposeViewTemplatesGlobal } from "./view-templates-store";
import { setupVgDialog, openVgDialog } from "./vg-dialog";

type Any = Record<string, any>;

function registerPaletteCommands(): void {
  try {
    const palette =
      (window as Any).__obsCommandPalette ??
      (window as Any).commandPalette ??
      (window as Any).__OBS_COMMANDS__;
    const register =
      palette?.register ??
      palette?.add ??
      (window as Any).registerCommand;

    const cmds = [
      {
        id: "view.visibilityGraphics",
        title: "Visibility/Graphics…",
        category: "View",
        keywords: ["vg", "visibility", "graphics", "categories", "halftone"],
        run: () => openVgDialog(),
      },
      {
        id: "view.viewTemplates",
        title: "View Templates…",
        category: "View",
        keywords: ["template", "view template"],
        run: () => openVgDialog({ templateId: viewTemplatesStore.listTemplates()[0]?.id }),
      },
      {
        id: "view.applyArchitecturalTemplate",
        title: "Apply Template: Architectural Plan",
        category: "View",
        run: () => {
          const t = viewTemplatesStore
            .listTemplates()
            .find((x) => /architectural/i.test(x.name));
          if (!t) return;
          const viewId = "default";
          viewTemplatesStore.applyTemplateToViews(t.id, [viewId], true);
          viewTemplatesStore.syncToVisibilityFilter(viewId);
          window.dispatchEvent(
            new CustomEvent("obs:vg-changed", { detail: { viewId, templateId: t.id } })
          );
        },
      },
      {
        id: "view.applyStructuralTemplate",
        title: "Apply Template: Structural Plan",
        category: "View",
        run: () => {
          const t = viewTemplatesStore
            .listTemplates()
            .find((x) => /structural/i.test(x.name));
          if (!t) return;
          const viewId = "default";
          viewTemplatesStore.applyTemplateToViews(t.id, [viewId], true);
          viewTemplatesStore.syncToVisibilityFilter(viewId);
          window.dispatchEvent(
            new CustomEvent("obs:vg-changed", { detail: { viewId, templateId: t.id } })
          );
        },
      },
      {
        id: "view.applyCoordinationTemplate",
        title: "Apply Template: Coordination",
        category: "View",
        run: () => {
          const t = viewTemplatesStore
            .listTemplates()
            .find((x) => /coordination/i.test(x.name));
          if (!t) return;
          const viewId = "default";
          viewTemplatesStore.applyTemplateToViews(t.id, [viewId], true);
          viewTemplatesStore.syncToVisibilityFilter(viewId);
        },
      },
    ];

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

    // Also expose a simple map for revit-parity-bridge consumers
    const map = ((window as Any).__obsPaletteCommands ??= {});
    for (const c of cmds) map[c.id] = c;
  } catch (e) {
    console.warn("[view-templates] palette registration skipped", e);
  }
}

function patchCommandCenter(): void {
  try {
    // Soft integration: when Command Center rebuilds, it may read __obsViewTemplateActions
    (window as Any).__obsViewTemplateActions = {
      openVg: () => openVgDialog(),
      openTemplates: () => openVgDialog(),
      applyArchitectural: () => {
        const t = viewTemplatesStore.listTemplates().find((x) => /architectural/i.test(x.name));
        if (t) {
          viewTemplatesStore.applyTemplateToViews(t.id, ["default"], true);
          viewTemplatesStore.syncToVisibilityFilter("default");
        }
      },
    };
  } catch { /* */ }
}

export function setupViewTemplates(): void {
  exposeViewTemplatesGlobal();
  setupVgDialog();
  registerPaletteCommands();
  patchCommandCenter();

  // Sync default view once visibility filter is available
  setTimeout(() => {
    try {
      viewTemplatesStore.syncToVisibilityFilter("default");
    } catch { /* */ }
  }, 800);

  console.log(
    `[view-templates] ready — ${viewTemplatesStore.listTemplates().length} template(s), Ctrl+Shift+V`
  );
}

export { openVgDialog, viewTemplatesStore };
