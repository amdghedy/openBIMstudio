/**
 * Model curves on faces — draw 2D curves on element faces and use them
 * for push-pull (extrude) or hosted element placement.
 *
 * BIM's "Model Lines" feature lets users draw lines on any face of
 * a 3D element. These lines can then be used to:
 *   - Create hosted elements (doors, windows) along the line
 *   - Push-pull the face along the curve to create geometry
 *   - Serve as reference for dimensions and alignment
 *
 * This module stores model curves per element face and exposes them
 * for the push-pull and hosted-placement tools.
 */

/** A model curve on a face. */
export interface ModelCurve {
  id: string;
  /** Host element ID (the element whose face the curve is drawn on). */
  hostElementId: string;
  /** Face index on the host element (which face). */
  faceIndex: number;
  /** 2D points on the face (UV coordinates in metres, relative to face origin). */
  points: Array<[number, number]>;
  /** Whether the curve is closed (polygon) or open (polyline). */
  closed: boolean;
  /** Color. */
  color: string;
  /** Created timestamp. */
  createdAt: number;
}

/** All model curves, keyed by host element ID. */
const curvesByElement = new Map<string, ModelCurve[]>();

let curveIdCounter = 0;

/** Add a model curve to an element's face. */
export function addModelCurve(
  hostElementId: string,
  faceIndex: number,
  points: Array<[number, number]>,
  closed: boolean = false,
  color: string = "#f59e0b",
): ModelCurve {
  const curve: ModelCurve = {
    id: `mc-${++curveIdCounter}`,
    hostElementId,
    faceIndex,
    points,
    closed,
    color,
    createdAt: Date.now(),
  };
  const arr = curvesByElement.get(hostElementId) ?? [];
  arr.push(curve);
  curvesByElement.set(hostElementId, arr);
  return curve;
}

/** Get all model curves for an element (optionally filtered by face). */
export function getModelCurves(
  hostElementId: string,
  faceIndex?: number,
): ModelCurve[] {
  const arr = curvesByElement.get(hostElementId) ?? [];
  if (faceIndex !== undefined) return arr.filter((c) => c.faceIndex === faceIndex);
  return arr;
}

/** Remove a model curve by ID. */
export function removeModelCurve(hostElementId: string, curveId: string): void {
  const arr = curvesByElement.get(hostElementId);
  if (!arr) return;
  curvesByElement.set(hostElementId, arr.filter((c) => c.id !== curveId));
}

/** Remove all model curves for an element. */
export function clearModelCurves(hostElementId: string): void {
  curvesByElement.delete(hostElementId);
}

/** Get all elements that have model curves. */
export function listElementsWithCurves(): string[] {
  return [...curvesByElement.keys()];
}

/** Check if an element has any model curves. */
export function hasModelCurves(hostElementId: string): boolean {
  const arr = curvesByElement.get(hostElementId);
  return !!arr && arr.length > 0;
}

/**
 * Convert a model curve's UV points to 3D world points on the face.
 *
 * @param curve - the model curve
 * @param faceOrigin - world [x, y, z] of the face's UV origin
 * @param faceU - world direction of the face's U axis [dx, dy, dz]
 * @param faceV - world direction of the face's V axis [dx, dy, dz]
 * @returns 3D world points
 */
export function curveToWorld3D(
  curve: ModelCurve,
  faceOrigin: [number, number, number],
  faceU: [number, number, number],
  faceV: [number, number, number],
): Array<[number, number, number]> {
  return curve.points.map(([u, v]) => [
    faceOrigin[0] + u * faceU[0] + v * faceV[0],
    faceOrigin[1] + u * faceU[1] + v * faceV[1],
    faceOrigin[2] + u * faceU[2] + v * faceV[2],
  ]);
}
