/**
 * Double-click in the 3D view — audit gap G5 (Revit 2D environment).
 *
 * Revit opens an editor appropriate to the double-clicked element. The
 * reachable subset here: double-click an authored element selects it and
 * opens Type Properties for it (`modify.typeProperties`), which edits the
 * type defaults for that element's type. The orbit pivot is still set to
 * the element centre, so the framing benefit of the old behaviour survives
 * without moving the camera.
 *
 * Preserved from the pre-G5 behaviour:
 *   - Shift+double-click on an authored element still fits the camera to
 *     it (the old behaviour, kept available on a modifier).
 *   - Double-click on a linked fragment element still fits it: fragments
 *     have no editable type defaults, so Type Properties would be wrong.
 *   - Double-click on empty space still does nothing (Revit's "do
 *     nothing"), never a surprise fit-all.
 *   - Middle-button double-click is untouched (navigation.ts owns it:
 *     fitAll after its gesture cooldown).
 *
 * A full Family Editor on double-click is out of reach in this workstream
 * (`family-sketch-editor.ts` exists for family sketching, but there is no
 * per-element family edit session wired to double-click); that limit is
 * recorded, not faked.
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { inputRouter, type Gesture } from "../core/input-router";
import { fitToMap, focusOnBox, setOrbitPivot } from "./camera-tools";
import {
  resolveDoubleClickAction,
  type DoubleClickTarget,
} from "../modules/double-click/double-click-dispatch";

let installed = false;

export function setupDblclickFit(): void {
  if (installed) { console.log("[dblclick-fit] already installed"); return; }
  installed = true;

  inputRouter.subscribe((g) => {
    if (g.kind !== "dblclick") return false;
    if (g.button !== 0) return false;               // left button only
    void handleDoubleClick(g);
    return true; // consume — nothing else should react
  }, 60); // priority 60 — before navigation (30) and context-menu (20)

  (ctx.features as any).dblclickFit = {
    fitUnderCursor,
    handleDoubleClick,
  };
  console.log("[dblclick-fit] ready");
}

/** Open Type Properties for the authored element `id` (selects it first). */
function openTypePropertiesFor(id: string): void {
  try {
    const auth: any = (ctx.features as any).authoring;
    auth?.setSelectedAuthored?.([id], "replace");
  } catch { /* selection is best-effort; the command toasts if empty */ }
  const exp: any = (window as any).__obsBIMExperience;
  if (typeof exp?.execute === "function") {
    exp.execute("modify.typeProperties");
    return;
  }
  // Fallback if the BIM experience handle is not up yet: dynamic import
  // avoids a static import cycle (bim-experience imports plan-view-panel).
  void import("./bim-experience").then((m: any) => {
    m.executeBimCommand?.("modify.typeProperties");
  }).catch(() => { /* */ });
}

async function handleDoubleClick(g: Extract<Gesture, { kind: "dblclick" }>): Promise<void> {
  const e = g.event;
  const shiftKey = !!g.mods?.shift;

  // ── 1. Authored element first (no worker round-trip) ─────────────
  try {
    const auth: any = (ctx.features as any).authoring;
    const id: string | null = auth?.pickAuthoredElementAt?.(e) ?? null;
    if (id) {
      const target: DoubleClickTarget = { kind: "authored-element", elementId: id };
      const action = resolveDoubleClickAction(target, { view: "3d", shiftKey });
      if (action.kind === "open-type-properties") {
        // Keep the pivot benefit of the old fit without moving the camera.
        try {
          const el = auth.getElementById?.(id);
          const wb: THREE.Box3 | null = el ? auth.getElementWorldBox?.(el) : null;
          if (wb && !wb.isEmpty()) setOrbitPivot(wb.getCenter(new THREE.Vector3()));
        } catch { /* */ }
        openTypePropertiesFor(id);
        console.log("[dblclick-fit] type-properties:", auth.getElementById?.(id)?.name ?? id);
        return;
      }
      // Shift+double-click: the old fit behaviour.
      await fitUnderCursor(e);
      return;
    }
  } catch (err) {
    console.warn("[dblclick-fit] authored pick failed", err);
  }

  // ── 2. Fragment element — keep fitting (no editable type) ─────────
  try {
    const selMod: any = await import("./selection");
    const hit = await selMod.pickFragmentAtPointer?.();
    if (!hit) return; // empty space -> no-op (unchanged)
    await fitFragment(hit);
  } catch (err) {
    console.warn("[dblclick-fit] fragment fit failed", err);
  }
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
    await fitFragment(hit);
  } catch (err) {
    console.warn("[dblclick-fit] fragment fit failed", err);
  }
}

async function fitFragment(hit: { modelId: string; localId: number }): Promise<void> {
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
}
