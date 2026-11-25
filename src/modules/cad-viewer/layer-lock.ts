/**
 * AutoCAD layer-lock enforcement (parity item A3) — pure helpers.
 *
 * AutoCAD rule: locked layers stay visible but their entities are never
 * selectable or editable, and no grips appear on them. The CAD viewer used
 * to store `layer.locked` as a flag + icon only — `visible()` and every
 * pick/select/edit path ignored it. These helpers are the single decision
 * point for "is this entity on a locked layer?"; `cad-viewer.ts` wires them
 * into the click pick, window/crossing selection, grip painting/hit-test,
 * `setSel`, the modify commits and the bulk-delete commands.
 *
 * Pure functions; no DOM, no viewer state — node-testable.
 */
import type { DxfEntity, DxfLayer } from "../drawings/dxf-types";

/** True when the named layer exists in the layer table and is locked. Unknown layers are treated as unlocked. */
export function isLayerLocked(layers: DxfLayer[] | undefined | null, layer: string): boolean {
  if (!layers) return false;
  for (const l of layers) if (l.name === layer) return !!l.locked;
  return false;
}

/** Names of the locked layers in the table (empty when there is no table). */
export function lockedLayerNames(layers: DxfLayer[] | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!layers) return out;
  for (const l of layers) if (l.locked) out.add(l.name);
  return out;
}

/** True when the entity sits on a locked layer. */
export function isEntityLocked(e: DxfEntity, layers: DxfLayer[] | undefined | null): boolean {
  return isLayerLocked(layers, e.layer);
}

/**
 * Pick/selection predicate: the entity passes the caller's own visibility
 * test (hidden layers, type filter, …) AND is not on a locked layer.
 * Rendering keeps using the visibility test alone, so locked layers stay drawn.
 */
export function isPickable(e: DxfEntity, layers: DxfLayer[] | undefined | null, visible: (e: DxfEntity) => boolean): boolean {
  return visible(e) && !isEntityLocked(e, layers);
}

/**
 * Keep only the indices whose entities are NOT on a locked layer.
 * Indices out of range or pointing at a missing entity are dropped.
 * Visibility is deliberately NOT checked here: callers that select without a
 * visibility filter (LAYSEL, TYPESEL, SELECTALL) keep their existing
 * behaviour for hidden layers; the lock gate is the only new exclusion.
 */
export function filterUnlockedIndices(entities: DxfEntity[], layers: DxfLayer[] | undefined | null, ids: number[]): number[] {
  const locked = lockedLayerNames(layers);
  const out: number[] = [];
  for (const i of ids) {
    const e = entities[i];
    if (!e) continue;
    if (locked.has(e.layer)) continue;
    out.push(i);
  }
  return out;
}
