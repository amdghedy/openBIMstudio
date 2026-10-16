// openbim-levels:level-driven-modeling
// Level facade over the authoring level array.
//
// Single source of truth is features/authoring.ts (which persists the
// level list into the project document via setLevels/getLevels). This
// module provides a stable, discoverable API for the ribbon, status bar,
// property palette, plan panel, and schedules, so they never reach into
// authoring internals.
//
// Back-compat: getLevels() / setLevels() still return / accept the same
// LevelDatum[] shape, so any pre-existing project document loads
// unchanged. Elements authored before this block have no levelId; that
// is legal (levelId is optional on AuthoredElement).

import {
  getLevels as getAuthoringLevels,
  setLevels as setAuthoringLevels,
  getActiveLevelId as getActiveLevelIdInner,
  setActiveLevelById as setActiveLevelByIdInner,
  onAuthoringChange,
} from "../../features/authoring";
import type { LevelDatum } from "../projects/types";

export type LevelRecord = LevelDatum;

const DEFAULT_LEVELS: ReadonlyArray<{ name: string; elevation: number }> = [
  { name: "Level 0", elevation: 0 },
  { name: "Level 1", elevation: 3 },
  { name: "Level 2", elevation: 6 },
];

function uid(): string {
  return (
    (crypto as any).randomUUID?.() ??
    `lvl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  );
}

export const levels = {
  /** All levels, sorted by elevation ascending. */
  list(): LevelRecord[] {
    return getAuthoringLevels()
      .slice()
      .sort((a, b) => a.elevation - b.elevation);
  },

  get(id: string | null | undefined): LevelRecord | null {
    if (!id) return null;
    return getAuthoringLevels().find((l) => l.id === id) ?? null;
  },

  /** First level whose elevation is within `tol` metres of `elevation`. */
  findByElevation(elevation: number, tol = 0.001): LevelRecord | null {
    for (const l of getAuthoringLevels()) {
      if (Math.abs(l.elevation - elevation) <= tol) return l;
    }
    return null;
  },

  /** Nearest level by |elevation - target|. */
  findNearest(elevation: number): LevelRecord | null {
    const all = getAuthoringLevels();
    if (!all.length) return null;
    let best = all[0];
    let bestD = Math.abs(best.elevation - elevation);
    for (let i = 1; i < all.length; i++) {
      const d = Math.abs(all[i].elevation - elevation);
      if (d < bestD) { bestD = d; best = all[i]; }
    }
    return best;
  },

  add(partial: Partial<LevelRecord> = {}): LevelRecord {
    const list = getAuthoringLevels().slice();
    const elevation =
      typeof partial.elevation === "number" && Number.isFinite(partial.elevation)
        ? partial.elevation
        : list.length
          ? list[list.length - 1].elevation + 3
          : 0;
    const record: LevelRecord = {
      id: partial.id || uid(),
      name: partial.name || `Level ${list.length}`,
      elevation,
      color: partial.color,
    };
    list.push(record);
    setAuthoringLevels(list);
    return record;
  },

  update(id: string, patch: Partial<LevelRecord>): LevelRecord | null {
    const list = getAuthoringLevels().slice();
    const i = list.findIndex((l) => l.id === id);
    if (i < 0) return null;
    const next: LevelRecord = { ...list[i], ...patch, id };
    list[i] = next;
    setAuthoringLevels(list);
    return next;
  },

  remove(id: string): boolean {
    const list = getAuthoringLevels().slice();
    const next = list.filter((l) => l.id !== id);
    if (next.length === list.length) return false;
    setAuthoringLevels(next);
    return true;
  },

  /** Seed 3 standard levels when the project has none. Idempotent. */
  ensureSeed(): LevelRecord[] {
    const existing = getAuthoringLevels();
    if (existing.length) return existing.slice();
    const seeded: LevelRecord[] = DEFAULT_LEVELS.map((d) => ({
      id: uid(),
      name: d.name,
      elevation: d.elevation,
    }));
    setAuthoringLevels(seeded);
    return seeded;
  },

  getActiveId(): string | null {
    return getActiveLevelIdInner();
  },

  getActive(): LevelRecord | null {
    const id = getActiveLevelIdInner();
    return id ? (getAuthoringLevels().find((l) => l.id === id) ?? null) : null;
  },

  setActiveId(id: string | null): void {
    setActiveLevelByIdInner(id);
  },

  /** Convenience: activate the level whose elevation matches exactly. */
  setActiveByElevation(elevation: number, tol = 0.001): boolean {
    const hit = this.findByElevation(elevation, tol);
    if (!hit) return false;
    this.setActiveId(hit.id);
    return true;
  },

  onChange(cb: () => void): () => void {
    return onAuthoringChange(cb);
  },
};