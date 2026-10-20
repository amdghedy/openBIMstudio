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
}

const cropRegions = new Map<string, CropRegion>();

let activeViewId: string | null = null;
let overlayEl: HTMLDivElement | null = null;
let handlesEl: HTMLDivElement | null = null;
let dragState: {
  handle: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
  startX: number;
  startY: number;
  startRegion: CropRegion;
} | null = null;

const SNAP = 0.1; // 10 cm grid

function snap(v: number): number {
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
    };
    cropRegions.set(viewId, r);
  }
  return r;
}

/** Set the crop region for a view. */
export function setCropRegion(viewId: string, region: Partial<CropRegion>): CropRegion {
  const r = getCropRegion(viewId);
  Object.assign(r, region);
  cropRegions.set(viewId, r);
  if (viewId === activeViewId) renderOverlay();
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
  if (viewId === activeViewId) renderOverlay();
  return r.enabled;
}

/** Reset crop region to default (50 × 50 m around origin). */
export function resetCropRegion(viewId: string): CropRegion {
  return setCropRegion(viewId, {
    minX: -50, minY: -50, maxX: 50, maxY: 50, rotation: 0, enabled: true,
  });
}

/** Check if a world-space point is inside the crop region. */
export function pointInCrop(viewId: string, x: number, y: number): boolean {
  const r = cropRegions.get(viewId);
  if (!r || !r.enabled) return true;
  return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
}

/** Activate a view for crop region interaction (renders overlay). */
export function setActiveView(viewId: string): void {
  activeViewId = viewId;
  ensureOverlayMounted();
  renderOverlay();
}

/** Deactivate crop region interaction (hide overlay). */
export function clearActiveView(): void {
  activeViewId = null;
  if (overlayEl) overlayEl.style.display = "none";
}

function ensureOverlayMounted(): void {
  if (overlayEl && overlayEl.isConnected) return;
  const host = document.querySelector(".obs-viewport") as HTMLElement | null
            ?? document.querySelector("#viewport") as HTMLElement | null
            ?? document.body;
  overlayEl = document.createElement("div");
  overlayEl.className = "obs-crop-region-overlay";
  overlayEl.style.cssText = `
    position: absolute; pointer-events: none;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 50;
    display: none;
  `;
  host.appendChild(overlayEl);
  handlesEl = document.createElement("div");
  handlesEl.style.cssText = `
    position: absolute; pointer-events: auto;
    cursor: move;
  `;
  overlayEl.appendChild(handlesEl);
  window.addEventListener("resize", renderOverlay);
}

function renderOverlay(): void {
  if (!overlayEl || !handlesEl || !activeViewId) return;
  const r = cropRegions.get(activeViewId);
  if (!r || !r.enabled) {
    overlayEl.style.display = "none";
    return;
  }
  overlayEl.style.display = "block";

  // Compute pixel position from world coords — uses canvas viewport transform.
  const canvas = document.querySelector(".obs-viewport canvas, #viewport canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  // Assume world-to-screen scaling is 1 m = N px (we approximate with rect width / 100 m).
  const scale = Math.min(rect.width / 100, rect.height / 100); // 1m → scale px
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  const x1 = cx + r.minX * scale;
  const y1 = cy - r.maxY * scale;
  const w = (r.maxX - r.minX) * scale;
  const h = (r.maxY - r.minY) * scale;

  handlesEl.style.left = `${x1}px`;
  handlesEl.style.top = `${y1}px`;
  handlesEl.style.width = `${w}px`;
  handlesEl.style.height = `${h}px`;
  handlesEl.style.border = `2px dashed ${r === getCropRegion(activeViewId) ? "#22d3ee" : "#94a3b8"}`;
  handlesEl.style.background = "rgba(34, 211, 238, 0.05)";
  handlesEl.style.boxSizing = "border-box";

  // Build corner + edge handles.
  handlesEl.innerHTML = "";
  const handleDefs = [
    { type: "nw", cx: 0,   cy: 0,   cursor: "nwse-resize" },
    { type: "n",  cx: 0.5, cy: 0,   cursor: "ns-resize" },
    { type: "ne", cx: 1,   cy: 0,   cursor: "nesw-resize" },
    { type: "e",  cx: 1,   cy: 0.5, cursor: "ew-resize" },
    { type: "se", cx: 1,   cy: 1,   cursor: "nwse-resize" },
    { type: "s",  cx: 0.5, cy: 1,   cursor: "ns-resize" },
    { type: "sw", cx: 0,   cy: 1,   cursor: "nesw-resize" },
    { type: "w",  cx: 0,   cy: 0.5, cursor: "ew-resize" },
  ];
  for (const hd of handleDefs) {
    const h = document.createElement("div");
    h.style.cssText = `
      position: absolute;
      left: ${hd.cx * 100}%;
      top: ${hd.cy * 100}%;
      width: 12px; height: 12px;
      background: #22d3ee;
      border: 2px solid #0e7490;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      cursor: ${hd.cursor};
      pointer-events: auto;
    `;
    h.dataset.handle = hd.type;
    h.addEventListener("pointerdown", (e) => onHandleDown(e, hd.type as typeof dragState extends { handle: infer T } ? T : never));
    handlesEl.appendChild(h);
  }
  // Body drag = move whole region.
  handlesEl.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).dataset.handle) return;
    onHandleDown(e, "move");
  });
}

function onHandleDown(e: PointerEvent, handle: "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"): void {
  if (!activeViewId) return;
  e.preventDefault();
  e.stopPropagation();
  const r = getCropRegion(activeViewId);
  dragState = {
    handle,
    startX: e.clientX,
    startY: e.clientY,
    startRegion: { ...r },
  };
  window.addEventListener("pointermove", onHandleMove);
  window.addEventListener("pointerup", onHandleUp);
}

function onHandleMove(e: PointerEvent): void {
  if (!dragState || !activeViewId) return;
  const canvas = document.querySelector(".obs-viewport canvas, #viewport canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const scale = Math.min(rect.width / 100, rect.height / 100);
  const dx = snap((e.clientX - dragState.startX) / scale);
  const dy = snap((e.clientY - dragState.startY) / scale);
  // Convert screen delta (down is +y) to world delta (up is +y).
  const wdx = dx;
  const wdy = -dy;
  const r = { ...dragState.startRegion };
  const h = dragState.handle;
  if (h === "move") {
    r.minX += wdx; r.maxX += wdx;
    r.minY += wdy; r.maxY += wdy;
  } else {
    if (h.includes("n")) r.maxY = Math.max(r.maxY + wdy, r.minY + 1);
    if (h.includes("s")) r.minY = Math.min(r.minY + wdy, r.maxY - 1);
    if (h.includes("e")) r.maxX = Math.max(r.maxX + wdx, r.minX + 1);
    if (h.includes("w")) r.minX = Math.min(r.minX + wdx, r.maxX - 1);
  }
  setCropRegion(activeViewId, r);
}

function onHandleUp(): void {
  dragState = null;
  window.removeEventListener("pointermove", onHandleMove);
  window.removeEventListener("pointerup", onHandleUp);
}

/** List all crop regions (for the View tab panel). */
export function listCropRegions(): CropRegion[] {
  return Array.from(cropRegions.values());
}

/** Delete a crop region. */
export function deleteCropRegion(viewId: string): boolean {
  if (viewId === activeViewId) clearActiveView();
  return cropRegions.delete(viewId);
}

/** Reset all (tests). */
export function resetCropRegions(): void {
  cropRegions.clear();
  activeViewId = null;
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    handlesEl = null;
  }
}
