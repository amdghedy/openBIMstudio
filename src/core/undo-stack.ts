/**
 * Shared bounded command stack for entity-list surfaces.
 *
 * One implementation of undo/redo for the surfaces that keep an ordered
 * array of entities with an id (CAD quick-sketch engine, 2D drafting
 * overlay). Every user-visible mutation is recorded as a deterministic
 * operation with the exact before/after entity data, so undo/redo can be
 * replayed without depending on the current selection or pointer state.
 *
 * This is NOT a replacement for features/history.ts (the canonical BIM
 * document stack with transactions) — it serves isolated entity surfaces
 * whose entities live in their own array and whose render loop is driven
 * by an onChange callback. Both cad-engine.ts and drafting-2d.ts mount it,
 * so there is a single undo/redo algorithm instead of per-module clones.
 *
 * Operation model (inverse is derived, never stored twice):
 *   add    → undo removes the entity (by id)      / redo re-inserts it
 *   delete → undo re-inserts at the recorded index / redo removes it again
 *   modify → undo restores the before entity       / redo restores the after
 *   compound (a labelled list of ops) is one undoable unit; inverses apply
 *   in reverse order, so multi-entity edits (e.g. FILLET) are atomic.
 */

export type EntityOp<E> =
  | { kind: "add"; entity: E }
  | { kind: "delete"; entity: E; index: number }
  | { kind: "modify"; id: string; before: E; after: E };

export interface EntityHistoryEntry<E> {
  label: string;
  ops: EntityOp<E>[];
}

export interface EntityUndoStackOptions<E> {
  /** Bound on stored entries; the oldest entry is dropped (like history.ts). */
  maxDepth?: number;
  /** Called after every mutation (undo, redo, record) so the owner re-renders. */
  onChange?: () => void;
  /** Clone hook — defaults to structured deep clone via JSON. */
  clone?: (entity: E) => E;
}

export class EntityUndoStack<E extends { id: string }> {
  private entries: EntityHistoryEntry<E>[] = [];
  private redoEntries: EntityHistoryEntry<E>[] = [];
  private maxDepth: number;
  private onChange: () => void;
  private clone: (entity: E) => E;
  private list: E[];

  constructor(list: E[], opts: EntityUndoStackOptions<E> = {}) {
    this.list = list;
    this.maxDepth = Math.max(1, opts.maxDepth ?? 100);
    this.onChange = opts.onChange ?? (() => {});
    this.clone = opts.clone ?? ((e: E) => JSON.parse(JSON.stringify(e)) as E);
  }

  /** Record an already-applied operation (or several, as one compound unit). */
  record(label: string, ops: EntityOp<E> | EntityOp<E>[]): void {
    const list = Array.isArray(ops) ? ops : [ops];
    if (!list.length) return;
    this.entries.push({ label, ops: list.map(this.snapshotOp, this) });
    if (this.entries.length > this.maxDepth) this.entries.shift();
    this.redoEntries = [];
    this.onChange();
  }

  /** Clone an op's entity payloads so later mutations cannot corrupt history. */
  private snapshotOp(op: EntityOp<E>): EntityOp<E> {
    if (op.kind === "add") return { kind: "add", entity: this.clone(op.entity) };
    if (op.kind === "delete") return { kind: "delete", entity: this.clone(op.entity), index: op.index };
    return { kind: "modify", id: op.id, before: this.clone(op.before), after: this.clone(op.after) };
  }

  private indexOf(id: string): number {
    return this.list.findIndex((e) => e.id === id);
  }

  private applyInverse(op: EntityOp<E>): boolean {
    if (op.kind === "add") {
      const i = this.indexOf(op.entity.id);
      if (i < 0) return false;
      this.list.splice(i, 1);
      return true;
    }
    if (op.kind === "delete") {
      const i = Math.min(Math.max(op.index, 0), this.list.length);
      this.list.splice(i, 0, this.clone(op.entity));
      return true;
    }
    const i = this.indexOf(op.id);
    if (i < 0) return false;
    this.list[i] = this.clone(op.before);
    return true;
  }

  private applyForward(op: EntityOp<E>): boolean {
    if (op.kind === "add") {
      if (this.indexOf(op.entity.id) >= 0) return false;
      this.list.push(this.clone(op.entity));
      return true;
    }
    if (op.kind === "delete") {
      const i = this.indexOf(op.entity.id);
      if (i < 0) return false;
      this.list.splice(i, 1);
      return true;
    }
    const i = this.indexOf(op.id);
    if (i < 0) return false;
    this.list[i] = this.clone(op.after);
    return true;
  }

  undo(): boolean {
    const entry = this.entries.pop();
    if (!entry) return false;
    let ok = true;
    for (let i = entry.ops.length - 1; i >= 0; i--) {
      if (!this.applyInverse(entry.ops[i])) ok = false;
    }
    this.redoEntries.push(entry);
    this.onChange();
    return ok;
  }

  redo(): boolean {
    const entry = this.redoEntries.pop();
    if (!entry) return false;
    let ok = true;
    for (const op of entry.ops) {
      if (!this.applyForward(op)) ok = false;
    }
    this.entries.push(entry);
    this.onChange();
    return ok;
  }

  canUndo(): boolean {
    return this.entries.length > 0;
  }

  canRedo(): boolean {
    return this.redoEntries.length > 0;
  }

  depth(): { undo: number; redo: number } {
    return { undo: this.entries.length, redo: this.redoEntries.length };
  }

  undoLabel(): string | null {
    return this.entries[this.entries.length - 1]?.label ?? null;
  }

  redoLabel(): string | null {
    return this.redoEntries[this.redoEntries.length - 1]?.label ?? null;
  }

  /** Drop all history (document load / clear). Redo invalidation included. */
  clear(): void {
    this.entries = [];
    this.redoEntries = [];
    this.onChange();
  }
}
