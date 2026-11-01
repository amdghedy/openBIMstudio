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
