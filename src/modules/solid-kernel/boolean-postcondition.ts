/**
 * One Boolean post-condition for all three Boolean engines (K4).
 *
 * Root cause (ENGINE_UPGRADE_PLAN.md §3, K4): Boolean results were never
 * validated, and the live path silently kept uncut solids. The convex
 * kernel and the general kernel threw on empty results but never
 * validated output; the third engine (`three-csg-ts`, wall opening /
 * door / reveal cuts in authoring.ts) was wrapped in `try/catch {
 * console.warn }` — on failure the UNCUT mesh was kept and displayed
 * as if the opening exists.
 *
 * Every Boolean result from every engine now passes through the single
 * helper in this module:
 *
 *   - `applyBooleanPostcondition` — the post-condition itself: weld +
 *     validate via K1's gate (`gateSolid`), a typed verdict
 *     (`ok` / `quarantined` / `refused`), diagnostics recorded. The
 *     convex kernel (`booleanOp`) and the general kernel
 *     (`generalBoolean`) both route their returns through it, with
 *     their K1-calibrated refusal policies preserved exactly
 *     (convex: quarantine-on-refusal — its splitter is seam-inconsistent
 *     on every overlapping operation, hard refusal would stop all void
 *     cutting; general: throw, except degenerate-input results which
 *     quarantine per the PE-10 contract). The K1 quarantine class
 *     (non-manifold junction / contact with finite positive volume)
 *     stays the `quarantined` verdict here — it is recorded, never
 *     silently whitelisted, and never hard-refused.
 *   - `postconditionThreeCsgResult` — the three-csg-ts leg: a
 *     three-csg-ts result (or its throw) is gated the same way, and a
 *     gated refusal — or a result that removed no material — falls back
 *     to the general kernel on the same operands. The fallback is
 *     attempted only where it is sound: same operands, same frame, and
 *     its result must itself gate `ok`/`quarantined` AND remove
 *     material. A three-csg-ts result that gates `ok` is kept as-is
 *     (no fallback round-trip). NOTHING in this module ever returns an
 *     uncut solid as a success: if both engines fail, the outcome is
 *     `failed` with diagnostics — the caller must quarantine the
 *     element and surface the failure to the user.
 *
 * Measured while building this (real three + three-csg-ts + real
 * kernels, Node probe on the chain base — see
 * tests/boolean-postcondition.test.cjs, which re-pins every number):
 *
 *   - A straight wall (4 m × 0.2 m × 3 m, ExtrudeGeometry, as built by
 *     `buildWallWithOpenings`) gates `ok`, volume exactly 2.4 m³.
 *   - A three-csg-ts door cut (0.9 m × 2.1 m through-hole) is
 *     volume-exact (2.022 m³ = 2.4 − 0.9·0.2·2.1) but gates REFUSED:
 *     ~50 non-manifold edges used exactly once (open-shell class) —
 *     three-csg-ts output is T-junction-ridden at the cut seams, the
 *     same defect class as the convex kernel's splitter. Hard refusal
 *     would fail every door/window cut, so the refused result falls
 *     back to the general kernel instead.
 *   - The general-kernel fallback on the same operands gates `ok`
 *     with the IDENTICAL volume (2.022 m³) — the fallback is sound and
 *     produces a strictly better (manifold) mesh.
 *   - A position-only cutter geometry (exactly what
 *     `generateRevealCutter` produces — positions, no normals, no
 *     index) makes `CSG.fromMesh` THROW
 *     (`Cannot read properties of undefined (reading 'array')`) —
 *     every reveal cut in production threw and was swallowed by
 *     `catch { console.warn }`, so reveals never cut. The fallback
 *     (positions only, no normals needed) cuts them.
 *   - An open operand makes the general-kernel fallback throw
 *     `ValidationGateError` — the deterministic total-failure case:
 *     both engines fail, the outcome is `failed`, never an uncut mesh
 *     presented as cut.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 * (Import cycle note: this module imports `generalBoolean` from
 * ./general-csg, and ./csg + ./general-csg import this module back for
 * their post-conditions. The cycle is call-time only — every cyclic
 * binding is used inside a function body, never at module top level —
 * the same pattern K1's validation-gate already relies on with
 * ./general-csg, so it resolves in both ESM and CommonJS.)
 */

