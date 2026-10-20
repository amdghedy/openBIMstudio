/**
 * Dimension chains — continuous + baseline dimension strings.
 *
 * BIM's dimension tools include:
 *   - Aligned: single dimension between two points (already exists)
 *   - Linear: horizontal/vertical dimension (already exists)
 *   - Angular, Radial, Diameter, Spot (already exist)
 *
 * MISSING:
 *   - Continuous: a chain of dimensions placed end-to-end
 *     (A→B→C→D = three dimensions sharing endpoints)
 *   - Baseline: multiple dimensions from a common baseline
 *     (A→B, A→C, A→D = three dimensions from A)
 *
 * This module generates the intermediate dimension references needed
 * to create a chain from a series of picked points.
 */

import type { Reference } from "../views/references";
import type { Dimension } from "../views/annotations";

/**
 * Create a continuous dimension chain from a series of references.
 *
 * Given references [R0, R1, R2, R3], creates dimensions:
 *   D0: R0 → R1
 *   D1: R1 → R2
 *   D2: R2 → R3
 *
 * All dimensions share the same offset (perpendicular distance from
 * the dimension line to the references) and style.
 *
 * @param viewId - the view to create dimensions in
 * @param refs - ordered references (minimum 2)
 * @param offsetMm - perpendicular offset in mm
 * @param styleId - dimension style ID
 * @returns array of Dimension objects (one per segment)
 */
export function createContinuousChain(
  viewId: string,
  refs: Reference[],
  offsetMm: number,
  styleId: string = "aligned-mm",
): Dimension[] {
  if (refs.length < 2) return [];
  const dims: Dimension[] = [];
  const now = Date.now();
  for (let i = 0; i < refs.length - 1; i++) {
    dims.push({
      id: `chain-cont-${now}-${i}`,
      viewId,
      kind: "aligned",
      styleId,
      ref1: refs[i],
      ref2: refs[i + 1],
      offsetMm,
      createdAt: now + i,
    });
  }
  return dims;
}

/**
 * Create a baseline dimension string from a series of references.
 *
 * Given references [R0, R1, R2, R3] where R0 is the baseline, creates
 * dimensions:
 *   D0: R0 → R1 (offset = baseOffset)
 *   D1: R0 → R2 (offset = baseOffset + stepMm)
 *   D2: R0 → R3 (offset = baseOffset + 2 * stepMm)
 *
 * Each dimension is placed at a progressively larger offset so they
 * don't overlap visually.
 *
 * @param viewId - the view
 * @param baselineRef - the baseline reference (R0)
 * @param refs - references to dimension from baseline [R1, R2, R3, ...]
 * @param baseOffsetMm - first dimension offset in mm
 * @param stepMm - additional offset per dimension (to stack them)
 * @param styleId - dimension style ID
 * @returns array of Dimension objects
 */
export function createBaselineChain(
  viewId: string,
  baselineRef: Reference,
  refs: Reference[],
  baseOffsetMm: number = 10,
  stepMm: number = 8,
  styleId: string = "aligned-mm",
): Dimension[] {
  if (!refs.length) return [];
  const dims: Dimension[] = [];
  const now = Date.now();
  for (let i = 0; i < refs.length; i++) {
    dims.push({
      id: `chain-base-${now}-${i}`,
      viewId,
      kind: "aligned",
      styleId,
      ref1: baselineRef,
      ref2: refs[i],
      offsetMm: baseOffsetMm + i * stepMm,
      createdAt: now + i,
    });
  }
  return dims;
}

/**
 * Compute the total length of a continuous chain.
 * Useful for showing the overall dimension value.
 */
export function chainTotalLength(dims: Dimension[]): number {
  // This would need to resolve the references to actual world coordinates
  // to compute lengths. For now, return the count as a metadata value.
  return dims.length;
}
