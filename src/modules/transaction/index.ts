/**
 * Transaction service — property-change transactions with undo/redo.
 *
 * TWO MODES, ONE STACK IN PRODUCTION:
 *
 *  • Canonical mode (getTransactionService()): committed transactions are
 *    recorded into the application-wide history stack (features/history.ts)
 *    as a single deterministic Command. Ctrl+Z, the ribbon undo buttons and
 *    every other undo surface all share that one stack, so a Group-1 Move,
 *    an authoring edit and a property change are undone in true document
 *    order — there are no parallel histories over the same model anymore.
 *    undo()/redo() delegate to history (async by design; the boolean return
 *    reports whether an entry was queued). Document boundaries are inherited
 *    automatically: history.beginDocumentTransition() clears the shared stack.
 *
 *  • Private mode (new TransactionService()): the pre-existing isolated
 *    stack with synchronous undo/redo. Kept for isolated tool/test usage;
 *    production code must use the canonical singleton.
 *
 * Delta model (unchanged): a TransactionSnapshot holds TransactionChange
 * entries (elementId / propertyPath / oldValue / newValue). The pluggable
 * applyChangeFn replays entries forward (redo) and reverse (undo). The
 * first forward replay of a freshly recorded change is skipped by the
 * handler wrapper at the record site (the tool applied the patch itself —
 * deviation D-16 in modules/modify/group1.ts), so record-then-commit never
 * double-applies.
 */
import type {
  TransactionChange,
  TransactionSnapshot,
  TransactionGroup,
  UndoRedoState,
  TransactionOptions,
  ITransactionService,
} from "./types";
import { history } from "../../features/history";

const MAX_HISTORY_DEFAULT = 50;

let _instance: TransactionService | null = null;

export class TransactionService implements ITransactionService {
  private undoStack: TransactionSnapshot[] = [];
  private redoStack: TransactionSnapshot[] = [];
  private maxHistory: number;
  private current: TransactionSnapshot | null = null;
  private currentGroup: TransactionGroup | null = null;
  private listeners = new Set<(state: UndoRedoState) => void>();
  private applyChangeFn: ((change: TransactionChange, reverse: boolean) => void) | null = null;
  /** Canonical mode: the shared features/history stack is the only storage. */
  private readonly canonical: boolean;
  private historyUnsub: (() => void) | null = null;

  constructor(maxHistory = MAX_HISTORY_DEFAULT, opts?: { canonical?: boolean }) {
    this.maxHistory = maxHistory;
    this.canonical = Boolean(opts?.canonical);
    if (this.canonical) {
      // Keep instance subscribers informed when the shared stack changes.
      this.historyUnsub = history.onChange(() => this.notify());
    }
  }

  /** True when this instance records into the shared application history. */
  get isCanonical(): boolean {
    return this.canonical;
  }

  setApplyHandler(fn: (change: TransactionChange, reverse: boolean) => void): void {
    this.applyChangeFn = fn;
  }

  /** Replay a committed snapshot through the handler (no skip logic). */
  private replay(txn: TransactionSnapshot, reverse: boolean): void {
    if (!this.applyChangeFn) return;
    if (reverse) {
      for (let i = txn.changes.length - 1; i >= 0; i--) this.applyChangeFn(txn.changes[i], true);
    } else {
      for (const ch of txn.changes) this.applyChangeFn(ch, false);
    }
  }

  start(options: TransactionOptions): string {
    if (this.current?.status === "pending") this.commit();
    const id = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    this.current = {
      id,
      name: options.name,
      changes: [],
      createdAt: Date.now(),
      status: "pending",
      parentId: this.currentGroup?.id,
      metadata: { source: options.source ?? "user", transient: options.transient ?? false },
    };
    if (options.startGroup) this.beginGroup(options.name);
    this.notify();
    return id;
  }

  commit(transactionId?: string): boolean {
    const txn = this.resolveTransaction(transactionId);
    if (!txn || txn.status !== "pending") return false;
    txn.status = "committed";
    const isTransient = Boolean(txn.metadata?.transient);
    if (!isTransient && txn.changes.length > 0) {
      if (this.canonical) {
        // One transaction == one deterministic command on the shared stack.
        // push() (not exec): the tool already applied every change (D-16).
        // Redo invalidation, depth bound, document-transition refusal and
        // nested-transaction buffering are all inherited from history.
        const snapshot = txn;
        const accepted = history.push({
          label: txn.name,
          apply: () => this.replay(snapshot, false),
          revert: () => this.replay(snapshot, true),
        });
        if (!accepted) {
          console.warn("[transaction] commit not undoable — history refused the command:", txn.name);
        }
      } else {
        this.undoStack.push(txn);
        if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
        this.redoStack = [];
      }
    }
    if (this.currentGroup) this.currentGroup.transactions.push(txn.id);
    this.current = null;
    this.notify();
    return true;
  }

