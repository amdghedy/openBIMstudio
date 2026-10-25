/**
 * Transaction system types
 */

export type TransactionStatus = "pending" | "committed" | "rolledback" | "cancelled";

export interface TransactionChange {
  id: string;
  elementId: string;
  propertyPath: string;
  oldValue: unknown;
  newValue: unknown;
  timestamp: number;
  source: "user" | "regen" | "import" | "plugin" | "system";
}

export interface TransactionSnapshot {
  id: string;
  name: string;
  changes: TransactionChange[];
  createdAt: number;
  status: TransactionStatus;
  parentId?: string;
  metadata?: Record<string, unknown>;
}

export interface TransactionGroup {
  id: string;
  name: string;
  transactions: string[];
  status: TransactionStatus;
  createdAt: number;
}

export interface UndoRedoState {
  undoStack: TransactionSnapshot[];
  redoStack: TransactionSnapshot[];
  maxHistory: number;
  isInTransaction: boolean;
  currentTransactionId: string | null;
  currentGroupId: string | null;
}

export interface TransactionOptions {
  name: string;
  startGroup?: boolean;
  maxChanges?: number;
  source?: TransactionChange["source"];
  transient?: boolean;
}

export interface ITransactionService {
  start(options: TransactionOptions): string;
  commit(transactionId?: string): boolean;
  rollback(transactionId?: string): boolean;
  cancel(transactionId?: string): boolean;
  recordChange(change: Omit<TransactionChange, "id" | "timestamp">): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  getState(): UndoRedoState;
  clearHistory(): void;
  beginGroup(name: string): string;
  endGroup(commit?: boolean): boolean;
  setApplyHandler(fn: (change: TransactionChange, reverse: boolean) => void): void;
}
