/**
 * BIM-aware framing math — pure functions, no DOM, no viewer access.
 *
 * frameBox() computes the camera distance / orthographic frustum needed to
 * frame a world-space box at a given field of view and aspect ratio, with
 * configurable padding and a hard minimum distance (never inside the model).
 */
import * as THREE from "three";

export interface FrameOptions {
  /** Vertical field of view in radians (perspective). */
  fovY: number;
  /** Viewport aspect ratio (width / height). */
  aspect: number;
  /** Padding multiplier on the bounding radius (> 1 recommended). */
  padding: number;
  /** Minimum camera distance (world units). */
  minDistance: number;
}

export interface FrameResult {
  /** Box center — use as the orbit target. */
  target: THREE.Vector3;
  /** Required camera distance from the target (perspective). */
  distance: number;
  /** Required orthographic frustum half-height. */
  orthoHalfHeight: number;
  /** Bounding radius used (half of the box diagonal). */
  radius: number;
}

function finiteBox(box: THREE.Box3): boolean {
  return (
    Number.isFinite(box.min.x) && Number.isFinite(box.min.y) && Number.isFinite(box.min.z) &&
    Number.isFinite(box.max.x) && Number.isFinite(box.max.y) && Number.isFinite(box.max.z)
  );
}

/**
 * Frame a world box. Returns null for empty, non-finite or exploded bounds —
 * callers fall back to a safe default instead of producing NaN cameras.
 *
 * Closed form: with bounding-sphere radius r and effective half-angle
 * f = min(fovY, fovX)/2, distance = r / sin(f). The bounding sphere uses the
 * box diagonal (conservative, exact for the worst rotation).
 */
export function frameBox(box: THREE.Box3, o: FrameOptions): FrameResult | null {
  if (!box || box.isEmpty() || !finiteBox(box)) return null;
  const size = box.getSize(new THREE.Vector3());
  if (size.length() > 1e9) return null; // exploded bounds guard
  const radius = Math.max(size.length() / 2, 1e-3);

  const fovY = THREE.MathUtils.clamp(o.fovY, 0.05, Math.PI - 0.05);
  const aspect = Math.max(1e-3, o.aspect);
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
  const f = Math.min(fovY, fovX) / 2;
  const pad = o.padding > 0 ? o.padding : 1;

  const distance = Math.max(o.minDistance, (radius * pad) / Math.max(1e-6, Math.sin(f)));
  // Ortho fits both dimensions: height binds when aspect >= 1, width otherwise.
  const orthoHalfHeight = Math.max(1e-3, (radius * pad) / Math.min(1, aspect));

  return {
    target: box.getCenter(new THREE.Vector3()),
    distance,
    orthoHalfHeight,
    radius,
  };
}

/**
 * Default home placement when nothing is saved: the repo's standard iso
 * direction (identical to resetToDefaultView), framing the given bounds.
 * With no usable bounds it degrades to the documented safe default
 * (target origin, distance 28) instead of producing an invalid camera.
 */
export function defaultHomePlacement(
  bounds: THREE.Box3 | null,
  minDistance: number,
): { target: THREE.Vector3; distance: number; dir: THREE.Vector3 } {
  const dir = new THREE.Vector3(1.2, 0.7, 1.2).normalize();
  if (bounds && !bounds.isEmpty()) {
    const center = bounds.getCenter(new THREE.Vector3());
    const r = bounds.getSize(new THREE.Vector3()).length() / 2;
    const distance = Math.max(minDistance, r * 2.2, 5);
    if (Number.isFinite(center.x) && Number.isFinite(distance)) {
      return { target: center, distance, dir };
    }
  }
  return { target: new THREE.Vector3(0, 0, 0), distance: 28, dir };
}