import { meshVolume, type IndexedMesh } from "../adaptive";
import { generalBoolean } from "./general-csg";
import type { GeometryDiagnostic, GeometryErrorCode } from "./validate";
import {
  gateSolid,
  listQuarantinedSolids,
  recordQuarantinedSolid,
  ValidationGateError,
  type GateResult,
  type GateVerdict,
} from "./validation-gate";

/** Which Boolean engine produced a result. */
export type BooleanEngine = "convex-kernel" | "general-kernel" | "three-csg-ts";

/**
 * Minimum removed volume (m³) for a subtract to count as a cut.
 * A through-opening removes orders of magnitude more than this (the
 * smallest opening `openingsForWall` admits is 0.02 m × 0.02 m through
 * a ≥0.01 m wall ≈ 4e-9 m³); 1e-9 m³ sits safely above float64 volume
 * noise at these magnitudes (~1e-12) and far below any real cut.
 */
export const MIN_REMOVED_VOLUME_M3 = 1e-9;

export interface BooleanPostconditionOptions {
  engine: BooleanEngine;
  /**
   * What to do with a `refused` verdict. Default `'throw'`
   * (`ValidationGateError`). `'quarantine'` records the refusal as
   * quarantined (admitted: true) and returns the mesh — the K1
   * calibration for the convex kernel only.
   */
  onRefused?: "throw" | "quarantine";
  /** Registry id for the quarantine record; defaults to `owner`. */
  id?: string;
}

export interface BooleanPostconditionResult extends GateResult {
  engine: BooleanEngine;
}

/**
 * THE unified Boolean post-condition: weld + validate via K1's gate,
 * typed verdict, diagnostics recorded. Returns the full gate result
 * (with `engine` attached) on `ok` / `quarantined`; throws
 * `ValidationGateError` on `refused` unless `onRefused` is
 * `'quarantine'`, in which case the refusal is recorded as quarantined
 * (admitted) and the result is returned — the same verdict handling
 * `assertCommitEligible` performs, extended with the engine tag so
 * every engine's outcome carries the same shape.
 */
export function applyBooleanPostcondition(
  mesh: IndexedMesh,
  owner = "solid",
  opts: BooleanPostconditionOptions,
): BooleanPostconditionResult {
  const result = gateSolid(mesh, owner, { source: opts.engine, id: opts.id });
  if (result.verdict === "refused") {
    if (opts.onRefused === "quarantine") {
      recordQuarantinedSolid({
        id: opts.id ?? owner,
        owner,
        source: opts.engine,
        disposition: "quarantined",
        admitted: true,
        diagnostics: result.errors.map((d) => ({ code: d.code, message: d.message })),
        volume: result.volume,
      });
      return { ...result, engine: opts.engine };
    }
    throw new ValidationGateError(owner, result.diagnostics);
  }
  return { ...result, engine: opts.engine };
}

// ── three-csg-ts leg + general-kernel fallback ───────────────────────────

export interface ThreeCsgPostconditionInput {
  /** Pre-cut wall/solid, same frame as `result` and `cutter`. */
  wallBefore: IndexedMesh;
  /** Hole/cutter solid, same frame as `wallBefore`. */
  cutter: IndexedMesh;
  /**
   * The three-csg-ts output converted to an IndexedMesh, or `null`
   * when three-csg-ts threw (pass the error in `threeCsgError`).
   */
  result: IndexedMesh | null;
  /** The three-csg-ts error message, when `result` is `null`. */
  threeCsgError?: string | null;
  /** Owner label for diagnostics, e.g. `wall:<id> door <hostId>`. */
  owner: string;
}

