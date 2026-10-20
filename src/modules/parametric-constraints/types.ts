/**
 * Parametric constraints — lock dimensions and equality constraints.
 *
 * BIM's parametric engine allows users to lock dimensions so that
 * moving one element doesn't change the locked distance. Equality
 * constraints make a set of dimensions equal (e.g. equal spacing
 * between columns).
 *
 * This module stores constraint metadata. The constraint solver
 * (already in src/features/constraint-solver.ts) applies them during
 * element move/edit operations.
 */

/** Constraint type. */
export type ConstraintType = "locked-dimension" | "equality" | "alignment" | "parallel" | "perpendicular";

/** A parametric constraint. */
export interface ParametricConstraint {
  id: string;
  type: ConstraintType;
  /** Element IDs involved in the constraint. */
  elementIds: string[];
  /** For locked-dimension: the locked value (metres). */
  value?: number;
  /** For equality: the dimension label that must be equal. */
  dimensionLabel?: string;
  /** Whether the constraint is currently active. */
  active: boolean;
  createdAt: number;
}

const constraints: ParametricConstraint[] = [];
let idCounter = 0;

/** Add a locked dimension constraint. */
export function lockDimension(
  elementId1: string,
  elementId2: string,
  value: number,
): ParametricConstraint {
  const c: ParametricConstraint = {
    id: `lock-${++idCounter}`,
    type: "locked-dimension",
    elementIds: [elementId1, elementId2],
    value,
    active: true,
    createdAt: Date.now(),
  };
  constraints.push(c);
  return c;
}

/** Add an equality constraint (make N dimensions equal). */
export function addEquality(
  elementIds: string[],
  dimensionLabel: string,
): ParametricConstraint {
  const c: ParametricConstraint = {
    id: `eq-${++idCounter}`,
    type: "equality",
    elementIds,
    dimensionLabel,
    active: true,
    createdAt: Date.now(),
  };
  constraints.push(c);
  return c;
}

/** Add an alignment constraint (align two elements). */
export function addAlignment(
  elementId1: string,
  elementId2: string,
): ParametricConstraint {
  const c: ParametricConstraint = {
    id: `align-${++idCounter}`,
    type: "alignment",
    elementIds: [elementId1, elementId2],
    active: true,
    createdAt: Date.now(),
  };
  constraints.push(c);
  return c;
}

/** Get all constraints for an element. */
export function getConstraints(elementId: string): ParametricConstraint[] {
  return constraints.filter((c) => c.elementIds.includes(elementId) && c.active);
}

/** Get all constraints. */
export function getAllConstraints(): ParametricConstraint[] {
  return constraints;
}

/** Remove a constraint. */
export function removeConstraint(id: string): void {
  const idx = constraints.findIndex((c) => c.id === id);
  if (idx >= 0) constraints.splice(idx, 1);
}

/** Toggle a constraint's active state. */
export function toggleConstraint(id: string): boolean {
  const c = constraints.find((c) => c.id === id);
  if (c) c.active = !c.active;
  return c?.active ?? false;
}

/** Check if a dimension between two elements is locked. */
export function isLocked(elementId1: string, elementId2: string): boolean {
  return constraints.some(
    (c) => c.type === "locked-dimension" && c.active &&
      c.elementIds.includes(elementId1) && c.elementIds.includes(elementId2),
  );
}

/** Get the locked value for a dimension between two elements (null if not locked). */
export function getLockedValue(elementId1: string, elementId2: string): number | null {
  const c = constraints.find(
    (c) => c.type === "locked-dimension" && c.active &&
      c.elementIds.includes(elementId1) && c.elementIds.includes(elementId2),
  );
  return c?.value ?? null;
}
