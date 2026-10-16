/**
 * Patch: when a selection pivot is active, Shift+MMB orbit always uses
 * the selection center of gravity (not only Ctrl+MMB).
 * Does not rewrite navigation.ts - observes drag-start and re-seeds pivot.
 */

import * as THREE from "three";
import { ctx } from "../core/context";

type Any = Record<string, any>;

let installed = false;

function reseedPivotFromFlag(): void {
  try {
    if (!(window as Any).__OBS_HAS_SELECTION_PIVOT) return;
    const pivot = (window as Any).__OBS_ORBIT_PIVOT as THREE.Vector3 | null;
    if (!pivot || !Number.isFinite(pivot.x)) return;
    const controls: Any = (ctx as Any).world?.camera?.controls;
    if (!controls) return;
    if (controls.target?.isVector3) {
      controls.target.copy(pivot);
    }
    if (typeof controls.setTarget === "function") {
      controls.setTarget(pivot.x, pivot.y, pivot.z, false);
    }
  } catch {
    /* */
  }
}

export function setupNavSelectionPivotPatch(): void {
  if (installed) return;
  installed = true;

  // On MMB drag start with Shift (orbit), force target = selection COG
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 1) return; // MMB
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return;
      reseedPivotFromFlag();
    },
    true,
  );

  // Also keep target locked during orbit moves when selection active
  window.addEventListener(
    "pointermove",
    (e) => {
      if (!(window as Any).__OBS_MMB_HELD) return;
      if (!e.shiftKey && !e.ctrlKey) return;
      if (!(window as Any).__OBS_HAS_SELECTION_PIVOT) return;
      reseedPivotFromFlag();
    },
    true,
  );

  console.log("[nav-selection-pivot-patch] Shift/Ctrl+MMB orbit uses selection COG");
}
