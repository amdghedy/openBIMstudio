// Free family creator, slice 1: evaluate template parts to numbers.
// Uses the family engine's own formula evaluator so the numbers match the
// geometry the engine builds.

import { evaluateFormula } from "../formula-engine";
import { BEND_RATIO } from "./templates";
import type { PartTemplate, TemplatePart } from "./templates";

export interface ResolvedPart {
  id: string;
  name: string;
  shape: "box" | "cylinder" | "prism" | "bend";
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
    id: p.id, name: p.name, shape: p.shape, points: p.shape === "prism" ? p.points : undefined, axis: p.shape === "cylinder" || p.shape === "bend" ? (p.axis ?? "y") : "y", basis: p.basis,
    cx: num(p.x, values, `${p.id}.x`), cy: num(p.y, values, `${p.id}.y`), cz: num(p.z, values, `${p.id}.z`),
    w: num(p.w, values, `${p.id}.w`), d: num(p.d, values, `${p.id}.d`),
    h: num(p.h, values, `${p.id}.h`), r: num(p.r, values, `${p.id}.r`),
  }));
}

/** Engine-local to world direction maps of a revolved part (matches the engine's mesh rotation per axis). */
export function bendFrame(axis: "x" | "y" | "z"): { lx: [number, number, number]; ly: [number, number, number]; lz: [number, number, number] } {
  if (axis === "x") return { lx: [0, 1, 0], ly: [-1, 0, 0], lz: [0, 0, 1] };
  if (axis === "z") return { lx: [1, 0, 0], ly: [0, 0, 1], lz: [0, -1, 0] };
  return { lx: [1, 0, 0], ly: [0, 1, 0], lz: [0, 0, 1] };
}

/** World (engine axes) points on the elbow's outer skin, for bounds. Revolve about local Y, sweep from +Z toward +X. */
export function bendSamplePoints(p: { cx: number; cy: number; cz: number; r: number; h: number; axis?: "x" | "y" | "z" }, steps = 48): Array<[number, number, number]> {
  const f = bendFrame(p.axis ?? "y"), out: Array<[number, number, number]> = [];
  const ang = (p.h * Math.PI) / 180;
  for (let i = 0; i <= steps; i++) {
    const phi = (ang * i) / steps;
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * Math.PI * 2;
      const rad = BEND_RATIO * p.r + p.r * Math.cos(t), y = p.r * Math.sin(t);
      const lx = rad * Math.sin(phi), ly = y, lz = rad * Math.cos(phi);
      out.push([
        p.cx + lx * f.lx[0] + ly * f.ly[0] + lz * f.lz[0],
        p.cy + lx * f.lx[1] + ly * f.ly[1] + lz * f.lz[1],
        p.cz + lx * f.lx[2] + ly * f.ly[2] + lz * f.lz[2],
      ]);
    }
  }
  return out;
}
