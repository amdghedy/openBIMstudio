/**
 * Cursor-anchored zoom: pure math, no three.js, so it can be tested numerically.
 *
 * Perspective: the camera AND its orbit target are scaled about the world point under
 * the pointer (the anchor). Position/target keep their offsets in the same direction, so the
 * view direction (camera orientation) is unchanged by construction, and the anchor projects
 * to exactly the same pixel before and after.
 * Orthographic: the frustum scale changes and the camera slides sideways (in the view
 * plane) so the anchor stays under the pointer; orientation is unchanged.
 */
export type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const finite3 = (a: V3) => a.every(Number.isFinite);

export const MIN_STEP = 0.15;  // never shrink the camera distance below 15 % in one event
export const MAX_STEP = 4.0;

/** Pointer position -> normalised device coords in the ACTUAL viewport rectangle. */
export function pointerNdc(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } | null {
  if (!(rect.width >= 1) || !(rect.height >= 1)) return null;
  const x = ((clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((clientY - rect.top) / rect.height) * 2 + 1;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  // outside the viewport -> not ours
  if (x < -1 || x > 1 || y < -1 || y > 1) return null;
  return { x, y };
}

/**
 * Wheel delta -> distance factor (<1 zoom in, >1 zoom out). Symmetric: f(d)*f(-d) = 1.
 * `speed` is the user multiplier (default 10 keeps the previous feel: one 100-unit notch = 1.67x).
 */
export function wheelDistanceFactor(deltaY: number, deltaMode: number, speed = 10, shift = false): number {
  let d = Number(deltaY);
  if (!Number.isFinite(d) || d === 0) return 1;
  if (deltaMode === 1) d *= 16; else if (deltaMode === 2) d *= 100;
  d = Math.max(-100, Math.min(100, d));
  const s = (Number.isFinite(speed) && speed > 0 ? speed : 10) * (shift ? 2.5 : 1);
  const f = Math.exp(d * s * 0.000513);
  return Math.max(MIN_STEP, Math.min(MAX_STEP, f));
}

export interface PerspIn { pos: V3; target: V3; anchor: V3; factor: number; minDist?: number }

/**
 * Scale camera and target about `anchor` by `factor` (new/old distance). Returns null when the
 * anchor is unusable (non-finite or not in front of the camera) so the caller can fall back.
 */
export function perspectiveZoomAbout(i: PerspIn): { pos: V3; target: V3; factor: number } | null {
  const { pos, target, anchor } = i;
  if (!finite3(pos) || !finite3(target) || !finite3(anchor)) return null;
  const view = sub(target, pos); const d0 = len(view);
  if (!(d0 > 1e-9)) return null;
  const fwd = mul(view, 1 / d0);
  if (dot(sub(anchor, pos), fwd) < 1e-6) return null; // behind / at the camera
  let f = Number(i.factor);
  if (!Number.isFinite(f) || f <= 0) return null;
  f = Math.max(MIN_STEP, Math.min(MAX_STEP, f));
  const minDist = i.minDist ?? 0.05;
  if (d0 * f < minDist) f = Math.max(minDist / d0, 1e-6);
  return {
    pos: add(anchor, mul(sub(pos, anchor), f)),
    target: add(anchor, mul(sub(target, anchor), f)),
    factor: f,
  };
}

/**
 * Fallback anchor: intersection of the pointer ray with the camera-facing plane through the
 * orbit target. Returns null if the ray is parallel to / diverging from the plane.
 */
export function planeAnchor(rayOrigin: V3, rayDir: V3, planePoint: V3, planeNormal: V3): V3 | null {
  const denom = dot(rayDir, planeNormal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(planePoint, rayOrigin), planeNormal) / denom;
  if (!(t > 0) || !Number.isFinite(t)) return null;
  return add(rayOrigin, mul(rayDir, t));
}

export interface OrthoIn { pos: V3; target: V3; anchor: V3; zoom: number; factor: number; minZoom?: number; maxZoom?: number }

/** `factor` = new/old visible size (<1 zoom in). Slides camera+target in the view plane. */
export function orthoZoomAbout(i: OrthoIn): { pos: V3; target: V3; zoom: number } | null {
  const { pos, target, anchor } = i;
  if (!finite3(pos) || !finite3(target) || !finite3(anchor)) return null;
  const view = sub(target, pos); const d = len(view);
  if (!(d > 1e-9) || !(i.zoom > 0) || !(i.factor > 0) || !Number.isFinite(i.factor)) return null;
  const fwd = mul(view, 1 / d);
  const f = Math.max(MIN_STEP, Math.min(MAX_STEP, i.factor));
  const newZoom = Math.max(i.minZoom ?? 0.01, Math.min(i.maxZoom ?? 5000, i.zoom / f));
  const eff = i.zoom / newZoom; // visible-size factor actually applied
  const rel = sub(anchor, target);
  const lateral = sub(rel, mul(fwd, dot(rel, fwd)));
  const shift = mul(lateral, 1 - eff);
  return { pos: add(pos, shift), target: add(target, shift), zoom: newZoom };
}
