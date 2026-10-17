// openbim-step1:family-foundation
// Family system foundation - type definitions.
//
// A FamilyDefinition is a data-driven, user-extensible description of a
// parametric BIM family: named parameters, a geometry recipe, and one or
// more named types. Nothing in this file imports runtime code, so it is
// safe to use as a type-only dependency from services.ts.

import type * as THREE from "three";

export type FamilyCategory =
  | "wall" | "slab" | "column" | "beam" | "brace" | "truss" | "footing"
  | "strip" | "mline" | "door" | "window" | "duct" | "pipe"
  | "cable-tray" | "conduit" | "equipment" | "fitting"
  | "curtain-wall" | "stairs" | "railing" | "ramp" | "roof" | "ceiling"
  | "generic";

export type ParameterType =
  | "length" | "angle" | "number" | "integer" | "text"
  | "area" | "volume"
  | "boolean" | "material" | "colour" | "family-type";

export type ParameterScope = "instance" | "type";

export interface FamilyParameter {
  name: string;
  /** Human-readable label for the UI. Falls back to `name` when absent. */
  label?: string;
  type: ParameterType;
  scope: ParameterScope;
  default: any;
  editable: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  group?: string;
  description?: string;
  /** Formula referencing other parameter names, evaluated in declaration order. */
  formula?: string;
}

export interface FamilyType {
  id: string;
  name: string;
  /** Type-scope parameter overrides. */
  values: Record<string, any>;
}

export type NumberRef =
  | { ref: string }
  | { const: number }
  /**
   * Safe arithmetic over parameter names, e.g. "thickness / 2" or
   * "(width + height) * 0.5". Evaluated by the same expression engine that
   * powers family parameter formulas -- see modules/families/formula-engine.
   */
  | { expr: string };

export type ProfileSpec =
  | { kind: "rect"; w: NumberRef; h: NumberRef }
  | { kind: "circle"; r: NumberRef; segments?: number }
  | { kind: "polygon"; points: [number, number][] };

export interface TransformSpec {
  /** Translation in metres, [x, y, z]. */
  translate?: [NumberRef, NumberRef, NumberRef];
  /** Rotation in radians, [x, y, z]. */
  rotate?: [NumberRef, NumberRef, NumberRef];
  /** Scale, [x, y, z]. */
  scale?: [NumberRef, NumberRef, NumberRef];
}

export type FamilyGeometrySpec =
  | { kind: "box"; w: NumberRef; d: NumberRef; h: NumberRef; transform?: TransformSpec }
  | { kind: "cylinder"; r: NumberRef; h: NumberRef; segments?: number; transform?: TransformSpec }
  | { kind: "extrusion"; profile: ProfileSpec; depth: NumberRef; holes?: ProfileSpec[]; transform?: TransformSpec }
  | { kind: "composed"; parts: FamilyGeometrySpec[] }
  | { kind: "custom"; builder: string };

export interface FamilyDefinition {
  id: string;
  name: string;
  category: FamilyCategory;
  /** IFC entity this family maps to on export. E.g. "IfcWall". */
  ifcEntity: string;
  /** Schema version for future migration. */
  schemaVersion: number;
  /** The element type in the current hardcoded system this family mirrors. */
  sourceElementType?: string;
  parameters: FamilyParameter[];
  geometry: FamilyGeometrySpec;
  types: FamilyType[];
  /** Optional grouping in the browser. */
  group?: string;
  /** Whether this family was shipped with the app. */
  builtIn: boolean;
}

export type CustomGeometryBuilder = (
  params: Record<string, any>,
  resolveNumber: (ref: NumberRef) => number,
  resolveTransform: (t: TransformSpec | undefined) => THREE.Object3D,
) => THREE.Object3D | null;

/** Public family service contract. */
export interface FamilyService {
  list(): FamilyDefinition[];
  get(id: string): FamilyDefinition | null;
  getByElementType(elementType: string): FamilyDefinition | null;

  create(def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn">): FamilyDefinition;
  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null;
  remove(id: string): boolean;
  duplicate(id: string, newName: string): FamilyDefinition | null;

  createType(familyId: string, name: string, values?: Record<string, any>): FamilyType | null;
  updateType(familyId: string, typeId: string, patch: Partial<FamilyType>): FamilyType | null;
  removeType(familyId: string, typeId: string): boolean;

  resolveParams(
    familyId: string,
    typeId: string | null,
    overrides?: Record<string, any>,
  ): Record<string, any> | null;

  buildGeometry(
    familyId: string,
    typeId: string | null,
    overrides?: Record<string, any>,
  ): THREE.Object3D | null;

  registerCustomBuilder(name: string, fn: CustomGeometryBuilder): void;

  onChange(cb: () => void): () => void;
  reset(): void;
}
