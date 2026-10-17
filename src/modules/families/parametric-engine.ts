/**
 * Open BIM Studio - Parametric Engine (BIM-competitive core)
 *
 * Orchestrates:
 *   1. Formula evaluation (topo-sorted, units-aware, conditional)
 *   2. Dimensional + geometric constraint solving
 *   3. Nested family instances & array expansion
 *   4. Geometry build (extrude / sweep / revolve / loft / void / conditional)
 *   5. Change propagation (type - instance - nested children)
 *
 * Public API is pure / side-effect free except for registered custom builders.
 * Authoring, UI, and store sit on top of this module.
 */

import * as THREE from "three";
import type {
  FamilyDefinition,
  FamilyGeometrySpec,
  FamilyParameter,
  FamilyType,
  NumberRef,
  ProfileSpec,
  TransformSpec,
} from "./types";
import {
  evaluateParameters,
  type FormulaResult,
} from "./formula-engine";
import {
  buildParametricGeometry,
  resolveNumber,
  resolveTransform,
  registerCustomBuilder,
  getCustomBuilder,
  tintObject,
} from "./parametric-geometry";
import {
  solveConstraints,
  type Constraint,
  type ConstraintResult,
} from "./constraint-graph";
import {
  expandArrays,
  type ArraySpec,
  type ExpandedPart,
} from "./array-expander";
import {
  resolveNested,
  type NestedFamilyRef,
} from "./nested-families";

/* ---------------------------------------------------------------------------
   Extended geometry kinds (additive - existing kinds still work)
   --------------------------------------------------------------------------- */

export type ExtendedGeometrySpec =
  | FamilyGeometrySpec
  | {
      kind: "sweep";
      profile: ProfileSpec;
      path: [NumberRef, NumberRef, NumberRef][];
      closed?: boolean;
      transform?: TransformSpec;
      /** Parameter name controlling visibility (truthy - show). */
      visibleWhen?: string;
    }
  | {
      kind: "revolve";
      profile: ProfileSpec;
      axis: "x" | "y" | "z";
      angle: NumberRef;
      segments?: number;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "loft";
      profiles: ProfileSpec[];
      segments?: number;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "void";
      /** Positive solid that will be subtracted from siblings in a composed group. */
      solid: FamilyGeometrySpec;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "conditional";
      /** Parameter name (boolean / number). Truthy - thenSpec, else - elseSpec. */
      when: string;
      then: FamilyGeometrySpec;
      else?: FamilyGeometrySpec;
    }
  | {
      kind: "nested";
      familyId: string;
      typeId?: string;
      paramMap?: Record<string, NumberRef | string>;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "array";
      of: FamilyGeometrySpec;
      count: NumberRef;
      /** Translation step between instances [dx, dy, dz]. */
      step: [NumberRef, NumberRef, NumberRef];
      /** Optional rotation step [rx, ry, rz] radians. */
      rotateStep?: [NumberRef, NumberRef, NumberRef];
      visibleWhen?: string;
    };

export interface ParametricBuildOptions {
  /** Extra instance overrides (already merged by caller if desired). */
  overrides?: Record<string, any>;
  /** Project / shared parameter values (lowest priority after defaults). */
  sharedParams?: Record<string, any>;
  /** Constraints to solve after formula evaluation. */
  constraints?: Constraint[];
  /** Lookup for nested families (id - definition). */
  familyLookup?: (id: string) => FamilyDefinition | null;
  /** Lookup nested type values. */
  typeLookup?: (familyId: string, typeId: string) => FamilyType | null;
  /** Material / colour override applied to all meshes. */
  colour?: string | THREE.Color;
  /** When true, skip void CSG (faster preview). */
  preview?: boolean;
}

export interface ParametricBuildResult {
  object: THREE.Object3D | null;
  params: Record<string, any>;
  formula: FormulaResult;
  constraints: ConstraintResult | null;
  errors: string[];
  warnings: string[];
}

/* ---------------------------------------------------------------------------
   Parameter pipeline
   --------------------------------------------------------------------------- */

/**
 * Full parameter resolution pipeline matching BIM's order of operations:
 *   defaults - shared/project - type - instance overrides - formulas - constraints
 */
