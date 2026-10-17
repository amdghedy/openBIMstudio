/**
 * Property readers shared by rule packs.
 *
 * Fragments exposes getItemsData(ids, opts) which returns a heterogeneous
 * object graph. This module flattens it into a simple { key: string } map
 * so rules can do:
 *   const fireRating = props.get(id)?.["Pset_DoorCommon.FireRating"];
 */
import type { RuleContext } from "./types";

export interface FlatProps {
  /** Bare attribute names, e.g. "Name", "GlobalId". */
  [key: string]: string;
}

export async function readProperties(
  ctx: RuleContext,
  ids: number[],
  attributes: string[] = ["Name", "ObjectType", "Tag", "GlobalId", "PredefinedType"],
): Promise<Map<number, FlatProps>> {
  const out = new Map<number, FlatProps>();
  if (!ids.length) return out;

  const CHUNK = 800;
  for (let i = 0; i < ids.length; i += CHUNK) {
    if (ctx.isCancelled?.()) break;
    const slice = ids.slice(i, i + CHUNK);
    let data: any[] = [];
    try {
      data = await (ctx.model as any).getItemsData(slice, {
        attributesDefault: false,
        attributes,
        psetsDefault: true,
        qtosDefault: false,
      });
    } catch {
      continue;
    }
    for (let j = 0; j < slice.length; j++) {
      out.set(slice[j], flatten(data[j] ?? {}));
    }
    ctx.progress?.(i + slice.length, ids.length);
  }
  return out;
}

function flatten(d: any): FlatProps {
  const out: FlatProps = {};
  if (!d || typeof d !== "object") return out;

  for (const [k, v] of Object.entries(d)) {
    if (k === "psets") continue;
    const val = (v as any)?.value ?? v;
    if (val == null) continue;
    if (typeof val === "object") continue;
    out[k] = String(val);
  }

  const psets = (d as any).psets;
  if (psets && typeof psets === "object") {
    for (const [psName, props] of Object.entries(psets)) {
      if (!props || typeof props !== "object") continue;
      for (const [pk, pv] of Object.entries(props as any)) {
        const val = (pv as any)?.value ?? pv;
        if (val == null) continue;
        if (typeof val === "object") continue;
        out[`${psName}.${pk}`] = String(val);
      }
    }
  }
  return out;
}

/** Case-insensitive property lookup with dotted fallback. */
export function getProp(flat: FlatProps | undefined, name: string): string | undefined {
  if (!flat) return undefined;
  if (flat[name] != null) return flat[name];
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(flat)) {
    if (k.toLowerCase() === lower) return v;
    const bare = k.includes(".") ? k.split(".").pop()! : k;
    if (bare.toLowerCase() === lower) return v;
  }
  return undefined;
}

export function getNumber(flat: FlatProps | undefined, ...names: string[]): number | null {
  for (const n of names) {
    const v = getProp(flat, n);
    if (v == null) continue;
    const num = parseFloat(v);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

export function getString(flat: FlatProps | undefined, ...names: string[]): string | null {
  for (const n of names) {
    const v = getProp(flat, n);
    if (v != null && v !== "") return v;
  }
  return null;
}