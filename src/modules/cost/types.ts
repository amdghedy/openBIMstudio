/**
 * Billable units for cost items and QTO rules.
 * "kg" exists for weight-based rules (rebar estimates etc.) — raw takeoff
 * rows carry no mass, so row-level assignments with a kg item yield qty 0
 * unless overridden, while rule-based lines compute their own quantity.
 */
export type CostUnit = "m" | "m2" | "m3" | "pcs" | "kg";

export interface CostItem {
  id: string;
  code: string;
  name: string;
  unit: CostUnit;
  rate: number;
  category: string;
}

/** Aggregate of one quantity kind (length / area / volume) with element count. */
export interface QtoBundle {
  length: number;
  area: number;
  volume: number;
  /** Number of elements that contributed to this bundle. */
  elements: number;
}

export type TakeoffSource = "authored" | "qto" | "geometry" | "bbox";

export interface TakeoffRow {
  /** "authored:<elementId>" | "ifc:<modelId>:<category>" */
  key: string;
  source: "authored" | "ifc";
  label: string;
  detail: string;
  count: number;
  /** Primary values — Qto when present and majority, else geometry. */
  length: number;
  area: number;
  volume: number;

  /**
   * Element dimensions where the type has a clear one (m, authored rows
   * only). QTO rules can reference them as the Height / Thickness / Width
   * formula variables; absent (undefined) = the type has no such dimension
   * or the row came from IFC, and a formula referencing it evaluates it
   * as 0 — visible in the rule tooltip, never silently estimated.
   */
  height?: number;
  thickness?: number;
  width?: number;
  /** Level name the element sits on (authored rows only), for level filters. */
  level?: string;

  /**
   * Stringified properties for QTO rule property filters. Authored rows:
   * the element's property bag. IFC rows: pset properties that are uniform
   * across the whole category aggregate (divergent values are omitted, so a
   * rule clause can only match what is true for every element in the row).
   */
  properties?: Record<string, string>;

  /** Author-provided quantities from Qto_*BaseQuantities psets (IFC only). */
  qto?: QtoBundle;
  /** Geometric extraction from triangle soups (IFC only). */
  geom?: QtoBundle;
  /** Where the primary values came from. */
  primarySource?: TakeoffSource;
  /** |qto.volume − geom.volume| / geom.volume × 100 (when both present). */
  variancePct?: number;
}

export interface CostAssignment {
  rowKey: string;
  costItemId: string | null;
  qtyOverride: number | null;
}

export interface CostData {
  items: CostItem[];
  /** Keyed by TakeoffRow.key. */
  assignments: Record<string, CostAssignment>;
  updatedAt: number;
}

export function emptyCostData(): CostData {
  return { items: [], assignments: {}, updatedAt: 0 };
}