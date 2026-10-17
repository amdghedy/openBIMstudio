/**
 * View store — CRUD + persistence for ViewDef.
 */

import type { ViewDef, ViewKind, Discipline } from "./types";

const STORAGE_KEY = "obs.views.v1";

let views: ViewDef[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* */ }
  }
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(views)); } catch { /* */ }
}

export function bootViewsStore(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) views = parsed;
    }
  } catch { /* */ }
  if (!views.length) seedDefaultViews();
  notify();
}

function seedDefaultViews(): void {
  const now = Date.now();
  views = [
    {
      id: "plan-level-0",
      kind: "plan",
      name: "Level 0 Plan",
      scale: 100,
      discipline: "COORD",
      crop: null,
      plan: { levelId: "level-0", levelElevation: 0, cutHeight: 1.2, topHeight: 2.4, bottomDepth: 1.2, viewDepth: 4.0 },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "plan-level-1",
      kind: "plan",
      name: "Level 1 Plan",
      scale: 100,
      discipline: "COORD",
      crop: null,
      plan: { levelId: "level-1", levelElevation: 3, cutHeight: 1.2, topHeight: 2.4, bottomDepth: 1.2, viewDepth: 4.0 },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "elev-north",
      kind: "elevation",
      name: "North Elevation",
      scale: 100,
      discipline: "COORD",
      crop: null,
      elevation: { direction: "north", origin: [0, 3, 15], farClip: 60 },
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "section-a",
      kind: "section",
      name: "Section A-A",
      scale: 50,
      discipline: "COORD",
      crop: null,
      section: { cutLine: { x1: -5, z1: 0, x2: 5, z2: 0 }, lookDir: "right", top: 6, bottom: -1, farClip: 30 },
      createdAt: now,
      updatedAt: now,
    },
  ];
}

export function listViews(): ViewDef[] { return views.slice(); }
export function listViewsByKind(kind: ViewKind): ViewDef[] { return views.filter((v) => v.kind === kind); }
export function getView(id: string): ViewDef | null { return views.find((v) => v.id === id) ?? null; }

export function addView(def: ViewDef): ViewDef {
  views.push(def);
  persist();
  notify();
  return def;
}

export function updateView(id: string, patch: Partial<ViewDef>): ViewDef | null {
  const v = views.find((x) => x.id === id);
  if (!v) return null;
  Object.assign(v, patch, { updatedAt: Date.now() });
  persist();
  notify();
  return v;
}

export function deleteView(id: string): boolean {
  const before = views.length;
  views = views.filter((v) => v.id !== id);
  if (views.length === before) return false;
  persist();
  notify();
  return true;
}

export function createView(kind: ViewKind, name: string, discipline: Discipline = "COORD"): ViewDef {
  const now = Date.now();
  const def: ViewDef = {
    id: `view-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind, name, scale: 100, discipline, crop: null,
    createdAt: now, updatedAt: now,
  };
  if (kind === "plan" || kind === "rcp") {
    def.plan = { levelId: "level-0", levelElevation: 0, cutHeight: 1.2, topHeight: 2.4, bottomDepth: 1.2, viewDepth: 4.0 };
  }
  if (kind === "section") {
    def.section = { cutLine: { x1: -5, z1: 0, x2: 5, z2: 0 }, lookDir: "right", top: 6, bottom: -1, farClip: 30 };
  }
  if (kind === "elevation") {
    def.elevation = { direction: "south", origin: [0, 3, 15], farClip: 60 };
  }
  return addView(def);
}

export function onViewsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}