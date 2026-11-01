/** Which clipper helper objects may be grabbed to drag a section plane (pure, structural checks).
 *
 *  The clipper item exposes the big translucent plane quad AND the move arrow. Treating the quad
 *  as a handle made hovering anywhere over the plane switch on "arrow mode", which disables
 *  orbit/selection. The arrow's own hit-test pickers are deliberately INVISIBLE meshes (a gizmo
 *  convention), so visibility must not be required: if the arrow were left to the gizmo itself,
 *  the gizmo would start its own drag and never see the button release (the viewport input
 *  router swallows it) - the "arrow stays stuck to the mouse" bug. */
export interface ObjLike {
  visible?: boolean;
  parent?: ObjLike | null;
  geometry?: { type?: string } | null;
}

export function isPlaneQuad(o: ObjLike): boolean {
  const t = o.geometry?.type ?? "";
  return t === "PlaneGeometry" || t === "ShapeGeometry";
}

export function isGrabbableHandle(o: ObjLike): boolean {
  return !isPlaneQuad(o);
}

/** A drag is stale when the primary button is no longer down although we never saw the release. */
export function isStaleDrag(buttons: number | undefined, dragging: boolean): boolean {
  return dragging && typeof buttons === "number" && (buttons & 1) === 0;
}

/** TransformControls-like objects reachable from a clipper item that are mid-drag.
 *  The clipper's own arrow is a TransformControls: it starts dragging on pointerdown and only ends on a
 *  pointerup that reaches the canvas. If another handler swallows that pointerup the arrow stays glued to
 *  the mouse. We look for such controls (by shape, since property names differ between versions). */
export interface DragControlsLike { dragging?: boolean; axis?: unknown; pointerUp?: (p: { button: number } | null) => void }

export function findDraggingControls(item: unknown): DragControlsLike[] {
  const out: DragControlsLike[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 2) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.dragging === "boolean" && ("axis" in o || typeof o.pointerUp === "function")) {
      if (o.dragging) out.push(o as DragControlsLike);
      return;
    }
    let keys: string[] = [];
    try { keys = Object.keys(o); } catch { /* */ }
    for (const k of keys) {
      if (k === "parent" || k === "children" || k === "geometry" || k === "material" || k === "world" || k === "components") continue;
      let child: unknown;
      try { child = o[k]; } catch { continue; }
      visit(child, depth + 1);
    }
  };
  visit(item, 0);
  return out;
}

/** Force a controls drag to end exactly as a normal pointerup would. */
export function endControlsDrag(c: DragControlsLike): void {
  try { c.pointerUp?.({ button: 0 }); } catch { /* */ }
  try { c.dragging = false; } catch { /* */ }
  try { c.axis = null; } catch { /* */ }
}
