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

/**
 * Keep the per-instance override record truthful (FU5 completion).
 * `element.familyOverrides` names the GEOMETRY_KEYS this instance
 * deliberately deviates from its type on, any scope — the only thing
 * that can tell a genuine override apart from a stale inherited value
 * (from stored params alone the two are indistinguishable). A key is
 * recorded only while its stored value actually differs from the given
 * type resolution, and cleared the moment it matches again, so writing
 * the type value back never freezes a stale value on a later sync.
 * Keys outside GEOMETRY_KEYS are never recorded: the sync machinery
 * cannot see them, so recording them would be a lie. An empty record
 * is removed rather than persisted as `[]`.
 */
function refreshOverrideRecord(
  element: AuthoredElement,
  key: string,
  typeResolvedValues: Record<string, any> | null,
): void {
  if (!GEOMETRY_KEYS.includes(key)) return;
  const stored = (element.params as Record<string, any>)[key];
  const base = typeResolvedValues?.[key];
  const deviates = typeof stored === "number" && Number.isFinite(stored) && stored !== base;
  const record = element.familyOverrides ?? (element.familyOverrides = []);
  const at = record.indexOf(key);
  if (deviates && at === -1) record.push(key);
  else if (!deviates && at !== -1) record.splice(at, 1);
  if (record.length === 0) delete element.familyOverrides;
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
    refreshOverrideRecord(element, paramName, svc.resolveParams(family.id, element.familyTypeId ?? null));
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

/**
 * Deliberately override one parameter on THIS instance only, without
 * touching the type — including a type-scope parameter. This is the
 * opt-in escape hatch `editFamilyParameter` deliberately does not
 * offer: that function routes type-scope edits to the type (Revit
 * semantics — the property palette uses it, and a type parameter edited
 * there edits the type). Use this when one instance must deviate from
 * its type (one door taller than its type, a placement-time caller
 * override), or from import/script flows that set per-instance values
 * directly.
 *
 * The value is written to the instance and the key is recorded in
 * `element.familyOverrides` exactly when it genuinely deviates from
 * the current type resolution, so a later manual sync preserves it
 * while still refreshing stale values. Writing the type value clears
 * the record. Returns `applied: "none"` when the family or parameter
 * does not exist; non-geometry keys are written (like
 * `editFamilyParameter` does) but never recorded — the sync machinery
 * cannot see them.
 */
export function overrideInstanceParameter(
  element: AuthoredElement,
  paramName: string,
  value: any,
): EditResult {
  const svc = familyService();
  if (!svc || !element.familyId) return { applied: "none", instancesSynced: 0 };
  const family = svc.get(element.familyId);
  if (!family) return { applied: "none", instancesSynced: 0 };
  const param = family.parameters.find((p: FamilyParameter) => p.name === paramName);
  if (!param) {
    return { applied: "none", instancesSynced: 0, reason: `unknown parameter "${paramName}"` };
  }
  (element.params as Record<string, any>)[paramName] = value;
  refreshOverrideRecord(element, paramName, svc.resolveParams(family.id, element.familyTypeId ?? null));
  return { applied: "instance", instancesSynced: 0 };
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
  // The overrides the swap re-applied are genuine by construction
  // (captured against the type being left, the correct baseline), so
  // record them: a later manual sync must preserve them instead of
  // reading them as stale deviations from the new type. Keys whose
  // stored value now matches the new type are not recorded — the record
  // only holds genuine deviations.
  const newResolved = newTypeId ? svc.resolveParams(family.id, newTypeId) : null;
  for (const [id, ov] of overridesByElement) {
    const target = siblings.find((s) => s.id === id);
    if (!target) continue;
    for (const key of Object.keys(ov)) {
      refreshOverrideRecord(target, key, newResolved);
    }
  }
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
 * compare against on a manual sync). Two key sets are captured:
 *
 *   - instance-scope family parameters (e.g. `thickness`, `elevation`),
 *     and geometry keys the family does not declare at all
 *     (placement-level values, per-instance by nature) — the FU5 set;
 *   - any key in the instance's override record
 *     (`element.familyOverrides`), ANY scope: a recorded key is a
 *     genuine deviation by construction (recorded at write time by
 *     `editFamilyParameter`, `overrideInstanceParameter` or
 *     `swapFamilyType`), so its type-scope value may be captured too.
 *
 * An UNRECORDED type-scope deviation is still never captured: no UI
 * path writes a type-scope value onto an instance except the deliberate
 * `overrideInstanceParameter`, so an unrecorded deviation is a stale
 * inherited value (the type changed out-of-band, e.g. via a catalog
 * import), not an override. Capturing it would freeze the stale value
 * and make the manual sync a no-op for exactly the keys it exists to
 * refresh.
 *
 * Residual limit (inherent without a record for legacy elements):
 * an instance-scope key whose *type* value changed out-of-band, on an
 * instance the user never overrode and which therefore carries no
 * record, is indistinguishable from a genuine override and is preserved
 * rather than refreshed. The capture errs towards preserving instance
 * data; overrides written through the recording paths above no longer
 * have this ambiguity.
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
    // Recorded overrides extend the key set: a key in the element's
    // override record is a genuine deviation by construction (recorded
    // at write time), so its type-scope value may be captured too.
    // Unrecorded type-scope deviations stay excluded — they are stale
    // inherited values, not overrides.
    const recorded = (el.familyOverrides ?? []).filter((key) => GEOMETRY_KEYS.includes(key));
    const keys = recorded.length ? [...new Set([...overrideKeys, ...recorded])] : overrideKeys;
    const ov = extractInstanceOverrides(
      currentResolved,
      (el.params ?? {}) as Record<string, any>,
      keys,
    );
    if (Object.keys(ov).length) captured.set(el.id, ov);
  }
  return captured;
}