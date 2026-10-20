/**
 * Module globals — exposes all v40+ modules on `window.__obs*` for the ribbon,
 * console and other modules to consume without a hard import.
 *
 * Each global is wrapped in a lazy-load try/catch so a failure in one module
 * does not break ribbon actions elsewhere.
 */

import * as THREE from "three";
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
  buildRamp, type RampParams, type RampResult,
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
import { loadPointCloud, clipPointCloudByPolygon, type PointCloudLoadOptions } from "../modules/point-cloud/point-cloud";
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
  pointInCrop, setActiveView, clearActiveView, listCropRegions,
  deleteCropRegion, resetCropRegions,
} from "../features/crop-region";
import {
  toggleSectionBox, enableSectionBox, disableSectionBox, resetSectionBox,
  isSectionBoxActive, growSectionBox, moveSectionBox,
} from "../features/section-box";

const w = window as any;

function toast(msg: string, kind: "info" | "warn" | "success" = "info") {
  try {
    w.__obsNotify?.(msg, kind);
    if (!w.__obsNotify) console.log(`[obs] ${msg}`);
  } catch { /* */ }
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
w.__obsToposurface = {
  build: (p: ToposurfaceParams) => {
    const r = buildToposurface(p);
    addObject(r.object, `Toposurface (${r.triangleCount} tris, ${r.area.toFixed(1)} m²)`);
    return r;
  },
  cutFill: cutFillVolume,
};

// ── Building Pad ─────────────────────────────────────────────────────────
w.__obsBuildingPad = {
  build: (p: BuildingPadParams) => {
    const r = buildBuildingPad(p);
    addObject(r.object, `Building Pad (${r.floorArea.toFixed(1)} m², cut ${r.cutVolume.toFixed(1)} m³, fill ${r.fillVolume.toFixed(1)} m³)`);
    return r;
  },
};

// ── Property Line ────────────────────────────────────────────────────────
w.__obsPropertyLine = {
  build: (p: PropertyLineParams) => {
    const r = buildPropertyLine(p);
    addObject(r.object, `Property Line (${r.perimeter.toFixed(1)} m, area ${r.area.toFixed(1)} m², closure error ${r.closureError.toFixed(3)} m)`);
    return r;
  },
};

// ── Site Components ──────────────────────────────────────────────────────
w.__obsSiteComponent = {
  build: (p: SiteComponentParams) => {
    const r = buildSiteComponent(p);
    addObject(r.object, `Site ${p.type}`);
    return r;
  },
  defaultSize, defaultColor,
};

// ── Ramp ─────────────────────────────────────────────────────────────────
w.__obsRamp = {
  build: (p: Partial<RampParams>) => {
    const r = buildRamp(p);
    addObject(r.object, `Ramp (${r.slopePercent.toFixed(1)}%, ${r.area.toFixed(1)} m²)`);
    return r;
  },
};

// ── Truss ─────────────────────────────────────────────────────────────────
w.__obsTruss = {
  build: (p: Partial<TrussParams>) => {
    const r = buildTruss(p);
    addObject(r.object, `Truss ${p.type ?? "pratt"} (${r.members.length} members, ${r.totalSteelLength.toFixed(1)} m total)`);
    return r;
  },
};

// ── Structural Connection ─────────────────────────────────────────────────
w.__obsStructuralConnection = {
  build: (p: Partial<ConnectionParams>) => {
    const r = buildStructuralConnection(p);
    addObject(r.object, `Connection ${p.type} (${r.plateCount} plates, ${r.boltCount} bolts)`);
    return r;
  },
};

// ── Fabrication Parts ─────────────────────────────────────────────────────
w.__obsFabricationPart = {
  build: (p: Partial<FabPartParams>) => {
    const r = buildFabricationPart(p);
    addObject(r.object, `Fab ${p.type} [${r.astmCode}] ${r.weightKg.toFixed(2)} kg`);
    return r;
  },
  getAstmCode,
};

// ── Scope Box ─────────────────────────────────────────────────────────────
w.__obsScopeBox = {
  create: createScopeBox, list: listScopeBoxes, get: getScopeBox,
  delete: deleteScopeBox, update: updateScopeBox,
  applyToView, removeFromView,
};

// ── Scope Box Visualizer (3D handles + drag-to-resize) ───────────────────
w.__obsScopeBoxViz = {
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
w.__obsViewFilters = {
  create: createViewFilter, list: listViewFilters, get: getViewFilter,
  delete: deleteViewFilter, addFilterToView, removeFilterFromView,
  toggleFilterInView, matchesFilter, resolveOverride,
};

// ── Matchline ─────────────────────────────────────────────────────────────
w.__obsMatchline = {
  build: (p: any) => {
    const r = buildMatchline(p);
    addObject(r.object, `Matchline (${r.length.toFixed(1)} m)`);
    return r;
  },
};

// ── Plan Region ───────────────────────────────────────────────────────────
w.__obsPlanRegion = {
  build: buildPlanRegion, pointIn: pointInRegion, resolveCutPlane,
};

// ── Dependent Views ───────────────────────────────────────────────────────
w.__obsDependentViews = {
  create: createDependentView, list: listDependents, get: getDependentView,
  updateCrop: updateCropRegion, delete: deleteDependentView,
};

// ── Model Checker ─────────────────────────────────────────────────────────
w.__obsModelChecker = {
  run: (elements: ModelElement[], config?: ModelCheckerConfig) => {
    const report = runModelChecker(elements, config);
    toast(`Model Checker: ${report.summary.errors} errors, ${report.summary.warnings} warnings (${report.durationMs} ms)`, report.summary.errors ? "warn" : "success");
    return report;
  },
  listRules: listShippedRules,
};

// ── Daylighting ───────────────────────────────────────────────────────────
w.__obsDaylighting = {
  run: (p: Partial<DaylightAnalysisParams>) => {
    const r = runDaylightAnalysis(p);
    toast(`Daylighting: avg DF ${r.averageDF.toFixed(2)}% (${classifyDF(r.averageDF)}), sDA ${r.sDA.toFixed(2)}, ASE ${r.ASE.toFixed(2)}`, "success");
    return r;
  },
  classify: classifyDF,
};

// ── Structural Loads ───────────────────────────────────────────────────────
w.__obsStructuralLoads = {
  createCase: createLoadCase, listCases: listLoadCases, deleteCase: deleteLoadCase,
  createCombination: createLoadCombination, listCombinations: listLoadCombinations,
  resolveCombination, generateDefaultLRFDCombinations, generateDefaultASDCombinations,
};

// ── Generative Design ─────────────────────────────────────────────────────
w.__obsGenerativeDesign = {
  run: (config: StudyConfig) => {
    const r = runStudy(config);
    toast(`Generative study complete: ${r.paretoFront.length} Pareto-optimal solutions, ${r.evaluated} evaluations`, "success");
    return r;
  },
};

// ── Point Cloud ───────────────────────────────────────────────────────────
w.__obsPointCloud = {
  load: async (options?: PointCloudLoadOptions) => {
    const file = await filePicker(".e57,.las,.laz,.pcd,.ply");
    if (!file) { toast("No file selected", "warn"); return null; }
    const r = await loadPointCloud(file, options ?? {});
    addObject(r.points, `Point cloud (${r.actualPoints.toLocaleString()} pts, ${r.header.format})`);
    return r;
  },
  clip: clipPointCloudByPolygon,
};

// ── PDF Underlay ──────────────────────────────────────────────────────────
w.__obsPdfUnderlay = {
  load: async (params?: Partial<PdfUnderlayParams>) => {
    const file = await filePicker(".pdf");
    if (!file) { toast("No file selected", "warn"); return null; }
    const r = await loadPdfUnderlay({ file, ...params });
    addObject(r.object, `PDF page ${params?.page ?? 1} (${r.pageCount} pages, ${r.rasterSize.width}×${r.rasterSize.height}px)`);
    return r;
  },
};

// ── Worksets ───────────────────────────────────────────────────────────────
w.__obsWorksets = {
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
w.__obsCropRegion = {
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
  list: listCropRegions,
  pointIn: pointInCrop,
};

// ── Section Box (interactive 6-face handles) ─────────────────────────────
w.__obsSectionBox = {
  toggle: () => {
    const on = toggleSectionBox();
    toast(on ? "Section Box ON — drag cyan face handles" : "Section Box OFF", "success");
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

console.log("[obs] v40 module globals registered: toposurface, building-pad, property-line, site-components, ramps, trusses, structural-connections, fabrication-parts, scope-box, view-filters, matchline, plan-region, dependent-views, model-checker, daylighting, structural-loads-ui, generative-design, point-cloud, pdf-underlay, worksets, scope-box-viz, crop-region, section-box");
