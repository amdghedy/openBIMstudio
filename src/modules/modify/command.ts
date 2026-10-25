/**
 * Unified Modify command architecture (MASTER PROMPT MODULE 2C.1, 2C.11).
 *
 * Every modify tool implements IModifyCommand with the spec's contract:
 * CanExecute, Begin, UpdatePreview, Validate, Commit, Cancel,
 * GetAffectedElements, GetRequiredReferences, GetDiagnostics.
 *
 * Discipline (spec 2C.11): commands never mutate the model during preview;
 * Validate gates Commit; a failed command leaves NO partial untracked
 * changes (the pending change set is discarded on Cancel/failure);
 * diagnostics carry severity and codes. Pinned elements reject modify
 * commands (spec 2C.9: pinning is an editability flag, NOT a geometric
 * constraint).
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { RelationshipRegistry } from "../relationships";

// ── Element model (lightweight, store-agnostic) ──────────────────────────

export interface ModifyElement {
  id: string;
  categoryId: string;
  /** Pinned elements reject every modify command (spec 2C.9). */
  pinned: boolean;
  /** false for uneditable objects (linked models, read-only layers). */
  editable: boolean;
  /** Plan position of the element origin (metres). */
  position: [number, number];
  /** Plan rotation (radians). */
  rotationZ: number;
  /** Line-based elements carry their local curve in the element frame. */
  curve?: { start: [number, number]; end: [number, number] };
  /** Parameter-driven sizes used when scaling is restricted (spec 2C.9). */
  params?: Record<string, number>;
}

export interface ElementPatch {
  position?: [number, number];
  rotationZ?: number;
  curve?: { start: [number, number]; end: [number, number] };
  params?: Record<string, number>;
  /** Relationship bookkeeping hint for the host application. */
  reason?: string;
}

export interface ElementStore {
  get(id: string): ModifyElement | undefined;
  apply(id: string, patch: ElementPatch): boolean;
  /** Insert a cloned element (copy/array/mirror results). */
  insert(el: ModifyElement): void;
  all(): ModifyElement[];
}

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface ModifyDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  elementIds: string[];
}

export interface PendingChange {
  elementId: string;
  patch: ElementPatch;
  /** For duplicating commands: the full new element. */
  newElement?: ModifyElement;
}

export interface ModifyContext {
  store: ElementStore;
  /** Optional relationship registry for propagation and conflict checks. */
  relationships?: RelationshipRegistry;
  /** Id allocator for duplicating commands. */
  allocateId?: () => string;
  /** Element ids whose edits are forbidden (worksharing ownership etc.). */
  lockedElementIds?: Set<string>;
}

// ── IModifyCommand (spec 2C.1) ───────────────────────────────────────────

export interface IModifyCommand {
  readonly name: string;
  CanExecute(ids: string[]): { can: boolean; reason?: string };
  Begin(ids: string[]): void;
  /** Feed input (points, angles, distances); recomputes the preview. */
  UpdatePreview(input: CommandInput): PendingChange[];
  Validate(): { ok: boolean; diagnostics: ModifyDiagnostic[] };
  /** Commit applies pending changes to the store (atomic best effort). */
  Commit(): { ok: boolean; applied: number; diagnostics: ModifyDiagnostic[] };
  Cancel(): void;
  GetAffectedElements(): string[];
  GetRequiredReferences(): string[];
  GetDiagnostics(): ModifyDiagnostic[];
}

export type CommandInput =
  | { type: "translation"; from: [number, number]; to: [number, number] }
  | { type: "numeric-offset"; dx: number; dy: number }
  | { type: "rotation"; pivot: [number, number]; angle: number }
  | { type: "rotation-two-point"; pivot: [number, number]; start: [number, number]; end: [number, number] }
  | { type: "mirror-axis"; point: [number, number]; dir: [number, number]; copy: boolean }
  | { type: "offset"; distance: number }
  | { type: "copy"; translation: [number, number] }
  | { type: "array-linear"; count: number; step: [number, number] }
  | { type: "array-radial"; count: number; center: [number, number]; totalAngle: number; rotateInstances: boolean }
  | { type: "trim"; boundary: { point: [number, number]; dir: [number, number] }; pick: [number, number] }
  | { type: "split"; parameter: number };

/** Shared implementation core: pending change set + diagnostics. */
export abstract class ModifyCommandBase implements IModifyCommand {
  abstract readonly name: string;
  protected ctx: ModifyContext;
  protected ids: string[] = [];
  protected pending: PendingChange[] = [];
  protected diagnostics: ModifyDiagnostic[] = [];
  protected started = false;

  constructor(ctx: ModifyContext) {
    this.ctx = ctx;
  }

  CanExecute(ids: string[]): { can: boolean; reason?: string } {
    if (!ids.length) return { can: false, reason: "no selection" };
    for (const id of ids) {
      const el = this.ctx.store.get(id);
      if (!el) return { can: false, reason: `element '${id}' not found` };
      if (el.pinned) return { can: false, reason: `element '${id}' is pinned (unpin it first)` };
      if (!el.editable) return { can: false, reason: `element '${id}' is not editable` };
      if (this.ctx.lockedElementIds?.has(id)) {
        return { can: false, reason: `element '${id}' is locked by another user` };
      }
    }
    return { can: true };
  }

  Begin(ids: string[]): void {
    const gate = this.CanExecute(ids);
    if (!gate.can) throw new Error(`${this.name}: ${gate.reason}`);
    this.ids = [...ids];
    this.pending = [];
    this.diagnostics = [];
    this.started = true;
  }

  abstract UpdatePreview(input: CommandInput): PendingChange[];

  Validate(): { ok: boolean; diagnostics: ModifyDiagnostic[] } {
    const errors = this.diagnostics.filter((d) => d.severity === "error");
    return { ok: errors.length === 0, diagnostics: [...this.diagnostics] };
  }

  Commit(): { ok: boolean; applied: number; diagnostics: ModifyDiagnostic[] } {
    const v = this.Validate();
    if (!v.ok) return { ok: false, applied: 0, diagnostics: v.diagnostics };
    let applied = 0;
    for (const change of this.pending) {
      if (change.newElement) {
        this.ctx.store.insert(change.newElement);
        applied++;
        continue;
      }
      if (this.ctx.store.apply(change.elementId, change.patch)) applied++;
    }
    return { ok: true, applied, diagnostics: v.diagnostics };
  }

  Cancel(): void {
    // Discard pending work — no partial state was ever applied (2C.11).
    this.pending = [];
    this.diagnostics = [];
    this.started = false;
  }

  GetAffectedElements(): string[] {
    return [...this.ids, ...this.pending.filter((p) => p.newElement).map((p) => p.newElement!.id)];
  }

  GetRequiredReferences(): string[] {
    return [];
  }

  GetDiagnostics(): ModifyDiagnostic[] {
    return [...this.diagnostics];
  }

  protected err(code: string, message: string, elementIds: string[] = this.ids): void {
    this.diagnostics.push({ severity: "error", code, message, elementIds });
  }

  protected warn(code: string, message: string, elementIds: string[] = this.ids): void {
    this.diagnostics.push({ severity: "warning", code, message, elementIds });
  }

  protected info(code: string, message: string, elementIds: string[] = this.ids): void {
    this.diagnostics.push({ severity: "info", code, message, elementIds });
  }
}
