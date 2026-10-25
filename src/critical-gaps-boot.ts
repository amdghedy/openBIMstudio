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

  // MEP auto-routing + ASHRAE sizing
  await safe("mep", async () => {
    const m: Any = await import("./modules/mep");
    m.setupMep?.();
  });

  // Rebar detailing engine + viewport integration
  await safe("rebar-engine", async () => {
    const m: Any = await import("./modules/rebar");
    m.setupRebar?.();
  });
  await safe("rebar-viewport", async () => {
    const m: Any = await import("./features/rebar-viewport");
    m.setupRebarViewport?.();
  });

  // Wall sweeps & reveals (cornice, baseboard, wainscot, reveal)
  await safe("wall-sweeps", async () => {
    const m: Any = await import("./modules/wall-sweeps");
    m.setupWallSweeps?.();
  });

  // Performance engine: BVH raycasting + InstancedMesh batching
  await safe("perf-engine", async () => {
    const m: Any = await import("./core/performance-engine");
    m.setupPerformanceEngine?.();
  });

  // Area plans & color fill (spatial analysis: color rooms by department)
  await safe("area-plans", async () => {
    const m: Any = await import("./modules/area-plans");
    m.setupAreaPlans?.();
  });

  // Detail components & repeating details
  await safe("detail-components", async () => {
    const m: Any = await import("./modules/detail-components");
    m.setupDetailComponents?.();
  });

  // Keynotes
  await safe("keynotes", async () => {
    const m: Any = await import("./modules/keynotes");
    m.setupKeynotes?.();
  });

  // Model curves on faces
  await safe("model-curves", async () => {
    const m: Any = await import("./modules/model-curves");
    m.setupModelCurves?.();
  });

  // Filled regions & masking regions (2D detail annotation)
  await safe("filled-regions", async () => {
    const m: Any = await import("./modules/filled-regions");
    m.setupFilledRegions?.();
  });

  // Material assignment engine (3D rendering + quantity takeoff)
  await safe("material-assignment", async () => {
    const m: Any = await import("./modules/material-assignment");
    m.setupMaterialAssignment?.();
  });

  // Parametric constraints (lock dimensions, equality, alignment)
  await safe("parametric-constraints", async () => {
    const m: Any = await import("./modules/parametric-constraints");
    m.setupParametricConstraints?.();
  });

  // Dimension chains (continuous + baseline)
  await safe("dimension-chains", async () => {
    const m: Any = await import("./modules/dimension-chains");
    m.setupDimensionChains?.();
  });

  // BIM / Navisworks import (RVT → IFC conversion via APS)
  await safe("bim-import", async () => {
    const m: Any = await import("./features/bim-import");
    m.setupBIMImport?.();
  });

  // Sun settings & shadows (solar study)
  await safe("sun-settings", async () => {
    const m: Any = await import("./modules/sun-settings");
    m.setupSunSettings?.();
  });

  // Line weights by element type
  await safe("line-weights", async () => {
    const m: Any = await import("./modules/line-weights");
    m.setupLineWeights?.();
  });

  // Grid bubbles & level markers in views
  await safe("grid-bubbles", async () => {
    const m: Any = await import("./modules/grid-bubbles");
    m.setupGridBubbles?.();
  });

  // In-place mass / freeform (conceptual massing)
  await safe("in-place-mass", async () => {
    const m: Any = await import("./modules/in-place-mass");
    m.setupInPlaceMass?.();
  });

  // Structural analytical model (FEM nodes + members + loads)
  await safe("analytical-model", async () => {
    const m: Any = await import("./modules/analytical-model");
    m.setupAnalyticalModel?.();
  });

  // Energy analysis (heat loss, solar gain, gbXML export)
  await safe("energy-analysis", async () => {
    const m: Any = await import("./modules/energy-analysis");
    m.setupEnergyAnalysis?.();
  });

  // Plugin marketplace registry
  await safe("plugin-marketplace", async () => {
    const m: Any = await import("./modules/plugin-marketplace");
    m.setupPluginMarketplace?.();
  });

  // Project base point & survey point (shared coordinates)
  await safe("project-base-point", async () => {
    const m: Any = await import("./modules/project-base-point");
    m.setupProjectBasePoint?.();
  });

  // DWG linking (live CAD references)
  await safe("cad-link", async () => {
    const m: Any = await import("./modules/cad-link");
    m.setupCadLinks?.();
  });

  // Model groups (group + reuse elements)
  await safe("model-groups", async () => {
    const m: Any = await import("./modules/model-groups");
    m.setupModelGroups?.();
  });

  // Work planes (set active sketch plane for modeling)
  await safe("work-planes", async () => {
    const m: Any = await import("./modules/work-planes");
    m.setupWorkPlanes?.();
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
  await safe("bim-mouse-policy", async () => {
    const m: Any = await import("./core/bim-mouse-policy");
    m.setupBIMMousePolicy?.();
  });

  // ── v40 module globals ────────────────────────────────────────────────
  await safe("v40-register", async () => {
    await import("./modules/v40-register");
  });

  // ── v67 engineering engines (constraints / structural / MEP pressure / adaptive)
  await safe("v67-register", async () => {
    const m: Any = await import("./modules/v67-register");
    m.setupV67Engines?.();
  });

  // ── v68 authoring core (dependency graph / solids / snapping / modify / properties)
  await safe("v68-register", async () => {
    const m: Any = await import("./modules/v68-register");
    m.setupV68Engines?.();
  });

  // ── View Tools Manager panel (replaces console.log dumps) ─────────────
  await safe("view-tools-manager", async () => {
    const m: Any = await import("./features/view-tools-manager");
    m.setupViewToolsManager?.();
  });

  // ── Element right-click context menu (native elements) ─────────────────
  await safe("element-context-menu", async () => {
    const m: Any = await import("./features/element-context-menu");
    m.setupElementContextMenu?.();
  });

  // ── Global Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (capture-phase safety net) ───
  await safe("global-undo", async () => {
    const m: Any = await import("./features/global-undo");
    m.setupGlobalUndo?.();
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
