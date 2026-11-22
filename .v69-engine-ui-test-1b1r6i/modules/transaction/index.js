"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TransactionService = void 0;
exports.getTransactionService = getTransactionService;
const history_1 = require("../../features/history");
const MAX_HISTORY_DEFAULT = 50;
let _instance = null;
class TransactionService {
    undoStack = [];
    redoStack = [];
    maxHistory;
    current = null;
    currentGroup = null;
    listeners = new Set();
    applyChangeFn = null;
    /** Canonical mode: the shared features/history stack is the only storage. */
    canonical;
    historyUnsub = null;
    constructor(maxHistory = MAX_HISTORY_DEFAULT, opts) {
        this.maxHistory = maxHistory;
        this.canonical = Boolean(opts?.canonical);
        if (this.canonical) {
            // Keep instance subscribers informed when the shared stack changes.
            this.historyUnsub = history_1.history.onChange(() => this.notify());
        }
    }
    /** True when this instance records into the shared application history. */
    get isCanonical() {
        return this.canonical;
    }
    setApplyHandler(fn) {
        this.applyChangeFn = fn;
    }
    /** Replay a committed snapshot through the handler (no skip logic). */
    replay(txn, reverse) {
        if (!this.applyChangeFn)
            return;
        if (reverse) {
            for (let i = txn.changes.length - 1; i >= 0; i--)
                this.applyChangeFn(txn.changes[i], true);
        }
        else {
            for (const ch of txn.changes)
                this.applyChangeFn(ch, false);
        }
    }
    start(options) {
        if (this.current?.status === "pending")
            this.commit();
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
        if (options.startGroup)
            this.beginGroup(options.name);
        this.notify();
        return id;
    }
    commit(transactionId) {
        const txn = this.resolveTransaction(transactionId);
        if (!txn || txn.status !== "pending")
            return false;
        txn.status = "committed";
        const isTransient = Boolean(txn.metadata?.transient);
        if (!isTransient && txn.changes.length > 0) {
            if (this.canonical) {
                // One transaction == one deterministic command on the shared stack.
                // push() (not exec): the tool already applied every change (D-16).
                // Redo invalidation, depth bound, document-transition refusal and
                // nested-transaction buffering are all inherited from history.
                const snapshot = txn;
                const accepted = history_1.history.push({
                    label: txn.name,
                    apply: () => this.replay(snapshot, false),
                    revert: () => this.replay(snapshot, true),
                });
                if (!accepted) {
                    console.warn("[transaction] commit not undoable — history refused the command:", txn.name);
                }
            }
            else {
                this.undoStack.push(txn);
                if (this.undoStack.length > this.maxHistory)
                    this.undoStack.shift();
                this.redoStack = [];
            }
        }
        if (this.currentGroup)
            this.currentGroup.transactions.push(txn.id);
        this.current = null;
        this.notify();
        return true;
    }
    rollback(transactionId) {
        const txn = this.resolveTransaction(transactionId);
        if (!txn || txn.status !== "pending")
            return false;
        for (let i = txn.changes.length - 1; i >= 0; i--) {
            this.applyChangeFn?.(txn.changes[i], true);
        }
        txn.status = "rolledback";
        this.current = null;
        this.notify();
        return true;
    }
    cancel(transactionId) {
        const txn = this.resolveTransaction(transactionId);
        if (!txn || txn.status !== "pending")
            return false;
        for (let i = txn.changes.length - 1; i >= 0; i--) {
            this.applyChangeFn?.(txn.changes[i], true);
        }
        txn.status = "cancelled";
        this.current = null;
        this.notify();
        return true;
    }
    recordChange(change) {
        if (!this.current || this.current.status !== "pending") {
            this.start({ name: "Auto", source: change.source });
        }
        const full = {
            ...change,
            id: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            timestamp: Date.now(),
        };
        this.current.changes.push(full);
        this.applyChangeFn?.(full, false);
        this.notify();
    }
    undo() {
        if (this.current?.status === "pending")
            this.commit();
        if (this.canonical) {
            if (!history_1.history.canUndo())
                return false;
            void history_1.history.undo();
            return true;
        }
        const txn = this.undoStack.pop();
        if (!txn)
            return false;
        this.replay(txn, true);
        this.redoStack.push(txn);
        this.notify();
        return true;
    }
    redo() {
        if (this.canonical) {
            if (!history_1.history.canRedo())
                return false;
            void history_1.history.redo();
            return true;
        }
        const txn = this.redoStack.pop();
        if (!txn)
            return false;
        this.replay(txn, false);
        this.undoStack.push(txn);
        this.notify();
        return true;
    }
    canUndo() {
        return this.canonical ? history_1.history.canUndo() : this.undoStack.length > 0;
    }
    canRedo() {
        return this.canonical ? history_1.history.canRedo() : this.redoStack.length > 0;
    }
    getState() {
        if (this.canonical) {
            const depth = history_1.history.depth();
            return {
                // Snapshot contents live on the shared stack; expose counts via the
                // array lengths without leaking stack internals.
                undoStack: new Array(depth.undo),
                redoStack: new Array(depth.redo),
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
    clearHistory() {
        if (this.canonical) {
            history_1.history.clear();
        }
        else {
            this.undoStack = [];
            this.redoStack = [];
        }
        this.notify();
    }
    beginGroup(name) {
        const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        this.currentGroup = { id, name, transactions: [], status: "pending", createdAt: Date.now() };
        this.notify();
        return id;
    }
    endGroup(commit = true) {
        if (!this.currentGroup)
            return false;
        if (this.current?.status === "pending") {
            if (commit)
                this.commit();
            else
                this.rollback();
        }
        this.currentGroup.status = commit ? "committed" : "rolledback";
        this.currentGroup = null;
        this.notify();
        return true;
    }
    subscribe(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }
    resolveTransaction(id) {
        if (!id)
            return this.current;
        if (this.current?.id === id)
            return this.current;
        if (this.canonical)
            return this.current?.id === id ? this.current : null;
        return this.undoStack.find((t) => t.id === id) ?? null;
    }
    notify() {
        const state = this.getState();
        for (const fn of this.listeners)
            fn(state);
    }
}
exports.TransactionService = TransactionService;
/**
 * Canonical singleton: every production transaction lands on the shared
 * history stack so there is exactly one undo/redo order for the document.
 */
function getTransactionService() {
    if (!_instance)
        _instance = new TransactionService(MAX_HISTORY_DEFAULT, { canonical: true });
    return _instance;
}
