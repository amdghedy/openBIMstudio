/**
 * Module feature APIs — registers the feature modules on ctx.features for the
 * ribbon and other modules to consume without a hard import. (History: every
 * one of these used to be a window-global stash; the last of them moved to
 * ctx.features on 2026-11-27. Unreachable features — point cloud, ramp — are
 * typed command-palette commands instead.)
 */

import * as THREE from "three";
import { notify as coreNotify } from "../core/notify";
import { ready as servicesReady } from "../core/services";
import { ctx } from "../core/context";

import {
  buildToposurface, cutFillVolume,
  type ToposurfaceParams, type ToposurfaceResult,
} from "../modules/toposurface/toposurface";
import {
  buildBuildingPad,
  type BuildingPadParams, type BuildingPadResult,
} from "../modules/building-pad/building-pad";
import {
  buildPropertyLine,
  type PropertyLineParams, type PropertyLineResult,
} from "../modules/property-line/property-line";
import {
  buildSiteComponent, defaultSize, defaultColor,
  type SiteComponentParams, type SiteComponentType,
} from "../modules/site-components/site-components";
import {
  buildRamp,
} from "../modules/ramps/ramps";
import {
  buildTruss, type TrussParams, type TrussResult, type TrussType,
} from "../modules/trusses/trusses";
import {
  buildStructuralConnection,
  type ConnectionParams, type ConnectionResult, type ConnectionType,
} from "../modules/structural-connections/structural-connections";
import {
  buildFabricationPart, getAstmCode,
  type FabPartParams, type FabPartResult, type FabPartType,
} from "../modules/fabrication-parts/fabrication-parts";
import {
  createScopeBox, listScopeBoxes, getScopeBox, deleteScopeBox,
  updateScopeBox, applyToView, removeFromView, pointInScope,
  bboxIntersectsScope, resetScopeBoxes,
  type ScopeBox,
} from "../modules/scope-box/scope-box";
import {
  enableScopeBoxVisualizer, disableScopeBoxVisualizer,
  refreshScopeBoxVisualizer, toggleScopeBoxVisualizer,
  isScopeBoxVisualizerEnabled,
} from "../modules/scope-box/scope-box-visualizer";
import {
  createViewFilter, listViewFilters, getViewFilter, deleteViewFilter,
  addFilterToView, removeFilterFromView, toggleFilterInView,
  matchesFilter, resolveOverride, resetViewFilters,
  type ViewFilter, type GraphicsOverride, type FilterRule,
} from "../modules/view-filters/view-filters";
import { buildMatchline, type MatchlineParams } from "../modules/matchline/matchline";
import { buildPlanRegion, pointInRegion, resolveCutPlane, type PlanRegionParams } from "../modules/plan-region/plan-region";
import {
  createDependentView, listDependents, getDependentView,
  updateCropRegion, deleteDependentView, resetDependentViews,
} from "../modules/dependent-views/dependent-views";
import {
  runModelChecker, listShippedRules,
  type ModelElement, type ModelCheckerReport, type ModelCheckerConfig,
} from "../modules/model-checker/model-checker";
import { runDaylightAnalysis, classifyDF, type DaylightAnalysisParams } from "../modules/daylighting/daylighting";
import {
  createLoadCase, listLoadCases, deleteLoadCase,
  createLoadCombination, listLoadCombinations, resolveCombination,
  generateDefaultLRFDCombinations, generateDefaultASDCombinations, resetLoadCases,
  type LoadCase, type LoadCombination,
} from "../modules/structural-loads-ui/structural-loads-ui";
import { runStudy, type StudyConfig, type StudyResult } from "../modules/generative-design/generative-design";
import { loadPointCloud, type PointCloudLoadOptions } from "../modules/point-cloud/point-cloud";
import { loadPdfUnderlay, type PdfUnderlayParams } from "../modules/pdf-underlay/pdf-underlay";
import {
  initWorksets, createWorkset, listWorksets, getWorkset, renameWorkset,
  deleteWorkset, assignToWorkset, getWorksetForElement, borrowElement,
  releaseElement, canEdit, setVisibility, isVisible, getWorksetSummary,
  resetWorksets, setCurrentUser,
} from "../modules/worksets/worksets";

