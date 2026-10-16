/**
 * Parametric array expansion.
 *
 * Turns an ArraySpec + resolved parameter map into a list of concrete
 * transform instances. Used by the parametric engine's "array" geometry
 * kind and by authoring when placing arrayed hosted elements (e.g. studs,
 * mullions, light fixtures).
 */

import type { NumberRef } from "./types";

export interface ArraySpec {
  /** Number of instances (resolved from NumberRef). */
  count: NumberRef;
  /** Linear step [dx, dy, dz] in metres. */
  step: [NumberRef, NumberRef, NumberRef];
  /** Optional angular step [rx, ry, rz] in radians. */
  rotateStep?: [NumberRef, NumberRef, NumberRef];
  /** Optional scale step [sx, sy, sz] (multiplicative per index). */
  scaleStep?: [NumberRef, NumberRef, NumberRef];
  /** Group spacing: every `groupSize` instances add `groupGap` extra translation. */
  groupSize?: NumberRef;
  groupGap?: [NumberRef, NumberRef, NumberRef];
  /** Mirror every other instance around the local Y axis. */
  alternateMirror?: boolean;
}

export interface ExpandedPart {
  index: number;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  mirrored: boolean;
}

type Resolve = (ref: NumberRef) => number;

/**
 * Expand an ArraySpec into concrete instance transforms.
 * Count is clamped to [0, 10_000] to protect the renderer.
 */
export function expandArrays(spec: ArraySpec, resolve: Resolve): ExpandedPart[] {
  const rawCount = Math.floor(resolve(spec.count));
  const count = Math.max(0, Math.min(10_000, rawCount));
  if (count === 0) return [];

  const dx = resolve(spec.step[0]);
  const dy = resolve(spec.step[1]);
  const dz = resolve(spec.step[2]);

  const rx = spec.rotateStep ? resolve(spec.rotateStep[0]) : 0;
  const ry = spec.rotateStep ? resolve(spec.rotateStep[1]) : 0;
  const rz = spec.rotateStep ? resolve(spec.rotateStep[2]) : 0;

  const sx = spec.scaleStep ? resolve(spec.scaleStep[0]) : 1;
  const sy = spec.scaleStep ? resolve(spec.scaleStep[1]) : 1;
  const sz = spec.scaleStep ? resolve(spec.scaleStep[2]) : 1;

  const groupSize = spec.groupSize ? Math.max(1, Math.floor(resolve(spec.groupSize))) : 0;
  const gx = spec.groupGap ? resolve(spec.groupGap[0]) : 0;
  const gy = spec.groupGap ? resolve(spec.groupGap[1]) : 0;
  const gz = spec.groupGap ? resolve(spec.groupGap[2]) : 0;

  const parts: ExpandedPart[] = [];
  for (let i = 0; i < count; i++) {
    const groupsBefore = groupSize > 0 ? Math.floor(i / groupSize) : 0;
    parts.push({
      index: i,
      position: [
        dx * i + gx * groupsBefore,
        dy * i + gy * groupsBefore,
        dz * i + gz * groupsBefore,
      ],
      rotation: [rx * i, ry * i, rz * i],
      scale: [
        Math.pow(sx, i),
        Math.pow(sy, i),
        Math.pow(sz, i),
      ],
      mirrored: !!(spec.alternateMirror && i % 2 === 1),
    });
  }
  return parts;
}
