/**
 * Parametric regeneration engine — dirty flags, formulas, constraint graph
 * Closes a major depth gap vs Revit family/instance regen.
 */
import type {
  ConstraintNode,
  DirtyFlag,
  FormulaContext,
  IParametricRegenService,
  RegenResult,
} from "./types";

let _instance: ParametricRegenService | null = null;

/** Restricted arithmetic evaluator (no eval of arbitrary JS). */
function safeEval(expr: string, params: Record<string, number>): number | null {
  const cleaned = expr.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().,a-zA-Z_]+$/.test(cleaned)) return null;
  let body = cleaned;
  for (const [k, v] of Object.entries(params)) {
    body = body.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
  }
  if (/[a-zA-Z_]/.test(body)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const n = Function(`"use strict"; return (${body});`)();
    return typeof n === "number" && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export class ParametricRegenService implements IParametricRegenService {
  private dirty = new Map<string, DirtyFlag>();
  private constraints = new Map<string, ConstraintNode>();
  private regenHandler: ((ids: string[]) => Promise<void>) | null = null;
  private getParam: ((id: string, name: string) => number | undefined) | null = null;
  private setParam: ((id: string, name: string, value: number) => void) | null = null;

  setRegenHandler(fn: (ids: string[]) => Promise<void>): void {
    this.regenHandler = fn;
  }

  setParamAccessors(
    get: (id: string, name: string) => number | undefined,
    set: (id: string, name: string, value: number) => void
  ): void {
    this.getParam = get;
    this.setParam = set;
  }

  markDirty(elementId: string, reason: DirtyFlag["reason"]): void {
    this.dirty.set(elementId, { elementId, reason, timestamp: Date.now() });
  }

  markDirtyMany(ids: string[], reason: DirtyFlag["reason"]): void {
    const t = Date.now();
    for (const id of ids) this.dirty.set(id, { elementId: id, reason, timestamp: t });
  }

  addConstraint(constraint: Omit<ConstraintNode, "id">): string {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.constraints.set(id, { ...constraint, id });
    for (const el of constraint.elements) this.markDirty(el, "constraint");
    return id;
  }

  removeConstraint(id: string): boolean {
    const c = this.constraints.get(id);
    if (!c) return false;
    this.constraints.delete(id);
    for (const el of c.elements) this.markDirty(el, "constraint");
    return true;
  }

  evaluateFormula(formula: string, ctx: FormulaContext): number | null {
    return safeEval(formula, ctx.params);
  }

  isDirty(elementId: string): boolean {
    return this.dirty.has(elementId);
  }

  clearDirty(): void {
    this.dirty.clear();
  }

  getConstraintsFor(elementId: string): ConstraintNode[] {
    return [...this.constraints.values()].filter((c) => c.elements.includes(elementId));
  }

  async regenerate(rootIds?: string[]): Promise<RegenResult> {
    const t0 = performance.now();
    const targets = rootIds?.length
      ? new Set(rootIds)
      : new Set(this.dirty.keys());

    // Expand via formula constraints
    for (const c of this.constraints.values()) {
      if (!c.enabled || c.type !== "formula" || !c.formula) continue;
      if (!c.elements.some((e) => targets.has(e))) continue;
      const params: Record<string, number> = {};
      for (const [k, v] of Object.entries(c.parameters)) {
        if (typeof v === "number") params[k] = v;
      }
      for (const el of c.elements) {
        if (this.getParam) {
          for (const key of Object.keys(params)) {
            const live = this.getParam(el, key);
            if (live != null) params[key] = live;
          }
        }
        const result = this.evaluateFormula(c.formula, { params, elementId: el });
        if (result != null && this.setParam) {
          const outKey = String(c.parameters["output"] ?? "value");
          this.setParam(el, outKey, result);
          targets.add(el);
        }
      }
    }

    const ids = [...targets];
    const failed: RegenResult["failed"] = [];
    try {
      if (this.regenHandler && ids.length) await this.regenHandler(ids);
      for (const id of ids) this.dirty.delete(id);
    } catch (e) {
      failed.push({ elementId: ids[0] ?? "?", error: e instanceof Error ? e.message : String(e) });
    }

    return {
      success: failed.length === 0,
      regenerated: ids,
      failed,
      durationMs: performance.now() - t0,
      iterations: 1,
    };
  }
}

export function getParametricRegenService(): ParametricRegenService {
  if (!_instance) _instance = new ParametricRegenService();
  return _instance;
}

export type { IParametricRegenService, RegenResult, ConstraintNode };
