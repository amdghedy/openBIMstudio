/** Which clipper helper objects may be grabbed to drag a section plane (pure, structural checks).
 *
 *  The clipper item exposes the big translucent plane quad AND the move arrow. Treating the quad
 *  as a handle made hovering anywhere over the plane (or over an invisible leftover of it) switch
 *  on "arrow mode", which disables orbit/selection. Only visible, non-quad parts qualify. */
export interface ObjLike {
  visible?: boolean;
  parent?: ObjLike | null;
  geometry?: { type?: string } | null;
  material?: { opacity?: number; visible?: boolean } | Array<{ opacity?: number; visible?: boolean }> | null;
}

export function isEffectivelyVisible(o: ObjLike): boolean {
  for (let n: ObjLike | null | undefined = o; n; n = n.parent) if (n.visible === false) return false;
  return true;
}

export function isPlaneQuad(o: ObjLike): boolean {
  const t = o.geometry?.type ?? "";
  return t === "PlaneGeometry" || t === "ShapeGeometry";
}

export function isGrabbableHandle(o: ObjLike): boolean {
  if (!isEffectivelyVisible(o)) return false;
  if (isPlaneQuad(o)) return false;
  const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
  if (mats.length && mats.every((m) => m.visible === false || (typeof m.opacity === "number" && m.opacity <= 0.01))) return false;
  return true;
}
