/**
 * AutoCAD parity A18 — QSELECT dialog criteria, FILTER property criteria +
 * named filters, and previous-selection restore.
 *
 * Pure selection predicates; no DOM, no rendering. The CAD viewer
 * (src/features/cad-viewer.ts) wires these helpers to the QSELECT dialog,
 * the extended FILTER dialog, the PREVIOUS command and the P option at a
 * "Select objects:" prompt.
 *
 * Conventions (AutoCAD):
 * - QSELECT picks objects by object type + one property + an operator,
 *   then applies the result as a new selection set (include), removes
 *   the matches from the whole drawing (exclude), or adds the matches to
 *   the current set (append).
 * - FILTER restricts what picking / window / crossing can land on. The
 *   type checkboxes from the old dialog stay; property criteria are an
 *   AND list on top of them. A named filter captures the whole filter
 *   state (types + criteria) under a name and is persisted per drawing,
 *   following the A16 layer-states pattern.
 * - PREVIOUS restores the most recent non-empty selection set. Clearing
 *   the selection never erases it; restoring it records it again, so
 *   repeating PREVIOUS keeps returning the same set (it does not
 *   toggle back to the set before it).
 */

import type { DxfEntity } from "../drawings/dxf-types";
import * as M from "./viewer-math";

/* ── property model ─────────────────────────────────────────────────── */

export type PropertyKind = "string" | "number" | "color" | "lineweight";

export interface PropertyDef {
  id: string;
  label: string;
  kind: PropertyKind;
  placeholder: string;
}

export type QSelectOperator = "=" | "!=" | ">" | "<" | ">=" | "<=" | "contains" | "not-contains";

export interface QSelectCriterion {
  property: string;
  operator: QSelectOperator;
  /** Raw value as typed in the dialog / command line (trimmed). */
  value: string;
}

export type QSelectApplyMode = "include" | "exclude" | "append";

const COMMON_PROPERTIES: PropertyDef[] = [
  { id: "type", label: "Object Type", kind: "string", placeholder: "e.g. LINE" },
  { id: "layer", label: "Layer", kind: "string", placeholder: "e.g. A-WALL" },
  { id: "color", label: "Color", kind: "color", placeholder: "e.g. 1, #ff0000 or BYLAYER" },
  { id: "linetype", label: "Linetype", kind: "string", placeholder: "e.g. DASHED" },
  { id: "lineweight", label: "Lineweight", kind: "lineweight", placeholder: "e.g. 0.5 or BYLAYER" },
  { id: "text", label: "Text Content", kind: "string", placeholder: "e.g. NOTE" },
];

const TYPE_PROPERTIES: Record<string, PropertyDef[]> = {
  LINE: [{ id: "length", label: "Length", kind: "number", placeholder: "e.g. 100" }],
  CIRCLE: [
    { id: "radius", label: "Radius", kind: "number", placeholder: "e.g. 50" },
    { id: "length", label: "Length (circumference)", kind: "number", placeholder: "e.g. 314.16" },
    { id: "area", label: "Area", kind: "number", placeholder: "e.g. 7854" },
  ],
  ARC: [
    { id: "radius", label: "Radius", kind: "number", placeholder: "e.g. 50" },
    { id: "length", label: "Length", kind: "number", placeholder: "e.g. 100" },
    { id: "area", label: "Area (sector)", kind: "number", placeholder: "e.g. 1000" },
  ],
  LWPOLYLINE: [
    { id: "length", label: "Length", kind: "number", placeholder: "e.g. 100" },
    { id: "area", label: "Area", kind: "number", placeholder: "e.g. 10000" },
    { id: "width", label: "Polyline Width", kind: "number", placeholder: "e.g. 2" },
  ],
  TEXT: [
    { id: "height", label: "Text Height", kind: "number", placeholder: "e.g. 10" },
    { id: "text", label: "Text Content", kind: "string", placeholder: "e.g. NOTE" },
  ],
};

/** Properties offered for one object type ("ALL" = every type). */
export function propertiesForType(type: string): PropertyDef[] {
  const t = (type ?? "ALL").toUpperCase();
  if (t === "ALL") return COMMON_PROPERTIES;
  const extra = TYPE_PROPERTIES[t] ?? [];
  // TEXT already carries the common "text" row; do not offer it twice.
  const common = t === "TEXT" ? COMMON_PROPERTIES.filter((p) => p.id !== "text") : COMMON_PROPERTIES;
  return [...common, ...extra];
}