  rollback(transactionId?: string): boolean {
    const txn = this.resolveTransaction(transactionId);
    if (!txn || txn.status !== "pending") return false;
    for (let i = txn.changes.length - 1; i >= 0; i--) {
      this.applyChangeFn?.(txn.changes[i], true);
    }
    txn.status = "rolledback";
    this.current = null;
    this.notify();
    return true;
  }

  cancel(transactionId?: string): boolean {
    const txn = this.resolveTransaction(transactionId);
    if (!txn || txn.status !== "pending") return false;
    for (let i = txn.changes.length - 1; i >= 0; i--) {
      this.applyChangeFn?.(txn.changes[i], true);
    }
    txn.status = "cancelled";
    this.current = null;
    this.notify();
    return true;
  }

  recordChange(change: Omit<TransactionChange, "id" | "timestamp">): void {
    if (!this.current || this.current.status !== "pending") {
      this.start({ name: "Auto", source: change.source });
    }
    const full: TransactionChange = {
      ...change,
      id: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };
    this.current!.changes.push(full);
    this.applyChangeFn?.(full, false);
    this.notify();
  }

  undo(): boolean {
    if (this.current?.status === "pending") this.commit();
    if (this.canonical) {
      if (!history.canUndo()) return false;
      void history.undo();
      return true;
    }
    const txn = this.undoStack.pop();
    if (!txn) return false;
    this.replay(txn, true);
    this.redoStack.push(txn);
    this.notify();
    return true;
  }

  redo(): boolean {
    if (this.canonical) {
      if (!history.canRedo()) return false;
      void history.redo();
      return true;
    }
    const txn = this.redoStack.pop();
    if (!txn) return false;
    this.replay(txn, false);
    this.undoStack.push(txn);
    this.notify();
    return true;
  }

  canUndo(): boolean {
    return this.canonical ? history.canUndo() : this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.canonical ? history.canRedo() : this.redoStack.length > 0;
  }

  getState(): UndoRedoState {
    if (this.canonical) {
      const depth = history.depth();
      return {
        // Snapshot contents live on the shared stack; expose counts via the
        // array lengths without leaking stack internals.
        undoStack: new Array(depth.undo) as TransactionSnapshot[],
        redoStack: new Array(depth.redo) as TransactionSnapshot[],
        maxHistory: depth.undo + depth.redo,
        isInTransaction: this.current?.status === "pending",
        currentTransactionId: this.current?.id ?? null,
        currentGroupId: this.currentGroup?.id ?? null,
      };
    }
    return {
      undoStack: [...this.undoStack],
      redoStack: [...this.redoStack],
      maxHistory: this.maxHistory,
      isInTransaction: this.current?.status === "pending",
      currentTransactionId: this.current?.id ?? null,
      currentGroupId: this.currentGroup?.id ?? null,
    };
  }

  clearHistory(): void {
    if (this.canonical) {
      history.clear();
    } else {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.notify();
  }

  beginGroup(name: string): string {
    const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.currentGroup = { id, name, transactions: [], status: "pending", createdAt: Date.now() };
    this.notify();
    return id;
  }

  endGroup(commit = true): boolean {
    if (!this.currentGroup) return false;
    if (this.current?.status === "pending") {
      if (commit) this.commit();
      else this.rollback();
    }
    this.currentGroup.status = commit ? "committed" : "rolledback";
    this.currentGroup = null;
    this.notify();
    return true;
  }

  subscribe(fn: (state: UndoRedoState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private resolveTransaction(id?: string): TransactionSnapshot | null {
    if (!id) return this.current;
    if (this.current?.id === id) return this.current;
    if (this.canonical) return this.current?.id === id ? this.current : null;
    return this.undoStack.find((t) => t.id === id) ?? null;
  }

  private notify(): void {
    const state = this.getState();
    for (const fn of this.listeners) fn(state);
  }
}

/**
 * Canonical singleton: every production transaction lands on the shared
 * history stack so there is exactly one undo/redo order for the document.
 */
export function getTransactionService(): TransactionService {
  if (!_instance) _instance = new TransactionService(MAX_HISTORY_DEFAULT, { canonical: true });
  return _instance;
}

export type { ITransactionService, TransactionChange, TransactionOptions, UndoRedoState };
