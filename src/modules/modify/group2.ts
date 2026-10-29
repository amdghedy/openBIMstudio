/**
 * Modify Group 2 — Align, Split-with-Gap, Wall Corner Trim/Extend
 * (MASTER PROMPT MODULE 2C — Groups 2–3 expansion)
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  ModifyCommandBase,
  type CommandInput, type PendingChange, type ModifyElement,
} from "./command";
import { cloneElement } from "./duplicate";

// ── Extended input types ─────────────────────────────────────────────────

export type Group2Input =
  | { type: "align"; axis: "x" | "y"; target: number; lockAfter: boolean }
  | { type: "split-gap"; parameter: number; gapDistance: number }
  | { type: "wall-corner-trim"; wallA: string; wallB: string; mode: "trim" | "extend" | "miter" };

// ── Align Command ────────────────────────────────────────────────────────

/**
 * AxisAlign: moves selected elements so that a chosen edge/center aligns with
 * a target line (X or Y coordinate). Optional lock-after prevents subsequent
 * moves from breaking the alignment.
 */
export class AxisAlignCommand extends ModifyCommandBase {
  readonly name = "axis-align";

  UpdatePreview(input: CommandInput): PendingChange[] {
    const ai = input as unknown as Extract<Group2Input, { type: "align" }>;
    if (ai.type !== "align") throw new Error("AxisAlignCommand: expects 'align' input");

    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      const pos: [number, number] = [...el.position];

      if (ai.axis === "x") {
        pos[0] = ai.target;
      } else {
        pos[1] = ai.target;
      }

      const patch = { position: pos, reason: ai.lockAfter ? "align-locked" : "align" };
      out.push({ elementId: id, patch });
    }
    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["align-reference-line"];
  }
}

export { AxisAlignCommand as AlignWithLockCommand };

// ── Split with Gap Command ───────────────────────────────────────────────

/**
 * Split with Gap: splits a linear element at a parameter and inserts a gap
 * of specified distance. The original keeps its identity (first part);
 * the second part receives a new ID. Both are shortened by gap/2 from
 * the split point.
 */
export class SplitWithGapCommand extends ModifyCommandBase {
  readonly name = "split-with-gap";

  UpdatePreview(input: CommandInput): PendingChange[] {
    const si = input as unknown as Extract<Group2Input, { type: "split-gap" }>;
    if (si.type !== "split-gap") throw new Error("SplitWithGapCommand: expects 'split-gap' input");

    const { parameter, gapDistance } = si;
    if (parameter <= 0 || parameter >= 1) {
      this.err("MOD-SPG-001", "Split parameter must be strictly between 0 and 1");
      return [];
    }
    if (gapDistance < 0) {
      this.err("MOD-SPG-002", "Gap distance cannot be negative");
      return [];
    }

    const out: PendingChange[] = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id)!;
      if (!el.curve) {
        this.warn("MOD-SPG-003", `Element '${id}' has no curve — skipped`, [id]);
        continue;
      }

      const { start, end } = el.curve;
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;

      const halfGapParam = (gapDistance / 2) / len;
      const nx = dx / len;
      const ny = dy / len;

      // Split point
      const splitX = start[0] + dx * parameter;
      const splitY = start[1] + dy * parameter;

      // Part 1: original element shortened — start to (splitPoint - halfGap)
      const end1Param = Math.max(0, parameter - halfGapParam);
      const end1: [number, number] = [start[0] + dx * end1Param, start[1] + dy * end1Param];

      out.push({
        elementId: id,
        patch: { curve: { start: [...start] as [number, number], end: end1 }, reason: "split-gap-part1" },
      });

      // Part 2: new element — (splitPoint + halfGap) to end
      const start2Param = Math.min(1, parameter + halfGapParam);
      const start2: [number, number] = [start[0] + dx * start2Param, start[1] + dy * start2Param];
      const newId = this.ctx.allocateId?.() ?? `${id}-split`;
      const newEl = cloneElement(el, newId, {
        curve: { start: start2, end: [...end] as [number, number] },
      });
      out.push({ elementId: id, patch: {}, newElement: newEl });
    }

    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["split-point"];
  }
}

// ── Wall Corner Trim/Extend ──────────────────────────────────────────────

function lineLineIntersect(
  p1: [number, number], d1: [number, number],
  p2: [number, number], d2: [number, number],
): [number, number] | null {
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(cross) < 1e-12) return null; // Parallel
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
export class WallCornerCommand extends ModifyCommandBase {
  readonly name = "wall-corner";

  private wallAId = "";
  private wallBId = "";
  private mode: "trim" | "extend" | "miter" = "miter";

  UpdatePreview(input: CommandInput): PendingChange[] {
    const wi = input as unknown as Extract<Group2Input, { type: "wall-corner-trim" }>;
    if (wi.type !== "wall-corner-trim") throw new Error("WallCornerCommand: expects 'wall-corner-trim' input");

    this.wallAId = wi.wallA;
    this.wallBId = wi.wallB;
    this.mode = wi.mode;

    const elA = this.ctx.store.get(wi.wallA);
    const elB = this.ctx.store.get(wi.wallB);

    if (!elA?.curve || !elB?.curve) {
      this.err("MOD-WCT-001", "Both wall elements must have curves");
      return [];
    }

    const dA: [number, number] = [elA.curve.end[0] - elA.curve.start[0], elA.curve.end[1] - elA.curve.start[1]];
    const dB: [number, number] = [elB.curve.end[0] - elB.curve.start[0], elB.curve.end[1] - elB.curve.start[1]];

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

    const patchA: { start: [number, number]; end: [number, number] } = {
      start: [...elA.curve.start] as [number, number],
      end: [...elA.curve.end] as [number, number],
    };
    if (distAEnd <= distAStart) {
      patchA.end = ix;
    } else {
      patchA.start = ix;
    }

    const patchB: { start: [number, number]; end: [number, number] } = {
      start: [...elB.curve.start] as [number, number],
      end: [...elB.curve.end] as [number, number],
    };
    if (distBEnd <= distBStart) {
      patchB.end = ix;
    } else {
      patchB.start = ix;
    }

    const out: PendingChange[] = [
      { elementId: wi.wallA, patch: { curve: patchA, reason: `wall-corner-${this.mode}` } },
      { elementId: wi.wallB, patch: { curve: patchB, reason: `wall-corner-${this.mode}` } },
    ];

    this.pending = out;
    return out;
  }

  GetRequiredReferences(): string[] {
    return ["wall-A", "wall-B"];
  }
}
