/**
 * Alignment and temporary constraints (MASTER PROMPT MODULE 2B.4).
 *
 * Residuals (spec formulas):
 *   parallel directions:        u × v ≈ 0
 *   point P on line (Q, u):     r = (P − Q) − [(P − Q)·u]·u   (2D: 1 eq.)
 *   point P on plane (Q, n):    r = (P − Q)·n
 *
 * Alignment may be one-time (a transform is applied, no record kept) or
 * persistent (a constraint is stored and re-enforced). Locked alignments
 * that conflict with a move produce diagnostics, never silent breakage
 * (spec 2B.4 "conflict detection, lock/unlock").
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { RelationshipRecord, RelationshipRegistry, GeometricReference } from "../relationships";

export interface LineRef {
  kind: "line";
  point: [number, number];
  /** Unit direction. */
  dir: [number, number];
}

export interface PlaneRef {
  kind: "plane-x" | "plane-y";
  /** Coordinate value of the plane (x = const or y = const). */
  value: number;
}

export type AlignmentReference = LineRef | PlaneRef;

/** AcquireAlignmentReference: normalise raw picks into references. */
export function acquireAlignmentReference(args: {
  kind: "line" | "plane-x" | "plane-y";
  point?: [number, number];
  dir?: [number, number];
  value?: number;
  elementId: string;
  name?: string;
}): AlignmentReference & { elementId: string; name?: string } {
  if (args.kind === "line") {
    if (!args.point || !args.dir) throw new Error("line alignment reference needs point and dir");
    const l = Math.hypot(args.dir[0], args.dir[1]);
    if (l < 1e-12) throw new Error("zero-length alignment direction");
    return {
      kind: "line",
      point: args.point,
      dir: [args.dir[0] / l, args.dir[1] / l],
      elementId: args.elementId,
      name: args.name,
    };
  }
  if (args.value === undefined) throw new Error(`${args.kind} alignment reference needs a value`);
  return { kind: args.kind, value: args.value, elementId: args.elementId, name: args.name };
}

/** ComputeAlignmentResidual (spec formulas above). */
export function computeAlignmentResidual(
  point: [number, number],
  ref: AlignmentReference,
): { residual: [number, number]; magnitude: number } {
  if (ref.kind === "line") {
    const px = point[0] - ref.point[0];
    const py = point[1] - ref.point[1];
    const along = px * ref.dir[0] + py * ref.dir[1];
    // r = (P−Q) − [(P−Q)·u]·u
    const rx = px - along * ref.dir[0];
    const ry = py - along * ref.dir[1];
    return { residual: [rx, ry], magnitude: Math.hypot(rx, ry) };
  }
  if (ref.kind === "plane-x") {
    const r = point[0] - ref.value;
    return { residual: [r, 0], magnitude: Math.abs(r) };
  }
  const r = point[1] - ref.value;
  return { residual: [0, r], magnitude: Math.abs(r) };
}

/** CreateAlignmentPreview: where the element would move to align. */
export function createAlignmentPreview(
  points: Array<[number, number]>,
  ref: AlignmentReference,
): { moves: Array<{ from: [number, number]; to: [number, number] }>; maxResidual: number } {
  const moves: Array<{ from: [number, number]; to: [number, number] }>[] = [];
  void moves;
  const out: Array<{ from: [number, number]; to: [number, number] }> = [];
  let maxResidual = 0;
  for (const p of points) {
    const { residual, magnitude } = computeAlignmentResidual(p, ref);
    maxResidual = Math.max(maxResidual, magnitude);
    out.push({ from: p, to: [p[0] - residual[0], p[1] - residual[1]] });
  }
  return { moves: out, maxResidual };
}

/** Alignment tolerance (metres) — separate from screen snap tolerance. */
export const ALIGNMENT_TOL = 1e-6;

/** ValidateAlignmentConstraint: residual within geometric tolerance. */
export function validateAlignmentConstraint(
  points: Array<[number, number]>,
  ref: AlignmentReference,
  tol = ALIGNMENT_TOL,
): { valid: boolean; maxResidual: number } {
  let maxResidual = 0;
  for (const p of points) {
    maxResidual = Math.max(maxResidual, computeAlignmentResidual(p, ref).magnitude);
  }
  return { valid: maxResidual <= tol, maxResidual };
}

/** CommitAlignmentConstraint: persist when `lock` is requested. */
export function commitAlignmentConstraint(args: {
  registry: RelationshipRegistry;
  source: GeometricReference;
  target: GeometricReference;
  lock: boolean;
  kind: "coincident" | "locked-distance";
  value?: number;
}): RelationshipRecord | null {
  if (!args.lock) return null; // one-time alignment: no record
  return args.registry.createRelationship({
    type: "persistent-alignment",
    source: args.source,
    target: args.target,
    constraint: { kind: args.kind, value: args.value },
    reconnection: "follow-source",
    origin: "user-defined",
  });
}

