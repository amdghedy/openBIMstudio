/**
 * Curtain-wall grid property parsing — the pure, DOM-free half of the
 * curtain-wall authored bridge.
 *
 * `CurtainWallParams` accepts explicit `vGrid` / `hGrid` positions (0-1
 * normalized, sorted, must include the 0 and 1 endpoints) and per-cell
 * `panelOverrides`, but authored elements only ever passed division COUNTS —
 * so custom grid lines and per-panel types silently vanished on rebuild.
 * This module turns raw `properties` into validated engine params, with
 * honest warnings for everything it drops.
 *
 * Pure module: no DOM, no THREE — safe to unit-test in Node.
 */

export type CurtainPanelType = "glazed" | "solid" | "door" | "void";
export const CURTAIN_PANEL_TYPES: CurtainPanelType[] = ["glazed", "solid", "door", "void"];
const EPS = 1e-4;
const MAX_GRID_LINES = 48;
const MAX_OVERRIDES = 200;

export interface CurtainPanelOverride {
  col: number;
  row: number;
  type: CurtainPanelType;
}

export interface CurtainGridProps {
  vGrid?: number[];
  hGrid?: number[];
  panelOverrides?: CurtainPanelOverride[];
  warnings: string[];
}

/**
 * Validate one axis of grid positions: numbers (or numeric strings) in 0-1,
 * clamped, sorted, de-duplicated, 0/1 endpoints always present. Returns
 * undefined when nothing usable remains — the engine then falls back to even
 * divisions.
 */
export function sanitizeGridPositions(raw: unknown, label: string, warnings: string[]): number[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!Array.isArray(raw)) {
    warnings.push(`${label}: expected an array, got ${typeof raw} — dropped`);
    return undefined;
  }
  const seen: number[] = [];
  let dropped = 0;
  for (const item of raw) {
    // Explicit type check — Number(null)=0 and Number(true)=1 would otherwise
    // slip garbage through as valid grid positions.
    const n = typeof item === "number"
      ? item
      : (typeof item === "string" && item.trim() !== "" ? Number(item) : NaN);
    if (!Number.isFinite(n)) {
      dropped++;
      continue;
    }
    const c = Math.min(1, Math.max(0, n));
    if (seen.some((s) => Math.abs(s - c) < EPS)) {
      dropped++;
      continue;
    }
    seen.push(c);
  }
  const cleaned = seen.sort((a, b) => a - b).slice(0, MAX_GRID_LINES);
  if (cleaned.length > 0 && cleaned[0] > EPS) cleaned.unshift(0);
  if (cleaned.length > 0 && cleaned[cleaned.length - 1] < 1 - EPS) cleaned.push(1);
  if (cleaned.length < 2) {
    warnings.push(`${label}: no usable positions — falling back to even divisions`);
    return undefined;
  }
  if (dropped > 0) warnings.push(`${label}: dropped ${dropped} invalid/duplicate entr${dropped === 1 ? "y" : "ies"}`);
  return cleaned;
}

function sanitizeOverrides(raw: unknown, warnings: string[]): CurtainPanelOverride[] | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (!Array.isArray(raw)) {
    warnings.push(`panelOverrides: expected an array, got ${typeof raw} — dropped`);
    return undefined;
  }
  const out: CurtainPanelOverride[] = [];
  let dropped = 0;
  for (const item of raw) {
    const it = item as Record<string, unknown> | null;
    const col = Number(it?.col);
    const row = Number(it?.row);
    const type = String(it?.type ?? "");
    if (!Number.isInteger(col) || col < 0 || !Number.isInteger(row) || row < 0 || !CURTAIN_PANEL_TYPES.includes(type as CurtainPanelType)) {
      dropped++;
      continue;
    }
    out.push({ col, row, type: type as CurtainPanelType });
    if (out.length >= MAX_OVERRIDES) {
      warnings.push(`panelOverrides: capped at ${MAX_OVERRIDES} entries`);
      break;
    }
  }
  if (dropped > 0) warnings.push(`panelOverrides: dropped ${dropped} invalid entr${dropped === 1 ? "y" : "ies"} (need integer col/row ≥ 0 and type in ${CURTAIN_PANEL_TYPES.join("/")})`);
  return out.length ? out : undefined;
}

/**
 * Read curtain grid properties off an authored element's `properties` bag.
 * Only valid data reaches the engine; everything rejected is reported in
 * `warnings` so the caller can surface it honestly.
 */
export function parseCurtainGridProps(props: Record<string, unknown> | undefined, warnings: string[]): CurtainGridProps {
  const p = props ?? {};
  const vGrid = sanitizeGridPositions(p.vGrid, "vGrid", warnings);
  const hGrid = sanitizeGridPositions(p.hGrid, "hGrid", warnings);
  const panelOverrides = sanitizeOverrides(p.panelOverrides, warnings);
  return { vGrid, hGrid, panelOverrides, warnings };
}

/**
 * Convert user-entered real-world distances (metres along the wall face,
 * measured from the start/bottom) into 0-1 normalized positions.
 * Out-of-range values are dropped with a warning; needs wall width/height.
 */
export function metersToGridPositions(raw: string, span: number, label: string, warnings: string[]): number[] | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (!Number.isFinite(span) || span <= 0) {
    warnings.push(`${label}: wall span is ${span} — cannot normalize distances`);
    return undefined;
  }
  const parts = s.split(/[;,]/).map((x) => Number(x.trim()));
  const good: number[] = [];
  let dropped = 0;
  for (const v of parts) {
    if (!Number.isFinite(v) || v <= 0 || v >= span) {
      dropped++;
      continue;
    }
    good.push(v / span);
  }
  if (dropped > 0) warnings.push(`${label}: dropped ${dropped} value${dropped === 1 ? "" : "s"} (must be > 0 and < ${span.toFixed(2)} m)`);
  if (!good.length) return undefined;
  return good;
}