export function propertyDef(id: string): PropertyDef | null {
  for (const list of [COMMON_PROPERTIES, ...Object.values(TYPE_PROPERTIES)]) {
    const found = list.find((p) => p.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Every property any type offers, once each — the FILTER dialog's
 * criterion picker (a filter criterion applies across types, so the
 * list is not scoped to one type the way the QSELECT dialog's is).
 */
export const ALL_FILTER_PROPERTIES: PropertyDef[] = (() => {
  const seen = new Set<string>();
  const out: PropertyDef[] = [];
  for (const list of [COMMON_PROPERTIES, ...Object.values(TYPE_PROPERTIES)]) {
    for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  return out;
})();

const NUMBER_OPERATORS: QSelectOperator[] = ["=", "!=", ">", "<", ">=", "<="];
const STRING_OPERATORS: QSelectOperator[] = ["=", "!=", "contains", "not-contains"];

/** Operators a property kind accepts. */
export function operatorsForKind(kind: PropertyKind): QSelectOperator[] {
  return kind === "number" || kind === "lineweight" ? NUMBER_OPERATORS : STRING_OPERATORS;
}

/* ── criterion validation ───────────────────────────────────────────── */

const MAX_VALUE_LEN = 200;

function parseColorValue(raw: string): string | null {
  const v = raw.trim();
  if (/^#?[0-9a-f]{6}$/i.test(v)) return `rgb:${v.replace(/^#/, "").toLowerCase()}`;
  if (/^(bylayer|default)$/i.test(v)) return "bylayer";
  if (/^\d+$/.test(v)) return `aci:${Number(v)}`;
  return null;
}

function parseLineweightValue(raw: string): number | "bylayer" | null {
  const v = raw.trim();
  if (/^(bylayer|default)$/i.test(v)) return "bylayer";
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Validates a raw criterion (dialog input or stored JSON). Returns the
 * normalised criterion or null when it is not usable — unknown property,
 * an operator the property kind does not accept, an empty value, or a
 * value that does not parse for the property kind. Never throws.
 */
export function sanitizeCriterion(raw: unknown): QSelectCriterion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.property !== "string" || typeof r.operator !== "string" || typeof r.value !== "string") return null;
  const property = r.property.trim().toLowerCase();
  const operator = r.operator.trim() as QSelectOperator;
  const value = r.value.trim();
  if (!value || value.length > MAX_VALUE_LEN) return null;
  const def = propertyDef(property);
  if (!def) return null;
  if (!operatorsForKind(def.kind).includes(operator)) return null;
  if (def.kind === "number" && !Number.isFinite(Number(value))) return null;
  if (def.kind === "color" && parseColorValue(value) === null) return null;
  if (def.kind === "lineweight" && parseLineweightValue(value) === null) return null;
  return { property, operator, value };
}

/** Validates a list of raw criteria (at most 10); drops the unusable ones. */
export function sanitizeCriteria(raw: unknown): QSelectCriterion[] {
  if (!Array.isArray(raw)) return [];
  const out: QSelectCriterion[] = [];
  for (const item of raw) {
    const c = sanitizeCriterion(item);
    if (c) out.push(c);
    if (out.length >= 10) break;
  }
  return out;
}

/* ── property values ────────────────────────────────────────────────── */

const colorKey = (e: DxfEntity): string =>
  e.rgb != null
    ? `rgb:${(e.rgb & 0xffffff).toString(16).padStart(6, "0")}`
    : e.color != null
      ? `aci:${e.color}`
      : "bylayer";

/** Numeric value of a numeric property, or null when the entity has none. */
function numericValue(e: DxfEntity, property: string): number | null {
  switch (property) {
    case "length": {
      const m = M.entityMetrics(e);
      return m.length ?? null;
    }
    case "radius": {
      const m = M.entityMetrics(e);
      return m.radius ?? null;
    }
    case "area": {
      if (e.type === "ARC") {
        const sw = M.arcSweepDeg(e.startAngle, e.endAngle);
        return 0.5 * e.radius * e.radius * ((sw * Math.PI) / 180);
      }
      const m = M.entityMetrics(e);
      return m.area ?? null;
    }
    case "height":
      return e.type === "TEXT" ? e.height : null;
    case "width": {
      if (e.type !== "LWPOLYLINE") return null;
      if (e.width != null) return e.width;
      if (e.startWidths?.length) return Math.max(...e.startWidths);
      return null;
    }
    default:
      return null;
  }
}

/** String value of a string property, or null when the entity has none. */
function stringValue(e: DxfEntity, property: string): string | null {
  switch (property) {
    case "type":
      return e.type;
    case "layer":
      return e.layer;
    case "linetype":
      return e.lineType ?? "BYLAYER";
    case "text":
      return e.type === "TEXT" ? e.value : null;
    default:
      return null;
  }
}

/* ── matching ───────────────────────────────────────────────────────── */

function compareNumber(actual: number, op: QSelectOperator, want: number): boolean {
  switch (op) {
    case "=": return actual === want;
    case "!=": return actual !== want;
    case ">": return actual > want;
    case "<": return actual < want;
    case ">=": return actual >= want;
    case "<=": return actual <= want;
    default: return false;
  }
}

function compareString(actual: string, op: QSelectOperator, want: string): boolean {
  const a = actual.toLowerCase();
  const w = want.toLowerCase();
  switch (op) {
    case "=": return a === w;
    case "!=": return a !== w;
    case "contains": return a.includes(w);
    case "not-contains": return !a.includes(w);
    default: return false;
  }
}

/** Does one entity satisfy one criterion? An invalid criterion never matches. */
export function matchesCriterion(e: DxfEntity, raw: QSelectCriterion): boolean {
  const c = sanitizeCriterion(raw);
  if (!c) return false;
  const def = propertyDef(c.property)!;
  if (def.kind === "number") {
    const actual = numericValue(e, c.property);
    if (actual === null) return false;
    return compareNumber(actual, c.operator, Number(c.value));
  }
  if (def.kind === "lineweight") {
    const want = parseLineweightValue(c.value)!;
    if (want === "bylayer") return e.lineweight == null ? c.operator === "=" : c.operator === "!=";
    if (e.lineweight == null) return false;
    return compareNumber(e.lineweight, c.operator, want);
  }
  if (def.kind === "color") {
    const want = parseColorValue(c.value)!;
    if (c.operator === "=") return colorKey(e) === want;
    if (c.operator === "!=") return colorKey(e) !== want;
    return compareString(colorKey(e), c.operator, want);
  }
  const actual = stringValue(e, c.property);
  if (actual === null) return false;
  return compareString(actual, c.operator, c.value);
}

/** Every criterion must match; an empty list matches everything. */
export function matchesAllCriteria(e: DxfEntity, criteria: QSelectCriterion[]): boolean {
  for (const c of criteria) if (!matchesCriterion(e, c)) return false;
  return true;
}

/**
 * QSELECT apply: `candidates` are the visible entity indices (the
 * command-line form already restricts to those). "include" replaces the
 * set with the matches, "exclude" removes the matches from the
 * candidates, "append" adds the matches to the current set.
 */
export function applyQSelect(
  entities: DxfEntity[],
  candidates: number[],
  criterion: QSelectCriterion,
  mode: QSelectApplyMode,
  current: ReadonlySet<number>,
): number[] {
  const matches = candidates.filter((i) => entities[i] && matchesCriterion(entities[i], criterion));
  if (mode === "exclude") {
    const hit = new Set(matches);
    return candidates.filter((i) => !hit.has(i));
  }
  if (mode === "append") {
    const out = new Set(current);
    for (const i of matches) out.add(i);
    return [...out].sort((a, b) => a - b);
  }
  return matches;
}

/* ── named filters ──────────────────────────────────────────────────── */

export interface NamedFilter {
  name: string;
  /** Entity types the filter allows (empty = every type). */
  types: string[];
  /** Property criteria; all must match (AND). */
  criteria: QSelectCriterion[];
}

const MAX_FILTERS = 50;
const MAX_TYPES = 60;
const MAX_NAME_LEN = 100;

/** Validates a stored named filter; returns null when it is not usable. Never throws. */
export function sanitizeNamedFilter(raw: unknown): NamedFilter | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  const name = r.name.trim();
  if (!name || name.length > MAX_NAME_LEN) return null;
  const types = Array.isArray(r.types)
    ? r.types.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= MAX_VALUE_LEN).slice(0, MAX_TYPES)
    : [];
  return { name, types, criteria: sanitizeCriteria(r.criteria) };
}

/** Validates a stored map of named filters (at most 50); drops the unusable ones. */
export function sanitizeNamedFilters(raw: unknown): Record<string, NamedFilter> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, NamedFilter> = {};
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const f = sanitizeNamedFilter(value);
    if (f) out[f.name] = f;
    if (Object.keys(out).length >= MAX_FILTERS) break;
  }
  return out;
}

/** Plain-JSON form of the named-filter map for the drawing session store. */
export function serializeNamedFilters(map: ReadonlyMap<string, NamedFilter>): Record<string, NamedFilter> {
  const out: Record<string, NamedFilter> = {};
  for (const [k, v] of map) out[k] = { name: v.name, types: [...v.types], criteria: v.criteria.map((c) => ({ ...c })) };
  return out;
}

/* ── previous selection ─────────────────────────────────────────────── */

/**
 * The previous selection after a selection change: the new set when it
 * is non-empty, otherwise the set already stored. Clearing the selection
 * never erases the previous one.
 */
export function recordPrevious(prev: number[], sel: number[]): number[] {
  return sel.length ? [...sel] : prev;
}

/** Previous-selection indices that still point at live entities. */
export function restorePrevious(prev: number[], entityCount: number): number[] {
  return prev.filter((i) => Number.isInteger(i) && i >= 0 && i < entityCount);
}
