"use strict";
/**
 * Unified Modify command architecture (Design spec MODULE 2C.1, 2C.11).
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ModifyCommandBase = void 0;
/** Shared implementation core: pending change set + diagnostics. */
class ModifyCommandBase {
    ctx;
    ids = [];
    pending = [];
    diagnostics = [];
    started = false;
    constructor(ctx) {
        this.ctx = ctx;
    }
    CanExecute(ids) {
        if (!ids.length)
            return { can: false, reason: "no selection" };
        for (const id of ids) {
            const el = this.ctx.store.get(id);
            if (!el)
                return { can: false, reason: `element '${id}' not found` };
            if (el.pinned)
                return { can: false, reason: `element '${id}' is pinned (unpin it first)` };
            if (!el.editable)
                return { can: false, reason: `element '${id}' is not editable` };
            if (this.ctx.lockedElementIds?.has(id)) {
                return { can: false, reason: `element '${id}' is locked by another user` };
            }
        }
        return { can: true };
    }
    Begin(ids) {
        const gate = this.CanExecute(ids);
        if (!gate.can)
            throw new Error(`${this.name}: ${gate.reason}`);
        this.ids = [...ids];
        this.pending = [];
        this.diagnostics = [];
        this.started = true;
    }
    Validate() {
        const errors = this.diagnostics.filter((d) => d.severity === "error");
        return { ok: errors.length === 0, diagnostics: [...this.diagnostics] };
    }
    Commit() {
        const v = this.Validate();
        if (!v.ok)
            return { ok: false, applied: 0, diagnostics: v.diagnostics };
        let applied = 0;
        for (const change of this.pending) {
            if (change.newElement) {
                this.ctx.store.insert(change.newElement);
                applied++;
                continue;
            }
            if (this.ctx.store.apply(change.elementId, change.patch))
                applied++;
        }
        return { ok: true, applied, diagnostics: v.diagnostics };
    }
    Cancel() {
        // Discard pending work — no partial state was ever applied (2C.11).
        this.pending = [];
        this.diagnostics = [];
        this.started = false;
    }
    GetAffectedElements() {
        return [...this.ids, ...this.pending.filter((p) => p.newElement).map((p) => p.newElement.id)];
    }
    GetRequiredReferences() {
        return [];
    }
    GetDiagnostics() {
        return [...this.diagnostics];
    }
    err(code, message, elementIds = this.ids) {
        this.diagnostics.push({ severity: "error", code, message, elementIds });
    }
    warn(code, message, elementIds = this.ids) {
        this.diagnostics.push({ severity: "warning", code, message, elementIds });
    }
    info(code, message, elementIds = this.ids) {
        this.diagnostics.push({ severity: "info", code, message, elementIds });
    }
}
exports.ModifyCommandBase = ModifyCommandBase;
