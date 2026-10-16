/**
 * Reference system â€” the thing that makes Revit dimensions follow walls.
 *
 * A Reference is an abstract pointer to a *feature* of an element:
 *   "the exterior face of Wall-4A"
 *   "the center axis of Column-C3"
 *   "the left end of Beam-B2"
 *
 * Dimensions and tags attach to References, not to coordinates. When the
 * element moves, the reference re-resolves and the annotation follows.
 */

import type { AuthoredElement } from "../projects/types";

export type ReferenceKind =
  | "element-face"
  | "element-axis"
  | "element-endpoint"
  | "element-center"
  | "grid"
  | "level"
  | "work-plane"
  | "hosted"
  | "opening";

export interface Reference {
  id: string;
  kind: ReferenceKind;
  elementId: string;
  faceIndex?: number;
  endpointIndex?: 0 | 1;
  side?: "left" | "right" | "top" | "bottom";
  feature?: string;
  cachedPosition?: [number, number, number];
  cachedDirection?: [number, number, number];
  valid: boolean;
}

let seq = 0;
export function makeReference(
  kind: ReferenceKind,
  elementId: string,
  extra: Partial<Reference> = {},
): Reference {
  seq += 1;
  return {
    id: `ref-${Date.now().toString(36)}-${seq}`,
    kind,
    elementId,
    valid: false,
    ...extra,
  };
}

export function resolveReference(
  ref: Reference,
  elements: readonly AuthoredElement[],
): [number, number, number] | null {
  const el = elements.find((e) => e.id === ref.elementId);
  if (!el) {
    ref.valid = false;
    return null;
  }
  const p = el.params;

  if (ref.kind === "element-endpoint" && p.start && p.end) {
    const pt = ref.endpointIndex === 0 ? p.start : p.end;
    return [pt[0], p.elevation, pt[1]];
  }
  if (ref.kind === "element-center") {
    if (p.start && p.end) return [(p.start[0] + p.end[0]) / 2, p.elevation, (p.start[1] + p.end[1]) / 2];
    if (p.point) return [p.point[0], p.elevation, p.point[1]];
  }
  if (ref.kind === "element-axis") {
    if (p.start && p.end) return [(p.start[0] + p.end[0]) / 2, p.elevation, (p.start[1] + p.end[1]) / 2];
    if (p.point) return [p.point[0], p.elevation, p.point[1]];
  }
  if (ref.kind === "element-face" && p.start && p.end) {
    const dx = p.end[0] - p.start[0];
    const dz = p.end[1] - p.start[1];
    const L = Math.hypot(dx, dz) || 1;
    const nx = -dz / L;
    const nz = dx / L;
    const half = (p.thickness ?? 0.2) / 2;
    const side = (ref.faceIndex ?? 0) === 0 ? 1 : -1;
    const mx = (p.start[0] + p.end[0]) / 2;
    const mz = (p.start[1] + p.end[1]) / 2;
    return [mx + nx * half * side, p.elevation, mz + nz * half * side];
  }
  return null;
}

export function invalidateReferences(refs: Reference[]): void {
  for (const r of refs) {
    r.cachedPosition = undefined;
    r.cachedDirection = undefined;
    r.valid = false;
  }
}