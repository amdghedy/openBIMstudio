/**
 * Dynamic-block parameters, authored in the editor (AutoCAD 2D parity A9).
 *
 * The model is the in-reach subset of AutoCAD dynamic blocks: parameters
 * authored on a block definition in the editor, with an action each, a grip
 * per parameter, and per-instance values on the INSERT. Import of real DWG
 * dynamic-block parameters is OUT OF REACH — it needs DWG dynamic-block
 * evaluation on the Rust side (recorded as a follow-up).
 *
 * Parameters:
 * - linear: a distance along an angle from a base point. The action moves
 *   the selection by (value - baseValue) along the angle. (A true AutoCAD
 *   stretch would move only the endpoints past the grip; this is a move
 *   action — honest, and what the grip drag proves.)
 * - rotation: an angle about a base point. The action rotates the
 *   selection by (value - baseValue) degrees.
 * - flip: a boolean mirror about the axis through the base point
 *   ("x" = the vertical line x = base.x, "y" = the horizontal line
 *   y = base.y — the same convention as the existing DynAction flip).
 * - visibility: named states, each hiding a list of the definition's
 *   entities BY INDEX into the definition's entity list (entities have no
 *   stable id; out-of-range indices are ignored). Hidden geometry is
 *   removed from the evaluated output — this is real per-state show/hide
 *   of geometry, not the old DynBlockStore layer/tag filter.
 * - lookup: a table mapping a chosen value to values for other
 *   parameters (one level; a lookup never drives another lookup).
 *
 * `selection` is a list of indices into the definition's entities; an
 * empty selection means "the whole block". Evaluation is pure: it clones
 * the input entities and never mutates them. Lookup values resolve before
 * the geometric actions run; visibility filters first.
 *
 * Persistence is the caller's job for the store (localStorage, mirroring
 * the existing DynBlockRich `obs.dynblock.<name>` record, under the
 * separate key `obs.dynblock.params.<name>` so the two never collide).
 */
import type { DxfBlockDef, DxfEntity, DxfInsert, DxfPoint } from "../drawings/dxf-types";
import { mirrorEnt, rotateEnt, translateEnt } from "./modify-math";

export type DynValue = number | string | boolean;

export interface DynParamBase {
  id: string;
  name: string;
  /** Indices into the definition's entities the action applies to; [] = all. */
  selection: number[];
}

export interface DynLinearParam extends DynParamBase {
  kind: "linear";
  basePoint: DxfPoint;
  /** Direction in degrees (0 = +X). */
  angle: number;
  value: number;
  baseValue: number;
}

export interface DynRotationParam extends DynParamBase {
  kind: "rotation";
  basePoint: DxfPoint;
  value: number;
  baseValue: number;
}

export interface DynFlipParam extends DynParamBase {
  kind: "flip";
  basePoint: DxfPoint;
  /** "x" = mirror about the vertical line x = base.x; "y" = the horizontal line y = base.y. */
  axis: "x" | "y";
  value: boolean;
}

export interface DynVisibilityParam extends DynParamBase {
  kind: "visibility";
  states: Array<{ name: string; hidden: number[] }>;
  value: string;
}

export interface DynLookupParam extends DynParamBase {
  kind: "lookup";
  table: Array<{ value: string; sets: Record<string, DynValue> }>;
  value: string;
}

export type DynParam = DynLinearParam | DynRotationParam | DynFlipParam | DynVisibilityParam | DynLookupParam;

