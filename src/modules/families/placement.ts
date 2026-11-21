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
  "offsetAlongHost", "rotation",
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

// ── Generic family hosting (Slice 9) ───────────────────────────────────────
// Thin wiring over `family-hosting.ts`: the family-to-instance bridge is
// where a placed element gets its host link. Placement itself is always
// re-derived from the host, never stored as a world point.

import {
  attachFamilyToFace,
  attachFamilyToWall,
  evaluateHostedFamiliesAfterHostChange,
  hostedFamilyPlacement,
  applyHostPlacementToElement,
  detachFamilyFromHost,
  type FamilyHostAttachment,
  type FamilyHostGeometry,
  type FamilyHostPlacement,
} from "./family-hosting";

export type { FamilyHostAttachment, FamilyHostGeometry, FamilyHostPlacement };

/**
 * Host an element on a wall or face from a world point
 * ([x plan, y plan, z elevation]). Derives the attachment AND the
 * placement from the host's current geometry and writes both onto the
 * element. Throws when the point does not fit the host.
 */
export function attachElementToHost(
  element: AuthoredElement,
  host: FamilyHostGeometry,
  point: [number, number, number],
): FamilyHostPlacement {
  const attachment =
    host.kind === "wall" ? attachFamilyToWall(host, point) : attachFamilyToFace(host, point);
  const placement = hostedFamilyPlacement(host, attachment);
  applyHostPlacementToElement(element, attachment, placement);
  return placement;
}

export interface RehostResult {
  /** "moved" when the placement was re-derived and applied, "invalid"
   *  when the attachment no longer fits the edited host, "detached"
   *  when the host is gone (the element keeps its last placement and
   *  loses its host link), "unchanged" when the host did not change. */
  outcome: "moved" | "invalid" | "detached" | "unchanged";
  placement?: FamilyHostPlacement;
  reason?: string;
}

/**
 * Re-evaluate a hosted element after its host was edited (or deleted).
 * The element's attachment keeps its host parameters; only the world
 * placement is re-derived. A host that no longer fits leaves the
 * element where it was and reports invalid; a deleted host detaches
 * it (the element is kept, the audit reports it as orphaned only if
 * the caller keeps the stale link — here the link is dropped).
 */
export function rehostElementAfterHostChange(
  element: AuthoredElement,
  previous: FamilyHostGeometry,
  next: FamilyHostGeometry | null,
): RehostResult {
  const attachment = element.hostAttachment;
  if (!attachment) return { outcome: "unchanged" };
  const result = evaluateHostedFamiliesAfterHostChange(previous, next, [attachment]);
  if (result.kind === "host-deleted") {
    detachFamilyFromHost(element);
    return { outcome: "detached", reason: result.invalid[0]?.reason };
  }
  if (result.invalid.length > 0) {
    return { outcome: "invalid", reason: result.invalid[0].reason };
  }
  if (result.kind === "unchanged") return { outcome: "unchanged" };
  const moved = result.moved[0];
  if (!moved) return { outcome: "unchanged" };
  const fresh: FamilyHostAttachment = {
    ...moved.attachment,
    hostVersion: next!.version,
  } as FamilyHostAttachment;
  applyHostPlacementToElement(element, fresh, moved.placement);
  return { outcome: "moved", placement: moved.placement };
}