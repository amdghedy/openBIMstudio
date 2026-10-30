/**
 * Transformation Modify commands: Move, Rotate, Align
 * (MASTER PROMPT MODULE 2C.3–2C.5).
 *
 * Math (spec formulas):
 *   Move:    P' = P + Δ ;  T' = T_Δ · T
 *   Rotate:  R = I·cosθ + (1−cosθ)·u uᵀ + [u]×·sinθ   (Rodrigues)
 *   Align:   translation = target − source (one-time) or a persistent
 *            locked constraint via the relationship registry.
 *
 * Relationship propagation (spec 2C.3): after commit, dependents of the
 * moved elements are re-evaluated through the relationship registry with
 * each record's reconnection policy. Constrained moves that would violate
 * locked alignments are blocked with diagnostics (spec acceptance test 7).
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  ModifyCommandBase,
  type CommandInput, type ElementPatch, type ModifyContext, type PendingChange, type ModifyDiagnostic,
} from "./command";
import type { RelationshipRegistry, GeometricReference } from "../relationships";
import { detectAlignmentConflict } from "../snapping/alignment";

// ── Move (2C.3) ──────────────────────────────────────────────────────────

export class MoveCommand extends ModifyCommandBase {
  readonly name = "move";
  private translation: [number, number] = [0, 0];

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type !== "translation" && input.type !== "numeric-offset") {
      throw new Error(`MoveCommand: input type '${input.type}' not accepted`);
    }
    if (input.type === "translation") {
      this.translation = [input.to[0] - input.from[0], input.to[1] - input.from[1]];
    } else {
      this.translation = [input.dx, input.dy];
    }
    this.pending = this.ids.map((id) => {
      const el = this.ctx.store.get(id)!;
      return {
        elementId: id,
        patch: {
          position: [el.position[0] + this.translation[0], el.position[1] + this.translation[1]],
          reason: "move",
        } satisfies ElementPatch,
      };
    });
    if (this.ctx.relationships) {
      for (const id of this.ids) {
        for (const conflict of detectAlignmentConflict(this.ctx.relationships, id, this.translation)) {
          this.err(
            "alignment-conflict",
            `move blocked: ${conflict.message}`,
            [id],
          );
        }
      }
    }
    return this.pending;
  }

  Commit(): { ok: boolean; applied: number; diagnostics: ModifyDiagnostic[] } {
    const result = super.Commit();
    if (!result.ok || !this.ctx.relationships) return result;
    let extra = 0;
    for (const id of this.ids) {
      const prop = propagateAfterCommit(
        this.ctx.relationships,
        id,
        this.translation,
        0,
      );
      for (const p of prop) {
        if (p.action === "moved-dependent" && p.newPosition) {
          if (this.ctx.store.apply(p.elementId, {
            position: p.newPosition,
            reason: "relationship-follow",
          })) {
            extra++;
          }
        }
      }
    }
    if (extra > 0) {
      this.info(
        "dependents-updated",
        `relationship propagation updated ${extra} dependent element(s)`,
        this.ids,
      );
    }
    return {
      ok: true,
      applied: result.applied + extra,
      diagnostics: this.GetDiagnostics(),
    };
  }

  GetRequiredReferences(): string[] {
    return ["move-base-point", "move-target-point"];
  }

  get currentTranslation(): [number, number] {
    return [...this.translation] as [number, number];
  }
}

// ── Rotate (2C.4) ────────────────────────────────────────────────────────

export function rotateAboutAxis(
  p: [number, number, number],
  axis: [number, number, number],
  theta: number,
): [number, number, number] {
  const l = Math.hypot(axis[0], axis[1], axis[2]);
  if (l < 1e-15) throw new Error("rotateAboutAxis: zero-length axis");
  const u: [number, number, number] = [axis[0] / l, axis[1] / l, axis[2] / l];
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const [x, y, z] = p;
  const [ux, uy, uz] = u;
  return [
    (c + (1 - c) * ux * ux) * x + ((1 - c) * ux * uy - uz * s) * y + ((1 - c) * ux * uz + uy * s) * z,
    ((1 - c) * uy * ux + uz * s) * x + (c + (1 - c) * uy * uy) * y + ((1 - c) * uy * uz - ux * s) * z,
    ((1 - c) * uz * ux - uy * s) * x + ((1 - c) * uz * uy + ux * s) * y + (c + (1 - c) * uz * uz) * z,
  ];
}

export class RotateCommand extends ModifyCommandBase {
  readonly name = "rotate";
  private angle = 0;
  private pivot: [number, number] = [0, 0];

  UpdatePreview(input: CommandInput): PendingChange[] {
    if (input.type === "rotation") {
      this.angle = input.angle;
      this.pivot = input.pivot;
    } else if (input.type === "rotation-two-point") {
      this.pivot = input.pivot;
      const a0 = Math.atan2(input.start[1] - input.pivot[1], input.start[0] - input.pivot[0]);
      const a1 = Math.atan2(input.end[1] - input.pivot[1], input.end[0] - input.pivot[0]);
      this.angle = a1 - a0;
    } else {
      throw new Error(`RotateCommand: input type '${input.type}' not accepted`);
    }
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    this.pending = this.ids.map((id) => {
      const el = this.ctx.store.get(id)!;
      const dx = el.position[0] - this.pivot[0];
      const dy = el.position[1] - this.pivot[1];
      const nx = this.pivot[0] + dx * c - dy * s;
      const ny = this.pivot[1] + dx * s + dy * c;
      const patch: ElementPatch = {
        position: [nx, ny],
        rotationZ: el.rotationZ + this.angle,
        reason: "rotate",
      };
      return { elementId: id, patch };
    });
    if (this.ctx.relationships) {
      for (const id of this.ids) {
        for (const conflict of detectAlignmentConflict(
          this.ctx.relationships,
          id,
          [Math.cos(this.angle), Math.sin(this.angle)],
        )) {
          this.warn(
            "rotation-near-constraint",
            `rotation may violate ${conflict.kind}: ${conflict.message}`,
            [id],
          );
        }
      }
    }
    return this.pending;
  }

  /**
   * Commit primary patches, then re-solve dependents via rigid-motion
   * evaluation (per-reference source transform about the pivot).
   */
  Commit(): { ok: boolean; applied: number; diagnostics: ModifyDiagnostic[] } {
    const result = super.Commit();
    if (!result.ok || !this.ctx.relationships) return result;
    let extra = 0;
    for (const id of this.ids) {
      const prop = propagateAfterRigidMotion(
        this.ctx.relationships,
        id,
        this.pivot,
        this.angle,
      );
      for (const p of prop) {
        if (p.action === "moved-dependent" && p.newPosition) {
          const dep = this.ctx.store.get(p.elementId);
          const patch: ElementPatch = {
            position: p.newPosition,
            reason: "relationship-follow-rotate",
          };
          if (dep && Number.isFinite(dep.rotationZ)) {
            patch.rotationZ = dep.rotationZ + this.angle;
          }
          if (this.ctx.store.apply(p.elementId, patch)) {
            extra++;
          }
        }
      }
    }
    if (extra > 0) {
      this.info(
        "dependents-updated",
        `rotation propagation updated ${extra} dependent element(s)`,
        this.ids,
      );
    }
    return {
      ok: true,
      applied: result.applied + extra,
      diagnostics: this.GetDiagnostics(),
    };
  }

  GetRequiredReferences(): string[] {
    return ["rotation-pivot", "rotation-angle-or-ray"];
  }
}