export interface DynParamSet {
  blockName: string;
  params: DynParam[];
  /** The definition's current (default) values by parameter id. */
  values: Record<string, DynValue>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** The parameter's default value (baseValue for linear/rotation, false for flip, first state/row otherwise). */
export function defaultDynValue(p: DynParam): DynValue {
  switch (p.kind) {
    case "linear":
    case "rotation": return p.baseValue;
    case "flip": return false;
    case "visibility": return p.states[0]?.name ?? "";
    case "lookup": return p.table[0]?.value ?? "";
  }
}

/** Values a fresh parameter set starts with. */
export function defaultDynValues(params: DynParam[]): Record<string, DynValue> {
  const out: Record<string, DynValue> = {};
  for (const p of params) out[p.id] = defaultDynValue(p);
  return out;
}

/** Effective values for an instance: the instance's overrides win over the definition's defaults. */
export function effectiveDynValues(set: DynParamSet, instance?: Record<string, DynValue>): Record<string, DynValue> {
  const out: Record<string, DynValue> = { ...set.values };
  for (const p of set.params) if (out[p.id] === undefined) out[p.id] = defaultDynValue(p);
  for (const [k, v] of Object.entries(instance ?? {})) if (set.params.some((p) => p.id === k)) out[k] = v;
  return out;
}

/** Apply the lookup rows: a lookup's chosen value sets the named parameters (one level). */
export function resolveLookupValues(params: DynParam[], values: Record<string, DynValue>): Record<string, DynValue> {
  const out: Record<string, DynValue> = { ...values };
  for (const p of params) {
    if (p.kind !== "lookup") continue;
    const row = p.table.find((r) => r.value === String(values[p.id] ?? ""));
    if (!row) continue;
    for (const [id, v] of Object.entries(row.sets)) {
      const target = params.find((q) => q.id === id);
      if (target && target.kind !== "lookup") out[id] = v;
    }
  }
  return out;
}

function selectedIndices(p: DynParam, count: number): Set<number> {
  if (!p.selection.length) return new Set(Array.from({ length: count }, (_, i) => i));
  return new Set(p.selection.filter((i) => Number.isInteger(i) && i >= 0 && i < count));
}

/**
 * Evaluate a block definition's entities under parameter values: visibility
 * states hide their geometry, lookup rows set the driven values, then the
 * geometric actions run in parameter order. Returns fresh entities.
 */
export function evaluateDynBlock(entities: DxfEntity[], params: DynParam[], values: Record<string, DynValue>): DxfEntity[] {
  const resolved = resolveLookupValues(params, values);
  // Visibility first: hidden geometry is removed, never drawn/picked/snapped.
  const hidden = new Set<number>();
  for (const p of params) {
    if (p.kind !== "visibility") continue;
    const state = p.states.find((s) => s.name === String(resolved[p.id] ?? ""));
    if (state) for (const i of state.hidden) hidden.add(i);
  }
  let out = entities.map((e) => clone(e)).filter((_, i) => !hidden.has(i));
  // Geometric actions, in parameter order. Indices refer to the ORIGINAL
  // definition order, so map them through the visibility filter.
  const keptIndex = entities.map((_, i) => i).filter((i) => !hidden.has(i));
  for (const p of params) {
    const sel = selectedIndices(p, entities.length);
    const apply = (fn: (e: DxfEntity) => DxfEntity): void => {
      out = out.map((e, j) => (sel.has(keptIndex[j]) ? fn(e) : e));
    };
    if (p.kind === "linear") {
      const d = (Number(resolved[p.id]) || 0) - p.baseValue;
      if (Math.abs(d) < 1e-12) continue;
      const rad = (p.angle * Math.PI) / 180;
      apply((e) => translateEnt(e, Math.cos(rad) * d, Math.sin(rad) * d));
    } else if (p.kind === "rotation") {
      const d = (Number(resolved[p.id]) || 0) - p.baseValue;
      if (Math.abs(d) < 1e-12) continue;
      apply((e) => rotateEnt(e, p.basePoint.x, p.basePoint.y, d));
    } else if (p.kind === "flip") {
      if (resolved[p.id] !== true) continue;
      const a = { x: p.basePoint.x, y: p.basePoint.y };
      const b = p.axis === "x" ? { x: p.basePoint.x, y: p.basePoint.y + 1 } : { x: p.basePoint.x + 1, y: p.basePoint.y };
      apply((e) => mirrorEnt(e, a, b));
    }
  }
  return out;
}

/* ── Grips ─────────────────────────────────────────────────────────────── */

/**
 * Move one block-space point through a set's geometric actions (for grip
 * display): the grip of a parameter must sit on the geometry as the OTHER
 * parameters transform it — e.g. the linear grip of a flipped block sits
 * at the mirrored position. `exceptId` skips the parameter the grip
 * belongs to (its own value is already in the grip point). Lookup rows
 * must already be resolved into `values`; visibility moves nothing.
 */
export function dynPointThroughParams(params: DynParam[], values: Record<string, DynValue>, pt: DxfPoint, exceptId?: string): DxfPoint {
  let out = { ...pt };
  for (const p of params) {
    if (p.id === exceptId) continue;
    out = dynPointAction(p, values[p.id] ?? defaultDynValue(p), out, 1);
  }
  return out;
}

/** Inverse of dynPointThroughParams (for grip drags): undo the other parameters' actions, in reverse order. */
export function dynPointInverseThroughParams(params: DynParam[], values: Record<string, DynValue>, pt: DxfPoint, exceptId?: string): DxfPoint {
  let out = { ...pt };
  for (let i = params.length - 1; i >= 0; i--) {
    const p = params[i];
    if (p.id === exceptId) continue;
    out = dynPointAction(p, values[p.id] ?? defaultDynValue(p), out, -1);
  }
  return out;
}

function dynPointAction(p: DynParam, value: DynValue, pt: DxfPoint, sign: 1 | -1): DxfPoint {
  if (p.kind === "linear") {
    const d = ((Number(value) || 0) - p.baseValue) * sign;
    const rad = (p.angle * Math.PI) / 180;
    return { x: pt.x + Math.cos(rad) * d, y: pt.y + Math.sin(rad) * d };
  }
  if (p.kind === "rotation") {
    const d = (((Number(value) || 0) - p.baseValue) * sign * Math.PI) / 180;
    const dx = pt.x - p.basePoint.x, dy = pt.y - p.basePoint.y;
    return {
      x: p.basePoint.x + dx * Math.cos(d) - dy * Math.sin(d),
      y: p.basePoint.y + dx * Math.sin(d) + dy * Math.cos(d),
    };
  }
  if (p.kind === "flip" && value === true) {
    // Mirroring is its own inverse; the sign does not matter.
    return p.axis === "x" ? { x: 2 * p.basePoint.x - pt.x, y: pt.y } : { x: pt.x, y: 2 * p.basePoint.y - pt.y };
  }
  return pt;
}

/** Fixed grip-arm length for the rotation grip (drawing units). */
export const ROTATION_GRIP_RADIUS = 20;
/** Fixed grip offset for the flip grip (drawing units). */
export const FLIP_GRIP_OFFSET = 12;

/** Block-space grip point for a parameter at its current value (visibility/lookup have none). */
export function paramGripPoint(p: DynParam, values: Record<string, DynValue>): DxfPoint | null {
  const v = values[p.id] ?? defaultDynValue(p);
  if (p.kind === "linear") {
    const rad = (p.angle * Math.PI) / 180;
    const d = Number(v) || 0;
    return { x: p.basePoint.x + Math.cos(rad) * d, y: p.basePoint.y + Math.sin(rad) * d };
  }
  if (p.kind === "rotation") {
    const rad = ((Number(v) || 0) * Math.PI) / 180;
    return { x: p.basePoint.x + Math.cos(rad) * ROTATION_GRIP_RADIUS, y: p.basePoint.y + Math.sin(rad) * ROTATION_GRIP_RADIUS };
  }
  if (p.kind === "flip") {
    return p.axis === "x"
      ? { x: p.basePoint.x + FLIP_GRIP_OFFSET, y: p.basePoint.y }
      : { x: p.basePoint.x, y: p.basePoint.y + FLIP_GRIP_OFFSET };
  }
  return null;
}

/** Value a drag to `pt` (block space) sets for a linear/rotation parameter; null for flip. */
export function paramValueFromPoint(p: DynParam, pt: DxfPoint): number | null {
  if (p.kind === "linear") {
    const rad = (p.angle * Math.PI) / 180;
    return (pt.x - p.basePoint.x) * Math.cos(rad) + (pt.y - p.basePoint.y) * Math.sin(rad);
  }
  if (p.kind === "rotation") {
    return (Math.atan2(pt.y - p.basePoint.y, pt.x - p.basePoint.x) * 180) / Math.PI;
  }
  return null;
}

/** Block-space point → world point through a reference's transform (first array cell; base from the definition). */
export function dynGripWorldPoint(ins: DxfInsert, base: DxfPoint, pt: DxfPoint): DxfPoint {
  const a = ((ins.rotation ?? 0) * Math.PI) / 180;
  const sx = ins.scale?.x ?? 1, sy = ins.scale?.y ?? 1;
  const lx = (pt.x - base.x) * sx, ly = (pt.y - base.y) * sy;
  return {
    x: ins.position.x + lx * Math.cos(a) - ly * Math.sin(a),
    y: ins.position.y + lx * Math.sin(a) + ly * Math.cos(a),
  };
}

/** World point → block-space point through the inverse of a reference's transform. */
export function dynWorldToBlockPoint(ins: DxfInsert, base: DxfPoint, pt: DxfPoint): DxfPoint {
  const a = ((ins.rotation ?? 0) * Math.PI) / 180;
  const sx = ins.scale?.x ?? 1, sy = ins.scale?.y ?? 1;
  const dx = pt.x - ins.position.x, dy = pt.y - ins.position.y;
  const lx = (dx * Math.cos(a) + dy * Math.sin(a)) / sx;
  const ly = (-dx * Math.sin(a) + dy * Math.cos(a)) / sy;
  return { x: lx + base.x, y: ly + base.y };
}

/* ── Validation ────────────────────────────────────────────────────────── */

export function validateDynParam(p: DynParam, others: DynParam[]): string | null {
  const id = (p.id ?? "").trim();
  if (!id) return "A dynamic-block parameter needs an id.";
  if (/\s/.test(id)) return "Parameter ids cannot contain spaces.";
  if (others.some((q) => q.id === id)) return `A parameter named "${id}" already exists on this block.`;
  if (!Array.isArray(p.selection) || p.selection.some((i) => !Number.isInteger(i) || i < 0)) return "The selection must be a list of entity indices.";
  if (p.kind === "linear" || p.kind === "rotation") {
    if (!p.basePoint || !isNum(p.basePoint.x) || !isNum(p.basePoint.y)) return "The parameter needs a finite base point.";
    if (p.kind === "linear" && !isNum(p.angle)) return "The linear parameter needs an angle in degrees.";
    if (!isNum(p.value) || !isNum(p.baseValue)) return "The parameter needs finite values.";
  }
  if (p.kind === "flip" && p.axis !== "x" && p.axis !== "y") return "The flip axis must be X or Y.";
  if (p.kind === "visibility") {
    if (!p.states.length) return "A visibility parameter needs at least one state.";
    const names = p.states.map((s) => s.name);
    if (names.some((n) => !n) || new Set(names).size !== names.length) return "Visibility states need unique non-empty names.";
    if (p.states.some((s) => !Array.isArray(s.hidden) || s.hidden.some((i) => !Number.isInteger(i) || i < 0))) return "Hidden sets must be lists of entity indices.";
  }
  if (p.kind === "lookup") {
    if (!p.table.length) return "A lookup table needs at least one row.";
    const vals = p.table.map((r) => r.value);
    if (vals.some((v) => !v) || new Set(vals).size !== vals.length) return "Lookup rows need unique non-empty values.";
    if (p.table.some((r) => !r.sets || typeof r.sets !== "object")) return "Each lookup row must set at least one parameter.";
  }
  return null;
}

/* ── Store ─────────────────────────────────────────────────────────────── */

export const DYN_PARAM_KEY = (blockName: string): string => `obs.dynblock.params.${blockName.toLowerCase()}`;

function sanitizeParamSet(raw: unknown): DynParamSet | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { blockName?: unknown; params?: unknown; values?: unknown };
  if (typeof o.blockName !== "string" || !o.blockName || !Array.isArray(o.params)) return null;
  const params: DynParam[] = [];
  for (const p of o.params as DynParam[]) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || typeof p.kind !== "string") continue;
    if (validateDynParam(p, params)) continue;
    params.push(clone(p));
  }
  if (!params.length) return null;
  const values: Record<string, DynValue> = {};
  const rawValues = (o.values ?? {}) as Record<string, DynValue>;
  for (const p of params) {
    const v = rawValues[p.id];
    values[p.id] = v === undefined ? defaultDynValue(p) : v;
  }
  return { blockName: o.blockName, params, values };
}

