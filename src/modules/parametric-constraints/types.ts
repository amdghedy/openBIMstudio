/**
 * Parametric constraints — lock dimensions and equality constraints.
 *
 * BIM's parametric engine allows users to lock dimensions so that
 * moving one element doesn't change the locked distance. Equality
 * constraints make a set of dimensions equal (e.g. equal spacing
 * between columns).
 *
 * This module stores constraint metadata. The solver bridge
 * (solver-bridge.ts) converts it into equations for the numeric geometric
 * solver (src/modules/constraints/solver.ts); the [S] solve button in
 * src/features/constraint-solver.ts runs that bridge over the authoring
 * model, so locked dimensions survive element moves and edits.
 *
 * (Historical note: this comment used to claim the old
 * features/constraint-solver.ts applied these constraints — it did not;
 * they were dead metadata until the bridge landed.)
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

/** Add a parallel constraint (two linear elements stay parallel). */
export function addParallel(
  elementId1: string,
  elementId2: string,
): ParametricConstraint {
  const c: ParametricConstraint = {
    id: `par-${++idCounter}`,
    type: "parallel",
    elementIds: [elementId1, elementId2],
    active: true,
    createdAt: Date.now(),
  };
  constraints.push(c);
  return c;
}

/** Add a perpendicular constraint (two linear elements stay at 90°). */
export function addPerpendicular(
  elementId1: string,
  elementId2: string,
): ParametricConstraint {
  const c: ParametricConstraint = {
    id: `perp-${++idCounter}`,
    type: "perpendicular",
    elementIds: [elementId1, elementId2],
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

// ── Persistence (project save / restore) ─────────────────────────────────
// The store is module state; ProjectDoc carries a serialized copy so locked
// dimensions and equality/alignment constraints survive a reload.

const CONSTRAINT_TYPES: ConstraintType[] = ["locked-dimension", "equality", "alignment", "parallel", "perpendicular"];

/** Deep copy of the current constraints, ready for `ProjectDoc.parametricConstraints`. */
export function exportConstraints(): ParametricConstraint[] {
  return constraints.map((c) => ({ ...c, elementIds: [...c.elementIds] }));
}

/**
 * Replace the whole store from a persisted payload. Malformed entries are
 * dropped (counted in the return value's complement — this returns how many
 * were imported). Re-importing an export round-trips exactly.
 */
export function importConstraints(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  const next: ParametricConstraint[] = [];
  for (const raw of list) {
    const r = raw as Record<string, unknown> | null;
    const type = r?.type as ConstraintType;
    const elementIds = Array.isArray(r?.elementIds) ? (r!.elementIds as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (!CONSTRAINT_TYPES.includes(type) || elementIds.length === 0) continue;
    if (type === "locked-dimension" && (elementIds.length < 2 || !Number.isFinite(Number(r?.value)))) continue;
    next.push({
      id: typeof r?.id === "string" && r.id ? r.id : `c-${++idCounter}-${Date.now().toString(36)}`,
      type,
      elementIds,
      value: Number.isFinite(Number(r?.value)) ? Number(r!.value) : undefined,
      dimensionLabel: typeof r?.dimensionLabel === "string" ? r!.dimensionLabel as string : undefined,
      active: r?.active !== false,
      createdAt: Number.isFinite(Number(r?.createdAt)) ? Number(r!.createdAt) : Date.now(),
    });
  }
  constraints.length = 0;
  constraints.push(...next);
  return next.length;
}

/** Drop every constraint (used before a fresh import and by tests). */
export function clearConstraints(): void {
  constraints.length = 0;
}
