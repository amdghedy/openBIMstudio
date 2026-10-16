/**
 * Hit-testing in the 2D view plane.
 *
 * Given a world-space 2D point (x, z), find the nearest reference-able
 * feature of any element: an endpoint, the center axis, or a face offset.
 * Returns a Reference (see references.ts) or null.
 *
 * Called from the interaction tools. Never called during rendering.
 */

import type { AuthoredElement } from "../projects/types";
import { makeReference, type Reference } from "./references";

export interface PickOptions {
  /** Maximum distance in world metres. */
  tolerance: number;
  /** Which feature kinds to allow. Default: all. */
  kinds?: Array<"endpoint" | "center" | "face">;
}

export function pickReference(
  elements: readonly AuthoredElement[],
  x: number,
  z: number,
  opts: PickOptions,
): Reference | null {
  const allowed = new Set(opts.kinds ?? ["endpoint", "center", "face"]);
  const tol = Math.max(0.01, opts.tolerance);

  let best: { ref: Reference; dist: number } | null = null;
  const consider = (ref: Reference, dist: number) => {
    if (dist <= tol && (!best || dist < best.dist)) best = { ref, dist };
  };

  for (const el of elements) {
    const p = el.params;

    if (p.start && p.end) {
      const [ax, az] = p.start;
      const [bx, bz] = p.end;

      if (allowed.has("endpoint")) {
        consider(
          makeReference("element-endpoint", el.id, { endpointIndex: 0 }),
          Math.hypot(x - ax, z - az),
        );
        consider(
          makeReference("element-endpoint", el.id, { endpointIndex: 1 }),
          Math.hypot(x - bx, z - bz),
        );
      }

      const cx = (ax + bx) / 2;
      const cz = (az + bz) / 2;

      if (allowed.has("center")) {
        consider(makeReference("element-center", el.id), Math.hypot(x - cx, z - cz));
      }

      if (allowed.has("face")) {
        const dx = bx - ax;
        const dz = bz - az;
        const L = Math.hypot(dx, dz) || 1;
        const nx = -dz / L;
        const nz = dx / L;
        const half = (p.thickness ?? 0.2) / 2;
        for (let side = 0; side < 2; side++) {
          const sign = side === 0 ? 1 : -1;
          const fx = cx + nx * half * sign;
          const fz = cz + nz * half * sign;
          consider(
            makeReference("element-face", el.id, { faceIndex: side }),
            Math.hypot(x - fx, z - fz),
          );
        }
      }
    } else if (p.point) {
      if (allowed.has("center")) {
        consider(
          makeReference("element-center", el.id),
          Math.hypot(x - p.point[0], z - p.point[1]),
        );
      }
    }
  }

  return best ? (best as { ref: Reference }).ref : null;
}