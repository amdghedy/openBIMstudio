/**
 * UI Items Register - GAP CLOSURE PATCH
 *
 * Replaces the four `available: false` stubs with live toggles bound to
 * the real feature modules that already ship in the codebase:
 *   - navigation-bar.ts
 *   - system-browser.ts
 *   - mep-fabrication.ts
 *   - pid-modeler.ts
 *
 * Apply by merging these registerUiItem() calls into registerUiItems()
 * (or call registerClosedGapUiItems() after registerUiItems()).
 */

import { ctx } from "../core/context";
import { registerUiItem, persistItem } from "../modules/ui-registry";

function F(): any {
  return (ctx.features as any) ?? {};
}

function safeToggle(id: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn("[ui-items]", id, e);
  }
  persistItem(id, true);
}

/**
 * Call once after feature modules have been set up.
 * Overwrites / re-registers the previously unavailable items as available.
 */
export function registerClosedGapUiItems(): void {
  // -- Navigation Bar ------------------------------------------------
  registerUiItem({
    id: "nav-bar",
    label: "Navigation Bar",
    group: "panels",
    available: true,
    isVisible: () => {
      try {
        return !!F().navigationBar?.isVisible?.();
      } catch {
        return false;
      }
    },
    toggle: () =>
      safeToggle("nav-bar", () => {
        const nav = F().navigationBar;
        if (nav?.toggle) nav.toggle();
        else if (nav?.setVisible) nav.setVisible(!nav.isVisible?.());
        else {
          // Lazy import fallback
          void import("./navigation-bar").then((m: any) => {
            m.setupNavigationBar?.();
            m.toggleNavigationBar?.();
          });
        }
      }),
  });

  // -- MEP System Browser --------------------------------------------
  registerUiItem({
    id: "system-browser",
    label: "System Browser",
    group: "panels",
    available: true,
    isVisible: () => {
      try {
        return !!F().systemBrowser?.isVisible?.();
      } catch {
        return false;
      }
    },
    toggle: () =>
      safeToggle("system-browser", () => {
        const sb = F().systemBrowser;
        if (sb?.toggle) sb.toggle();
        else {
          void import("./system-browser").then((m: any) => {
            m.setupSystemBrowser?.();
            m.toggleSystemBrowser?.();
          });
        }
      }),
  });

  // -- MEP Fabrication Parts -----------------------------------------
  registerUiItem({
    id: "mep-fabrication",
    label: "MEP Fabrication Parts",
    group: "panels",
    available: true,
    isVisible: () => {
      try {
        return !!F().mepFabrication?.isVisible?.();
      } catch {
        return false;
      }
    },
    toggle: () =>
      safeToggle("mep-fabrication", () => {
        const fab = F().mepFabrication;
        if (fab?.toggle) fab.toggle();
        else {
          void import("./mep-fabrication").then((m: any) => {
            m.setupMepFabrication?.();
            m.toggleMepFabrication?.();
          });
        }
      }),
  });

  // -- P&ID Modeler --------------------------------------------------
  registerUiItem({
    id: "pid-modeler",
    label: "P&ID Modeler",
    group: "panels",
    available: true,
    isVisible: () => {
      try {
        return !!F().pidModeler?.isVisible?.();
      } catch {
        return false;
      }
    },
    toggle: () =>
      safeToggle("pid-modeler", () => {
        const pid = F().pidModeler;
        if (pid?.toggle) pid.toggle();
        else {
          void import("./pid-modeler").then((m: any) => {
            m.setupPidModeler?.();
            m.togglePidModeler?.();
          });
        }
      }),
  });

  // -- New gap-closure panels ----------------------------------------
  registerUiItem({
    id: "rooms-panel",
    label: "Rooms & Areas",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsRooms,
    toggle: () => {
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "rooms" } }));
    },
  });

  registerUiItem({
    id: "phases-panel",
    label: "Phasing",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsPhases,
    toggle: () => {
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "phases" } }));
    },
  });

  registerUiItem({
    id: "design-options-panel",
    label: "Design Options",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsDesignOptions,
    toggle: () => {
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "design-options" } }));
    },
  });

  registerUiItem({
    id: "ref-planes-panel",
    label: "Reference Planes",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsRefPlanes,
    toggle: () => {
      const rp = (window as any).__obsRefPlanes;
      rp?.showOverlay?.(true);
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "ref-planes" } }));
    },
  });

  
  registerUiItem({
    id: "groups-panel",
    label: "Model Groups",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsGroups,
    toggle: () => {
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "groups" } }));
    },
  });

  registerUiItem({
    id: "copy-monitor-panel",
    label: "Copy / Monitor",
    group: "panels",
    available: true,
    isVisible: () => !!(window as any).__obsCopyMonitor,
    toggle: () => {
      window.dispatchEvent(new CustomEvent("obs-open-panel", { detail: { id: "copy-monitor" } }));
    },
  });

console.log("[ui-items-register-patch] closed-gap UI items registered");
}
