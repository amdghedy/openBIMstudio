/**
 * OpenBIMStudio — Parametric Regeneration Engine (P0)
 * Constraint graph + dirty propagation + formula evaluation.
 */

export type ConstraintType =
  | "equal"
  | "distance"
  | "angle"
  | "parallel"
  | "perpendicular"
  | "coincident"
  | "horizontal"
  | "vertical"
  | "fixed"
  | "formula"
  | "array"
  | "mirror";

export interface ConstraintNode {
  id: string;
  type: ConstraintType;
  elements: string[];
  parameters: Record<string, number | string | boolean>;
  formula?: string;
  priority: number;
  enabled: boolean;
}

export interface DirtyFlag {
  elementId: string;
  reason: "geometry" | "parameter" | "host" | "constraint" | "array" | "nested";
  timestamp: number;
}

export interface RegenResult {
  success: boolean;
  regenerated: string[];
  failed: Array<{ elementId: string; error: string }>;
  durationMs: number;
  iterations: number;
}

export interface FormulaContext {
  params: Record<string, number>;
  elementId: string;
  typeName?: string;
}

export interface IParametricRegenService {
  markDirty(elementId: string, reason: DirtyFlag["reason"]): void;
  markDirtyMany(ids: string[], reason: DirtyFlag["reason"]): void;
  addConstraint(constraint: Omit<ConstraintNode, "id">): string;
  removeConstraint(id: string): boolean;
  evaluateFormula(formula: string, ctx: FormulaContext): number | null;
  regenerate(rootIds?: string[]): Promise<RegenResult>;
  isDirty(elementId: string): boolean;
  clearDirty(): void;
  getConstraintsFor(elementId: string): ConstraintNode[];
}
