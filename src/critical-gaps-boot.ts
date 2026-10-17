/**
 * Critical Gaps Boot - wires every BIM-parity module.
 *
 * Import once from main.ts (`import "./critical-gaps-boot"`).
 *
 * Design rules for zero-crash boot:
 *  - Only ctx is a static import
 *  - Everything else loads via dynamic import() inside safe()
 *  - One failure never stops the rest
 */

import { ctx } from "./core/context";

type Any = Record<string, any>;

let started = false;
let timer: number | null = null;

function isReady(): boolean {
  const c = ctx as Any;
  const renderer = c.world?.renderer?.three ?? c.world?.renderer;
  const hasRenderer = !!renderer && typeof renderer.render === "function";
  const hasHost =
    !!c.rightHost ||
    !!document.getElementById("viewport") ||
    !!document.querySelector(".obs-viewport");
  return hasRenderer && hasHost;
}

async function safe(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.warn("[critical-gaps-boot]", label, e);
  }
}

async function runOnce(): Promise<void> {
  if (started) return;
  started = true;
  (window as Any).__OBS_CTX__ = ctx;

  // Existing project modules
  await safe("performance-optimizer", async () => {
    const m: Any = await import("./core/performance-optimizer");
    m.setupPerformanceOptimizer?.();
  });
  await safe("hosted-openings", async () => {
    const m: Any = await import("./features/hosted-openings");
    m.setupHostedOpenings?.();
  });
  await safe("constraint-solver", async () => {
    const m: Any = await import("./features/constraint-solver");
    m.setupConstraintSolver?.();
  });
  await safe("drafting-2d", async () => {
    const m: Any = await import("./features/drafting-2d");
    m.setupDrafting2D?.();
  });
  await safe("drafting-bridge", async () => {
    const m: Any = await import("./features/drafting-bridge");
    m.setupDraftingBridge?.();
  });
  await safe("lod-manager", async () => {
    const m: Any = await import("./features/lod-manager");
    m.setupLodManager?.();
  });
  await safe("focus-service", async () => { await import("./features/focus-service"); });
  await safe("hosted-place-sync", async () => { await import("./features/hosted-place-sync"); });

  // Core BIM-parity stores
  await safe("rooms", async () => {
    const m: Any = await import("./modules/rooms/rooms");
    m.setupRooms?.();
  });
  await safe("phases", async () => {
    const m: Any = await import("./modules/phases/phases");
    m.setupPhases?.();
  });
  await safe("groups", async () => {
    const m: Any = await import("./modules/groups/groups");
    m.setupGroups?.();
  });
  await safe("design-options", async () => {
    const m: Any = await import("./modules/design-options/design-options");
    m.setupDesignOptions?.();
  });
  await safe("ref-planes", async () => {
    const m: Any = await import("./modules/ref-planes/ref-planes");
    m.setupRefPlanes?.();
  });
  await safe("shared-params", async () => {
    const m: Any = await import("./modules/shared-params/shared-params");
    m.setupSharedParams?.();
  });
  await safe("visibility-filter", async () => {
    const m: Any = await import("./modules/visibility/visibility-filter");
    m.setupVisibilityFilter?.();
  });

  // Geometry generators
  await safe("stairs", async () => {
    const m: Any = await import("./modules/stairs/stairs");
    m.setupStairs?.();
  });
  await safe("railings", async () => {
    const m: Any = await import("./modules/railings/railings");
    m.setupRailings?.();
  });
  await safe("curtain-wall", async () => {
    const m: Any = await import("./modules/curtain-wall/curtain-wall");
    m.setupCurtainWall?.();
  });

  // Coordination
  await safe("copy-monitor", async () => {
    const m: Any = await import("./modules/copy-monitor/copy-monitor");
    m.setupCopyMonitor?.();
  });
  await safe("type-catalog", async () => {
    const m: Any = await import("./modules/type-catalog/type-catalog");
    m.setupTypeCatalog?.();
  });

  // Tools
  await safe("align-tool", async () => {
    const m: Any = await import("./features/align-tool");
    m.setupAlignTool?.();
  });
  await safe("temp-dimensions", async () => {
    const m: Any = await import("./features/temp-dimensions");
    m.setupTempDimensions?.();
  });

  // Parametric families - full engine upgrade + sample door + UI
  await safe("parametric-families", async () => {
    const m: Any = await import("./modules/families/families-parametric-boot");
    m.setupParametricFamilies?.();
  });
  await safe("parametric-family-panel", async () => {
    const m: Any = await import("./features/parametric-family-panel");
    m.setupParametricFamilyPanel?.();
  });

  // UI
  await safe("gap-panels", async () => {
    const m: Any = await import("./features/panels/gap-panels");
    m.setupGapPanels?.();
  });
  await safe("ui-items-gap-patch", async () => {
    const m: Any = await import("./features/ui-items-register-patch");
    m.registerClosedGapUiItems?.();
  });
  await safe("bim-parity-bridge", async () => {
    const m: Any = await import("./features/bim-parity-bridge");
    m.setupBimParityBridge?.();
  });
  await safe("bim-command-center", async () => {
    const m: Any = await import("./features/bim-command-center");
    m.setupBimCommandCenter?.();
  });
  await safe("selection-orbit-pivot", async () => {
    const m: Any = await import("./features/selection-orbit-pivot");
    m.setupSelectionOrbitPivot?.();
  });
  await safe("nav-cog-force", async () => {
    const m: Any = await import("./features/nav-cog-force");
    m.setupNavCogForce?.();
  });
  await safe("nav-selection-pivot-patch", async () => {
    const m: Any = await import("./features/nav-selection-pivot-patch");
    m.setupNavSelectionPivotPatch?.();
  });
  await safe("bim-input-parity", async () => {
    const m: Any = await import("./features/bim-input-parity");
    m.setupBimInputParity?.();
  });
  await safe("cad-parity", async () => {
    const m: Any = await import("./features/cad-parity");
    m.setupCadParity?.();
  });
  await safe("dwg-engine", async () => {
    const m: Any = await import("./modules/drawings/dwg-engine");
    m.setupDwgEngine?.();
  });
  await safe("drawings-panel", async () => {
    const m: Any = await import("./features/drawings-panel");
    m.setupDrawingsPanel?.();
  });
  await safe("parity-tab-bar", async () => {
    const m: Any = await import("./features/parity-tab-bar");
    m.setupParityTabBar?.();
  });
  await safe("section-arrow-select-block", async () => {
    const m: Any = await import("./features/section-arrow-select-block");
    m.setupSectionArrowSelectBlock?.();
  });
  await safe("section-cut-interaction", async () => {
    const m: Any = await import("./features/section-cut-interaction");
    m.setupSectionCutInteraction?.();
  });
  await safe("ribbon-parity-inject", async () => {
  });
  await safe("critical-gaps-ui", async () => {
    const m: Any = await import("./features/critical-gaps-ui");
    m.setupCriticalGapsUI?.();
  });

  // Enable previously-stubbed features
  await safe("navigation-bar", async () => {
    const m: Any = await import("./features/navigation-bar");
    m.setupNavigationBar?.();
  });
  await safe("system-browser", async () => {
    const m: Any = await import("./features/system-browser");
    m.setupSystemBrowser?.();
  });
  await safe("mep-fabrication", async () => {
    const m: Any = await import("./features/mep-fabrication");
    m.setupMepFabrication?.();
  });
  await safe("pid-modeler", async () => {
    const m: Any = await import("./features/pid-modeler");
    m.setupPidModeler?.();
  });

  await safe("wheel-arbiter", async () => {
    const m: Any = await import("./core/wheel-arbiter");
    m.setupWheelArbiter?.();
  });
  await safe("realtime-client", async () => {
    const m: Any = await import("./modules/collaboration/realtime-client");
    m.setupRealtimeClient?.();
  });
  await safe("revit-mouse-policy", async () => {
    const m: Any = await import("./core/revit-mouse-policy");
    m.setupBIMMousePolicy?.();
  });

  console.log("[critical-gaps-boot] all critical gaps wired");
}

timer = window.setInterval(() => {
  if (isReady()) {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    void runOnce();
  }
}, 200);

window.setTimeout(() => {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
    void runOnce();
  }
}, 120000);
