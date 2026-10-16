/**
 * Parametric-aware family service wrapper.
 *
 * Drop-in enhancement of createFamilyService() that routes geometry builds
 * through the full parametric engine (formulas - constraints - nested /
 * array / sweep / revolve / conditional visibility).
 *
 * Usage in index.ts:
 *   import { createParametricFamilyService } from "./registry-parametric";
 *   const svc = createParametricFamilyService();
 */

import * as THREE from "three";
import { familyStore } from "./store";
import { registerCustomBuilder } from "./parametric-geometry";
import {
  buildParametricFamily,
  resolveParametricValues,
  propagateTypeChange,
  collectReportingValues,
  type ParametricBuildOptions,
  type InstanceParamBinding,
} from "./parametric-engine";
import type {
  CustomGeometryBuilder,
  FamilyDefinition,
  FamilyService,
  FamilyType,
} from "./types";
import type { Constraint } from "./constraint-graph";

export interface ParametricFamilyService extends FamilyService {
  /** Full parametric build with constraints / nested / arrays. */
  buildParametric(
    familyId: string,
    typeId: string | null,
    options?: ParametricBuildOptions,
  ): ReturnType<typeof buildParametricFamily>;

  /** Resolve params with formula + constraint pipeline. */
  resolveParametric(
    familyId: string,
    typeId: string | null,
    options?: ParametricBuildOptions,
  ): Record<string, any> | null;

  /** Propagate a type-parameter edit to all bound instances. */
  propagateType(
    familyId: string,
    typeId: string,
    instances: InstanceParamBinding[],
    options?: ParametricBuildOptions,
  ): Map<string, Record<string, any>>;

  /** Collect reporting (schedule) values for an instance. */
  reportingValues(
    familyId: string,
    typeId: string | null,
    overrides?: Record<string, any>,
  ): Record<string, any> | null;

  /** Attach dimensional constraints to a family (persisted in memory). */
  setConstraints(familyId: string, constraints: Constraint[]): boolean;
  getConstraints(familyId: string): Constraint[];
}

/** Per-family constraint store (not in FamilyDefinition schema yet). */
const constraintMap = new Map<string, Constraint[]>();

export function createParametricFamilyService(): ParametricFamilyService {
  const familyLookup = (id: string) => familyStore.get(id);
  const typeLookup = (fid: string, tid: string) => {
    const f = familyStore.get(fid);
    return f?.types.find((t) => t.id === tid) ?? null;
  };

  const baseOptions = (): ParametricBuildOptions => ({
    familyLookup,
    typeLookup,
  });

  const svc: ParametricFamilyService = {
    list: () => familyStore.list(),
    get: (id) => familyStore.get(id),
    getByElementType: (et) => familyStore.getByElementType(et),

    create: (def) => familyStore.create(def),
    update: (id, patch) => familyStore.update(id, patch),
    remove: (id) => {
      constraintMap.delete(id);
      return familyStore.remove(id);
    },
    duplicate: (id, name) => familyStore.duplicate(id, name),

    createType: (fid, name, values) => familyStore.createType(fid, name, values),
    updateType: (fid, tid, patch) => familyStore.updateType(fid, tid, patch),
    removeType: (fid, tid) => familyStore.removeType(fid, tid),

    resolveParams: (fid, tid, overrides) => {
      return svc.resolveParametric(fid, tid, { overrides });
    },

    buildGeometry: (fid, tid, overrides) => {
      const result = svc.buildParametric(fid, tid, { overrides });
      return result.object;
    },

    registerCustomBuilder: (name, fn) => registerCustomBuilder(name, fn),

    onChange: (cb) => familyStore.onChange(cb),
    reset: () => {
      constraintMap.clear();
      familyStore.reset();
    },

    // -- Parametric extensions --------------------------------------

    buildParametric(familyId, typeId, options = {}) {
      const fam = familyStore.get(familyId);
      if (!fam) {
        return {
          object: null,
          params: {},
          formula: { values: {}, computed: new Set(), errors: [], order: [] },
          constraints: null,
          errors: [`Family not found: ${familyId}`],
          warnings: [],
        };
      }
      const type = typeId
        ? fam.types.find((t) => t.id === typeId) ?? null
        : null;
      const constraints = constraintMap.get(familyId);
      return buildParametricFamily(fam, type, {
        ...baseOptions(),
        ...options,
        constraints: options.constraints ?? constraints,
      });
    },

    resolveParametric(familyId, typeId, options = {}) {
      const fam = familyStore.get(familyId);
      if (!fam) return null;
      const type = typeId
        ? fam.types.find((t) => t.id === typeId) ?? null
        : null;
      const constraints = constraintMap.get(familyId);
      const { values } = resolveParametricValues(fam, type, {
        ...baseOptions(),
        ...options,
        constraints: options.constraints ?? constraints,
      });
      return values;
    },

    propagateType(familyId, typeId, instances, options = {}) {
      const fam = familyStore.get(familyId);
      if (!fam) return new Map();
      const type = fam.types.find((t) => t.id === typeId);
      if (!type) return new Map();
      return propagateTypeChange(fam, type, instances, {
        ...baseOptions(),
        ...options,
        constraints: constraintMap.get(familyId),
      });
    },

    reportingValues(familyId, typeId, overrides) {
      const values = svc.resolveParametric(familyId, typeId, { overrides });
      if (!values) return null;
      const fam = familyStore.get(familyId);
      if (!fam) return null;
      return collectReportingValues(fam, values);
    },

    setConstraints(familyId, constraints) {
      if (!familyStore.get(familyId)) return false;
      constraintMap.set(familyId, constraints);
      return true;
    },

    getConstraints(familyId) {
      return constraintMap.get(familyId) ?? [];
    },
  };

  return svc;
}

export type { CustomGeometryBuilder, InstanceParamBinding };
