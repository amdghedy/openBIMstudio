/** Keep the camera's up vector on world +Y for axis-aligned views (pure, tuple based).
 *
 *  camera-controls orbits around the up axis it captured, so leaving `camera.up` at (0,0,-1) after
 *  a Top view makes every later manual rotation swap/roll the axes. Instead we keep up = +Y and
 *  get the same screen orientation by offsetting the camera a hair (EPS rad) horizontally,
 *  which is what picks the on-screen "up" direction for a straight-down / straight-up view. */
export type V3 = [number, number, number];
export const TOP_EPS = 1e-3;
// Start blending before the pole to avoid a one-frame camera-up snap.
const TOP_BLEND_START = 0.98;
const TOP_BLEND_END = 0.9999;
function smoothstep01(value: number): number {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface UpResolution { pos: V3; up: V3; keptWorldUp: boolean }

export function resolveWorldUp(pos: V3, target: V3, up: V3): UpResolution {
  const toTarget = sub(target, pos);
  const dist = len(toTarget);
  const f = norm(toTarget);
  const upN = norm(up);
  const s = f[1];
  const pole = Math.abs(s);

  // Away from the vertical pole, preserve the requested orientation exactly.
  if (pole <= TOP_BLEND_START) {
    return { pos, up: upN, keptWorldUp: Math.abs(upN[1]) > 0.9999 };
  }

  // Smoothly hand off camera.up and the pole-avoidance offset. The old hard
  // threshold changed camera.up to +Y in one frame while a snap was animating.
  const blend = smoothstep01((pole - TOP_BLEND_START) / (TOP_BLEND_END - TOP_BLEND_START));
  const horizontalLength = Math.hypot(upN[0], upN[2]);
  if (horizontalLength < 1e-6) {
    return { pos, up: [0, 1, 0], keptWorldUp: true };
  }

  const h: V3 = [upN[0] / horizontalLength, 0, upN[2] / horizontalLength];
  const sgn = s < 0 ? -1 : 1;
  const offset = TOP_EPS * dist * blend;
  const resolvedPos: V3 = [
    pos[0] + h[0] * sgn * offset,
    pos[1],
    pos[2] + h[2] * sgn * offset,
  ];
  const resolvedUp = norm([
    upN[0] * (1 - blend),
    upN[1] * (1 - blend) + blend,
    upN[2] * (1 - blend),
  ]);
  return { pos: resolvedPos, up: resolvedUp, keptWorldUp: blend >= 1 };
}

/** Screen-up direction produced by a three.js lookAt with world up +Y (for verification). */
export function screenUp(pos: V3, target: V3): V3 {
  const f = norm(sub(target, pos));
  const d = f[1];
  return norm([-d * f[0], 1 - d * f[1], -d * f[2]]);
}

/**
 * Per-frame lookAt hint for the camera adapter.
 *
 * Two pose families reach the adapter:
 *  1. Navigation-transition samples and drag poses. Their up vector is the
 *     interpolated lookAt basis (up ⊥ view direction), already smooth by
 *     construction — pass it through UNMODIFIED. Running the pole blend on
 *     these frames made camera.up race the slerp: the slerp keeps rolling
 *     the basis toward the pole's screen-up while the blend simultaneously
 *     drags camera.up back to +Y over the last ~1° of the arc, so the roll
 *     reversed direction and re-accelerated at the end of Top/Bottom
 *     transitions — the "shaking" reported on cube navigation.
 *  2. Settled poses (transition endpoint or a direct command pose). These
 *     end with camera.up on world +Y (camera-controls' orbit basis stays
 *     world-Y). The pole's horizontal offset that defines the on-screen up
 *     is added only when the pose does not already carry it: transition
 *     endpoints come pre-tilted (baked by the controller), so the settle
 *     frame is a pure hint conversion with zero rendered change.
 */
export function resolveLookAtHint(pos: V3, target: V3, up: V3, settle: boolean): UpResolution {
  const toTarget = sub(target, pos);
  const dist = len(toTarget);
  const f = norm(toTarget);
  const upN = norm(up);
  const dot = upN[0] * f[0] + upN[1] * f[1] + upN[2] * f[2];
  if (Math.abs(dot) >= 1e-6) {
    // Not an orthonormal lookAt basis (external/home pose): full pole
    // resolution, exactly as before.
    return resolveWorldUp(pos, target, up);
  }
  if (!settle) {
    // Intermediate transition/drag sample: keep the interpolated
    // orientation exactly, no pole correction.
    return { pos, up: upN, keptWorldUp: Math.abs(upN[1]) > 0.9999 };
  }
  // Settled navigation pose: re-level the hint to world +Y.
  const pole = Math.abs(f[1]);
  if (pole <= TOP_BLEND_START) {
    return { pos, up: upN, keptWorldUp: Math.abs(upN[1]) > 0.9999 };
  }
  const horizontalLength = Math.hypot(upN[0], upN[2]);
  if (horizontalLength < 1e-6) {
    return { pos, up: [0, 1, 0], keptWorldUp: true };
  }
  const h: V3 = [upN[0] / horizontalLength, 0, upN[2] / horizontalLength];
  const sgn = f[1] < 0 ? -1 : 1;
  // Idempotent tilt: a transition endpoint already carries the offset.
  const along = ((pos[0] - target[0]) * h[0] + (pos[2] - target[2]) * h[2]) / Math.max(dist, 1e-12);
  const resolvedPos: V3 = along > TOP_EPS * 0.5 ? pos : [
    pos[0] + h[0] * sgn * TOP_EPS * dist,
    pos[1],
    pos[2] + h[2] * sgn * TOP_EPS * dist,
  ];
  return { pos: resolvedPos, up: [0, 1, 0], keptWorldUp: true };
}