export type ThreeCsgPostconditionOutcome =
  | {
      status: "cut";
      /** The gated mesh to commit (three-csg-ts result or fallback). */
      mesh: IndexedMesh;
      engine: BooleanEngine;
      verdict: GateVerdict;
      volume: number;
      volumeBefore: number;
      fallbackUsed: boolean;
      diagnostics: GeometryDiagnostic[];
    }
  | {
      status: "failed";
      reason: string;
      diagnostics: GeometryDiagnostic[];
      volumeBefore: number;
      lastEngine: BooleanEngine;
    };

function removedVolume(volumeBefore: number, volumeAfter: number): number {
  // Inverted winding is only a warning in validate.ts, so volumes are
  // compared by magnitude: a cut removes |volume| either way.
  return Math.abs(volumeBefore) - Math.abs(volumeAfter);
}

function shortError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Post-condition for one three-csg-ts subtraction, with the
 * general-kernel fallback. Never returns the uncut solid as a success:
 * a result counts as a cut only if it gates `ok`/`quarantined` AND
 * removes material (`MIN_REMOVED_VOLUME_M3`); otherwise the general
 * kernel is tried on the same operands, and if that also fails the
 * outcome is `failed` — the caller must quarantine the element and
 * surface the failure to the user, never display the wall as cut.
 */
export function postconditionThreeCsgResult(
  input: ThreeCsgPostconditionInput,
): ThreeCsgPostconditionOutcome {
  const volumeBefore = meshVolume(input.wallBefore);
  const owner = input.owner;

  // ── Leg 1: the three-csg-ts result, gated like every other engine.
  if (input.result !== null) {
    try {
      const gated = applyBooleanPostcondition(input.result, owner, {
        engine: "three-csg-ts",
        onRefused: "throw",
      });
      if (removedVolume(volumeBefore, gated.volume) > MIN_REMOVED_VOLUME_M3) {
        return {
          status: "cut",
          mesh: gated.mesh,
          engine: "three-csg-ts",
          verdict: gated.verdict,
          volume: gated.volume,
          volumeBefore,
          fallbackUsed: false,
          diagnostics: gated.diagnostics,
        };
      }
      // Volume-exact but uncut: three-csg-ts returned the wall
      // unchanged (e.g. a cutter that missed). That is a failed cut,
      // not a success — fall through to the general kernel.
      return fallbackToGeneral(input, volumeBefore, [
        {
          code: "invalid-boolean",
          severity: "error",
          message: `${owner}: three-csg-ts returned the uncut solid (no material removed)`,
          affected: [owner],
          recoveryAction: "Rebuild the opening from its hosted element parameters.",
          commitEligible: false,
        },
      ]);
    } catch (err) {
      // Gate refusal (or a converter failure upstream): fall through
      // to the general kernel with the gate diagnostics on record.
      const diagnostics =
        err instanceof ValidationGateError
          ? err.diagnostics
          : [
              {
                code: "invalid-boolean" as const,
                severity: "error" as const,
                message: `${owner}: three-csg-ts result failed the post-condition: ${shortError(err)}`,
                affected: [owner],
                recoveryAction: "Rebuild the opening from its hosted element parameters.",
                commitEligible: false,
              },
            ];
      return fallbackToGeneral(input, volumeBefore, diagnostics);
    }
  }

  // three-csg-ts threw outright (e.g. the position-only reveal
  // cutter: `CSG.fromMesh` reads a missing normal attribute).
  return fallbackToGeneral(input, volumeBefore, [
    {
      code: "invalid-boolean",
      severity: "error",
      message: `${owner}: three-csg-ts threw: ${input.threeCsgError ?? "unknown error"}`,
      affected: [owner],
      recoveryAction: "Rebuild the opening from its hosted element parameters.",
      commitEligible: false,
    },
  ]);
}

