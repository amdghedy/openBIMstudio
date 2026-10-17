// openbim-step1:family-foundation
// Family system foundation - in-memory store with localStorage persistence.
//
// Mirrors the pattern used by core/options-registry.ts. Every mutation
// notifies subscribers so the UI (or verify scripts) can react.

import type { FamilyDefinition, FamilyType } from "./types";

const STORAGE_KEY = "obs.families.v1";

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

    let restored: FamilyDefinition[] | null = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) restored = parsed;
      }
    } catch { /* */ }

    if (restored && restored.length) {
      for (const d of restored) this.byId.set(d.id, d);
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
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
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
      const arr = [...this.byId.values()];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
    } catch (err) {
      console.warn("[families] persist failed", err);
    }
  }
}

export const familyStore = new FamilyStore();
