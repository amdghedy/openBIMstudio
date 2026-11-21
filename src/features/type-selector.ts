/**
 * G10 — Properties palette Type Selector (pure model + re-type engine).
 *
 * Revit behaviour: the Properties palette is topped by a Type Selector
 * listing the selected element's family types; picking another type
 * re-types the element(s); "Edit Type" opens Type Properties. With a
 * mixed selection Revit shows "<varies>" and a re-type only touches the
 * elements whose family offers that type.
 *
 * This module is the DOM-free core the palette drives. It knows two type
 * sources, resolved per element in this priority:
 *
 *   1. family — the element itself carries a familyId. The options are
 *      that family's types (the parametric-families registry).
 *   2. wall preset — a wall / curtain-wall with no family falls back to
 *      the architectural wall-type catalog (`WALL_TYPE_PRESETS`), which
 *      is the established type system for placed walls (compound layers
 *      included) and the same list the palette's wall-type block offers.
 *   3. registered family — any other element type with a family
 *      registered for it (`getByElementType`) uses that family's types.
 *
 * Re-type semantics (Revit's type/instance split):
 *
 *   • Keys the old or the new type defines (the type's `values`) are
 *     type-driven: they take the new type's resolved value.
 *   • Every other dimensional key keeps the element's current value —
 *     that is the instance override (e.g. a wall whose height was edited
 *     to 4.5 m keeps 4.5 m when its type changes from Generic 200 to
 *     Generic 300; only the thickness follows the type). Placement keys
 *     (notably `elevation`) are never overwritten by a type change.
 *   • Only the re-typed elements are touched. The previous palette path
 *     called `syncFamilyInstances(newType)` after a type switch, which
 *     re-resolved EVERY instance already on the new type and silently
 *     overwrote their instance overrides; this engine does not do that.
 *     (A type-definition edit still propagates via `editFamilyParameter`.)
 *
 * The wall-preset mutation mirrors `mutateElementWallType` in
 * modules/architecture-depth/index.ts (thickness from the preset, height
 * only when missing, layers / curtain system properties, name) so the
 * selector and the existing wall-type blocks agree; the palette calls
 * this engine for both paths.
 */

import type { FamilyDefinition } from "../modules/families/types";
import type { AuthoredElement } from "../modules/projects/types";
import {
  WALL_TYPE_PRESETS,
  type WallTypePreset,
} from "../modules/architecture-depth/wall-types";

/** Dimensional keys a type resolution may drive (cf. families/placement GEOMETRY_KEYS). */
export const GEOMETRY_KEYS: readonly string[] = [
  "height", "thickness", "width", "depth",
  "elevation", "sillHeight", "frameThickness",
  "offsetAlongHost",
];

export interface TypeOption {
  id: string;
  name: string;
  familyName: string;
}

export type TypeSelectorKind = "family" | "wall" | "mixed" | "none";

export interface TypeSelectorModel {
  kind: TypeSelectorKind;
  /** Family name, "Wall Type", "Multiple types", or "" when there is no source. */
  sourceName: string;
  options: TypeOption[];
  /** Common current type id, or null when the selection varies / has no type. */
  currentId: string | null;
  varies: boolean;
}

/** Minimal family-service surface this engine needs (the real service satisfies it). */
export interface TypeSelectorFamilyService {
  get(id: string): FamilyDefinition | null;
  getByElementType(elementType: string): FamilyDefinition | null;
  resolveParams(
    familyId: string,
    familyTypeId: string | null,
    overrides?: Record<string, any>,
  ): Record<string, any> | null;
}

export interface TypeSelectorDeps {
  familyService?: TypeSelectorFamilyService | null;
  /** Defaults to the real wall-type catalog. */
  wallPresets?: WallTypePreset[];
}

export interface ElementTypeSource {
  kind: "family" | "wall";
  familyId?: string;
  familyName: string;
  options: TypeOption[];
  currentId: string | null;
}

function wallPresets(deps: TypeSelectorDeps): WallTypePreset[] {
  return deps.wallPresets ?? WALL_TYPE_PRESETS;
}

/**
 * Mirror of `inferWallTypeId` (modules/architecture-depth/index.ts):
 * stored wallTypeId wins, then an exact layers match, then the
 * no-layers default. Kept here so the selector model is computable
 * without the architecture-depth service (which needs the authoring ctx).
 */
