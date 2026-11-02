/**
 * Undo / redo command stack (BIM/Blender class).
 *
 * - Bounded depth (default 100 commands)
 * - Grouped transactions: nested pushes fold into one undoable command
 * - Coalescing window: rapid same-label edits merge (e.g. slider drags)
 * - Listener bus for UI (undo/redo buttons, status bar hints)
 */
export interface Command {
  label: string;
  apply: () => void | Promise<void>;
  revert: () => void | Promise<void>;
}

class HistoryManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxDepth = 100;
  private listeners = new Set<() => void>();
  private isExecuting = false;

  // Coalescing
  private coalesceKey: string | null = null;
  private coalesceTimer: number | null = null;

  // Transactions (grouping)
  private txDepth = 0;
  private txCommands: Command[] = [];
  private txLabel = "";

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        /* */
      }
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string | null {
    return this.undoStack[this.undoStack.length - 1]?.label ?? null;
  }
  redoLabel(): string | null {
    return this.redoStack[this.redoStack.length - 1]?.label ?? null;
  }
  depth(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /**
   * Push a command. If `coalesce` is set and matches the previous command's
   * key within the coalesce window, the previous command is discarded and
   * replaced with this one (they merge).
   */
  push(cmd: Command, coalesce?: string): void {
    if (this.isExecuting) return;

    // Inside a transaction: buffer, don't push yet.
    if (this.txDepth > 0) {
      this.txCommands.push(cmd);
      return;
    }

    if (coalesce && this.coalesceKey === coalesce) {
      // Replace the last command instead of stacking.
      this.undoStack[this.undoStack.length - 1] = cmd;
    } else {
      this.undoStack.push(cmd);
      if (this.undoStack.length > this.maxDepth) this.undoStack.shift();
    }

    this.redoStack.length = 0;

    if (coalesce) {
      this.coalesceKey = coalesce;
      if (this.coalesceTimer != null) clearTimeout(this.coalesceTimer);
      this.coalesceTimer = window.setTimeout(() => {
        this.coalesceKey = null;
        this.coalesceTimer = null;
      }, 400);
    } else {
      this.coalesceKey = null;
    }

    this.emit();
  }

  /**
   * Run a function inside a transaction: all pushes it performs become one
   * atomic undoable command. Useful for compound operations (e.g. delete 12
   * elements in one action).
   */
  async transaction(label: string, fn: () => void | Promise<void>): Promise<void> {
    const outermost = this.txDepth === 0;
    const savepoint = this.txCommands.length;
    if (outermost) {
      this.txCommands = [];
      this.txLabel = label;
    }
    this.txDepth++;

    try {
      await fn();
    } catch (error) {
      // A failed nested scope is a savepoint: undo only work added by that
      // scope. This also means a caller may catch the nested error and keep
      // the surrounding transaction alive.
      const failed = this.txCommands.splice(savepoint);
      let rollbackError: unknown;
      this.isExecuting = true;
      try {
        for (let i = failed.length - 1; i >= 0; i--) {
          try {
            await failed[i].revert();
          } catch (cause) {
            rollbackError ??= cause;
          }
        }
      } finally {
        this.isExecuting = false;
        this.txDepth--;
        if (outermost) {
          this.txCommands = [];
          this.txLabel = "";
        }
      }
      if (rollbackError) {
        throw new AggregateError([error, rollbackError], `Transaction '${label}' failed and rollback was incomplete`);
      }
      throw error;
    }

    this.txDepth--;
    if (!outermost) return;

    const inner = this.txCommands.slice();
    this.txCommands = [];
    const groupLabel = this.txLabel || label;
    this.txLabel = "";
    if (!inner.length) return;

    const group: Command = {
      label: groupLabel,
      apply: async () => {
        for (const command of inner) await command.apply();
      },
      revert: async () => {
        for (let i = inner.length - 1; i >= 0; i--) await inner[i].revert();
      },
    };
    // Bypass tx buffering (we're already out).
    this.push(group);
  }

  /** Execute and record a command (convenience for one-shot actions). */
  async exec(cmd: Command, coalesce?: string): Promise<void> {
    this.isExecuting = true;
    try {
      await cmd.apply();
    } catch (error) {
      // apply() may have mutated part of the model before throwing. Attempt
      // the command's inverse before exposing the failure to the caller.
      try {
        await cmd.revert();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Command '${cmd.label}' failed and its rollback was incomplete`);
      }
      throw error;
    } finally {
      this.isExecuting = false;
    }
    this.push(cmd, coalesce);
  }

  // Undo/redo run one at a time. Holding Ctrl+Z (key repeat) used to start
  // overlapping async reverts that corrupted the executing flag and stacks.
  private chain: Promise<void> = Promise.resolve();

  undo(): Promise<void> {
    const run = this.chain.then(() => this.doUndo());
    this.chain = run.catch(() => { /* keep the queue alive after a failure */ });
    return run;
  }

  redo(): Promise<void> {
    const run = this.chain.then(() => this.doRedo());
    this.chain = run.catch(() => { /* keep the queue alive after a failure */ });
    return run;
  }

  private async doUndo(): Promise<void> {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    this.isExecuting = true;
    try {
      await cmd.revert();
    } catch (e) {
      console.error("[history] undo failed", e);
      // Put it back on failure so the user can retry.
      this.undoStack.push(cmd);
      throw e;
    } finally {
      this.isExecuting = false;
    }
    this.redoStack.push(cmd);
    this.coalesceKey = null;
    try {
      window.dispatchEvent(new CustomEvent("obs-history", { detail: { action: "undo", label: cmd.label } }));
      window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Undo: ${cmd.label}`, kind: "info" } }));
    } catch { /* */ }
    this.emit();
  }

  private async doRedo(): Promise<void> {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    this.isExecuting = true;
    try {
      await cmd.apply();
    } catch (e) {
      console.error("[history] redo failed", e);
      this.redoStack.push(cmd);
      throw e;
    } finally {
      this.isExecuting = false;
    }
    this.undoStack.push(cmd);
    this.coalesceKey = null;
    try {
      window.dispatchEvent(new CustomEvent("obs-history", { detail: { action: "redo", label: cmd.label } }));
      window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Redo: ${cmd.label}`, kind: "info" } }));
    } catch { /* */ }
    this.emit();
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.coalesceKey = null;
    this.emit();
  }
}

export const history = new HistoryManager();