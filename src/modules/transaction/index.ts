/**
 * Transaction Service — Revit-like Transaction / TransactionGroup + Undo/Redo
 */
import type {
  TransactionChange,
  TransactionSnapshot,
  TransactionGroup,
  UndoRedoState,
  TransactionOptions,
  ITransactionService,
} from "./types";

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

  constructor(maxHistory = MAX_HISTORY_DEFAULT) {
    this.maxHistory = maxHistory;
  }

  setApplyHandler(fn: (change: TransactionChange, reverse: boolean) => void): void {
    this.applyChangeFn = fn;
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
      this.undoStack.push(txn);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.redoStack = [];
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
    const txn = this.undoStack.pop();
    if (!txn) return false;
    for (let i = txn.changes.length - 1; i >= 0; i--) {
      this.applyChangeFn?.(txn.changes[i], true);
    }
    this.redoStack.push(txn);
    this.notify();
    return true;
  }

  redo(): boolean {
    const txn = this.redoStack.pop();
    if (!txn) return false;
    for (const ch of txn.changes) this.applyChangeFn?.(ch, false);
    this.undoStack.push(txn);
    this.notify();
    return true;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  getState(): UndoRedoState {
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
    this.undoStack = [];
    this.redoStack = [];
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
    return this.undoStack.find((t) => t.id === id) ?? null;
  }

  private notify(): void {
    const state = this.getState();
    for (const fn of this.listeners) fn(state);
  }
}

export function getTransactionService(): TransactionService {
  if (!_instance) _instance = new TransactionService();
  return _instance;
}

export type { ITransactionService, TransactionChange, TransactionOptions, UndoRedoState };
