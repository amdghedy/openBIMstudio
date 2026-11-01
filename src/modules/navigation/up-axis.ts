/** Keep the camera's up vector on world +Y for axis-aligned views (pure, tuple based).
 *
 *  camera-controls orbits around the up axis it captured, so leaving `camera.up` at (0,0,-1) after
 *  a Top view makes every later manual rotation swap/roll the axes. Instead we keep up = +Y and
 *  get the same screen orientation by offsetting the camera a hair (EPS rad) horizontally,
 *  which is what picks the on-screen "up" direction for a straight-down / straight-up view. */
export type V3 = [number, number, number];
export const TOP_EPS = 1e-3;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

export interface UpResolution { pos: V3; up: V3; keptWorldUp: boolean }

export function resolveWorldUp(pos: V3, target: V3, up: V3): UpResolution {
  const f = norm(sub(target, pos));                // view direction
  const upN = norm(up);
  const s = f[1];                                  // component of the view direction along +Y
  const alreadyY = Math.abs(upN[1]) > 0.9999;
  if (alreadyY) return { pos, up: [0, 1, 0], keptWorldUp: true };
  if (Math.abs(s) > 0.999) {
    // straight down / up: horizontal part of the wanted screen-up
    const h = norm([upN[0], 0, upN[2]]);
    if (Math.hypot(upN[0], upN[2]) < 1e-6) return { pos, up: [0, 1, 0], keptWorldUp: true };
    const dist = len(sub(target, pos));
    const sgn = s < 0 ? -1 : 1;                    // top view: s = -1 -> camera offset = -u
    const o: V3 = [h[0] * sgn * TOP_EPS * dist, 0, h[2] * sgn * TOP_EPS * dist];
    return { pos: [pos[0] + o[0], pos[1], pos[2] + o[2]], up: [0, 1, 0], keptWorldUp: true };
  }
  // oblique custom view: honour the requested up (caller refreshes the controls' up axis)
  return { pos, up: upN, keptWorldUp: false };
}

/** Screen-up direction produced by a three.js lookAt with world up +Y (for verification). */
export function screenUp(pos: V3, target: V3): V3 {
  const f = norm(sub(target, pos));
  const d = f[1];
  return norm([-d * f[0], 1 - d * f[1], -d * f[2]]);
}
