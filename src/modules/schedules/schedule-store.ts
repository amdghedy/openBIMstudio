/**
 * Persistent schedule storage.
 *
 * Stores user-created schedule definitions in localStorage, separate from
 * the built-in templates. A definition is self-contained — everything the
 * generator needs to produce rows.
 */
import type { ScheduleDefinition } from "./schedule-types";

const STORE_KEY = "obs.schedules.definitions.v1";

export interface StoredSchedule extends ScheduleDefinition {
  /** Auto-filled when the user creates a schedule. */
  createdAt?: number;
  /** Last time the definition was edited or run. */
  lastRunAt?: number;
  /** Marked when the schedule is derived from a built-in template. */
  derivedFrom?: string;
}

export function listSavedSchedules(): StoredSchedule[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as StoredSchedule[];
  } catch {
    return [];
  }
}

export function getSavedSchedule(id: string): StoredSchedule | null {
  return listSavedSchedules().find((s) => s.id === id) ?? null;
}

function persist(list: StoredSchedule[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn("[schedule-store] failed to persist", err);
  }
}

export function saveSchedule(def: ScheduleDefinition): StoredSchedule {
  const list = listSavedSchedules();
  const idx = list.findIndex((s) => s.id === def.id);
  const stored: StoredSchedule = {
    ...def,
    createdAt: idx >= 0 ? list[idx].createdAt : Date.now(),
    lastRunAt: Date.now(),
  };
  if (idx >= 0) list[idx] = stored;
  else list.unshift(stored);
  persist(list);
  return stored;
}

export function deleteSchedule(id: string): void {
  persist(listSavedSchedules().filter((s) => s.id !== id));
}

export function renameSchedule(id: string, name: string): void {
  const list = listSavedSchedules();
  const idx = list.findIndex((s) => s.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], name, updatedAt: Date.now() };
  persist(list);
}

export function duplicateSchedule(id: string, newName?: string): StoredSchedule | null {
  const src = getSavedSchedule(id);
  if (!src) return null;
  const copy: StoredSchedule = {
    ...JSON.parse(JSON.stringify(src)),
    id: `sch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: newName ?? `${src.name} (copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  delete (copy as any).lastRunAt;
  delete (copy as any).derivedFrom;
  const list = listSavedSchedules();
  list.unshift(copy);
  persist(list);
  return copy;
}

export function exportSchedules(): string {
  return JSON.stringify(listSavedSchedules(), null, 2);
}

export function importSchedules(json: string): number {
  try {
    const incoming = JSON.parse(json);
    if (!Array.isArray(incoming)) return 0;
    const list = listSavedSchedules();
    const byId = new Map(list.map((s) => [s.id, s]));
    let count = 0;
    for (const s of incoming) {
      if (!s || typeof s !== "object") continue;
      if (!s.id) s.id = `sch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      byId.set(s.id, s);
      count++;
    }
    persist([...byId.values()]);
    return count;
  } catch {
    return 0;
  }
}