/**
 * Unified Visibility Filter - combines phasing, design options, and
 * temporary hide/isolate (BIM VG / Temporary Hide-Isolate).
 */

import { ctx } from "../../core/context";
import { phasesStore, type PhaseAssignment } from "../phases/phases";
import { designOptionsStore } from "../design-options/design-options";

export interface VisibilityElement {
  id: string;
  category?: string;
  phaseCreated?: string | null;
  phaseDemolished?: string | null;
  designOptionId?: string | null;
  /** Explicit temporary hide. */
  tempHidden?: boolean;
}

export interface CategoryOverride {
  visible: boolean;
  halftone: boolean;
  transparent: boolean;
}

type Listener = () => void;

class VisibilityFilter {
  private tempHidden = new Set<string>();
  private tempIsolated: Set<string> | null = null; // null = no isolate
  private categoryOverrides = new Map<string, CategoryOverride>();
  private listeners = new Set<Listener>();

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  // -- Temporary Hide / Isolate --------------------------------------

  hideElement(id: string): void {
    this.tempHidden.add(id);
    this.emit();
  }

  hideElements(ids: string[]): void {
    for (const id of ids) this.tempHidden.add(id);
    this.emit();
  }

  isolateElements(ids: string[]): void {
    this.tempIsolated = new Set(ids);
    this.emit();
  }

  resetTemporary(): void {
    this.tempHidden.clear();
    this.tempIsolated = null;
    this.emit();
  }

  isTemporarilyHidden(id: string): boolean {
    if (this.tempIsolated) return !this.tempIsolated.has(id);
    return this.tempHidden.has(id);
  }

  // -- Category overrides --------------------------------------------

  setCategoryOverride(category: string, override: Partial<CategoryOverride>): void {
    const cur = this.categoryOverrides.get(category) ?? {
      visible: true,
      halftone: false,
      transparent: false,
    };
    this.categoryOverrides.set(category, { ...cur, ...override });
    this.emit();
  }

  getCategoryOverride(category: string): CategoryOverride {
    return (
      this.categoryOverrides.get(category) ?? {
        visible: true,
        halftone: false,
        transparent: false,
      }
    );
  }

  clearCategoryOverrides(): void {
    this.categoryOverrides.clear();
    this.emit();
  }

  // -- Combined test -------------------------------------------------

  /**
   * Full visibility test for an element under current view settings.
   */
  isVisible(el: VisibilityElement): boolean {
    // Temporary hide/isolate
    if (this.isTemporarilyHidden(el.id)) return false;

    // Category
    if (el.category) {
      const cat = this.getCategoryOverride(el.category);
      if (!cat.visible) return false;
    }

    // Phasing
    const phaseAssign: PhaseAssignment = {
      phaseCreated: el.phaseCreated ?? null,
      phaseDemolished: el.phaseDemolished ?? null,
    };
    if (!phasesStore.isVisible(phaseAssign)) return false;

    // Design options
    if (!designOptionsStore.isVisible(el.designOptionId)) return false;

    return true;
  }

  /**
   * Graphic style hint combining phase role + category overrides.
   */
  graphicStyle(el: VisibilityElement): {
    opacity: number;
    dashed: boolean;
    halftone: boolean;
    role: string;
  } {
    const phase = phasesStore.graphicOverride({
      phaseCreated: el.phaseCreated ?? null,
      phaseDemolished: el.phaseDemolished ?? null,
    });
    const cat = el.category
      ? this.getCategoryOverride(el.category)
      : { visible: true, halftone: false, transparent: false };

    let opacity = phase.opacity;
    if (cat.halftone) opacity = Math.min(opacity, 0.4);
    if (cat.transparent) opacity = Math.min(opacity, 0.3);

    return {
      opacity,
      dashed: phase.dashed,
      halftone: cat.halftone || phase.role === "existing",
      role: phase.role,
    };
  }

  /** Filter a list of elements down to those visible. */
  filter<T extends VisibilityElement>(elements: T[]): T[] {
    return elements.filter((e) => this.isVisible(e));
  }
}

export const visibilityFilter = new VisibilityFilter();

export function setupVisibilityFilter(): typeof visibilityFilter {
  // Ensure dependent stores are booted (safe if already booted)
  try {
    if (typeof (phasesStore as any).boot === "function") (phasesStore as any).boot();
  } catch { /* */ }
  try {
    if (typeof (designOptionsStore as any).boot === "function") (designOptionsStore as any).boot();
  } catch { /* */ }

  try {
    (ctx.features as any).visibility = visibilityFilter;
  } catch { /* */ }
  (window as any).__obsVisibility = visibilityFilter;
  console.log("[visibility-filter] ready");
  return visibilityFilter;
}
