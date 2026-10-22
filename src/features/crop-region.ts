/**
 * Crop Region — 2D rectangular crop applied to a plan / section / elevation view.
 *
 * BIM-equivalent of Revit's "Crop Region" tool. Each view has its own
 * crop state (min/max in view-space XZ), with 4 corner + 4 edge handles
 * that the user can drag to resize.
 *
 * When enabled, the crop region overlays the plan view and elements outside
 * the region are visually clipped (CSS `clip-path` on the canvas).
 */

export interface CropRegion {
  viewId: string;
  /** Min corner in view-space (m). */
  minX: number;
  minY: number;
  /** Max corner in view-space (m). */
  maxX: number;
  maxY: number;
  /** View rotation in degrees (0, 90, 180, 270). */
  rotation: number;
  /** Is the crop region active (clip applied)? */
  enabled: boolean;
  /** False until the user/tool sets explicit bounds: the plan then fits the region to the model. */
  custom?: boolean;
}

const cropRegions = new Map<string, CropRegion>();

let activeViewId: string | null = null;

const listeners = new Set<(viewId: string) => void>();

/** Subscribe to crop changes; the plan view re-renders its crop rectangle from this. */
export function onCropChanged(cb: (viewId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(viewId: string): void {
  for (const cb of listeners) { try { cb(viewId); } catch { /* */ } }
  try { window.dispatchEvent(new CustomEvent("obs:crop-changed", { detail: viewId })); } catch { /* */ }
}

const SNAP = 0.1; // 10 cm grid

export function snapCrop(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

/** Get or create a crop region for a view. */
export function getCropRegion(viewId: string): CropRegion {
  let r = cropRegions.get(viewId);
  if (!r) {
    r = {
      viewId,
      minX: -50, minY: -50,
      maxX: 50, maxY: 50,
      rotation: 0,
      enabled: false,
      custom: false,
    };
    cropRegions.set(viewId, r);
  }
  return r;
}

/** Set the crop region for a view. */
export function setCropRegion(viewId: string, region: Partial<CropRegion>): CropRegion {
  const r = getCropRegion(viewId);
  Object.assign(r, region);
  if (["minX", "minY", "maxX", "maxY"].some((k) => k in region)) r.custom = region.custom ?? true;
  cropRegions.set(viewId, r);
  emit(viewId);
  return r;
}

/** Enable / disable crop for a view. */
export function setCropEnabled(viewId: string, enabled: boolean): CropRegion {
  return setCropRegion(viewId, { enabled });
}

/** Toggle crop for a view. */
export function toggleCrop(viewId: string): boolean {
  const r = getCropRegion(viewId);
  r.enabled = !r.enabled;
  emit(viewId);
  return r.enabled;
}

/** Reset crop region to default (the plan fits it to the model) and switch it on. */
export function resetCropRegion(viewId: string): CropRegion {
  return setCropRegion(viewId, {
    minX: -50, minY: -50, maxX: 50, maxY: 50, rotation: 0, enabled: true, custom: false,
  });
}

/** Check if a world-space point is inside the crop region. */
export function pointInCrop(viewId: string, x: number, y: number): boolean {
  const r = cropRegions.get(viewId);
  if (!r || !r.enabled) return true;
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/** Mark a view as the one whose crop is being edited (the plan draws handles for it). */
export function setActiveView(viewId: string): void {
  activeViewId = viewId;
  emit(viewId);
}

/** Stop editing the crop (hides handles). */
export function clearActiveView(): void {
  const v = activeViewId;
  activeViewId = null;
  if (v) emit(v);
}

export function getActiveCropView(): string | null {
  return activeViewId;
}

/**
 * Apply a drag of one handle to a region (pure). dx/dz are world deltas
 * (X east, Z north). Keeps at least `minSize` between opposite edges.
 */
export function dragCropHandle(
  start: Pick<CropRegion, "minX" | "minY" | "maxX" | "maxY">,
  handle: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw",
  dx: number, dz: number, minSize = 1,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const r = { minX: start.minX, minY: start.minY, maxX: start.maxX, maxY: start.maxY };
  if (handle === "move") {
    r.minX += dx; r.maxX += dx; r.minY += dz; r.maxY += dz;
    return r;
  }
  if (handle.includes("n")) r.maxY = Math.max(start.maxY + dz, start.minY + minSize);
  if (handle.includes("s")) r.minY = Math.min(start.minY + dz, start.maxY - minSize);
  if (handle.includes("e")) r.maxX = Math.max(start.maxX + dx, start.minX + minSize);
  if (handle.includes("w")) r.minX = Math.min(start.minX + dx, start.maxX - minSize);
  return r;
}

/** List all crop regions (for the View tab panel). */
export function listCropRegions(): CropRegion[] {
  return Array.from(cropRegions.values());
}

/** Delete a crop region. */
export function deleteCropRegion(viewId: string): boolean {
  if (viewId === activeViewId) activeViewId = null;
  const ok = cropRegions.delete(viewId);
  emit(viewId);
  return ok;
}

/** Reset all (tests). */
export function resetCropRegions(): void {
  cropRegions.clear();
  activeViewId = null;
}
