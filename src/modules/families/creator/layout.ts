// Free family creator, slice 1: evaluate template parts to numbers.
// Uses the family engine's own formula evaluator so the numbers match the
// geometry the engine builds.

import { evaluateFormula } from "../formula-engine";
import type { PartTemplate, TemplatePart } from "./templates";

export interface ResolvedPart {
  id: string;
  name: string;
  shape: "box" | "cylinder" | "prism";
  /** Prism outline in profile units (scaled by r, extruded h along Z). */
  points?: Array<[number, number]>;
  /** Cylinder axis (engine axes). Boxes: "y". */
  axis?: "x" | "y" | "z";
  basis?: "catalogue" | "inferred";
  /** Centre, metres, engine axes (X width, Y up, Z depth). */
  cx: number; cy: number; cz: number;
  /** box: w (X), d (Z), h (Y). cylinder: r, h. */
  w: number; d: number; h: number; r: number;
}

function num(expr: string | undefined, values: Record<string, any>, what: string): number {
  if (expr === undefined) return 0;
  const v = evaluateFormula(expr, values);
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Cannot evaluate ${what}: ${expr}`);
  return v;
}

export function resolveParts(tpl: PartTemplate, values: Record<string, any>): ResolvedPart[] {
  return tpl.parts.map((p: TemplatePart) => ({
    id: p.id, name: p.name, shape: p.shape, points: p.shape === "prism" ? p.points : undefined, axis: p.shape === "cylinder" ? (p.axis ?? "y") : "y", basis: p.basis,
    cx: num(p.x, values, `${p.id}.x`), cy: num(p.y, values, `${p.id}.y`), cz: num(p.z, values, `${p.id}.z`),
    w: num(p.w, values, `${p.id}.w`), d: num(p.d, values, `${p.id}.d`),
    h: num(p.h, values, `${p.id}.h`), r: num(p.r, values, `${p.id}.r`),
  }));
}
