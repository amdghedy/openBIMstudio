"use strict";
/**
 * Modify Group 2 — Align, Split-with-Gap, Wall Corner Trim/Extend
 * (Design spec MODULE 2C — Groups 2–3 expansion)
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WallCornerCommand = exports.SplitWithGapCommand = exports.AlignWithLockCommand = exports.AxisAlignCommand = void 0;
const command_1 = require("./command");
const duplicate_1 = require("./duplicate");
// ── Align Command ────────────────────────────────────────────────────────
/**
 * AxisAlign: moves selected elements so that a chosen edge/center aligns with
 * a target line (X or Y coordinate). Optional lock-after prevents subsequent
 * moves from breaking the alignment.
 */
class AxisAlignCommand extends command_1.ModifyCommandBase {
    name = "axis-align";
    UpdatePreview(input) {
        const ai = input;
        if (ai.type !== "align")
            throw new Error("AxisAlignCommand: expects 'align' input");
        const out = [];
        for (const id of this.ids) {
            const el = this.ctx.store.get(id);
            const pos = [...el.position];
            if (ai.axis === "x") {
                pos[0] = ai.target;
            }
            else {
                pos[1] = ai.target;
            }
            const patch = { position: pos, reason: ai.lockAfter ? "align-locked" : "align" };
            out.push({ elementId: id, patch });
        }
        this.pending = out;
        return out;
    }
    GetRequiredReferences() {
        return ["align-reference-line"];
    }
}
exports.AxisAlignCommand = AxisAlignCommand;
exports.AlignWithLockCommand = AxisAlignCommand;
// ── Split with Gap Command ───────────────────────────────────────────────
/**
 * Split with Gap: splits a linear element at a parameter and inserts a gap
 * of specified distance. The original keeps its identity (first part);
 * the second part receives a new ID. Both are shortened by gap/2 from
 * the split point.
 */
class SplitWithGapCommand extends command_1.ModifyCommandBase {
    name = "split-with-gap";
    UpdatePreview(input) {
        const si = input;
        if (si.type !== "split-gap")
            throw new Error("SplitWithGapCommand: expects 'split-gap' input");
        const { parameter, gapDistance } = si;
        if (parameter <= 0 || parameter >= 1) {
            this.err("MOD-SPG-001", "Split parameter must be strictly between 0 and 1");
            return [];
        }
        if (gapDistance < 0) {
            this.err("MOD-SPG-002", "Gap distance cannot be negative");
            return [];
        }
        const out = [];
        for (const id of this.ids) {
            const el = this.ctx.store.get(id);
            if (!el.curve) {
                this.warn("MOD-SPG-003", `Element '${id}' has no curve — skipped`, [id]);
                continue;
            }
            const { start, end } = el.curve;
            const dx = end[0] - start[0];
            const dy = end[1] - start[1];
            const len = Math.hypot(dx, dy);
            if (len < 1e-6)
                continue;
            const halfGapParam = (gapDistance / 2) / len;
            const nx = dx / len;
            const ny = dy / len;
            // Split point
            const splitX = start[0] + dx * parameter;
            const splitY = start[1] + dy * parameter;
            // Part 1: original element shortened — start to (splitPoint - halfGap)
            const end1Param = Math.max(0, parameter - halfGapParam);
            const end1 = [start[0] + dx * end1Param, start[1] + dy * end1Param];
            out.push({
                elementId: id,
                patch: { curve: { start: [...start], end: end1 }, reason: "split-gap-part1" },
            });
            // Part 2: new element — (splitPoint + halfGap) to end
            const start2Param = Math.min(1, parameter + halfGapParam);
            const start2 = [start[0] + dx * start2Param, start[1] + dy * start2Param];
            const newId = this.ctx.allocateId?.() ?? `${id}-split`;
            const newEl = (0, duplicate_1.cloneElement)(el, newId, {
                curve: { start: start2, end: [...end] },
            });
            out.push({ elementId: id, patch: {}, newElement: newEl });
        }
        this.pending = out;
        return out;
    }
    GetRequiredReferences() {
        return ["split-point"];
    }
}
exports.SplitWithGapCommand = SplitWithGapCommand;
// ── Wall Corner Trim/Extend ──────────────────────────────────────────────
function lineLineIntersect(p1, d1, p2, d2) {
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-12)
        return null; // Parallel
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const t = (dx * d2[1] - dy * d2[0]) / cross;
    return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}
/**
 * Wall Corner Trim/Extend: given two walls (line-based elements), finds their
 * geometric intersection and either trims or extends their endpoints to form
 * a clean corner (miter join). Both walls' near-endpoints are moved to the
 * intersection point.
 */
class WallCornerCommand extends command_1.ModifyCommandBase {
    name = "wall-corner";
    wallAId = "";
    wallBId = "";
    mode = "miter";
    UpdatePreview(input) {
        const wi = input;
        if (wi.type !== "wall-corner-trim")
            throw new Error("WallCornerCommand: expects 'wall-corner-trim' input");
        this.wallAId = wi.wallA;
        this.wallBId = wi.wallB;
        this.mode = wi.mode;
        const elA = this.ctx.store.get(wi.wallA);
        const elB = this.ctx.store.get(wi.wallB);
        if (!elA?.curve || !elB?.curve) {
            this.err("MOD-WCT-001", "Both wall elements must have curves");
            return [];
        }
        const dA = [elA.curve.end[0] - elA.curve.start[0], elA.curve.end[1] - elA.curve.start[1]];
        const dB = [elB.curve.end[0] - elB.curve.start[0], elB.curve.end[1] - elB.curve.start[1]];
        const ix = lineLineIntersect(elA.curve.start, dA, elB.curve.start, dB);
        if (!ix) {
            this.err("MOD-WCT-002", "Walls are parallel — no intersection found");
            return [];
        }
        // Determine which endpoint of each wall is closest to the intersection
        const distAStart = Math.hypot(ix[0] - elA.curve.start[0], ix[1] - elA.curve.start[1]);
        const distAEnd = Math.hypot(ix[0] - elA.curve.end[0], ix[1] - elA.curve.end[1]);
        const distBStart = Math.hypot(ix[0] - elB.curve.start[0], ix[1] - elB.curve.start[1]);
        const distBEnd = Math.hypot(ix[0] - elB.curve.end[0], ix[1] - elB.curve.end[1]);
        const patchA = {
            start: [...elA.curve.start],
            end: [...elA.curve.end],
        };
        if (distAEnd <= distAStart) {
            patchA.end = ix;
        }
        else {
            patchA.start = ix;
        }
        const patchB = {
            start: [...elB.curve.start],
            end: [...elB.curve.end],
        };
        if (distBEnd <= distBStart) {
            patchB.end = ix;
        }
        else {
            patchB.start = ix;
        }
        const out = [
            { elementId: wi.wallA, patch: { curve: patchA, reason: `wall-corner-${this.mode}` } },
            { elementId: wi.wallB, patch: { curve: patchB, reason: `wall-corner-${this.mode}` } },
        ];
        this.pending = out;
        return out;
    }
    GetRequiredReferences() {
        return ["wall-A", "wall-B"];
    }
}
exports.WallCornerCommand = WallCornerCommand;
