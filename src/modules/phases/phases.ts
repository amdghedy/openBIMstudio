/**
 * Phasing - BIM-style construction phases.
 *
 * Every authored element / room can carry phaseCreated + phaseDemolished.
 * Views filter by phase + phase filter (Show Complete / Show New / Show Previous + New).
 */

import { ctx } from "../../core/context";

export type PhaseId = string;

export interface Phase {
  id: PhaseId;
  name: string;
  /** Sort order (lower = earlier). */
  order: number;
  description?: string;
}

export type PhaseFilter =
  | "show-all"
  | "show-complete"
  | "show-new"
  | "show-previous"
  | "show-previous-and-new"
  | "show-demo";

export interface PhaseAssignment {
  phaseCreated: PhaseId | null;
  phaseDemolished: PhaseId | null;
}

const STORAGE = "obs.phases.v1";

type Listener = () => void;

function uid(): string {
  return `phase-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class PhasesStore {
  private phases: Phase[] = [];
  private currentPhaseId: PhaseId | null = null;
  private currentFilter: PhaseFilter = "show-complete";
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const data = JSON.parse(raw);
        this.phases = data.phases ?? [];
        this.currentPhaseId = data.currentPhaseId ?? null;
        this.currentFilter = data.currentFilter ?? "show-complete";
      }
    } catch { /* */ }
    if (!this.phases.length) {
      this.phases = [
        { id: uid(), name: "Existing", order: 0 },
        { id: uid(), name: "New Construction", order: 1 },
      ];
      this.currentPhaseId = this.phases[1].id;
      this.persist();
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          phases: this.phases,
          currentPhaseId: this.currentPhaseId,
          currentFilter: this.currentFilter,
        }),
      );
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  list(): Phase[] {
    return [...this.phases].sort((a, b) => a.order - b.order);
  }

  get(id: PhaseId): Phase | null {
    return this.phases.find((p) => p.id === id) ?? null;
  }

  create(name: string): Phase {
    const order = this.phases.reduce((m, p) => Math.max(m, p.order), -1) + 1;
    const phase: Phase = { id: uid(), name, order };
    this.phases.push(phase);
    this.persist();
    return phase;
  }

  rename(id: PhaseId, name: string): boolean {
    const p = this.get(id);
    if (!p) return false;
    p.name = name;
    this.persist();
    return true;
  }

  remove(id: PhaseId): boolean {
    if (this.phases.length <= 1) return false;
    const idx = this.phases.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.phases.splice(idx, 1);
    if (this.currentPhaseId === id) {
      this.currentPhaseId = this.phases[0]?.id ?? null;
    }
    this.persist();
    return true;
  }

  getCurrent(): Phase | null {
    return this.currentPhaseId ? this.get(this.currentPhaseId) : null;
  }

  setCurrent(id: PhaseId): void {
    if (!this.get(id)) return;
    this.currentPhaseId = id;
    this.persist();
  }

  getFilter(): PhaseFilter {
    return this.currentFilter;
  }

  setFilter(f: PhaseFilter): void {
    this.currentFilter = f;
    this.persist();
  }

  /**
   * Should an element with the given phase assignment be visible
   * given the active view phase + filter?
   */
  isVisible(assignment: PhaseAssignment | null | undefined): boolean {
    if (!assignment) return true;
    const viewPhase = this.getCurrent();
    if (!viewPhase) return true;

    const created = assignment.phaseCreated
      ? this.get(assignment.phaseCreated)
      : null;
    const demo = assignment.phaseDemolished
      ? this.get(assignment.phaseDemolished)
      : null;

    const createdOrder = created?.order ?? -Infinity;
    const demoOrder = demo?.order ?? Infinity;
    const viewOrder = viewPhase.order;

    switch (this.currentFilter) {
      case "show-all":
        return true;
      case "show-complete":
        // Exists at view phase: created <= view and (not demolished or demo > view)
        return createdOrder <= viewOrder && demoOrder > viewOrder;
      case "show-new":
        return createdOrder === viewOrder && demoOrder > viewOrder;
      case "show-previous":
        return createdOrder < viewOrder && demoOrder > viewOrder;
      case "show-previous-and-new":
        return createdOrder <= viewOrder && demoOrder > viewOrder;
      case "show-demo":
        return demoOrder === viewOrder;
      default:
        return true;
    }
  }

  /** Graphic override style for phase display (New / Existing / Demo). */
  graphicOverride(assignment: PhaseAssignment | null | undefined): {
    role: "new" | "existing" | "demo" | "none";
    opacity: number;
    dashed: boolean;
  } {
    if (!assignment || !this.currentPhaseId) {
      return { role: "none", opacity: 1, dashed: false };
    }
    const viewPhase = this.getCurrent();
    if (!viewPhase) return { role: "none", opacity: 1, dashed: false };

    const created = assignment.phaseCreated
      ? this.get(assignment.phaseCreated)
      : null;
    const demo = assignment.phaseDemolished
      ? this.get(assignment.phaseDemolished)
      : null;
    const createdOrder = created?.order ?? -Infinity;
    const demoOrder = demo?.order ?? Infinity;

    if (demoOrder === viewPhase.order) {
      return { role: "demo", opacity: 0.45, dashed: true };
    }
    if (createdOrder === viewPhase.order) {
      return { role: "new", opacity: 1, dashed: false };
    }
    if (createdOrder < viewPhase.order && demoOrder > viewPhase.order) {
      return { role: "existing", opacity: 0.7, dashed: false };
    }
    return { role: "none", opacity: 1, dashed: false };
  }
}

export const phasesStore = new PhasesStore();

export function setupPhases(): typeof phasesStore {
  phasesStore.boot();
  (ctx.features as any).phases = phasesStore;
  (window as any).__obsPhases = phasesStore;
  console.log("[phases] ready -", phasesStore.list().map((p) => p.name).join(", "));
  return phasesStore;
}
