/**
 * Double-click fit.
 *
 * When the user double-clicks an element in the 3D view, the camera
 * smoothly frames that element and sets it as the orbit pivot.
 *
 * Works for both:
 *   - authored elements (walls, slabs, columns you drew)
 *   - fragment elements (IFC / FRAG models loaded in the scene)
 *
 * If the double-click lands on empty space, nothing happens (no
 * camera move, no fit all) so it never surprises the user.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { fitToMap, focusOnBox, setOrbitPivot } from "./camera-tools";

let installed = false;

export function setupDblclickFit(): void {
  if (installed) { console.log("[dblclick-fit] already installed"); return; }
  installed = true;

  inputRouter.subscribe((g) => {
    if (g.kind !== "dblclick") return false;
    if (g.button !== 0) return false;               // left button only
    void fitUnderCursor(g.event);
    return true; // consume — nothing else should react
  }, 60); // priority 60 — before navigation (30) and context-menu (20)

  (ctx.features as any).dblclickFit = {
    fitUnderCursor,
  };
  console.log("[dblclick-fit] ready");
}

async function fitUnderCursor(e: PointerEvent): Promise<void> {
  // ── 1. Authored element first (no worker round-trip) ─────────────
  try {
    const auth: any = (ctx.features as any).authoring;
    const id: string | null = auth?.pickAuthoredElementAt?.(e) ?? null;
    if (id) {
      const el = auth.getElementById?.(id);
      const wb: THREE.Box3 | null = el ? auth.getElementWorldBox?.(el) : null;
      if (wb && !wb.isEmpty()) {
        focusOnBox(wb);
        try { setOrbitPivot(wb.getCenter(new THREE.Vector3())); } catch { /* */ }
        console.log("[dblclick-fit] authored:", el?.name ?? id);
        return;
      }
    }
  } catch (err) {
    console.warn("[dblclick-fit] authored pick failed", err);
  }

  // ── 2. Fragment element ───────────────────────────────────────────
  try {
    const selMod: any = await import("./selection");
    const hit = await selMod.pickFragmentAtPointer?.();
    if (!hit) return; // empty space -> no-op

    const map: Record<string, Set<number>> = {};
    map[hit.modelId] = new Set([hit.localId]);
    await fitToMap(map as any);

    // Set orbit pivot to fragment's world center
    try {
      const model: any = ctx.fragments.list.get(hit.modelId);
      if (model) {
        const wbMod: any = await import("../modules/geometry/world-box");
        const wbs = await wbMod.getElementWorldBoxes(model, [hit.localId], hit.modelId);
        const box = wbs?.[0]?.box as THREE.Box3 | undefined;
        if (box && !box.isEmpty()) {
          setOrbitPivot(box.getCenter(new THREE.Vector3()));
        }
      }
    } catch { /* */ }

    console.log("[dblclick-fit] fragment:", hit.modelId, "#" + hit.localId);
  } catch (err) {
    console.warn("[dblclick-fit] fragment fit failed", err);
  }
}