/** 5D cost and 6D carbon spread over the schedule. Pure. */
import type { SchedTask } from "./types";
import { plannedFraction } from "./schedule-model";
import type { LinkResult } from "./task-linking";

export interface SpreadItem { id: string; start: number; finish: number; value: number; source: string }

/** Value accumulated at time t (each item spreads linearly between its start and finish). */
export function valueAt(items: SpreadItem[], t: number): number {
  let v = 0;
  for (const it of items) v += it.value * plannedFraction({ start: it.start, finish: it.finish } as SchedTask, t);
  return v;
}

export function curve(items: SpreadItem[], start: number, finish: number, samples = 24): Array<{ t: number; value: number }> {
  const n = Math.max(2, samples), out: Array<{ t: number; value: number }> = [];
  for (let i = 0; i < n; i++) { const t = start + ((finish - start) * i) / (n - 1); out.push({ t, value: valueAt(items, t) }); }
  return out;
}

export const total = (items: SpreadItem[]) => items.reduce((s, i) => s + i.value, 0);

/**
 * 5D: one item per task. Budget = P6 resource-assigned cost when present, otherwise the sum of the linked
 * elements' model cost (cost module line costs). `source` records which one was used.
 */
export function buildCostItems(tasks: SchedTask[], links: LinkResult, elementCost: Map<string, number>): SpreadItem[] {
  const out: SpreadItem[] = [];
  for (const t of tasks) {
    const model = (links.byTask.get(t.id) ?? []).reduce((s, id) => s + (elementCost.get(id) ?? 0), 0);
    const value = t.plannedCost > 0 ? t.plannedCost : model;
    if (value > 0) out.push({ id: t.id, start: t.start, finish: t.finish, value, source: t.plannedCost > 0 ? "p6" : "model" });
  }
  return out;
}

/* ───────────────────────── 6D embodied carbon ───────────────────────── */

export type FactorUnit = "m3" | "m2" | "m";
export interface CarbonFactor { unit: FactorUnit; kgCO2ePerUnit: number; note: string }

/**
 * Indicative cradle-to-gate defaults so the 6D view works out of the box. They are generic placeholders, NOT
 * project EPDs: replace them with your EPD / ICE values via `overrides`.
 */
export const DEFAULT_CARBON_FACTORS: Record<string, CarbonFactor> = {
  wall: { unit: "m3", kgCO2ePerUnit: 250, note: "masonry / blockwork, generic" },
  column: { unit: "m3", kgCO2ePerUnit: 420, note: "reinforced concrete incl. rebar, generic" },
  beam: { unit: "m3", kgCO2ePerUnit: 420, note: "reinforced concrete incl. rebar, generic" },
  slab: { unit: "m3", kgCO2ePerUnit: 380, note: "reinforced concrete, generic" },
  footing: { unit: "m3", kgCO2ePerUnit: 340, note: "reinforced concrete, generic" },
  roof: { unit: "m2", kgCO2ePerUnit: 60, note: "generic roof build-up" },
  ceiling: { unit: "m2", kgCO2ePerUnit: 12, note: "plasterboard ceiling, generic" },
  door: { unit: "m2", kgCO2ePerUnit: 40, note: "timber door leaf, generic" },
  window: { unit: "m2", kgCO2ePerUnit: 150, note: "double glazed unit, generic" },
  "curtain-wall": { unit: "m2", kgCO2ePerUnit: 200, note: "aluminium + glass, generic" },
  duct: { unit: "m", kgCO2ePerUnit: 14, note: "galvanised duct, per metre, generic" },
  pipe: { unit: "m", kgCO2ePerUnit: 7, note: "steel/PVC pipe, per metre, generic" },
  "cable-tray": { unit: "m", kgCO2ePerUnit: 5, note: "galvanised tray, per metre, generic" },
  conduit: { unit: "m", kgCO2ePerUnit: 2, note: "conduit, per metre, generic" },
  stairs: { unit: "m3", kgCO2ePerUnit: 400, note: "reinforced concrete stair, generic" },
};

export interface Qty { length: number; area: number; volume: number }

export function elementCarbon(type: string | undefined, qty: Qty, overrides?: Record<string, CarbonFactor>): number {
  const key = String(type ?? "").toLowerCase().replace(/^ifc/, "");
  const f = overrides?.[key] ?? DEFAULT_CARBON_FACTORS[key];
  if (!f) return 0;
  const q = f.unit === "m3" ? qty.volume : f.unit === "m2" ? qty.area : qty.length;
  return Math.max(0, q * f.kgCO2ePerUnit);
}

const polyArea = (pts: Array<[number, number]>) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
};

/** Quantities of an authored element from its parameters (m, m2, m3). */
export function authoredQuantity(el: { type: string; params: any }): Qty {
  const p = el.params ?? {};
  const h = Number(p.height) || 0, t = Number(p.thickness) || 0;
  const w = Number(p.width ?? t) || 0, d = Number(p.depth ?? t) || 0;
  if (p.start && p.end) {
    const L = Math.hypot(p.end[0] - p.start[0], p.end[1] - p.start[1]);
    if (el.type === "wall" || el.type === "curtain-wall") return { length: L, area: L * h, volume: L * h * t };
    return { length: L, area: L * (w || t), volume: L * (w || t) * (h || t) };
  }
  if (Array.isArray(p.polygon) && p.polygon.length >= 3) {
    const A = polyArea(p.polygon);
    return { length: 0, area: A, volume: A * t };
  }
  if (p.point) return { length: h, area: w * d, volume: w * d * h };
  return { length: 0, area: 0, volume: 0 };
}

/** 6D: one item per task = sum of the linked elements' embodied carbon (kg CO2e). */
export function buildCarbonItems(
  tasks: SchedTask[], links: LinkResult, elementCarbonKg: Map<string, number>,
): SpreadItem[] {
  const out: SpreadItem[] = [];
  for (const t of tasks) {
    const v = (links.byTask.get(t.id) ?? []).reduce((s, id) => s + (elementCarbonKg.get(id) ?? 0), 0);
    if (v > 0) out.push({ id: t.id, start: t.start, finish: t.finish, value: v, source: "model" });
  }
  return out;
}