export interface AlignmentConflict {
  relationshipId: string;
  kind: "locked-distance-violated" | "coincident-violated" | "cross-constraint";
  message: string;
  allowedMove: [number, number] | null;
}

/**
 * DetectAlignmentConflict: would the proposed move violate a locked
 * alignment? Returns the violating records with the maximum move that
 * WOULD be allowed (projected onto the permitted direction).
 */
export function detectAlignmentConflict(
  registry: RelationshipRegistry,
  movedElementId: string,
  proposedTranslation: [number, number],
): AlignmentConflict[] {
  const out: AlignmentConflict[] = [];
  const recs = registry.queryRelationships({ elementId: movedElementId, validOnly: true });
  for (const rec of recs) {
    if (rec.type !== "persistent-alignment" || !rec.constraint) continue;
    const isSource = rec.source.elementId === movedElementId;
    const refPos: [number, number] = isSource ? rec.target.position.slice(0, 2) as [number, number] : rec.source.position.slice(0, 2) as [number, number];
    void refPos;
    if (rec.constraint.kind === "coincident") {
      // Any translation that separates the two references violates the lock.
      const otherPos: [number, number] = isSource
        ? rec.target.position.slice(0, 2) as [number, number]
        : rec.source.position.slice(0, 2) as [number, number];
      const movedPos = (isSource ? rec.source.position.slice(0, 2) : rec.target.position.slice(0, 2)) as [number, number];
      const newDist = Math.hypot(
        movedPos[0] + proposedTranslation[0] - otherPos[0],
        movedPos[1] + proposedTranslation[1] - otherPos[1],
      );
      if (newDist > ALIGNMENT_TOL) {
        out.push({
          relationshipId: rec.id,
          kind: "coincident-violated",
          message: `locked coincidence with element '${otherPos === rec.source.position.slice(0, 2) ? rec.source.elementId : rec.target.elementId}' would break (new distance ${newDist.toFixed(6)} m)`,
          allowedMove: [0, 0],
        });
      }
    } else if (rec.constraint.kind === "locked-distance" && rec.constraint.value !== undefined) {
      const otherPos: [number, number] = isSource
        ? rec.target.position.slice(0, 2) as [number, number]
        : rec.source.position.slice(0, 2) as [number, number];
      const movedPos = (isSource ? rec.source.position.slice(0, 2) : rec.target.position.slice(0, 2)) as [number, number];
      const dx = movedPos[0] + proposedTranslation[0] - otherPos[0];
      const dy = movedPos[1] + proposedTranslation[1] - otherPos[1];
      const newDist = Math.hypot(dx, dy);
      if (Math.abs(newDist - rec.constraint.value) > ALIGNMENT_TOL) {
        // Exact allowed move along the PROPOSED direction: the second
        // intersection of the proposed ray with the locked-distance circle
        // |P − anchor| = value.  P + t·u keeps |·| = value iff
        //   |P + t·u|² = v²  →  t = 0 or t = −2·(r·u)/(u·u),  r = P − anchor
        const rx = movedPos[0] - otherPos[0];
        const ry = movedPos[1] - otherPos[1];
        const uu = proposedTranslation[0] * proposedTranslation[0] + proposedTranslation[1] * proposedTranslation[1];
        let allowedMove: [number, number] | null = [0, 0];
        if (uu > 1e-18) {
          const tStar = (-2 * (rx * proposedTranslation[0] + ry * proposedTranslation[1])) / uu;
          allowedMove = [proposedTranslation[0] * tStar, proposedTranslation[1] * tStar];
        }
        out.push({
          relationshipId: rec.id,
          kind: "locked-distance-violated",
          message: `locked distance ${rec.constraint.value.toFixed(4)} m would become ${newDist.toFixed(4)} m`,
          allowedMove,
        });
      }
    }
  }
  return out;
}

/** UpdateAlignedElements: apply the alignment transform to all points. */
export function updateAlignedElements(
  points: Array<[number, number]>,
  ref: AlignmentReference,
): Array<[number, number]> {
  return points.map((p) => {
    const { residual } = computeAlignmentResidual(p, ref);
    return [p[0] - residual[0], p[1] - residual[1]] as [number, number];
  });
}

/** RemoveAlignmentConstraint. */
export function removeAlignmentConstraint(
  registry: RelationshipRegistry,
  relationshipId: string,
): boolean {
  return registry.breakRelationship(relationshipId, true);
}
