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
import type * as THREE from "three";
import type { MepConnector } from "../mep/connectors";
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
/**
 * Derive the selected family type's MEP ports after its rendered instance
 * exists. The family service transforms local definitions through the
 * instance world matrix; callers can register the result with MepModelLifecycle.
 */
export function resolvePlacementConnectors(
  ownerElementId: string,
  familyId: string,
  familyTypeId: string | null,
  instanceObject: THREE.Object3D,
): MepConnector[] | null {
  const svc = familyService();
  if (!svc?.buildConnectors) return null;
  return svc.buildConnectors(ownerElementId, familyId, familyTypeId, instanceObject);
}

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
export interface SwapResult {
  /** False when nothing changed (same type, or no family/service). */
  swapped: boolean;
  instancesSynced: number;
}

/**
 * Swap one element's family type, preserving instance overrides.
 *
 * This is the type-swap counterpart of the Slice 1 type-edit fix: the
 * property palette used to set `element.familyTypeId` and call
 * `syncFamilyInstances(familyId, newTypeId)` with no override map, so a
 * swap wiped the swapped element's overrides (and, for instances already
 * on the new type, their overrides too — the sync re-resolved them from
 * the type alone).
 *
 * Overrides are captured BEFORE the type changes, against the type each
 * instance was last synced against: the swapped element against the
 * PREVIOUS type's resolution (comparing after the swap would misread its
 * stale inherited values as overrides and freeze them), every other
 * sibling against its own current type's resolution. A swapped element
 * with no previous type had nothing to inherit from, so an override is
 * a stored value that differs from the family default.
 * The re-sync then re-resolves each instance of the new type from the
 * new type values with its own overrides on top.
 *
 * Undo is the same operation in reverse: `applyType(prevType)` captures
 * against the type being left, so an override survives a swap and its
 * revert.
 */
export function swapFamilyType(
  element: AuthoredElement,
  newTypeId: string | null,
): SwapResult {
  const svc = familyService();
  if (!svc || !element.familyId) return { swapped: false, instancesSynced: 0 };

  const family = svc.get(element.familyId);
  if (!family) return { swapped: false, instancesSynced: 0 };

  const prevTypeId = element.familyTypeId ?? null;
  if (newTypeId === prevTypeId) return { swapped: false, instancesSynced: 0 };

  const auth: any = (ctx.features as any).authoring;
  const siblings: AuthoredElement[] = auth?.getElements?.() ?? [];

  const overridesByElement = new Map<string, Record<string, any>>();
  const prevResolved = prevTypeId ? svc.resolveParams(family.id, prevTypeId) : null;
  for (const sibling of siblings) {
    if (sibling.familyId !== family.id) continue;
    if (sibling.id === element.id) {
      if (prevResolved) {
        const ov = extractInstanceOverrides(
          prevResolved,
          (sibling.params ?? {}) as Record<string, any>,
          GEOMETRY_KEYS,
        );
        if (Object.keys(ov).length) overridesByElement.set(sibling.id, ov);
      } else {
        // Typeless element: nothing was inherited, so an override is a
        // stored value that differs from the family default — values
        // equal to the defaults are not user-set and must adopt the new
        // type instead of being frozen in place.
        const defaults: Record<string, any> = {};
        for (const p of family.parameters) {
          if (typeof p.default === "number") defaults[p.name] = p.default;
        }
        const ov = extractInstanceOverrides(
          defaults,
          (sibling.params ?? {}) as Record<string, any>,
          GEOMETRY_KEYS,
        );
        if (Object.keys(ov).length) overridesByElement.set(sibling.id, ov);
      }
      continue;
    }
    // Any other instance that the sync will touch (same family, on the
    // new type — or every family instance when swapping to no type) keeps
    // its overrides against its own current type.
    const ownTypeId = sibling.familyTypeId ?? null;
    if (newTypeId !== null && ownTypeId !== newTypeId) continue;
    const ownResolved = ownTypeId ? svc.resolveParams(family.id, ownTypeId) : null;
    if (!ownResolved) continue;
    const ov = extractInstanceOverrides(
      ownResolved,
      (sibling.params ?? {}) as Record<string, any>,
      GEOMETRY_KEYS,
    );
    if (Object.keys(ov).length) overridesByElement.set(sibling.id, ov);
  }

  element.familyTypeId = newTypeId ?? undefined;
  const instancesSynced = auth?.syncFamilyInstances?.(
    family.id,
    newTypeId,
    overridesByElement,
  ) ?? 0;
  return { swapped: true, instancesSynced };
}