export function resolveParametricValues(
  family: FamilyDefinition,
  type: FamilyType | null,
  options: ParametricBuildOptions = {},
): { values: Record<string, any>; formula: FormulaResult; constraints: ConstraintResult | null; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, any> = {};

  // 1. Family defaults
  for (const p of family.parameters) {
    values[p.name] = p.default;
  }

  // 2. Shared / project parameters (only keys that exist on the family)
  if (options.sharedParams) {
    for (const p of family.parameters) {
      if (p.name in options.sharedParams) {
        values[p.name] = options.sharedParams[p.name];
      }
    }
  }

  // 3. Type overrides
  if (type) {
    for (const [k, v] of Object.entries(type.values)) {
      values[k] = v;
    }
  }

  // 4. Instance overrides
  if (options.overrides) {
    for (const [k, v] of Object.entries(options.overrides)) {
      values[k] = v;
    }
  }

  // 5. Clamp numeric parameters to min/max before formulas
  for (const p of family.parameters) {
    if (typeof values[p.name] === "number") {
      let n = values[p.name] as number;
      if (p.min != null && n < p.min) n = p.min;
      if (p.max != null && n > p.max) n = p.max;
      if (p.type === "integer") n = Math.round(n);
      values[p.name] = n;
    }
  }

  // 6. Formula evaluation (topo-sorted, cycle-safe)
  const formula = evaluateParameters(family.parameters, values);
  Object.assign(values, formula.values);
  for (const e of formula.errors) {
    errors.push(`formula:${e.parameter}: ${e.message}`);
  }

  // 7. Constraint solve (equality / ratio / sum / distance)
  let constraints: ConstraintResult | null = null;
  if (options.constraints && options.constraints.length) {
    constraints = solveConstraints(values, options.constraints);
    Object.assign(values, constraints.values);
    for (const e of constraints.errors) {
      errors.push(`constraint:${e}`);
    }
  }

  // 8. Final clamp after constraints
  for (const p of family.parameters) {
    if (typeof values[p.name] === "number") {
      let n = values[p.name] as number;
      if (p.min != null && n < p.min) n = p.min;
      if (p.max != null && n > p.max) n = p.max;
      values[p.name] = n;
    }
  }

  return { values, formula, constraints, errors };
}

/* ---------------------------------------------------------------------------
   Visibility helper
   --------------------------------------------------------------------------- */

function isVisible(spec: { visibleWhen?: string }, params: Record<string, any>): boolean {
  if (!spec.visibleWhen) return true;
  const v = params[spec.visibleWhen];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
  return !!v;
}

/* ---------------------------------------------------------------------------
   Extended geometry builders
   --------------------------------------------------------------------------- */

function buildSweep(
  profile: ProfileSpec,
  path: [NumberRef, NumberRef, NumberRef][],
  closed: boolean,
  params: Record<string, any>,
): THREE.Object3D | null {
  if (path.length < 2) return null;
  const shape = profileToShapeLocal(profile, params);
  const curvePts = path.map(([x, y, z]) =>
    new THREE.Vector3(resolveNumber(x, params), resolveNumber(y, params), resolveNumber(z, params)),
  );
  const curve = new THREE.CatmullRomCurve3(curvePts, closed);
  const geo = new THREE.ExtrudeGeometry(shape, {
    steps: Math.max(2, curvePts.length * 4),
    bevelEnabled: false,
    extrudePath: curve,
  });
  return new THREE.Mesh(geo);
}

