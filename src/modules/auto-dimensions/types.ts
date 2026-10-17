/**
 * Auto-Dimensions types – Revit-style aligned / linear / angular dimensions.
 */

export type DimensionKind = "aligned" | "linear" | "angular" | "radial" | "arcLength";

export interface DimPoint {
  x: number;
  y: number;
  z: number;
  /** Optional element id this witness attaches to. */
  elementId?: string;
  /** Optional reference name (e.g. "Wall face", "Grid A"). */
  refName?: string;
}

export interface DimensionString {
  id: string;
  kind: DimensionKind;
  /** Witness points (order matters for multi-segment). */
  points: DimPoint[];
  /** Display value in model units (metres). */
  value: number;
  /** Formatted label. */
  label: string;
  /** Offset of the dimension line from the measured geometry (metres). */
  offset: number;
  /** View this dimension belongs to (null = 3D / global). */
  viewId: string | null;
  /** True while still a temporary (edit-time) dimension. */
  temporary: boolean;
  /** Style key. */
  styleId: string;
  /** User or auto-generated. */
  source: "auto" | "user" | "temp";
  createdAt: string;
}

export interface DimensionStyle {
  id: string;
  name: string;
  textHeight: number; // model units relative scale for screen
  tickSize: number;
  color: string;
  textColor: string;
  unit: "auto" | "mm" | "m" | "ft-in";
  precision: number;
  /** Show equality (EQ) when segments are equal. */
  showEquality: boolean;
}

export interface AutoDimOptions {
  /** Categories to measure against. */
  categories: string[];
  /** Max gap between parallel faces to consider (metres). */
  maxGap: number;
  /** Minimum dimension length to create (metres). */
  minLength: number;
  /** Prefer overall + openings chain. */
  chainOpenings: boolean;
  /** Include grids / levels as references. */
  includeReferences: boolean;
  /** Offset of first dimension line from geometry. */
  baseOffset: number;
  /** Spacing between stacked dimension strings. */
  stackSpacing: number;
}

export function defaultDimStyle(): DimensionStyle {
  return {
    id: "default",
    name: "Default",
    textHeight: 2.5,
    tickSize: 1.5,
    color: "#1a1a1a",
    textColor: "#1a1a1a",
    unit: "auto",
    precision: 2,
    showEquality: true,
  };
}

export function defaultAutoDimOptions(): AutoDimOptions {
  return {
    categories: ["Walls", "Columns", "Grids", "Doors", "Windows"],
    maxGap: 50,
    minLength: 0.05,
    chainOpenings: true,
    includeReferences: true,
    baseOffset: 1.2,
    stackSpacing: 0.9,
  };
}