/** In-memory parameter sets with localStorage persistence (storage itself is the caller's job to inject). */
export class DynParamStore {
  private map = new Map<string, DynParamSet>();
  get(blockName: string): DynParamSet | undefined {
    return this.map.get(blockName.toLowerCase());
  }
  names(): string[] {
    return [...this.map.values()].map((s) => s.blockName);
  }
  set(set: DynParamSet): void {
    this.map.set(set.blockName.toLowerCase(), clone(set));
  }
  remove(blockName: string): boolean {
    return this.map.delete(blockName.toLowerCase());
  }
  /** Serialize one set for storage. */
  static serialize(set: DynParamSet): string {
    return JSON.stringify(set);
  }
  /** Parse a stored set; null when the record is corrupt (never throws). */
  static deserialize(raw: string | null): DynParamSet | null {
    if (!raw) return null;
    try { return sanitizeParamSet(JSON.parse(raw)); } catch { return null; }
  }
  /** Load every stored set through a reader (localStorage.getItem by default shape). */
  loadAll(read: (key: string) => string | null, keys: string[]): void {
    for (const k of keys) {
      const set = DynParamStore.deserialize(read(k));
      if (set) this.map.set(set.blockName.toLowerCase(), set);
    }
  }
}

/** The definition a set of parameters belongs to (for grip transforms). */
export function findDynBlockDef(blocks: Record<string, DxfBlockDef> | undefined, name: string): DxfBlockDef | undefined {
  if (!blocks) return undefined;
  const key = name.toLowerCase();
  return Object.values(blocks).find((b) => b.name.toLowerCase() === key);
}
