/**
 * Read the orbit target from a camera-controls instance.
 *
 * camera-controls v3 exposes NO public `.target` property (it keeps `_target` and offers
 * `getTarget(out)`). Code that tested `controls.target?.isVector3` therefore always fell back to
 * a guess (scene centre / origin), and any setLookAt built from that guess re-aimed the camera,
 * which is what made the mouse wheel rotate the view.
 */
export interface Vec3Like { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown }

export function readControlsTarget<T extends Vec3Like>(controls: any, out: T): boolean {
  try {
    if (typeof controls?.getTarget === "function") {
      controls.getTarget(out);
      if (Number.isFinite(out.x + out.y + out.z)) return true;
    }
  } catch { /* fall through */ }
  try {
    const t = controls?.target;
    if (t && Number.isFinite(t.x + t.y + t.z)) { out.set(t.x, t.y, t.z); return true; }
  } catch { /* fall through */ }
  return false;
}

/** On-axis fallback when the controls expose no target: a point straight ahead of the camera. */
export function axisTargetFallback(
  pos: [number, number, number], dir: [number, number, number], center: [number, number, number], minDist = 1,
): [number, number, number] {
  const d = Math.max(minDist, (center[0] - pos[0]) * dir[0] + (center[1] - pos[1]) * dir[1] + (center[2] - pos[2]) * dir[2]);
  return [pos[0] + dir[0] * d, pos[1] + dir[1] * d, pos[2] + dir[2] * d];
}
