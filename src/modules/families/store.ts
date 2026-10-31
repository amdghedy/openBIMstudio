// openbim-step1:family-foundation
// Family system foundation - in-memory store with project-scoped persistence.
//
// Custom families are stored per-project so they don't leak between different
// projects. When no project is open, it falls back to a global library.

import type { FamilyDefinition, FamilyType } from "./types";
import { getCurrentProject, onProjectChanged } from "../projects/projects";

const DEFAULT_STORAGE_KEY = "obs.families.v1.global";

function getStorageKey(): string {
  try {
    const proj = getCurrentProject();
    if (proj && proj.id) return `obs.families.v1.${proj.id}`;
  } catch { /* projects not ready yet */ }
  return DEFAULT_STORAGE_KEY;
}

function uid(): string {
  return (crypto as any).randomUUID?.()
    ?? ("fam-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8));
}

class FamilyStore {
  private byId = new Map<string, FamilyDefinition>();
  private listeners = new Set<() => void>();
  private booted = false;

  boot(seedBuiltIns: FamilyDefinition[]): void {
    if (this.booted) return;
    this.booted = true;

    try {
      onProjectChanged(() => {
        this.byId.clear();
        this.load(seedBuiltIns);
        this.emit();
      });
    } catch (err) {
      console.warn("[families] could not hook into project changes", err);
    }

    this.load(seedBuiltIns);
  }

  private load(seedBuiltIns: FamilyDefinition[]): void {
    let restored: FamilyDefinition[] | null = null;
    try {
      const raw = localStorage.getItem(getStorageKey());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) restored = parsed;
      }
    } catch { /* */ }

    if (restored && restored.length) {
      for (const d of restored) this.byId.set(d.id, d);
      // Ensure built-ins still present
      for (const d of seedBuiltIns) {
        if (!this.byId.has(d.id)) this.byId.set(d.id, d);
      }
    } else {
      for (const d of seedBuiltIns) this.byId.set(d.id, d);
      this.persist();
    }
  }

  list(): FamilyDefinition[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): FamilyDefinition | null {
    return this.byId.get(id) ?? null;
  }

  getByElementType(elementType: string): FamilyDefinition | null {
    for (const d of this.byId.values()) {
      if (d.sourceElementType === elementType) return d;
    }
    return null;
  }

  create(def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn">): FamilyDefinition {
    const family: FamilyDefinition = {
      ...def,
      id: uid(),
      schemaVersion: 1,
      builtIn: false,
    };
    this.byId.set(family.id, family);
    this.persist();
    this.emit();
    return family;
  }

  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null {
    const cur = this.byId.get(id);
    if (!cur) return null;
    const next: FamilyDefinition = { ...cur, ...patch, id: cur.id };
    this.byId.set(id, next);
    this.persist();
    this.emit();
    return next;
  }

  remove(id: string): boolean {
    const cur = this.byId.get(id);
    if (!cur) return false;
    if (cur.builtIn) return false;
    const ok = this.byId.delete(id);
    if (ok) { this.persist(); this.emit(); }
    return ok;
  }

  duplicate(id: string, newName: string): FamilyDefinition | null {
    const cur = this.byId.get(id);
    if (!cur) return null;
    const clone: FamilyDefinition = {
      ...JSON.parse(JSON.stringify(cur)),
      id: uid(),
      name: newName,
      builtIn: false,
    };
    this.byId.set(clone.id, clone);
    this.persist();
    this.emit();
    return clone;
  }

  createType(familyId: string, name: string, values: Record<string, any> = {}): FamilyType | null {
    const fam = this.byId.get(familyId);
    if (!fam) return null;
    const t: FamilyType = { id: uid(), name, values };
    fam.types.push(t);
    this.persist();
    this.emit();
    return t;
  }

  updateType(familyId: string, typeId: string, patch: Partial<FamilyType>): FamilyType | null {
    const fam = this.byId.get(familyId);
    if (!fam) return null;
    const idx = fam.types.findIndex((t) => t.id === typeId);
    if (idx < 0) return null;
    fam.types[idx] = { ...fam.types[idx], ...patch, id: typeId };
    this.persist();
    this.emit();
    return fam.types[idx];
  }

  removeType(familyId: string, typeId: string): boolean {
    const fam = this.byId.get(familyId);
    if (!fam) return false;
    const before = fam.types.length;
    fam.types = fam.types.filter((t) => t.id !== typeId);
    if (fam.types.length === before) return false;
    this.persist();
    this.emit();
    return true;
  }

  reset(): void {
    this.byId.clear();
    this.booted = false;
    try { localStorage.removeItem(getStorageKey()); } catch { /* */ }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) { try { cb(); } catch { /* */ } }
  }

  private persist(): void {
    try {
      // Built-ins are re-seeded on boot - only persist user families to save quota.
      const arr = [...this.byId.values()].filter((d) => !d.builtIn);
      const key = getStorageKey();
      try {
        localStorage.setItem(key, JSON.stringify(arr));
        return;
      } catch (err: any) {
        const isQuota =
          err?.name === "QuotaExceededError" ||
          err?.code === 22 ||
          err?.code === 1014 ||
          (typeof err?.message === "string" && /quota/i.test(err.message));
        if (!isQuota) {
          console.warn("[families] persist failed", err);
          return;
        }
        // Free space from other project family keys first
        try {
          const doomed: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("obs.families.v1.") && k !== key) doomed.push(k);
          }
          for (const k of doomed) localStorage.removeItem(k);
        } catch { /* */ }
        let working = arr.slice();
        while (working.length) {
          try {
            localStorage.setItem(key, JSON.stringify(working));
            if (working.length < arr.length) {
              console.warn(`[families] quota: persisted ${working.length}/${arr.length} user families`);
            }
            return;
          } catch {
            working = working.slice(0, Math.max(0, working.length - 1));
          }
        }
        try { localStorage.removeItem(key); } catch { /* */ }
        // One quiet warning - session continues in-memory
        console.warn("[families] localStorage full - family edits work this session only");
      }
    } catch (err) {
      console.warn("[families] persist failed", err);
    }
  }
}

export const familyStore = new FamilyStore();
