"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.history = void 0;
class HistoryManager {
    undoStack = [];
    redoStack = [];
    maxDepth = 100;
    listeners = new Set();
    isExecuting = false;
    // Project transitions suspend new edits and wait for in-flight history work.
    suspended = false;
    activeOperations = 0;
    idleWaiters = [];
    // Coalescing
    coalesceKey = null;
    coalesceTimer = null;
    // Transactions (grouping)
    txDepth = 0;
    txCommands = [];
    txLabel = "";
    onChange(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }
    emit() {
        for (const cb of this.listeners) {
            try {
                cb();
            }
            catch {
                /* */
            }
        }
    }
    enterOperation() {
        this.activeOperations++;
    }
    leaveOperation() {
        this.activeOperations = Math.max(0, this.activeOperations - 1);
        if (this.activeOperations === 0 && this.idleWaiters.length) {
            const waiters = this.idleWaiters.splice(0);
            for (const resolve of waiters)
                resolve();
        }
    }
    waitForOperations() {
        if (this.activeOperations === 0)
            return Promise.resolve();
        return new Promise((resolve) => this.idleWaiters.push(resolve));
    }
    /**
     * Start a project/document boundary. Existing undo/redo work is allowed to
     * finish against the old scene; new history actions are blocked until the
     * returned release function is called after the new scene is ready.
     */
    async beginDocumentTransition() {
        if (this.suspended)
            throw new Error("A project/document transition is already in progress");
        this.suspended = true;
        try {
            // Drain operations already queued on the serial undo/redo chain.
            await this.chain;
            // Commands and grouped transactions are async and are not part of that
            // chain. Wait for them too before the scene is torn down.
            await this.waitForOperations();
            this.clearStacks();
        }
        catch (error) {
            this.suspended = false;
            this.emit();
            throw error;
        }
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.suspended = false;
            this.emit();
        };
    }
    clearStacks() {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.coalesceKey = null;
        if (this.coalesceTimer != null) {
            clearTimeout(this.coalesceTimer);
            this.coalesceTimer = null;
        }
    }
    canUndo() {
        return this.undoStack.length > 0;
    }
    canRedo() {
        return this.redoStack.length > 0;
    }
    undoLabel() {
        return this.undoStack[this.undoStack.length - 1]?.label ?? null;
    }
    redoLabel() {
        return this.redoStack[this.redoStack.length - 1]?.label ?? null;
    }
    depth() {
        return { undo: this.undoStack.length, redo: this.redoStack.length };
    }
    /**
     * Push a command. If `coalesce` is set and matches the previous command's
     * key within the coalesce window, the previous command is discarded and
     * replaced with this one (they merge).
     *
     * Returns true when the command was recorded (or buffered into an active
     * transaction) and false when it was refused — so callers that must not
     * lose undo coverage can react instead of the drop being silent.
     * A push is refused only while another undo/redo is mid-flight (ordering
     * would be ambiguous) or during a project/document transition.
     */
    push(cmd, coalesce) {
        if (this.isExecuting) {
            console.warn("[history] push refused: an undo/redo is executing —", cmd.label);
            return false;
        }
        // An active transaction may still be unwinding while a transition starts;
        // keep its savepoint buffer intact so its own rollback remains correct.
        if (this.txDepth > 0) {
            this.txCommands.push(cmd);
            return true;
        }
        if (this.suspended) {
            console.warn("[history] push refused during project/document transition —", cmd.label);
            return false;
        }
        // Inside a transaction: buffer, don't push yet.
        if (coalesce && this.coalesceKey === coalesce) {
            // Replace the last command instead of stacking.
            this.undoStack[this.undoStack.length - 1] = cmd;
        }
        else {
            this.undoStack.push(cmd);
            if (this.undoStack.length > this.maxDepth)
                this.undoStack.shift();
        }
        this.redoStack.length = 0;
        if (coalesce) {
            this.coalesceKey = coalesce;
            if (this.coalesceTimer != null)
                clearTimeout(this.coalesceTimer);
            this.coalesceTimer = window.setTimeout(() => {
                this.coalesceKey = null;
                this.coalesceTimer = null;
            }, 400);
        }
        else {
            this.coalesceKey = null;
        }
        this.emit();
        return true;
    }
    /**
     * Run a function inside a transaction: all pushes it performs become one
     * atomic undoable command. Useful for compound operations (e.g. delete 12
     * elements in one action).
     */
    async transaction(label, fn) {
        if (this.suspended)
            throw new Error("Cannot start a history transaction during a project/document transition");
        this.enterOperation();
        try {
            const outermost = this.txDepth === 0;
            const savepoint = this.txCommands.length;
            if (outermost) {
                this.txCommands = [];
                this.txLabel = label;
            }
            this.txDepth++;
            try {
                await fn();
            }
            catch (error) {
                // A failed nested scope is a savepoint: undo only work added by that
                // scope. This also means a caller may catch the nested error and keep
                // the surrounding transaction alive.
                const failed = this.txCommands.splice(savepoint);
                let rollbackError;
                this.isExecuting = true;
                try {
                    for (let i = failed.length - 1; i >= 0; i--) {
                        try {
                            await failed[i].revert();
                        }
                        catch (cause) {
                            rollbackError ??= cause;
                        }
                    }
                }
                finally {
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
            if (!outermost)
                return;
            const inner = this.txCommands.slice();
            this.txCommands = [];
            const groupLabel = this.txLabel || label;
            this.txLabel = "";
            if (!inner.length)
                return;
            const group = {
                label: groupLabel,
                apply: async () => {
                    for (const command of inner)
                        await command.apply();
                },
                revert: async () => {
                    for (let i = inner.length - 1; i >= 0; i--)
                        await inner[i].revert();
                },
            };
            // Bypass tx buffering (we're already out).
            this.push(group);
        }
        finally {
            this.leaveOperation();
        }
    }
    /** Execute and record a command (convenience for one-shot actions). */
    async exec(cmd, coalesce) {
        if (this.suspended)
            throw new Error("Cannot execute a history command during a project/document transition");
        this.enterOperation();
        try {
            this.isExecuting = true;
            try {
                await cmd.apply();
            }
            catch (error) {
                // apply() may have mutated part of the model before throwing. Attempt
                // the command's inverse before exposing the failure to the caller.
                try {
                    await cmd.revert();
                }
                catch (rollbackError) {
                    throw new AggregateError([error, rollbackError], `Command '${cmd.label}' failed and its rollback was incomplete`);
                }
                throw error;
            }
            finally {
                this.isExecuting = false;
            }
            this.push(cmd, coalesce);
        }
        finally {
            this.leaveOperation();
        }
    }
    // Undo/redo run one at a time. Holding Ctrl+Z (key repeat) used to start
    // overlapping async reverts that corrupted the executing flag and stacks.
    chain = Promise.resolve();
    undo() {
        const run = this.chain.then(() => this.doUndo());
        this.chain = run.catch(() => { });
        return run;
    }
    redo() {
        const run = this.chain.then(() => this.doRedo());
        this.chain = run.catch(() => { });
        return run;
    }
    async doUndo() {
        if (this.suspended)
            return;
        const cmd = this.undoStack.pop();
        if (!cmd)
            return;
        this.isExecuting = true;
        try {
            await cmd.revert();
        }
        catch (e) {
            console.error("[history] undo failed", e);
            // Put it back on failure so the user can retry.
            this.undoStack.push(cmd);
            throw e;
        }
        finally {
            this.isExecuting = false;
        }
        this.redoStack.push(cmd);
        this.coalesceKey = null;
        try {
            window.dispatchEvent(new CustomEvent("obs-history", { detail: { action: "undo", label: cmd.label } }));
            window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Undo: ${cmd.label}`, kind: "info" } }));
        }
        catch { /* */ }
        this.emit();
    }
    async doRedo() {
        if (this.suspended)
            return;
        const cmd = this.redoStack.pop();
        if (!cmd)
            return;
        this.isExecuting = true;
        try {
            await cmd.apply();
        }
        catch (e) {
            console.error("[history] redo failed", e);
            this.redoStack.push(cmd);
            throw e;
        }
        finally {
            this.isExecuting = false;
        }
        this.undoStack.push(cmd);
        this.coalesceKey = null;
        try {
            window.dispatchEvent(new CustomEvent("obs-history", { detail: { action: "redo", label: cmd.label } }));
            window.dispatchEvent(new CustomEvent("obs-toast", { detail: { message: `Redo: ${cmd.label}`, kind: "info" } }));
        }
        catch { /* */ }
        this.emit();
    }
    clear() {
        this.clearStacks();
        this.emit();
    }
}
exports.history = new HistoryManager();
