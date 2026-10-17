/**
 * Additive type extensions for the BIM-competitive parametric engine.
 * Import alongside ./types - does not break existing FamilyDefinition consumers.
 */

import type {
  FamilyGeometrySpec,
  NumberRef,
  ProfileSpec,
  TransformSpec,
} from "./types";
import type { Constraint } from "./constraint-graph";

/** Extended geometry kinds that the parametric engine understands. */
export type ExtendedGeometrySpec =
  | FamilyGeometrySpec
  | SweepSpec
  | RevolveSpec
  | LoftSpec
  | VoidSpec
  | ConditionalSpec
  | NestedSpec
  | ArrayGeomSpec;

export interface SweepSpec {
  kind: "sweep";
  profile: ProfileSpec;
  path: [NumberRef, NumberRef, NumberRef][];
  closed?: boolean;
  transform?: TransformSpec;
  visibleWhen?: string;
}

export interface RevolveSpec {
  kind: "revolve";
  profile: ProfileSpec;
  axis: "x" | "y" | "z";
  angle: NumberRef;
  segments?: number;
  transform?: TransformSpec;
  visibleWhen?: string;
}

export interface LoftSpec {
  kind: "loft";
  profiles: ProfileSpec[];
  segments?: number;
  transform?: TransformSpec;
  visibleWhen?: string;
}

export interface VoidSpec {
  kind: "void";
  solid: FamilyGeometrySpec;
  transform?: TransformSpec;
  visibleWhen?: string;
}

export interface ConditionalSpec {
  kind: "conditional";
  when: string;
  then: FamilyGeometrySpec | ExtendedGeometrySpec;
  else?: FamilyGeometrySpec | ExtendedGeometrySpec;
}

export interface NestedSpec {
  kind: "nested";
  familyId: string;
  typeId?: string;
  paramMap?: Record<string, NumberRef | string>;
  transform?: TransformSpec;
  visibleWhen?: string;
  shared?: boolean;
}

export interface ArrayGeomSpec {
  kind: "array";
  of: FamilyGeometrySpec | ExtendedGeometrySpec;
  count: NumberRef;
  step: [NumberRef, NumberRef, NumberRef];
  rotateStep?: [NumberRef, NumberRef, NumberRef];
  visibleWhen?: string;
}

/**
 * Optional constraint set stored on a FamilyDefinition (via extension field).
 * Existing families without constraints continue to work unchanged.
 */
export interface FamilyConstraints {
  constraints?: Constraint[];
}

/**
 * Shared / project parameter definition (BIM Shared Parameter analogue).
 * Stored at project level; bound onto families by name.
 */
export interface SharedParameter {
  guid: string;
  name: string;
  type: import("./types").ParameterType;
  group: string;
  description?: string;
  /** When true, appears in schedules as a project parameter. */
  instance: boolean;
}
