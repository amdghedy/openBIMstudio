/**
 * Plan dock layout — Revit 2D environment audit gap G12 (a).
 *
 * The plan view is a separate SVG projection regenerated from the model, NOT
 * a live view of the Three.js scene. This module does not change that: it
 * only decides WHERE the plan panel sits and how much of the screen the 3D
 * viewport keeps, so the plan can stay open beside 3D instead of only as a
 * full-width modal overlay.
 *
 * Pure, DOM-free geometry: given the viewport size and the ribbon height it
 * returns the overlay rectangle and the margins the 3D viewport host
 * (`#viewport`) must reserve, so the 3D canvas is resized to share the
 * screen instead of being covered by the panel. The panel
 * (src/features/plan-view-panel.ts) applies the numbers; it owns the DOM.
 *
 * Modes:
 *   modal         — full-width overlay under the ribbon (the pre-G12
 *                   behaviour); the 3D viewport keeps no margin and the
 *                   renderer is paused while the plan covers it.
 *   docked-right  — plan pinned to the right edge; the 3D viewport keeps a
 *                   right margin equal to the panel width.
 *   docked-bottom — plan pinned to the bottom edge; the 3D viewport keeps a
 *                   bottom margin equal to the panel height.
 *
 * Tiled views (Revit WT) remain out of reach: there is no multi-view window
 * system, so exactly one plan panel exists and it never tiles with other
 * views.
 */

export type PlanDockMode = "modal" | "docked-right" | "docked-bottom";

export const PLAN_DOCK_MODES: readonly PlanDockMode[] = [
  "modal",
  "docked-right",
  "docked-bottom",
];

/** Default docked-right panel width (px). */
export const PLAN_DOCK_DEFAULT_WIDTH_PX = 560;
/** Narrowest usable docked-right panel (px) — the Properties column is 280 px. */
export const PLAN_DOCK_MIN_WIDTH_PX = 320;
/** Widest docked-right panel as a fraction of the viewport width. */
export const PLAN_DOCK_MAX_WIDTH_FRACTION = 0.5;
/** Default docked-bottom panel height as a fraction of the viewport height. */
export const PLAN_DOCK_DEFAULT_HEIGHT_FRACTION = 0.45;
/** Shortest usable docked-bottom panel (px). */
export const PLAN_DOCK_MIN_HEIGHT_PX = 240;
/** Tallest docked-bottom panel as a fraction of the viewport height. */
export const PLAN_DOCK_MAX_HEIGHT_FRACTION = 0.6;

/** localStorage key for the persisted dock mode. */
export const PLAN_DOCK_MODE_KEY = "obs.bim.plan-dock-mode.v1";

export function isPlanDockMode(value: unknown): value is PlanDockMode {
  return (
    value === "modal" || value === "docked-right" || value === "docked-bottom"
  );
}

/** Unknown / absent stored values fall back to the modal overlay. */
export function parsePlanDockMode(value: unknown): PlanDockMode {
  return isPlanDockMode(value) ? value : "modal";
}

/**
 * The Dock button toggles between the modal overlay and the docked panel.
 * Docking always lands on the right side; the side button switches sides.
 */
export function togglePlanDockMode(mode: PlanDockMode): PlanDockMode {
  return mode === "modal" ? "docked-right" : "modal";
}

/**
 * The side button switches a docked panel between right and bottom. A modal
 * panel has no side, so it is returned unchanged.
 */
export function togglePlanDockSide(mode: PlanDockMode): PlanDockMode {
  if (mode === "docked-right") return "docked-bottom";
  if (mode === "docked-bottom") return "docked-right";
  return mode;
}

/** Human label for the Dock button in a given mode. */
export function planDockToggleLabel(mode: PlanDockMode): string {
  return mode === "modal" ? "Dock" : "Undock";
}

/** Human label for the side button in a given mode (the side it switches to). */
export function planDockSideLabel(mode: PlanDockMode): string {
  if (mode === "docked-right") return "Bottom";
  if (mode === "docked-bottom") return "Right";
  return "Right";
}

export function clampPlanDockWidth(
  requestedPx: number,
  viewportWidthPx: number,
): number {
  const max = Math.max(
    PLAN_DOCK_MIN_WIDTH_PX,
    Math.floor(viewportWidthPx * PLAN_DOCK_MAX_WIDTH_FRACTION),
  );
  const wanted = Number.isFinite(requestedPx)
    ? requestedPx
    : PLAN_DOCK_DEFAULT_WIDTH_PX;
  return Math.max(PLAN_DOCK_MIN_WIDTH_PX, Math.min(wanted, max));
}

export function clampPlanDockHeight(
  requestedPx: number,
  viewportHeightPx: number,
): number {
  const max = Math.max(
    PLAN_DOCK_MIN_HEIGHT_PX,
    Math.floor(viewportHeightPx * PLAN_DOCK_MAX_HEIGHT_FRACTION),
  );
  const wanted = Number.isFinite(requestedPx)
    ? requestedPx
    : Math.floor(viewportHeightPx * PLAN_DOCK_DEFAULT_HEIGHT_FRACTION);
  return Math.max(PLAN_DOCK_MIN_HEIGHT_PX, Math.min(wanted, max));
}

export interface PlanDockGeometry {
  /**
   * Overlay rectangle in viewport pixels. `null` means "stretch to that
   * edge" (the panel's CSS leaves that side unset). Exactly one of
   * left/width is null in every mode, and top is always set except for
   * docked-bottom, where the panel is anchored to the bottom edge.
   */
  overlay: {
    left: number | null;
    right: number | null;
    top: number | null;
    bottom: number | null;
    width: number | null;
    height: number | null;
  };
  /** Margins the 3D viewport host (`#viewport`) must reserve, in pixels. */
  viewportMargin: { right: number; bottom: number };
  /** Effective panel width (docked-right) or height (docked-bottom), else 0. */
  dockSizePx: number;
}

export function computePlanDockLayout(
  mode: PlanDockMode,
  viewport: { width: number; height: number },
  ribbonHeightPx: number,
  dockWidthPx: number = PLAN_DOCK_DEFAULT_WIDTH_PX,
  dockHeightPx?: number,
): PlanDockGeometry {
  const top = Math.max(28, Math.round(ribbonHeightPx));
  if (mode === "docked-right") {
    const width = clampPlanDockWidth(dockWidthPx, viewport.width);
    return {
      overlay: { left: null, right: 0, top, bottom: 0, width, height: null },
      viewportMargin: { right: width, bottom: 0 },
      dockSizePx: width,
    };
  }
  if (mode === "docked-bottom") {
    const height = clampPlanDockHeight(
      dockHeightPx ?? Math.floor(viewport.height * PLAN_DOCK_DEFAULT_HEIGHT_FRACTION),
      viewport.height,
    );
    return {
      overlay: { left: 0, right: 0, top: null, bottom: 0, width: null, height },
      viewportMargin: { right: 0, bottom: height },
      dockSizePx: height,
    };
  }
  return {
    overlay: { left: 0, right: 0, top, bottom: 0, width: null, height: null },
    viewportMargin: { right: 0, bottom: 0 },
    dockSizePx: 0,
  };
}