export function inferWallPresetId(
  el: AuthoredElement,
  presets?: WallTypePreset[],
): string | null {
  if (!el) return null;
  const list = presets ?? WALL_TYPE_PRESETS;
  const stored = (el.properties as any)?.wallTypeId;
  if (stored && list.some((p) => p.id === String(stored))) return String(stored);
  const layers = String((el.properties as any)?.layers || "");
  if (el.type === "curtain-wall") {
    const pt = String((el.properties as any)?.panelType || "glazed");
    return pt === "solid" ? "curtain-solid" : "curtain-system";
  }
  for (const p of list) {
    if (p.kind === "curtain") continue;
    if (p.layers && p.layers === layers) return p.id;
  }
  if (!layers) return "basic-generic-200";
  return "compound-exterior";
}

function familySource(
  el: AuthoredElement,
  svc: TypeSelectorFamilyService,
): ElementTypeSource | null {
  let fam: FamilyDefinition | null = null;
  if (el.familyId) fam = svc.get(el.familyId);
  if (!fam && typeof svc.getByElementType === "function") {
    fam = svc.getByElementType(el.type);
  }
  if (!fam) return null;
  return {
    kind: "family",
    familyId: fam.id,
    familyName: fam.name,
    options: fam.types.map((t) => ({ id: t.id, name: t.name, familyName: fam!.name })),
    currentId: el.familyTypeId ?? inferFamilyTypeId(el, fam, svc),
  };
}

/**
 * Infer the family type of an element that carries no familyTypeId by
 * matching its current dimensional params against each type's resolved
 * values. Returns the type id only when exactly one type matches; an
 * ambiguous or unmatched element reports no current type.
 */
export function inferFamilyTypeId(
  el: AuthoredElement,
  fam: FamilyDefinition,
  svc: TypeSelectorFamilyService,
): string | null {
  const matches: string[] = [];
  for (const type of fam.types) {
    const keys = Object.keys(type.values ?? {});
    if (!keys.length) continue;
    const resolved = svc.resolveParams(fam.id, type.id, undefined);
    if (!resolved) continue;
    const ok = keys.every((k) => {
      const want = (resolved as any)[k];
      const got = (el.params as any)[k];
      return typeof want === "number" && typeof got === "number"
        ? Math.abs(want - got) < 1e-9
        : want === got;
    });
    if (ok) matches.push(type.id);
  }
  return matches.length === 1 ? matches[0] : null;
}

function wallSource(
  el: AuthoredElement,
  presets: WallTypePreset[],
): ElementTypeSource | null {
  if (el.type !== "wall" && el.type !== "curtain-wall") return null;
  const list = el.type === "curtain-wall"
    ? presets.filter((p) => p.kind === "curtain")
    : presets.filter((p) => p.kind !== "curtain");
  if (!list.length) return null;
  return {
    kind: "wall",
    familyName: "Wall Type",
    options: list.map((p) => ({ id: p.id, name: p.name, familyName: "Wall Type" })),
    currentId: inferWallPresetId(el, presets),
  };
}

/** The type source for one element, or null when it has no types to pick from. */
export function typeSourceForElement(
  el: AuthoredElement,
  deps: TypeSelectorDeps,
): ElementTypeSource | null {
  if (!el) return null;
  // 1. The element's own family, when it has one.
  if (el.familyId && deps.familyService) {
    const fam = familySource(el, deps.familyService);
    if (fam) return fam;
  }
  // 2. Placed walls use the wall-type catalog (compound layers included).
  if (el.type === "wall" || el.type === "curtain-wall") {
    return wallSource(el, wallPresets(deps));
  }
  // 3. Any other type with a registered family uses that family's types.
  if (deps.familyService) {
    return familySource(el, deps.familyService);
  }
  return null;
}

