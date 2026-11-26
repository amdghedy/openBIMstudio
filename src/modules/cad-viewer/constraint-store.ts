/**
 * Constraint persistence (Phase 4c): recorded relations travel with the DXF as XRECORDs under a named
 * dictionary entry, so a saved drawing re-opens with its constraints still attached.
 *
 * Entities have no file-level identity in the model, so a stored relation names objects by their position
 * in the model-space list plus a geometry fingerprint. On load a relation is only restored when every
 * fingerprint still matches the object at that position; anything else is dropped and counted — a
 * constraint is never attached to the wrong object.
 */
import type { DxfEntity } from "../drawings/dxf-types";
import type { Relation, RelationKind } from "./constraint-bridge";
import { relationArity } from "./constraint-bridge";

export interface StoredConstraint {
  kind: string;
  /** Positions in the model-space entity list. */
  refs: number[];
  /** One fingerprint per ref (same order). */
  fp: string[];
  value?: number;
}

const KINDS: ReadonlySet<string> = new Set(["horizontal", "vertical", "parallel", "perpendicular", "equal", "concentric", "tangent", "length", "radius", "angle"]);
const KEYS = ["start", "end", "center", "radius", "position", "startAngle", "endAngle", "vertices", "majorAxis", "ratio", "rx", "ry"];

const r4 = (n: number): string => (Number.isFinite(n) ? (Math.round(n * 1e4) / 1e4).toString() : "x");

function flat(v: unknown, out: string[], depth = 0): void {
  if (typeof v === "number") out.push(r4(v));
  else if (Array.isArray(v) && depth < 3) { for (const x of v.slice(0, 64)) flat(x, out, depth + 1); }
  else if (v && typeof v === "object" && depth < 3) { const o = v as Record<string, unknown>; for (const k of ["x", "y", "bulge"]) if (typeof o[k] === "number") out.push(r4(o[k] as number)); }
}

/** Stable, file-safe digest of an entity's type and geometry (ASCII, no spaces, ≤ 255 chars). */
export function fingerprint(e: DxfEntity): string {
  const parts: string[] = [String((e as { type?: string }).type ?? "?")];
  const o = e as unknown as Record<string, unknown>;
  for (const k of KEYS) if (k in o) flat(o[k], parts);
  return parts.join(";").replace(/[^A-Za-z0-9;.\-+]/g, "_").slice(0, 250);
}

export interface ExportResult { stored: StoredConstraint[]; dropped: number }

/** Map live relations (session ids) onto positions in `list`; relations naming an object that is gone are dropped. */
export function exportConstraints(relations: readonly Relation[], list: readonly DxfEntity[], uidOf: (e: DxfEntity) => string | undefined): ExportResult {
  const pos = new Map<string, number>();
  list.forEach((e, i) => { const u = uidOf(e); if (u) pos.set(u, i); });
  const stored: StoredConstraint[] = [];
  let dropped = 0;
  for (const r of relations) {
    const refs = r.ids.map((id) => pos.get(id));
    if (refs.some((x) => x === undefined) || refs.length !== relationArity(r.kind)) { dropped++; continue; }
    const idx = refs as number[];
    stored.push({ kind: r.kind, refs: idx, fp: idx.map((i) => fingerprint(list[i])), ...(r.value !== undefined && Number.isFinite(r.value) ? { value: r.value } : {}) });
  }
  return { stored, dropped };
}

export interface RestoreResult { ok: Array<{ kind: RelationKind; refs: number[]; value?: number }>; dropped: number }

/** Keep only stored relations whose every fingerprint still matches the object at its position. */
export function verifyConstraints(stored: readonly StoredConstraint[] | undefined, list: readonly DxfEntity[]): RestoreResult {
  const ok: RestoreResult["ok"] = [];
  let dropped = 0;
  for (const c of stored ?? []) {
    const valid = KINDS.has(c.kind) && c.refs.length === relationArity(c.kind as RelationKind) && c.fp.length === c.refs.length
      && c.refs.every((i, k) => Number.isInteger(i) && i >= 0 && i < list.length && fingerprint(list[i]) === c.fp[k])
      && new Set(c.refs).size === c.refs.length;
    if (!valid) { dropped++; continue; }
    ok.push({ kind: c.kind as RelationKind, refs: [...c.refs], ...(c.value !== undefined ? { value: c.value } : {}) });
  }
  return { ok, dropped };
}
