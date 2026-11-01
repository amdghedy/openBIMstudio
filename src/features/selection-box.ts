/**
 * Selection Box — auto-fit section box / crop region to selected elements.
 *
 * BIM-equivalent of Revit's right-click → "Show Selection Box" command
 * (which wraps a 3D section box tightly around the current selection) and
 * the plan-view "Crop to Selection" action that tightens the crop region
 * to the current authoring selection.
 */

import * as THREE from "three";
import { ctx } from "../core/context";
import { getElementById, getElementWorldBox, getSelectedIds, getAuthoredGroup } from "./authoring";
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
  const idSet = new Set(ids.map(String));
  const box = new THREE.Box3();
  let hasAny = false;

  // Prefer live scene meshes (correct world transforms after placement / coordination).
  try {
    const group = getAuthoredGroup?.();
    if (group) {
      try { group.updateMatrixWorld(true); } catch { /* */ }
      group.traverse((o: any) => {
        if (!o?.isMesh) return;
        const eid = o.userData?.elementId;
        if (eid == null || !idSet.has(String(eid))) return;
        const b = new THREE.Box3().setFromObject(o);
        if (!b.isEmpty()) {
          box.union(b);
          hasAny = true;
        }
      });
    }
  } catch { /* fall through to synthetic path */ }

  if (!hasAny) {
    for (const id of ids) {
      const el = getElementById(id);
      if (!el) continue;
      const elBox = getElementWorldBox(el);
      if (!elBox) continue;
      box.union(elBox);
      hasAny = true;
    }
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
    console.warn("[selection-box] no selection — cannot show selection box");
    return false;
  }

  const padded = box.clone();
  padded.expandByScalar(padding);

  // enableSectionBoxWithBox creates a new section box from the given AABB.
  enableSectionBoxWithBox(padded);

  if (options.fitCamera !== false) {
    try { focusOnBox(padded); } catch { /* */ }
  }

  if (options.disable) {
    disableSectionBox();
  }

  return true;
}

/**
 * Crop to Selection — tighten the active plan-view crop region to the
 * current selection's 2D footprint.
 */
export function cropToSelection(options: CropToSelectionOptions = {}): boolean {
  const padding = options.padding ?? 0.5;
  const viewId = options.viewId ?? "plan-view-1";
  const bbox = getSelectionViewBbox();
  if (!bbox) {
    console.warn("[selection-box] no selection — cannot crop to selection");
    return false;
  }

  const region = {
    minX: bbox.minX - padding,
    maxX: bbox.maxX + padding,
    minZ: bbox.minZ - padding,
    maxZ: bbox.maxZ + padding,
  };

  setCropRegion(viewId, region);
  if (options.enable !== false) {
    setActiveView(viewId);
  }
  return true;
}

/** Toggle selection box on/off. When turning on, fits to current selection. */
export function toggleSelectionBox(): boolean {
  if (isSectionBoxActive()) {
    disableSectionBox();
    return false;
  }
  return showSelectionBox();
}

/** Grow the existing section box by the given amount (m) on all sides. */
export function growSelectionBox(amount = 0.5): void {
  growSectionBox(amount);
}

/** Fit the camera to the current selection without changing the section box. */
export function fitCameraToSelection(): boolean {
  const box = getSelectionWorldBox();
  if (!box) return false;
  focusOnBox(box);
  return true;
}

/** Fit the camera to everything (authored + linked). */
export function fitCameraToAll(): void {
  fitAll();
}

export function setupSelectionBox(): void {
  try {
    (ctx.features as any).selectionBox = {
      show: showSelectionBox,
      crop: cropToSelection,
      toggle: toggleSelectionBox,
      grow: growSelectionBox,
      fitSelection: fitCameraToSelection,
      fitAll: fitCameraToAll,
      getWorldBox: getSelectionWorldBox,
      getViewBbox: getSelectionViewBbox,
    };
  } catch { /* */ }
  console.log("[selection-box] ready");
}
