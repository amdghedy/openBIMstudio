/**
 * Design Options - Revit-style alternative design sets.
 *
 * Elements tagged with a designOptionId are visible only when that option
 * is active (or when viewing the primary/main model).
 */

import { ctx } from "../../core/context";

export type OptionSetId = string;
export type OptionId = string;

export interface DesignOption {
  id: OptionId;
  name: string;
  /** Primary option within its set (the "main model" for that set). */
  isPrimary: boolean;
}

export interface DesignOptionSet {
  id: OptionSetId;
  name: string;
  options: DesignOption[];
  /** Currently active option for this set (drives viewport filter). */
  activeOptionId: OptionId | null;
}

const STORAGE = "obs.design-options.v1";
type Listener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class DesignOptionsStore {
  private sets = new Map<OptionSetId, DesignOptionSet>();
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        for (const s of JSON.parse(raw) as DesignOptionSet[]) {
          this.sets.set(s.id, s);
        }
      }
    } catch { /* */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE, JSON.stringify([...this.sets.values()]));
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listSets(): DesignOptionSet[] {
    return [...this.sets.values()];
  }

  getSet(id: OptionSetId): DesignOptionSet | null {
    return this.sets.get(id) ?? null;
  }

  createSet(name: string): DesignOptionSet {
    const primary: DesignOption = {
      id: uid("opt"),
      name: "Primary",
      isPrimary: true,
    };
    const set: DesignOptionSet = {
      id: uid("oset"),
      name,
      options: [primary],
      activeOptionId: primary.id,
    };
    this.sets.set(set.id, set);
    this.persist();
    return set;
  }

  addOption(setId: OptionSetId, name: string): DesignOption | null {
    const set = this.sets.get(setId);
    if (!set) return null;
    const opt: DesignOption = { id: uid("opt"), name, isPrimary: false };
    set.options.push(opt);
    this.persist();
    return opt;
  }

  setActive(setId: OptionSetId, optionId: OptionId): boolean {
    const set = this.sets.get(setId);
    if (!set) return false;
    if (!set.options.find((o) => o.id === optionId)) return false;
    set.activeOptionId = optionId;
    this.persist();
    return true;
  }

  removeOption(setId: OptionSetId, optionId: OptionId): boolean {
    const set = this.sets.get(setId);
    if (!set) return false;
    const opt = set.options.find((o) => o.id === optionId);
    if (!opt || opt.isPrimary) return false;
    set.options = set.options.filter((o) => o.id !== optionId);
    if (set.activeOptionId === optionId) {
      set.activeOptionId = set.options.find((o) => o.isPrimary)?.id ?? null;
    }
    this.persist();
    return true;
  }

  removeSet(setId: OptionSetId): boolean {
    const ok = this.sets.delete(setId);
    if (ok) this.persist();
    return ok;
  }

  /**
   * Visibility test for an element tagged with designOptionId.
   * null / undefined - always visible (main model).
   */
  isVisible(designOptionId: string | null | undefined): boolean {
    if (!designOptionId) return true;
    for (const set of this.sets.values()) {
      const opt = set.options.find((o) => o.id === designOptionId);
      if (!opt) continue;
      // Visible if this option is active, or if it's primary and nothing else is forced
      if (set.activeOptionId === opt.id) return true;
      if (opt.isPrimary && set.activeOptionId == null) return true;
      return false;
    }
    // Unknown option id - show (don't hide orphaned tags)
    return true;
  }

  /** All currently active option ids across sets. */
  activeOptionIds(): Set<string> {
    const ids = new Set<string>();
    for (const set of this.sets.values()) {
      if (set.activeOptionId) ids.add(set.activeOptionId);
    }
    return ids;
  }
}

export const designOptionsStore = new DesignOptionsStore();

export function setupDesignOptions(): typeof designOptionsStore {
  designOptionsStore.boot();
  (ctx.features as any).designOptions = designOptionsStore;
  (window as any).__obsDesignOptions = designOptionsStore;
  console.log("[design-options] ready -", designOptionsStore.listSets().length, "sets");
  return designOptionsStore;
}