// ── Align (2C.5) ─────────────────────────────────────────────────────────

export interface AlignReferences {
  source: { elementId: string; position: [number, number] };
  target: { elementId: string; position: [number, number] };
  lock?: boolean;
}

export class AlignCommand extends ModifyCommandBase {
  readonly name = "align";
  private translation: [number, number] = [0, 0];
  private refs: AlignReferences | null = null;

  UpdatePreview(input: CommandInput): PendingChange[] {
    void input;
    if (!this.refs) throw new Error("AlignCommand: call setReferences first");
    this.translation = [
      this.refs.target.position[0] - this.refs.source.position[0],
      this.refs.target.position[1] - this.refs.source.position[1],
    ];
    const el = this.ctx.store.get(this.refs.source.elementId);
    if (!el) {
      this.err("element-missing", `element '${this.refs.source.elementId}' not found`);
      return [];
    }
    this.pending = [
      {
        elementId: this.refs.source.elementId,
        patch: {
          position: [el.position[0] + this.translation[0], el.position[1] + this.translation[1]],
          reason: "align",
        },
      },
    ];
    return this.pending;
  }

  setReferences(refs: AlignReferences): void {
    this.refs = refs;
  }

  Commit(): { ok: boolean; applied: number; diagnostics: ModifyDiagnostic[] } {
    const result = super.Commit();
    if (result.ok && this.refs?.lock && this.ctx.relationships) {
      const src: GeometricReference = {
        elementId: this.refs.source.elementId,
        kind: "endpoint",
        position: [this.refs.source.position[0], this.refs.source.position[1], 0],
      };
      const tgt: GeometricReference = {
        elementId: this.refs.target.elementId,
        kind: "endpoint",
        position: [this.refs.target.position[0], this.refs.target.position[1], 0],
      };
      this.ctx.relationships.createRelationship({
        type: "persistent-alignment",
        source: src,
        target: tgt,
        constraint: { kind: "coincident" },
        reconnection: "follow-source",
        origin: "user-defined",
      });
      this.info("alignment-locked", "persistent alignment created", [this.refs.source.elementId, this.refs.target.elementId]);
    }
    return result;
  }