/** The Type Selector model for a selection (one element or many). */
export function resolveTypeSelector(
  elements: AuthoredElement[],
  deps: TypeSelectorDeps,
): TypeSelectorModel {
  const sources = (elements ?? [])
    .map((el) => typeSourceForElement(el, deps))
    .filter((s): s is ElementTypeSource => s !== null);
  if (!sources.length) {
    return { kind: "none", sourceName: "", options: [], currentId: null, varies: false };
  }
  const kinds = new Set(sources.map((s) => s.kind));
  const kind: TypeSelectorKind = kinds.size === 1 ? (sources[0].kind as TypeSelectorKind) : "mixed";
  const names = new Set(sources.map((s) => s.familyName));
  const sourceName = names.size === 1 ? sources[0].familyName : "Multiple types";
  const seen = new Set<string>();
  const options: TypeOption[] = [];
  for (const s of sources) {
    for (const o of s.options) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        options.push(o);
      }
    }
  }
  const firstCurrent = sources[0].currentId;
  const allSameCurrent = sources.every((s) => s.currentId === firstCurrent);
  const varies = !allSameCurrent;
  return {
    kind,
    sourceName,
    options,
    currentId: allSameCurrent ? firstCurrent : null,
    varies,
  };
}

export interface RetypeResult {
  retyped: string[];
  skipped: string[];
}

function applyFamilyRetype(
  el: AuthoredElement,
  newTypeId: string,
  fam: FamilyDefinition,
  svc: TypeSelectorFamilyService,
): boolean {
  const newType = fam.types.find((t) => t.id === newTypeId);
  if (!newType) return false;
  const oldType = el.familyTypeId
    ? fam.types.find((t) => t.id === el.familyTypeId) ?? null
    : null;
  // Keys the old or the new type defines are type-driven.
  const typeDriven = new Set<string>([
    ...Object.keys(oldType?.values ?? {}),
    ...Object.keys(newType.values ?? {}),
  ]);
  const newResolved = svc.resolveParams(fam.id, newTypeId, undefined) ?? {};
  el.familyId = fam.id;
  el.familyTypeId = newTypeId;
  // Type-driven keys take the new type's resolved value; every other
  // dimensional key keeps the element's current (instance) value.
  for (const key of GEOMETRY_KEYS) {
    if (!typeDriven.has(key)) continue;
    const v = (newResolved as any)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      (el.params as any)[key] = v;
    }
  }
  return true;
}

/**
 * Mirror of `mutateElementWallType` (modules/architecture-depth/index.ts):
 * thickness from the preset, height only when missing (so a height
 * override survives), layers / curtain system properties, name.
 */
export function applyWallPreset(
  el: AuthoredElement,
  preset: WallTypePreset,
): boolean {
  if (el.type !== "wall" && el.type !== "curtain-wall") return false;
  const isCurtain = preset.kind === "curtain";
  el.type = isCurtain ? "curtain-wall" : "wall";
  el.params = { ...(el.params || {}) };
  el.params.thickness = preset.thickness;
  if (preset.height && !el.params.height) el.params.height = preset.height;
  el.properties = { ...(el.properties || {}) };
  (el.properties as any).wallTypeId = preset.id;
  el.name = preset.name;
  if (preset.layers) (el.properties as any).layers = preset.layers;
  else delete (el.properties as any).layers;
  if (isCurtain) {
    (el.properties as any).system = "mullion-panel";
    (el.properties as any).panelType = preset.panelType || "glazed";
    (el.properties as any).mullionProfile = preset.mullionProfile || "rect";
  } else {
    delete (el.properties as any).system;
    delete (el.properties as any).panelType;
    delete (el.properties as any).mullionProfile;
  }
  return true;
}

/**
 * Re-type each element to `newTypeId` where its type source offers that
 * type; elements whose source does not offer it are skipped untouched.
 * Only the re-typed elements are mutated.
 */
export function retypeElements(
  elements: AuthoredElement[],
  newTypeId: string,
  deps: TypeSelectorDeps,
): RetypeResult {
  const retyped: string[] = [];
  const skipped: string[] = [];
  const presets = wallPresets(deps);
  for (const el of elements ?? []) {
    const source = typeSourceForElement(el, deps);
    if (!source || !source.options.some((o) => o.id === newTypeId)) {
      skipped.push(el.id);
      continue;
    }
    let ok = false;
    if (source.kind === "family" && deps.familyService && source.familyId) {
      const fam = deps.familyService.get(source.familyId);
      ok = fam ? applyFamilyRetype(el, newTypeId, fam, deps.familyService) : false;
    } else if (source.kind === "wall") {
      const preset = presets.find((p) => p.id === newTypeId);
      ok = preset ? applyWallPreset(el, preset) : false;
    }
    if (ok) retyped.push(el.id);
    else skipped.push(el.id);
  }
  return { retyped, skipped };
}