function buildRevolve(
  profile: ProfileSpec,
  axis: "x" | "y" | "z",
  angle: NumberRef,
  segments: number,
  params: Record<string, any>,
): THREE.Object3D | null {
  const shape = profileToShapeLocal(profile, params);
  const theta = resolveNumber(angle, params);
  if (!Number.isFinite(theta) || Math.abs(theta) < 1e-6) return null;
  const geo = new THREE.LatheGeometry(
    shape.getPoints(64).map((p) => new THREE.Vector2(p.x, p.y)),
    Math.max(3, segments),
    0,
    theta,
  );
  const mesh = new THREE.Mesh(geo);
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function buildLoft(
  profiles: ProfileSpec[],
  segments: number,
  params: Record<string, any>,
): THREE.Object3D | null {
  if (profiles.length < 2) return null;
  // Approximate loft by stacking extruded slices between consecutive profiles.
  // Full NURBS loft is future work; this gives editable parametric massing.
  const group = new THREE.Group();
  const n = Math.max(1, segments);
  for (let i = 0; i < profiles.length - 1; i++) {
    const a = profileToShapeLocal(profiles[i], params).getPoints(32);
    const b = profileToShapeLocal(profiles[i + 1], params).getPoints(32);
    const count = Math.min(a.length, b.length);
    for (let s = 0; s < n; s++) {
      const t0 = s / n;
      const t1 = (s + 1) / n;
      const shape = new THREE.Shape();
      const pts: THREE.Vector2[] = [];
      for (let k = 0; k < count; k++) {
        const x = a[k].x * (1 - t0) + b[k].x * t0;
        const y = a[k].y * (1 - t0) + b[k].y * t0;
        pts.push(new THREE.Vector2(x, y));
      }
      if (pts.length < 3) continue;
      shape.moveTo(pts[0].x, pts[0].y);
      for (let k = 1; k < pts.length; k++) shape.lineTo(pts[k].x, pts[k].y);
      shape.closePath();
      const depth = 1 / (n * (profiles.length - 1));
      const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo);
      mesh.position.z = (i + t0) / (profiles.length - 1);
      group.add(mesh);
    }
  }
  return group.children.length ? group : null;
}

function profileToShapeLocal(profile: ProfileSpec, params: Record<string, any>): THREE.Shape {
  const shape = new THREE.Shape();
  if (profile.kind === "rect") {
    const w = resolveNumber(profile.w, params);
    const h = resolveNumber(profile.h, params);
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(w / 2, h / 2);
    shape.lineTo(-w / 2, h / 2);
    shape.closePath();
  } else if (profile.kind === "circle") {
    const r = resolveNumber(profile.r, params);
    shape.absarc(0, 0, Math.max(1e-6, r), 0, Math.PI * 2, false);
  } else if (profile.kind === "polygon") {
    const pts = profile.points;
    if (pts.length >= 3) {
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
    }
  }
  return shape;
}

/**
 * Recursively build geometry from an extended (or classic) spec.
 */
