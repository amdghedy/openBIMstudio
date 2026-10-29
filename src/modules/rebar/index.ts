/**
 * Rebar module — public barrel + boot wiring.
 *
 * Imports the layout + geometry functions, registers a typed service
 * in the host's ServiceMap, and exposes a `__obsRebar` global for
 * console access.
 */

import { layoutRebar as layoutImpl } from "./layout";
import { generateRebarMesh as meshImpl, generateBarMesh } from "./geometry";
import { generateBBS, bbsToCSV, bbsToJSON, bbsToText, bbsToExcel, generateQuantityTakeoff } from "./schedule";
import { detectRebarClashes, clashReportToCSV, clashReportToHTML, type ClashReport } from "./clash-detection";
import { detectLapSplices, renderLapSpliceOverlay, type LapSpliceResult } from "./lap-splice";
import { REBAR_STANDARDS, type StandardCode, type RebarStandard } from "./standards";
import type { RebarLayout, RebarLayoutConfig, RebarHost, RebarBar } from "./types";
import { registerCommand } from "../../features/command-palette";

export * from "./types";
export { layoutRebar, layoutBeamRebar, layoutColumnRebar } from "./layout";
export { generateRebarMesh, generateBarMesh } from "./geometry";
export { generateBBS, bbsToCSV, bbsToJSON, bbsToText, bbsToExcel, generateQuantityTakeoff } from "./schedule";
export * from "./shapes";
export * from "./standards";
export * from "./clash-detection";
export * from "./lap-splice";

/** Public Rebar service interface. */
export interface RebarService {
  /** Compute a rebar layout for a host element. */
  layout(cfg: Partial<RebarLayoutConfig>): RebarLayout;
  /** Generate 3D mesh for a rebar layout. */
  generateMesh(bars: RebarLayout["bars"], segments?: number, color?: string): ReturnType<typeof meshImpl>;
  /** Generate a Bar Bending Schedule from a layout. */
  generateBBS(layout: RebarLayout, elementName?: string): ReturnType<typeof generateBBS>;
  /** Detect rebar collisions and clearance problems. */
  detectClashes(bars: RebarBar[], minClearance?: number, standard?: StandardCode): ClashReport;
  /** Check lap splice lengths against design standards. */
  detectLapSplices(bars: RebarBar[], standard?: StandardCode, fck?: number): LapSpliceResult[];
  /** Standards database. */
  standards: Record<StandardCode, RebarStandard>;
}

let installed = false;

export function setupRebar(): RebarService {
  if (installed) return (window as any).__obsRebar as RebarService;
  installed = true;

  const svc: RebarService = {
    layout: layoutImpl,
    generateMesh: meshImpl,
    generateBBS: generateBBS,
    detectClashes: detectRebarClashes,
    detectLapSplices: detectLapSplices,
    standards: REBAR_STANDARDS,
  };

  try {
    (window as any).__obsRebar = svc;
  } catch {
    /* ignore */
  }

  // Register commands in ribbon/palette
  try {
    registerCommand({
      id: "rebar.clashReview",
      label: "Rebar — Clash Review & Clearances",
      category: "Structural",
      run: () => import("../../features/rebar-clash-review").then((m) => m.openRebarClashReview()),
    });
    registerCommand({
      id: "rebar.standards",
      label: "Rebar — International Standards & Codes",
      category: "Structural",
      run: () => import("../../features/rebar-clash-review").then((m) => m.openRebarStandardsDialog()),
    });
  } catch {
    /* command-palette not yet loaded */
  }

  console.log("[rebar] ready. Shape library + layout engine + standards + clash detector online.");

  return svc;
}

/** True after setupRebar() has run. */
export function isRebarReady(): boolean {
  return installed;
}
