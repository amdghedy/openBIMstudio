// openbim-step1:family-foundation
// Family system foundation - registry that ties store + geometry + params.

import * as THREE from "three";
import { familyStore } from "./store";
import { buildParametricGeometry, registerCustomBuilder } from "./parametric-geometry";
import { evaluateParameters } from "./formula-engine";
import type {
  CustomGeometryBuilder,
  FamilyDefinition,
  FamilyParameter,
  FamilyService,
  FamilyType,
} from "./types";

/** Resolve parameters for a family/type, applying instance overrides last. */
function resolveParameters(
  family: FamilyDefinition,
  type: FamilyType | null,
  overrides: Record<string, any> | undefined,
): Record<string, any> {
  const values: Record<string, any> = {};

  // 1. Family defaults.
  for (const p of family.parameters) {
    values[p.name] = p.default;
  }

  // 2. Type-scope overrides.
  if (type) {
    for (const [k, v] of Object.entries(type.values)) {
      values[k] = v;
    }
  }

  // 3. Instance overrides.
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      values[k] = v;
    }
  }

  // 4. Formula pass -- delegated to the formula engine so a formula that
  //    references a later-declared parameter, or a cycle, or a typo, is
  //    surfaced instead of silently dropped.
  const result = evaluateParameters(family.parameters, values);
  if (result.errors.length) {
    for (const e of result.errors) {
      console.warn(
        "[families] formula error -- " + e.parameter + ": " + e.message,
      );
    }
  }
  return result.values;
}

export function createFamilyService(): FamilyService {
  const svc: FamilyService = {
    list: () => familyStore.list(),
    get: (id) => familyStore.get(id),
    getByElementType: (et) => familyStore.getByElementType(et),

    create: (def) => familyStore.create(def),
    update: (id, patch) => familyStore.update(id, patch),
    remove: (id) => familyStore.remove(id),
    duplicate: (id, name) => familyStore.duplicate(id, name),

    createType: (fid, name, values) => familyStore.createType(fid, name, values),
    updateType: (fid, tid, patch) => familyStore.updateType(fid, tid, patch),
    removeType: (fid, tid) => familyStore.removeType(fid, tid),

    resolveParams: (fid, tid, overrides) => {
      const fam = familyStore.get(fid);
      if (!fam) return null;
      const type = tid ? fam.types.find((t) => t.id === tid) ?? null : null;
      return resolveParameters(fam, type, overrides);
    },

    buildGeometry: (fid, tid, overrides) => {
      const fam = familyStore.get(fid);
      if (!fam) return null;
      const type = tid ? fam.types.find((t) => t.id === tid) ?? null : null;
      const params = resolveParameters(fam, type, overrides);
      const obj = buildParametricGeometry(fam.geometry, params);
      if (!obj) return null;
      obj.userData.familyId = fam.id;
      obj.userData.familyTypeId = tid;
      obj.userData.familyParams = params;
      return obj;
    },

    registerCustomBuilder: (name, fn) => registerCustomBuilder(name, fn),

    onChange: (cb) => familyStore.onChange(cb),
    reset: () => familyStore.reset(),
  };
  return svc;
}

/** Type-guard helper used by built-in family definitions. */
export function isFamilyParameter(v: any): v is FamilyParameter {
  return v && typeof v === "object" && typeof v.name === "string" && typeof v.type === "string";
}

/** Expose the raw geometry builder for tests / editor previews. */
export { buildParametricGeometry, resolveParameters };

/** Convenience: build a bare THREE.Group from a family + type. */
export function buildFamilyPreview(
  svc: FamilyService,
  familyId: string,
  typeId: string | null,
): THREE.Object3D | null {
  return svc.buildGeometry(familyId, typeId, undefined);
}

// Re-export the register hook so modules can install custom builders without
// importing parametric-geometry directly.
export type { CustomGeometryBuilder };
