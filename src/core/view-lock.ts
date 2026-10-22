/**
 * Pure helpers that keep the camera ORIENTATION unchanged while zooming or
 * panning (those gestures only translate the eye; only orbit may rotate).
 */
export type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Distance from the eye to the orbit target measured along the view direction (never below `min`). */
export function axisDistance(pos: V3, target: V3, fwd: V3, min = 0.5): number {
  const d = dot(sub(target, pos), fwd);
  return Number.isFinite(d) && d > min ? d : min;
}

/** Look-at target for a translated eye: always straight ahead along the original view direction. */
export function targetAhead(pos: V3, fwd: V3, dist: number): V3 {
  return add(pos, mul(fwd, dist));
}

/**
 * Perspective zoom towards a world point: the eye moves along the ray to
 * `focus` by (1 - 1/factor) of the distance. Pure translation, so the view
 * direction is untouched. Returns the new eye position.
 */
export function dollyTowards(pos: V3, focus: V3, factor: number, minDistance = 0.05): V3 {
  const toF = sub(focus, pos);
  const len = Math.hypot(toF[0], toF[1], toF[2]);
  if (len < 1e-9 || !(factor > 0)) return pos;
  // Never pass through the focus point.
  const maxStep = Math.max(len - minDistance, 0);
  const wanted = len * (1 - 1 / factor);
  const step = wanted >= 0 ? Math.min(wanted, maxStep) : wanted; // zooming out has no limit
  return add(pos, mul(toF, step / len));
}