function fallbackToGeneral(
  input: ThreeCsgPostconditionInput,
  volumeBefore: number,
  threeCsgDiagnostics: GeometryDiagnostic[],
): ThreeCsgPostconditionOutcome {
  const owner = input.owner;
  let mesh: IndexedMesh;
  try {
    // generalBoolean gates its own result through this same
    // post-condition (applyBooleanPostcondition, engine
    // 'general-kernel', throw on refusal).
    mesh = generalBoolean("subtract", input.wallBefore, input.cutter);
  } catch (err) {
    const diagnostics =
      err instanceof ValidationGateError
        ? [...threeCsgDiagnostics, ...err.diagnostics]
        : [
            ...threeCsgDiagnostics,
            {
              code: "invalid-boolean" as const,
              severity: "error" as const,
              message: `${owner}: general-kernel fallback threw: ${shortError(err)}`,
              affected: [owner],
              recoveryAction: "Rebuild the opening from its hosted element parameters.",
              commitEligible: false,
            },
          ];
    return {
      status: "failed",
      reason:
        `opening cut failed on both engines — three-csg-ts: ${threeCsgDiagnostics[0]?.message ?? "failed"}; ` +
        `general-kernel fallback: ${err instanceof ValidationGateError ? `validation gate refused (${err.diagnostics.map((d) => d.code).join(", ")})` : shortError(err)}`,
      diagnostics,
      volumeBefore,
      lastEngine: "general-kernel",
    };
  }
  const volumeAfter = meshVolume(mesh);
  if (removedVolume(volumeBefore, volumeAfter) <= MIN_REMOVED_VOLUME_M3) {
    return {
      status: "failed",
      reason:
        `opening cut failed on both engines — three-csg-ts: ${threeCsgDiagnostics[0]?.message ?? "failed"}; ` +
        `general-kernel fallback returned the uncut solid (no material removed)`,
      diagnostics: [
        ...threeCsgDiagnostics,
        {
          code: "invalid-boolean",
          severity: "error",
          message: `${owner}: general-kernel fallback returned the uncut solid (no material removed)`,
          affected: [owner],
          recoveryAction: "Rebuild the opening from its hosted element parameters.",
          commitEligible: false,
        },
      ],
      volumeBefore,
      lastEngine: "general-kernel",
    };
  }
  // The fallback mesh is already gated inside generalBoolean; re-read
  // its verdict via the gate for the outcome shape (welding is
  // idempotent, so this does not change the mesh) — without recording
  // again, so a quarantined fallback is recorded exactly once, by the
  // gate inside generalBoolean.
  const gated = gateSolid(mesh, owner, { source: "general-kernel", recordQuarantine: false });
  return {
    status: "cut",
    mesh: gated.mesh,
    engine: "general-kernel",
    verdict: gated.verdict,
    volume: gated.volume,
    volumeBefore,
    fallbackUsed: true,
    diagnostics: [...threeCsgDiagnostics, ...gated.diagnostics],
  };
}

// ── FAILED-TO-CUT registry record ────────────────────────────────────────

/**
 * Record a failed Boolean cut for one element + opening in K1's
 * quarantine registry, so the failure is visible via
 * `listQuarantinedSolids()` and the solids debug API instead of
 * vanishing into a `console.warn`. The record id is
 * `${elementId}:cut:${label}` (distinct from the element id, so K1's
 * rebuild gate — which clears an element's record when its mesh
 * validates clean again — cannot erase a cut failure: the uncut wall
 * IS a valid solid, the missing opening is the defect). Disposition
 * `quarantined`, `admitted: true`: the wall element stays in the model
 * (uncut), flagged FAILED-TO-CUT. Returns false when a record for this
 * element + opening already exists (the caller then skips the repeat
 * toast — a rebuild re-attempts the cut and must not re-toast every
 * time).
 */
export function recordBooleanCutFailure(args: {
  elementId: string;
  label: string;
  diagnostics: Array<{ code: GeometryErrorCode; message: string }>;
  volumeBefore: number;
  source?: string;
}): boolean {
  const id = `${args.elementId}:cut:${args.label}`;
  const already = listQuarantinedSolids().some((q) => q.id === id);
  recordQuarantinedSolid({
    id,
    owner: args.elementId,
    source: args.source ?? "wall-cut",
    disposition: "quarantined",
    admitted: true,
    diagnostics: args.diagnostics,
    volume: args.volumeBefore,
  });
  return !already;
}
