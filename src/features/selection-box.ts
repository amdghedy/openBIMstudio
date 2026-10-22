/**
 * Selection Box — auto-fit section box / crop region to selected elements.
 *
 * BIM-equivalent of Revit's right-click → "Show Selection Box" command
 * (wraps a section box tightly around the selected element(s)) and the
 * "Crop to Selection" command (auto-sizes a 2D crop region in the active
 * plan/section/elevation view to fit the selected elements).
 *
 * Both functions accept either a list of element IDs (string[]) or, if
 * omitted, fall back to the current authoring selection.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { getElementById, getElementWorldBox, getSelectedIds } from "./authoring";
import {
  enableSectionBox, disableSectionBox, isSectionBoxActive, growSectionBox, enableSectionBoxWithBox,
} from "./section-box";
import { getCropRegion, setCropRegion, setActiveView } from "./crop-region";
import { fitAll, focusOnBox } from "./camera-tools";

export interface SelectionBoxOptions {
  /** Padding (m) added around the selection's bbox on all sides. */
  padding?: number;
  /** Disable the box after creating it (default: keep enabled). */
  disable?: boolean;
  /** Also fit the camera to the new box (default: true). */
  fitCamera?: boolean;
}

export interface CropToSelectionOptions {
  /** Padding (m) added around the selection's 2D bbox on all sides. */
  padding?: number;
  /** View ID to apply the crop to (default: "plan-view-1"). */
  viewId?: string;
  /** Activate the crop region after creating it (default: true). */
  enable?: boolean;
  /** Also fit the plan view to the new crop region (default: false). */
  fit?: boolean;
}

/** Compute the world-space bounding box of a set of elements. */
export function getSelectionWorldBox(elementIds?: string[]): THREE.Box3 | null {
  const ids = elementIds ?? getSelectedIds();
  if (!ids.length) return null;
  const box = new THREE.Box3();
  let hasAny = false;
  for (const id of ids) {
    const el = getElementById(id);
    if (!el) continue;
    const elBox = getElementWorldBox(el);
    if (!elBox) continue;
    box.union(elBox);
    hasAny = true;
  }
  return hasAny && !box.isEmpty() ? box : null;
}

/** Compute the XZ-plane 2D bounding box of a set of elements (for plan view crop). */
export function getSelectionViewBbox(elementIds?: string[]): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
  const box = getSelectionWorldBox(elementIds);
  if (!box) return null;
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minZ: box.min.z,
    maxZ: box.max.z,
  };
}

/**
 * Show Selection Box — wrap a 3D section box tightly around the selected
 * elements. If section box was already on, it is resized to the new
 * selection; if it was off, it is enabled.
 *
 * BIM equivalent: right-click selected element → "Show Selection Box".
 */
export function showSelectionBox(options: SelectionBoxOptions = {}): boolean {
  const padding = options.padding ?? 0.5;
  const box = getSelectionWorldBox();
  if (!box) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Select at least one element first.", kind: "warn" },
    }));
    return false;
  }
  // Apply padding on all sides.
  box.expandByScalar(padding);
  // Works with or without loaded fragment models (authored elements only).
  enableSectionBoxWithBox(box);
  if (options.fitCamera !== false) {
    // Frame the selection box itself (not the whole scene).
    focusOnBox(box);
  }
  if (options.disable) disableSectionBox();
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: {
      message: `Selection Box ON — ${(box.max.x - box.min.x).toFixed(2)}×${(box.max.y - box.min.y).toFixed(2)}×${(box.max.z - box.min.z).toFixed(2)} m (incl. ${padding} m padding)`,
      kind: "success",
    },
  }));
  return true;
}

/**
 * Crop to Selection — auto-fit the 2D crop region of the active plan/section
 * view to the bounding box of the selected elements.
 *
 * BIM equivalent: View → Crop Region → "Crop to Selection".
 */
export function cropToSelection(options: CropToSelectionOptions = {}): boolean {
  const padding = options.padding ?? 1.0;
  const viewId = options.viewId ?? "plan-view-1";
  const bbox = getSelectionViewBbox();
  if (!bbox) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Select at least one element first.", kind: "warn" },
    }));
    return false;
  }
  const region = {
    minX: bbox.minX - padding,
    maxX: bbox.maxX + padding,
    minY: bbox.minZ - padding,
    maxY: bbox.maxZ + padding,
    rotation: 0,
    enabled: options.enable !== false,
  };
  setCropRegion(viewId, region);
  setActiveView(viewId);
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: {
      message: `Crop region fit to selection — ${(bbox.maxX - bbox.minX + 2 * padding).toFixed(1)}×${(bbox.maxZ - bbox.minZ + 2 * padding).toFixed(1)} m`,
      kind: "success",
    },
  }));
  return true;
}

/**
 * Zoom to Selection — fit the camera frustum to the selected elements
 * without affecting the section box or crop region.
 *
 * BIM equivalent: right-click → "Zoom to Fit" / "Frame Selected".
 */
export function zoomToSelection(): boolean {
  const box = getSelectionWorldBox();
  if (!box) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Select at least one element first.", kind: "warn" },
    }));
    return false;
  }
  focusOnBox(box);
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: "Zoomed to selection", kind: "info" },
  }));
  return true;
}

/**
 * Isolate Selection — hide everything except the selected elements.
 *
 * BIM equivalent: right-click → "Isolate".
 */
export function isolateSelection(): boolean {
  const ids = getSelectedIds();
  if (!ids.length) {
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: "Select at least one element first.", kind: "warn" },
    }));
    return false;
  }
  // Prefer the app's single temporary-visibility mechanism so Reset works everywhere.
  const vis = (ctx.features as any).visibility;
  if (typeof vis?.isolateSelection === "function") {
    const n = vis.isolateSelection();
    window.dispatchEvent(new CustomEvent("obs-toast", {
      detail: { message: `Isolated ${ids.length} element(s)`, kind: "success" },
    }));
    void n;
    return true;
  }
  const elements = (ctx as any).elements ?? [];
  let hiddenCount = 0;
  for (const el of elements) {
    if (!ids.includes(String(el.id))) {
      const mesh = (ctx as any).__obsGetElementMesh?.(el.id) ?? el.mesh;
      if (mesh) {
        mesh.visible = false;
        hiddenCount++;
      }
    }
  }
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: `Isolated ${ids.length} element(s), hid ${hiddenCount}`, kind: "success" },
  }));
  return true;
}

/**
 * Reset Isolation — show all hidden elements again.
 */
export function resetIsolation(): void {
  const vis = (ctx.features as any).visibility;
  if (typeof vis?.reset === "function") {
    vis.reset();
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: "Isolation reset", kind: "info" } }));
    return;
  }
  const elements = (ctx as any).elements ?? [];
  let shown = 0;
  for (const el of elements) {
    const mesh = (ctx as any).__obsGetElementMesh?.(el.id) ?? el.mesh;
    if (mesh && !mesh.visible) {
      mesh.visible = true;
      shown++;
    }
  }
  window.dispatchEvent(new CustomEvent("obs-toast", {
    detail: { message: `Restored ${shown} hidden element(s)`, kind: "info" },
  }));
}

/** Compute combined bbox of N authored elements — exposed for tests + console. */
export function computeElementsBbox(elementIds: string[]): THREE.Box3 | null {
  return getSelectionWorldBox(elementIds);
}
