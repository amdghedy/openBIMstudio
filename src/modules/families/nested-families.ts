/**
 * Nested family resolution.
 *
 * A nested family is a FamilyDefinition embedded inside another family's
 * geometry tree (kind: "nested"). Parameter maps bind parent parameters
 * (or constants) onto the child's instance overrides - the same model
 * Revit uses for nested shared / non-shared families.
 */

import type { FamilyDefinition, FamilyType, NumberRef } from "./types";

export interface NestedFamilyRef {
  familyId: string;
  typeId?: string | null;
  /** parentParamName - childParamName  OR  childParamName - NumberRef */
  paramMap?: Record<string, string | NumberRef>;
  /** When true, nested instance is shared (schedulable as its own type). */
  shared?: boolean;
  label?: string;
}

export interface ResolvedNested {
  family: FamilyDefinition;
  type: FamilyType | null;
  overrides: Record<string, any>;
  shared: boolean;
  label: string;
}

type FamilyLookup = (id: string) => FamilyDefinition | null;
type TypeLookup = (familyId: string, typeId: string) => FamilyType | null;

function resolveRef(
  ref: string | NumberRef,
  parentParams: Record<string, any>,
): any {
  if (typeof ref === "string") {
    return parentParams[ref];
  }
  if ("const" in ref) return (ref as { const: number }).const;
  if ("ref" in ref) return parentParams[(ref as { ref: string }).ref];
  if ("expr" in ref) return parentParams[(ref as { expr: string }).expr];
  return undefined;
}

/**
 * Resolve a nested family reference against parent parameters.
 * Returns null when the target family cannot be found.
 */
export function resolveNested(
  ref: NestedFamilyRef,
  parentParams: Record<string, any>,
  familyLookup: FamilyLookup,
  typeLookup?: TypeLookup,
): ResolvedNested | null {
  const family = familyLookup(ref.familyId);
  if (!family) return null;

  const type =
    ref.typeId && typeLookup
      ? typeLookup(ref.familyId, ref.typeId) ?? null
      : ref.typeId
        ? family.types.find((t) => t.id === ref.typeId) ?? null
        : null;

  const overrides: Record<string, any> = {};
  if (ref.paramMap) {
    for (const [key, binding] of Object.entries(ref.paramMap)) {
      // Convention: key is the CHILD parameter name.
      overrides[key] = resolveRef(binding, parentParams);
    }
  }

  return {
    family,
    type,
    overrides,
    shared: !!ref.shared,
    label: ref.label ?? family.name,
  };
}

/**
 * Collect every nested family id referenced by a geometry tree (depth-first).
 * Useful for load-order / dependency graphs.
 */
export function collectNestedFamilyIds(
  geometry: any,
  out: Set<string> = new Set(),
): Set<string> {
  if (!geometry || typeof geometry !== "object") return out;
  if (geometry.kind === "nested" && typeof geometry.familyId === "string") {
    out.add(geometry.familyId);
  }
  if (geometry.kind === "composed" && Array.isArray(geometry.parts)) {
    for (const p of geometry.parts) collectNestedFamilyIds(p, out);
  }
  if (geometry.kind === "array" && geometry.of) {
    collectNestedFamilyIds(geometry.of, out);
  }
  if (geometry.kind === "conditional") {
    if (geometry.then) collectNestedFamilyIds(geometry.then, out);
    if (geometry.else) collectNestedFamilyIds(geometry.else, out);
  }
  if (geometry.kind === "void" && geometry.solid) {
    collectNestedFamilyIds(geometry.solid, out);
  }
  return out;
}