// ── Crop Region + Section Box (interactive view crops) ───────────────────
import {
  getCropRegion, setCropRegion, setCropEnabled, toggleCrop, resetCropRegion,
  pointInCrop, setActiveView, clearActiveView, getActiveCropView, listCropRegions,
  deleteCropRegion, resetCropRegions,
} from "../features/crop-region";
import {
  toggleSectionBox, enableSectionBox, disableSectionBox, resetSectionBox,
  isSectionBoxActive, growSectionBox, moveSectionBox,
} from "../features/section-box";
import {
  showSelectionBox, cropToSelection, zoomToSelection,
  isolateSelection, resetIsolation,
  getSelectionWorldBox, getSelectionViewBbox, computeElementsBbox,
} from "../features/selection-box";


function toast(msg: string, kind: "info" | "warn" | "success" = "info") {
  // The legacy notify window-globals never had a producer (and this called
  // them with the arguments swapped anyway), so toasts went to console.log only.
  coreNotify(kind, msg);
}

function addObject(obj: THREE.Object3D, kind: string) {
  try {
    const world = (ctx as any).world;
    if (world?.scene?.three) world.scene.three.add(obj);
    toast(`${kind} added to scene`, "success");
  } catch (e) {
    toast(`Could not add ${kind}: ${(e as Error).message}`, "warn");
  }
}