  GetRequiredReferences(): string[] {
    return ["align-source", "align-target"];
  }

  get currentTranslation(): [number, number] {
    return [...this.translation] as [number, number];
  }
}

/** Registry propagation helper: pure translation (optional rotation about origin of offsets). */
export function propagateAfterCommit(
  registry: RelationshipRegistry,
  changedElementId: string,
  translation: [number, number],
  rotationZ = 0,
  newVersion?: number,
): Array<{ elementId: string; newPosition: [number, number] | null; action: string }> {
  const v = newVersion ?? registry.geometryVersion(changedElementId) + 1;
  registry.setGeometryVersion(changedElementId, v);
  const results = registry.evaluateRelationshipAfterGeometryChange({
    elementId: changedElementId,
    newVersion: v,
    translation: [translation[0], translation[1], 0],
    rotationZ,
  });
  return results.map((r) => ({
    elementId: r.elementId,
    newPosition: r.newPosition ? [r.newPosition[0], r.newPosition[1]] : null,
    action: r.action,
  }));
}

/** Rigid-body plan rotation about a pivot — preferred path for RotateCommand. */
export function propagateAfterRigidMotion(
  registry: RelationshipRegistry,
  changedElementId: string,
  pivot: [number, number],
  angle: number,
  newVersion?: number,
): Array<{ elementId: string; newPosition: [number, number] | null; action: string }> {
  const v = newVersion ?? registry.geometryVersion(changedElementId) + 1;
  registry.setGeometryVersion(changedElementId, v);
  const results = registry.evaluateAfterRigidMotion({
    elementId: changedElementId,
    newVersion: v,
    pivot,
    angle,
  });
  return results.map((r) => ({
    elementId: r.elementId,
    newPosition: r.newPosition ? [r.newPosition[0], r.newPosition[1]] : null,
    action: r.action,
  }));
}

export type { ModifyContext, PendingChange, ElementPatch } from "./command";
