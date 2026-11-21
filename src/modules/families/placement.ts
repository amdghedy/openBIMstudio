// openbim-family-placement
// Family-to-instance bridge.
//
// Owns two things:
//   1. When a family is active, which parameters should a NEW element be
//      born with? Precedence: family default < type override < caller
//      override. Only geometry-shaped keys reach element.params; anything
//      else (formulas, derived values, labels) stays in the family.
//   2. When the user edits a single parameter on a family-backed element,
//      does that edit belong to the instance or to the type? Instance
//      edits touch this element only; type edits update the family type
//      and re-sync every instance of that type.

import { ctx } from "../../core/context";
import type { AuthoredElement } from "../projects/types";
import type { FamilyService, FamilyParameter } from "./types";
import { extractInstanceOverrides } from "./parametric-engine";

/**
 * Keys that AuthoredElement.params actually stores. Anything outside
 * this set is a family-level concept and must not pollute the element.
 */
export const GEOMETRY_KEYS: readonly string[] = [
  "height", "thickness", "width", "depth",
  "elevation", "sillHeight", "frameThickness",
  "offsetAlongHost",
];

export interface PlacementParams {
  /** Filtered to geometry keys only. */
  params: Partial<AuthoredElement["params"]>;
  /** Full resolved map, including non-geometry parameters. */
  resolved: Record<string, any>;
}

function familyService(): FamilyService | null {
  const svc = (ctx.features as any)?.family as FamilyService | undefined;
  return svc ?? null;
}

/**
 * Resolve placement parameters for a new element.
 * Returns null if the family system is not ready.
 */
export function resolvePlacement(
  familyId: string,
  familyTypeId: string | null,
  callerOverrides?: Record<string, any>,
): PlacementParams | null {
  const svc = familyService();
  if (!svc) return null;
  const resolved = svc.resolveParams(familyId, familyTypeId, callerOverrides);
  if (!resolved) return null;

  const params: Record<string, any> = {};
  for (const key of GEOMETRY_KEYS) {
    const v = resolved[key];
    if (typeof v === "number" && Number.isFinite(v)) params[key] = v;
  }
  return { params: params as Partial<AuthoredElement["params"]>, resolved };
}

/**
 * Apply a resolved parameter map to an existing element instance.
 * Only geometry keys are touched. Returns true if anything changed.
 */
export function applyResolvedParams(
  element: AuthoredElement,
  resolved: Record<string, any>,
): boolean {
  let changed = false;
  const p = element.params as Record<string, any>;
  for (const key of GEOMETRY_KEYS) {
    const v = resolved[key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    if (p[key] !== v) { p[key] = v; changed = true; }
  }
  return changed;
}

export interface EditResult {
  applied: "instance" | "type" | "none";
  instancesSynced: number;
  /** Why the edit did not apply, when `applied` is "none". */
  reason?: string;
}

/**
 * Route a single parameter edit to the right place based on the
 * family's declared scope for that parameter.
 */
export function editFamilyParameter(
  element: AuthoredElement,
  paramName: string,
  value: any,
): EditResult {
  const svc = familyService();
  if (!svc || !element.familyId) return { applied: "none", instancesSynced: 0 };

  const family = svc.get(element.familyId);
  if (!family) return { applied: "none", instancesSynced: 0 };

  const param = family.parameters.find((p: FamilyParameter) => p.name === paramName);
  if (!param) return { applied: "none", instancesSynced: 0 };

  if (param.scope === "instance") {
    (element.params as Record<string, any>)[paramName] = value;
    return { applied: "instance", instancesSynced: 0 };
  }

  // Type-scope edit. The explicit check (rather than a fall-through) keeps
  // the two-valued ParameterScope enum honest: a future third scope value
  // will hit the trailing "none" return instead of silently being treated
  // as a type edit.
  if (param.scope === "type") {
    const typeId = element.familyTypeId;
    if (!typeId) {
      // No type to edit: report it instead of silently degrading to an
      // instance write. Nothing is written.
      return {
        applied: "none",
        instancesSynced: 0,
        reason: "no family type assigned to this element",
      };
    }

    const familyType = family.types.find((t) => t.id === typeId);
    if (!familyType) {
      return {
        applied: "none",
        instancesSynced: 0,
        reason: "family type not found",
      };
    }

    // Capture every target instance's stored overrides BEFORE the type
    // changes. An override is a stored geometry value that differs from
    // what the type currently resolves to; comparing after the update
    // would misread stale inherited values as overrides and freeze them.
    // The re-sync below then re-resolves each instance from the new type
    // values with its own overrides on top, so overrides survive the
    // type edit (A3).
    const auth: any = (ctx.features as any).authoring;
    let overridesByElement: Map<string, Record<string, any>> | null = null;
    const currentResolved = svc.resolveParams(family.id, typeId);
    const siblings: AuthoredElement[] = auth?.getElements?.() ?? [];
    if (currentResolved && siblings.length) {
      const captured = new Map<string, Record<string, any>>();
      for (const sibling of siblings) {
        if (sibling.familyId !== family.id) continue;
        if (sibling.familyTypeId !== typeId) continue;
        const ov = extractInstanceOverrides(
          currentResolved,
          (sibling.params ?? {}) as Record<string, any>,
          GEOMETRY_KEYS,
        );
        if (Object.keys(ov).length) captured.set(sibling.id, ov);
      }
      overridesByElement = captured;
    }

    const nextValues = { ...(familyType.values ?? {}), [paramName]: value };
    svc.updateType(family.id, typeId, { values: nextValues });

    // Re-resolve every instance of this type, preserving the overrides
    // captured above.
    const instancesSynced = auth?.syncFamilyInstances?.(
      family.id,
      typeId,
      overridesByElement,
    ) ?? 0;

    return { applied: "type", instancesSynced };
  }

  return { applied: "none", instancesSynced: 0 };
}