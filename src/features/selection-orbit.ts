import { ctx } from "../core/context";

type Any = Record<string, any>;

/*
 * Thin selection-orbit helper.
 *
 * IMPORTANT: this module intentionally does NOT register any input-router
 * gesture handler and does NOT listen to middle-mouse or wheel. The canonical
 * Revit navigation in src/features/navigation.ts is the SOLE owner of:
 *   MMB drag = pan, Shift/Ctrl+MMB = orbit, Wheel = zoom-to-cursor.
 *
 * Duplicating those here was the cause of "view rotates / zooms out on MMB
 * release": two handlers fought over the same gesture and the losing one
 * applied a stale orbit/recenter when the gesture ended.
 *
 * All this file does now: after a LEFT-click selection settles, re-center the
 * orbit pivot on the current selection (the documented "focus on select"
 * behaviour), using camera-tools helpers via the global context. No MMB, no
 * wheel, no drag.
 */

let installed = false;

function camTools(): Any {
  const c = ctx as Any;
  return (c.cam as Any) ?? (window as Any).__OBS_CAMERA_TOOLS ?? {};
}

// Debounce so rapid left-clicks through a coordination model do not queue
// dozens of overlapping Fragments worker round-trips (getElementWorldBoxes
// is async and slow on large models).
let pendingPivot: number | null = null;

function schedulePivotOnSelection(): void {
  if (pendingPivot !== null) {
    window.clearTimeout(pendingPivot);
  }
  pendingPivot = window.setTimeout(() => {
    pendingPivot = null;
    pivotOnSelectionSafe();
  }, 40);
}

function pivotOnSelectionSafe(): void {
  try {
    const t = camTools();
    if (typeof t.pivotOnSelection === "function") {
      void t.pivotOnSelection();
    }
  } catch {
    /* camera-tools not ready yet; ignore */
  }
}

function setPivotSafe(point: Any): void {
  try {
    const t = camTools();
    if (typeof t.setOrbitPivot === "function") {
      t.setOrbitPivot(point);
    }
  } catch {
    /* ignore */
  }
}

export function setupSelectionOrbit(): void {
  if (installed) return;
  installed = true;

  // LEFT click only -> recenter orbit pivot on the resulting selection.
  const onClick = (e: MouseEvent): void => {
    if (e.button !== 0) return;            // never react to MMB / RMB
    const tgt = e.target as Any;
    if (tgt && typeof tgt.closest === "function" &&
        tgt.closest('button, input, select, textarea, [contenteditable="true"], .obs-ribbon, .obs-panel, .obs-property, .obs-dialog, .obs-adv-toolbar')) {
      return;                              // ignore UI chrome clicks
    }
    // let the highlighter / selection commit first, then recenter
    schedulePivotOnSelection();
  };

  window.addEventListener("click", onClick, true);

  // Explicit focus requests from other modules (e.g. "Zoom to Selection").
  window.addEventListener("obs:focus-selection", () => pivotOnSelectionSafe());
  window.addEventListener("obs:selection-changed", () => {
    // soft recenter only when something is actually selected
    window.setTimeout(pivotOnSelectionSafe, 60);
  });

  (window as Any).__obsSelectionOrbit = {
    enabled: true,
    setPivot: setPivotSafe,
    pivotOnSelection: pivotOnSelectionSafe,
  };

  console.log(
    "[selection-orbit] thin mode active: pivot-on-left-click only; " +
    "MMB pan/orbit and wheel zoom are owned exclusively by navigation.ts",
  );
}

// Compatibility aliases (in case any importer used a different entry name).
export function installSelectionOrbit(): void { setupSelectionOrbit(); }
export function setupOrbit(): void { setupSelectionOrbit(); }
export function enableSelectionOrbit(): void { /* no-op, always on */ }
export function disableSelectionOrbit(): void { /* no-op */ }
export function isSelectionOrbitEnabled(): boolean { return true; }