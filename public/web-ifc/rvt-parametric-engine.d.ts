export type ParamKindName =
  | 'Length' | 'Area' | 'Volume' | 'Angle'
  | 'Number' | 'Integer' | 'Text' | 'YesNo'
  | 'Material' | 'URL' | 'FamilyType';

export interface ParameterSpec {
  name: string;
  kind?: ParamKindName;
  isType?: boolean;
  isInstance?: boolean;
  group?: string;
  formula?: string;
  unit?: string;
  default?: number | string;
  isReadOnly?: boolean;
  isShared?: boolean;
}

export interface GeometryRecipe { kind: string; [k: string]: unknown; }

export interface FamilySpec {
  category?: string;
  parameters?: ParameterSpec[];
  formulas?: string[];
  constraints?: Constraint[];
  geometry?: (params: Record<string, number | string>) => GeometryRecipe;
}

export class Constraint {
  constructor(kind: 'equal'|'ratio'|'lock'|'sum'|'range', target: string[], params?: any);
  satisfied(ctx: Record<string, number>): boolean;
  resolve(ctx: Record<string, number>, mutable: Set<string>): boolean;
}

export class BIMParametricEngine {
  static attach(api: any, modelID: number, options?: any): BIMParametricEngine;
  units: any;
  families: Map<string, any>;
  instances: Map<number, any>;
  loadFamilies(): Map<string, any>;
  defineFamily(name: string, spec: FamilySpec): any;
  defineType(familyName: string, typeName: string, overrides?: Record<string, any>): any;
  bindInstance(expressID: number, familyName: string, typeName: string): any;
  effectiveParameters(expressID: number): Record<string, number | string> | null;
  setTypeParameter(familyName: string, typeName: string, paramName: string, value: any): any;
  setInstanceParameter(expressID: number, paramName: string, value: any): any;
  addConstraint(familyName: string, c: Constraint): any;
  regenerate(opts?: { dryRun?: boolean }): any[];
  beginTransaction(label?: string): { commit(): void; rollback(): void };
  commit(): void;
  rollback(): void;
  listFamilies(): Array<{ name: string; category: string; typeCount: number; parameters: string[] }>;
  listTypes(familyName: string): string[];
  listInstances(familyName: string, typeName: string): number[];
}

export const FormulaEngine: {
  compile(src: string): unknown;
  evaluate(src: string, ctx: Record<string, number | string>): number | string;
};
export const GeometryBuilder: { build(recipe: GeometryRecipe | ((p: any) => GeometryRecipe), params: Record<string, any>): any; };
export const UnitSystem: { new (): any; detectFromIfc(api: any, modelID: number): any; };