export function buildExtendedGeometry(
  spec: ExtendedGeometrySpec,
  params: Record<string, any>,
  options: ParametricBuildOptions = {},
): THREE.Object3D | null {
  // Visibility gate (shared by most extended kinds)
  if ("visibleWhen" in spec && !isVisible(spec as any, params)) {
    return null;
  }

  switch (spec.kind) {
    case "box":
    case "cylinder":
    case "extrusion":
    case "composed":
    case "custom":
      return buildParametricGeometry(spec as FamilyGeometrySpec, params);

    case "sweep": {
      const mesh = buildSweep(spec.profile, spec.path, !!spec.closed, params);
      if (!mesh) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "revolve": {
      const mesh = buildRevolve(
        spec.profile,
        spec.axis,
        spec.angle,
        spec.segments ?? 32,
        params,
      );
      if (!mesh) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "loft": {
      const obj = buildLoft(spec.profiles, spec.segments ?? 4, params);
      if (!obj) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(obj);
      return wrap;
    }

    case "void": {
      // Mark as void; CSG subtraction is applied at composed-group level.
      const solid = buildParametricGeometry(spec.solid, params);
      if (!solid) return null;
      solid.userData.isVoid = true;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(solid);
      wrap.userData.isVoid = true;
      return wrap;
    }

    case "conditional": {
      const v = params[spec.when];
      const truthy =
        typeof v === "boolean" ? v :
        typeof v === "number" ? v !== 0 :
        !!v;
      const branch = truthy ? spec.then : spec.else;
      if (!branch) return null;
      return buildExtendedGeometry(branch as ExtendedGeometrySpec, params, options);
    }

    case "nested": {
      if (!options.familyLookup) {
        console.warn("[parametric-engine] nested family requires familyLookup");
        return null;
      }
      const nestedFam = options.familyLookup(spec.familyId);
      if (!nestedFam) return null;
      const nestedType = spec.typeId
        ? options.typeLookup?.(spec.familyId, spec.typeId) ?? null
        : null;

      // Map parent params - nested overrides
      const nestedOverrides: Record<string, any> = {};
      if (spec.paramMap) {
        for (const [childKey, ref] of Object.entries(spec.paramMap)) {
          if (typeof ref === "string") {
            nestedOverrides[childKey] = params[ref];
          } else {
            nestedOverrides[childKey] = resolveNumber(ref, params);
          }
        }
      }

      const nested = buildParametricFamily(nestedFam, nestedType, {
        ...options,
        overrides: nestedOverrides,
      });
      if (!nested.object) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(nested.object);
      return wrap;
    }

    case "array": {
      const count = Math.max(0, Math.floor(resolveNumber(spec.count, params)));
      if (count === 0) return null;
      const dx = resolveNumber(spec.step[0], params);
      const dy = resolveNumber(spec.step[1], params);
      const dz = resolveNumber(spec.step[2], params);
      const rx = spec.rotateStep ? resolveNumber(spec.rotateStep[0], params) : 0;
      const ry = spec.rotateStep ? resolveNumber(spec.rotateStep[1], params) : 0;
      const rz = spec.rotateStep ? resolveNumber(spec.rotateStep[2], params) : 0;

      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const child = buildExtendedGeometry(spec.of as ExtendedGeometrySpec, params, options);
        if (!child) continue;
        child.position.set(dx * i, dy * i, dz * i);
        if (rx || ry || rz) child.rotation.set(rx * i, ry * i, rz * i);
        group.add(child);
      }
      return group.children.length ? group : null;
    }

    default:
      return null;
  }
}

/* ---------------------------------------------------------------------------
   Public: build a complete parametric family instance
   --------------------------------------------------------------------------- */

export function buildParametricFamily(
  family: FamilyDefinition,
  type: FamilyType | null,
  options: ParametricBuildOptions = {},
): ParametricBuildResult {
  const warnings: string[] = [];
  const { values, formula, constraints, errors } = resolveParametricValues(
    family,
    type,
    options,
  );

  let object: THREE.Object3D | null = null;
  try {
    object = buildExtendedGeometry(
      family.geometry as ExtendedGeometrySpec,
      values,
      options,
    );
  } catch (err) {
    errors.push(
      `geometry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (object) {
    object.userData.familyId = family.id;
    object.userData.familyTypeId = type?.id ?? null;
    object.userData.familyParams = { ...values };
    object.userData.ifcEntity = family.ifcEntity;
    if (options.colour) tintObject(object, options.colour);
  }

  return {
    object,
    params: values,
    formula,
    constraints,
    errors,
    warnings,
  };
}

/* ---------------------------------------------------------------------------
   Parameter change propagation (type edit - all instances)
   --------------------------------------------------------------------------- */

export interface InstanceParamBinding {
  elementId: string;
  familyId: string;
  typeId: string | null;
  /** Instance-level overrides only (type values live on the type). */
  overrides: Record<string, any>;
}

/**
 * Given a type parameter change, recompute every bound instance's effective
 * parameter map. Does not touch the scene - caller applies geometry rebuild.
 */
export function propagateTypeChange(
  family: FamilyDefinition,
  type: FamilyType,
  instances: InstanceParamBinding[],
  options: ParametricBuildOptions = {},
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const inst of instances) {
    if (inst.familyId !== family.id) continue;
    if (inst.typeId !== type.id) continue;
    const { values } = resolveParametricValues(family, type, {
      ...options,
      overrides: inst.overrides,
    });
    out.set(inst.elementId, values);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Reporting parameters (read-only, derived, shown in schedules)
   --------------------------------------------------------------------------- */

export function collectReportingValues(
  family: FamilyDefinition,
  values: Record<string, any>,
): Record<string, any> {
  const report: Record<string, any> = {};
  for (const p of family.parameters) {
    // Convention: group === "Reporting" or name starts with "Report_"
    if (p.group === "Reporting" || p.name.startsWith("Report_") || !p.editable) {
      if (p.formula || p.group === "Reporting") {
        report[p.name] = values[p.name];
      }
    }
  }
  return report;
}

/* ---------------------------------------------------------------------------
   Re-exports for a single import path
   --------------------------------------------------------------------------- */

export {
  evaluateParameters,
  buildParametricGeometry,
  resolveNumber,
  resolveTransform,
  registerCustomBuilder,
  getCustomBuilder,
  tintObject,
  solveConstraints,
  expandArrays,
  resolveNested,
};

export type {
  FormulaResult,
  Constraint,
  ConstraintResult,
  ArraySpec,
  ExpandedPart,
  NestedFamilyRef,
};