/**
 * Capture per-instance overrides for a manual "Sync instances" action
 * (family-browser button), so the sync re-resolves from the current type
 * without wiping them.
 *
 * Each target instance's stored geometry values are compared against
 * what its type resolves to *right now*, via `extractInstanceOverrides`
 * — the same delta Slice 1 uses for type edits, except the comparison
 * here is against the current type (there is no pre-change type to
 * compare against on a manual sync). Only keys that can legitimately
 * carry a per-instance override are captured:
 *
 *   - instance-scope family parameters (e.g. `thickness`, `elevation`),
 *     and geometry keys the family does not declare at all
 *     (placement-level values, per-instance by nature);
 *   - a type-scope parameter is NEVER captured. `editFamilyParameter`
 *     routes type-scope edits to the type, so no UI path ever writes a
 *     type-scope value onto an instance: a stored type-scope value that
 *     differs from the current type resolution is a stale inherited
 *     value (the type changed out-of-band, e.g. via a catalog import),
 *     not an override. Capturing it would freeze the stale value and
 *     make the manual sync a no-op for exactly the keys it exists to
 *     refresh.
 *
 * Residual limit (inherent without a separate override record on the
 * element, as Slice 1 already noted): an instance-scope key whose *type*
 * value changed out-of-band, on an instance the user never overrode,
 * is indistinguishable from a genuine override and is preserved rather
 * than refreshed. The capture errs towards preserving instance data.
 *
 * `familyTypeId` null means all types of the family (the button syncs
 * every instance then); otherwise only instances of that type are
 * captured, mirroring `syncFamilyInstances`. Returns null when the
 * family service is not ready, so the caller can fall back to an
 * uncaptured sync; otherwise a (possibly empty) per-element map.
 */
export function captureManualSyncOverrides(
  familyId: string,
  familyTypeId: string | null,
): Map<string, Record<string, any>> | null {
  const svc = familyService();
  if (!svc) return null;
  const family = svc.get(familyId);
  if (!family) return null;
  const auth: any = (ctx.features as any).authoring;
  const elements: AuthoredElement[] = auth?.getElements?.() ?? [];

  const overrideKeys = GEOMETRY_KEYS.filter((key) => {
    const param = family.parameters.find((p: FamilyParameter) => p.name === key);
    return !param || param.scope !== "type";
  });

  const captured = new Map<string, Record<string, any>>();
  // One resolution per type (null = family defaults for untyped
  // instances); instances of the same type share it.
  const resolvedByType = new Map<string, Record<string, any> | null>();
  for (const el of elements) {
    if (el.familyId !== familyId) continue;
    if (familyTypeId !== null && el.familyTypeId !== familyTypeId) continue;
    const typeId = el.familyTypeId ?? familyTypeId;
    const cacheKey = typeId ?? "";
    if (!resolvedByType.has(cacheKey)) {
      resolvedByType.set(cacheKey, svc.resolveParams(familyId, typeId));
    }
    const currentResolved = resolvedByType.get(cacheKey);
    if (!currentResolved) continue;
    const ov = extractInstanceOverrides(
      currentResolved,
      (el.params ?? {}) as Record<string, any>,
      overrideKeys,
    );
    if (Object.keys(ov).length) captured.set(el.id, ov);
  }
  return captured;
}