function filePicker(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

// ── Toposurface ──────────────────────────────────────────────────────────
(ctx.features as any).toposurface = {
  build: (p: ToposurfaceParams) => {
    const r = buildToposurface(p);
    addObject(r.object, `Toposurface (${r.triangleCount} tris, ${r.area.toFixed(1)} m²)`);
    return r;
  },
  cutFill: cutFillVolume,
};

// ── Building Pad ─────────────────────────────────────────────────────────
(ctx.features as any).buildingPad = {
  build: (p: BuildingPadParams) => {
    const r = buildBuildingPad(p);
    addObject(r.object, `Building Pad (${r.floorArea.toFixed(1)} m², cut ${r.cutVolume.toFixed(1)} m³, fill ${r.fillVolume.toFixed(1)} m³)`);
    return r;
  },
};

// ── Property Line ────────────────────────────────────────────────────────
(ctx.features as any).propertyLine = {
  build: (p: PropertyLineParams) => {
    const r = buildPropertyLine(p);
    addObject(r.object, `Property Line (${r.perimeter.toFixed(1)} m, area ${r.area.toFixed(1)} m², closure error ${r.closureError.toFixed(3)} m)`);
    return r;
  },
};

// ── Site Components ──────────────────────────────────────────────────────
(ctx.features as any).siteComponent = {
  build: (p: SiteComponentParams) => {
    const r = buildSiteComponent(p);
    addObject(r.object, `Site ${p.type}`);
    return r;
  },
  defaultSize, defaultColor,
};

// ── Ramp ─────────────────────────────────────────────────────────────────
// Ramp had one window-global stash with no consumer anywhere in the repo
// — an unreachable feature, same as the point cloud. It is now a typed
// palette command with the same build flow (default parameters).
void servicesReady("commandPalette").then((palette) => {
  try {
    palette.register({
      id: "model.ramp",
      label: "Model: Build Ramp\u2026",
      category: "Model",
      hint: "ramp, slope, accessibility",
      run: () => {
        const r = buildRamp({});
        addObject(r.object, `Ramp (${r.slopePercent.toFixed(1)}%, ${r.area.toFixed(1)} m²)`);
      },
    });
  } catch { /* */ }
});

// ── Truss ─────────────────────────────────────────────────────────────────
(ctx.features as any).truss = {
  build: (p: Partial<TrussParams>) => {
    const r = buildTruss(p);
    addObject(r.object, `Truss ${p.type ?? "pratt"} (${r.members.length} members, ${r.totalSteelLength.toFixed(1)} m total)`);
    return r;
  },
};

// ── Structural Connection ─────────────────────────────────────────────────
(ctx.features as any).structuralConnection = {
  build: (p: Partial<ConnectionParams>) => {
    const r = buildStructuralConnection(p);
    addObject(r.object, `Connection ${p.type} (${r.plateCount} plates, ${r.boltCount} bolts)`);
    return r;
  },
};

// ── Fabrication Parts ─────────────────────────────────────────────────────
(ctx.features as any).fabricationPart = {
  build: (p: Partial<FabPartParams>) => {
    const r = buildFabricationPart(p);
    addObject(r.object, `Fab ${p.type} [${r.astmCode}] ${r.weightKg.toFixed(2)} kg`);
    return r;
  },
  getAstmCode,
};

// ── Scope Box ─────────────────────────────────────────────────────────────
(ctx.features as any).scopeBox = {
  create: createScopeBox, list: listScopeBoxes, get: getScopeBox,
  delete: deleteScopeBox, update: updateScopeBox,
  applyToView, removeFromView,
};

// ── Scope Box Visualizer (3D handles + drag-to-resize) ───────────────────
(ctx.features as any).scopeBoxViz = {
  enable: () => { enableScopeBoxVisualizer(); toast("Scope Box visualizer ON — drag handles to resize", "success"); },
  disable: () => { disableScopeBoxVisualizer(); toast("Scope Box visualizer OFF", "info"); },
  toggle: () => {
    const on = toggleScopeBoxVisualizer();
    toast(on ? "Scope Box visualizer ON" : "Scope Box visualizer OFF", "success");
    return on;
  },
  refresh: refreshScopeBoxVisualizer,
  isEnabled: isScopeBoxVisualizerEnabled,
};

// ── View Filters ──────────────────────────────────────────────────────────
// View filters, generative design and the PDF underlay used to be
// window-globals; their only consumers are ribbon buttons, which already
// read feature APIs off ctx — so these now live on ctx.features.
(ctx.features as any).viewFilters = {
  create: createViewFilter, list: listViewFilters, get: getViewFilter,
  delete: deleteViewFilter, addFilterToView, removeFilterFromView,
  toggleFilterInView, matchesFilter, resolveOverride,
};

// ── Matchline ─────────────────────────────────────────────────────────────
(ctx.features as any).matchline = {
  build: (p: any) => {
    const r = buildMatchline(p);
    addObject(r.object, `Matchline (${r.length.toFixed(1)} m)`);
    return r;
  },
};

// ── Plan Region ───────────────────────────────────────────────────────────
(ctx.features as any).planRegion = {
  build: buildPlanRegion, pointIn: pointInRegion, resolveCutPlane,
};

// ── Dependent Views ───────────────────────────────────────────────────────
(ctx.features as any).dependentViews = {
  create: createDependentView, list: listDependents, get: getDependentView,
  updateCrop: updateCropRegion, delete: deleteDependentView,
};

// ── Model Checker ─────────────────────────────────────────────────────────
(ctx.features as any).modelChecker = {
  run: (elements: ModelElement[], config?: ModelCheckerConfig) => {
    const report = runModelChecker(elements, config);
    toast(`Model Checker: ${report.summary.errors} errors, ${report.summary.warnings} warnings (${report.durationMs} ms)`, report.summary.errors ? "warn" : "success");
    return report;
  },
  listRules: listShippedRules,
};

// ── Daylighting ───────────────────────────────────────────────────────────
(ctx.features as any).daylighting = {
  run: (p: Partial<DaylightAnalysisParams>) => {
    const r = runDaylightAnalysis(p);
    toast(`Daylighting: avg DF ${r.averageDF.toFixed(2)}% (${classifyDF(r.averageDF)}), sDA ${r.sDA.toFixed(2)}, ASE ${r.ASE.toFixed(2)}`, "success");
    return r;
  },
  classify: classifyDF,
};

// ── Structural Loads ───────────────────────────────────────────────────────
(ctx.features as any).structuralLoads = {
  createCase: createLoadCase, listCases: listLoadCases, deleteCase: deleteLoadCase,
  createCombination: createLoadCombination, listCombinations: listLoadCombinations,
  resolveCombination, generateDefaultLRFDCombinations, generateDefaultASDCombinations,
};

// ── Generative Design ─────────────────────────────────────────────────────
(ctx.features as any).generativeDesign = {
  run: (config: StudyConfig) => {
    const r = runStudy(config);
    toast(`Generative study complete: ${r.paretoFront.length} Pareto-optimal solutions, ${r.evaluated} evaluations`, "success");
    return r;
  },
};

// ── Point Cloud ───────────────────────────────────────────────────────────
// Point clouds had one window-global stash with no consumer anywhere in
// the repo — the feature was unreachable. It now lives where users find
// tools: a typed palette command (same load flow as the old stash).
async function loadPointCloudInteractive(options?: PointCloudLoadOptions) {
  const file = await filePicker(".e57,.las,.laz,.pcd,.ply");
  if (!file) { toast("No file selected", "warn"); return null; }
  const r = await loadPointCloud(file, options ?? {});
  addObject(r.points, `Point cloud (${r.actualPoints.toLocaleString()} pts, ${r.header.format})`);
  return r;
}
void servicesReady("commandPalette").then((palette) => {
  try {
    palette.register({
      id: "insert.pointCloud",
      label: "Point Cloud: Load\u2026",
      category: "Insert",
      hint: "point cloud, e57, las, laz, pcd, ply, scan",
      run: () => { void loadPointCloudInteractive(); },
    });
  } catch { /* */ }
});

// ── PDF Underlay ──────────────────────────────────────────────────────────
(ctx.features as any).pdfUnderlay = {
  load: async (params?: Partial<PdfUnderlayParams>) => {
    const file = await filePicker(".pdf");
    if (!file) { toast("No file selected", "warn"); return null; }
    const r = await loadPdfUnderlay({ file, ...params });
    addObject(r.object, `PDF page ${params?.page ?? 1} (${r.pageCount} pages, ${r.rasterSize.width}×${r.rasterSize.height}px)`);
    return r;
  },
};

// ── Worksets ───────────────────────────────────────────────────────────────
(ctx.features as any).worksets = {
  init: () => { initWorksets(); toast("Worksets initialised (default worksets created)", "success"); },
  list: listWorksets,
  create: (name: string) => {
    const ws = createWorkset(name);
    toast(`Workset "${name}" created`, "success");
    return ws;
  },
  rename: renameWorkset,
  delete: deleteWorkset,
  assign: assignToWorkset,
  borrow: (elId: number) => {
    const ok = borrowElement(elId);
    toast(ok ? `Borrowed element ${elId}` : `Cannot borrow element ${elId}`, ok ? "success" : "warn");
    return ok;
  },
  release: releaseElement,
  canEdit,
  setVisibility,
  isVisible,
  summary: getWorksetSummary,
};

// ── Crop Region (2D plan/section/elevation crop with handles) ─────────────
(ctx.features as any).cropRegion = {
  get: getCropRegion,
  set: (viewId: string, region: any) => {
    setCropRegion(viewId, region);
    toast(`Crop region set for view "${viewId}"`, "success");
  },
  toggle: (viewId: string) => {
    const on = toggleCrop(viewId);
    toast(on ? `Crop ON for view "${viewId}"` : `Crop OFF for view "${viewId}"`, "success");
    return on;
  },
  reset: (viewId: string) => {
    resetCropRegion(viewId);
    toast(`Crop region reset to 100×100 m default`, "info");
  },
  setActive: setActiveView,
  clearActive: clearActiveView,
  // G9: which view the crop buttons should follow (the plan marks itself
  // active when it opens; null until any view does).
  getActive: getActiveCropView,
  list: listCropRegions,
  pointIn: pointInCrop,
};

// ── Section Box (interactive 6-face handles) ─────────────────────────────
(ctx.features as any).sectionBox = {
  // Merge over setupSectionBox's engine api (debugPlanes/getBox/setBox and
  // friends) - replacing it drops those methods and breaks the section-box
  // e2e; these toast-ified helpers are the ribbon-facing surface.
  ...(((ctx.features as any).sectionBox ?? {}) as Record<string, unknown>),
  toggle: () => {
    const on = toggleSectionBox();
    toast(on ? "Section Box ON — drag the cyan arrows on each face to stretch / shrink" : "Section Box OFF", "success");
    return on;
  },
  enable: (padding = 1.0) => enableSectionBox(padding),
  disable: () => disableSectionBox(),
  reset: () => { resetSectionBox(); toast("Section Box reset to model bounds", "info"); },
  isActive: isSectionBoxActive,
  grow: (m = 0.5) => {
    growSectionBox(m);
    toast(`Section Box grew by ${m} m on all sides`, "info");
  },
  shrink: (m = 0.5) => {
    growSectionBox(-m);
    toast(`Section Box shrank by ${m} m on all sides`, "info");
  },
  move: (x: number, y: number, z: number) => {
    moveSectionBox(new THREE.Vector3(x, y, z));
    toast(`Section Box moved to (${x}, ${y}, ${z})`, "info");
  },
};

// ── Selection Box — auto-fit section box / crop region to selection ──────
(ctx.features as any).selectionBox = {
  show: (opts?: any) => showSelectionBox(opts ?? { padding: 0.5 }),
  cropTo: (opts?: any) => cropToSelection(opts ?? { padding: 1.0 }),
  zoom: () => zoomToSelection(),
  isolate: () => isolateSelection(),
  resetIsolation: () => resetIsolation(),
  getBbox: () => {
    const b = getSelectionWorldBox();
    if (!b) return null;
    return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } };
  },
  getViewBbox: () => getSelectionViewBbox(),
  computeBboxFor: (ids: string[]) => {
    const b = computeElementsBbox(ids);
    if (!b) return null;
    return { min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } };
  },
};

console.log("[obs] module feature APIs registered on ctx.features (+ palette commands: point cloud, ramp)");
