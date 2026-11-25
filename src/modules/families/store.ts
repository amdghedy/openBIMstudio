// openbim-step1:family-foundation
// Family system foundation - in-memory store with project-scoped persistence.
//
// Custom families are stored per-project so they don't leak between different
// projects. When no project is open, it falls back to a global library.

import type { FamilyDefinition, FamilyType } from "./types";
import { notify } from "../../core/notify";
import { getCurrentProject, onProjectChanged } from "../projects/projects";
import { CURRENT_FAMILY_SCHEMA_VERSION, migrateFamilyDefinition } from "./migration";
import {
  partitionFamilyDefinitions,
  serializeUserFamilies as serializeUserFamiliesPure,
  type FamilyRestoreReport,
} from "./project-families";

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
  /**
   * Unedited shipped catalog families, by id -> the exact object the store
   * holds. They are re-created from the catalog on every boot, so they are
   * not written to localStorage (3,000+ of them filled the 5 MB quota and
   * made every later save of the user's own families fail). Editing one
   * replaces its object, which drops it from this check and so it is
   * saved like any user family. A family loaded from storage that is not
   * registered here is always kept: when unsure, save it.
   */
  private pristineSeeds = new Map<string, FamilyDefinition>();
  private emitQueued = false;
  private batchDepth = 0;
  private pendingPersist = false;
  private pendingEmit = false;
  private storageFullReported = false;

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

    // Migrate everything the store holds to the current schema
    // (Revit parity Rank 6): a family saved by an older build, or
    // hand-written JSON, loads normalised — a parameter without a scope,
    // stale type values, or a family with no types never reach the
    // engine unchecked. An entry that cannot be migrated is skipped
    // (and reported), never fatal to the whole library; a migrated user
    // family is persisted back so the migration sticks.
    let persistAgain = false;
    for (const [id, def] of [...this.byId.entries()]) {
      try {
        const r = migrateFamilyDefinition(def);
        if (r.migratedFrom !== null || r.warnings.length) {
          for (const w of r.warnings) console.warn(`[families] ${w}`);
        }
        if (r.migratedFrom !== null) {
          this.byId.set(id, r.family);
          if (!r.family.builtIn) persistAgain = true;
        }
      } catch (err) {
        console.warn(`[families] skipping unmigratable stored family "${id}":`, err);
        this.byId.delete(id);
      }
    }
    if (persistAgain) this.persist();
  }

  list(): FamilyDefinition[] {
    return [...this.byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The user families that travel with the project document: everything
   * that is not a built-in, deep-cloned. Called by the project save
   * path; see `src/modules/families/project-families.ts`.
   */
  serializeUserFamilies(): FamilyDefinition[] {
    return serializeUserFamiliesPure([...this.byId.values()]);
  }

  /**
   * Restore user families carried by a project document (see
   * `project-families.ts`). The document wins over the local copy for a
   * family id it carries. Invalid entries are skipped and reported,
   * never fatal; valid ones are persisted to this project's localStorage
   * key so the next open finds them even without the document.
   */
  restoreUserFamilies(raw: unknown): FamilyRestoreReport {
    const { valid, skipped } = partitionFamilyDefinitions(raw);
    for (const def of valid) this.byId.set(def.id, def);
    if (valid.length) {
      this.persist();
      this.emit();
    }
    return { restored: valid.length, skipped };
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
    // New families are written at the current schema, and the input is
    // migrated (validated + normalised) before it reaches the store, so
    // a caller cannot store a v1-shaped definition by accident.
    const migrated = migrateFamilyDefinition({
      ...def,
      id: uid(),
      schemaVersion: CURRENT_FAMILY_SCHEMA_VERSION,
      builtIn: false,
    });
    const family = migrated.family;
    for (const w of migrated.warnings) console.warn(`[families] ${w}`);
    this.byId.set(family.id, family);
    this.persist();
    this.emit();
    return family;
  }

  /**
   * Insert a shipped seed-catalog family under its catalog id.
   *
   * `create()` always assigns a fresh random id, which is why the
   * library loader's `get(entry.id)` "already present" check could
   * never match a family loaded on an earlier boot — every reload
   * re-added the whole catalog (50 → 111). Seed families keep their
   * catalog id so the check works across boots. If a family with this
   * id already exists it is returned untouched: a user-edited copy
   * always wins over re-seeding.
   */
  createSeed(def: FamilyDefinition): FamilyDefinition {
    const existing = this.byId.get(def.id);
    if (existing) return existing;
    const migrated = migrateFamilyDefinition({
      ...def,
      schemaVersion: CURRENT_FAMILY_SCHEMA_VERSION,
      builtIn: false,
    });
    const family = migrated.family;
    for (const w of migrated.warnings) console.warn(`[families] ${w}`);
    this.byId.set(family.id, family);
    // Seeds come back from the catalog on every boot: do not write them (the
    // old per-seed write was O(n^2) and filled localStorage) and tell
    // listeners once per burst, not once per family.
    this.pristineSeeds.set(family.id, family);
    this.emitSoon();
    return family;
  }

  /**
   * The loader found this stored family already present and identical to
   * its catalog entry: mark it as an unedited shipped copy so it is not
   * written back to localStorage. Never marks an edited family.
   */
  markPristineSeed(existing: FamilyDefinition, sameAsCatalog: boolean): void {
    if (!sameAsCatalog) return;
    if (this.byId.get(existing.id) !== existing) return;
    if (existing.origin !== "seed-catalog") return;
    this.pristineSeeds.set(existing.id, existing);
  }

  /** Rewrite the saved copy now (drops stored unedited catalog copies once the loader has marked them). */
  flushToStorage(): void {
    this.persist();
  }

  /** Run many edits as one: a single save and one change notice at the end. */
  batch<T>(fn: () => T): T {
    this.batchDepth++;
    try {
      return fn();
    } finally {
      this.batchDepth--;
      if (this.batchDepth === 0) {
        if (this.pendingPersist) { this.pendingPersist = false; this.persist(); }
        if (this.pendingEmit) { this.pendingEmit = false; this.emit(); }
      }
    }
  }

  private emitSoon(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    setTimeout(() => { this.emitQueued = false; this.emit(); }, 50);
  }

  update(id: string, patch: Partial<FamilyDefinition>): FamilyDefinition | null {
    const cur = this.byId.get(id);
    if (!cur) return null;
    // The merged result is re-migrated (idempotent): a patch carrying a
    // v1-shaped parameter cannot reintroduce an unmigrated definition.
    const next = migrateFamilyDefinition({ ...cur, ...patch, id: cur.id }).family;
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
    const clone: FamilyDefinition = migrateFamilyDefinition({
      ...JSON.parse(JSON.stringify(cur)),
      id: uid(),
      name: newName,
      builtIn: false,
    }).family;
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
    if (this.batchDepth > 0) { this.pendingEmit = true; return; }
    for (const cb of this.listeners) { try { cb(); } catch { /* */ } }
  }

  private persist(): void {
    if (this.batchDepth > 0) { this.pendingPersist = true; return; }
    try {
      // Built-ins are re-seeded on boot. Unedited shipped catalog copies are
      // re-created from the catalog too. Everything else is the user's work
      // and is always written, never trimmed.
      const arr = [...this.byId.values()].filter(
        (d) => !d.builtIn && this.pristineSeeds.get(d.id) !== d,
      );
      const key = getStorageKey();
      try {
        localStorage.setItem(key, JSON.stringify(arr));
        this.storageFullReported = false;
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
        // Do NOT delete other projects' family keys or drop families to fit:
        // the previous copy in storage stays as it was, the families stay in
        // memory (and in the project document on save), and the user is told.
        if (!this.storageFullReported) {
          this.storageFullReported = true;
          console.warn(`[families] browser storage is full: ${arr.length} families not saved locally this session. Save the project to keep them.`);
          try {
            window.dispatchEvent(new CustomEvent("obs:families-storage-full", { detail: { count: arr.length } }));
          } catch { /* */ }
          // Visible, not console-only: the user keeps working, so tell them how to keep the work.
          notify(
            "warn",
            `Browser storage is full, so ${arr.length} of your families are not saved in this browser yet. Keep your work: the File menu item Project → JSON saves a backup copy that includes them. Do not clear site data.`,
            { timeout: 90000 },
          );
        }
      }
    } catch (err) {
      console.warn("[families] persist failed", err);
    }
  }
}

export const familyStore = new FamilyStore();
