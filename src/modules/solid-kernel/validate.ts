/**
 * Geometry validation diagnostics (MASTER PROMPT MODULE 2.12).
 *
 * Reusable across the engine: profiles, B-Rep solids, boolean results,
 * hosts and references. Every diagnostic carries a severity, a stable
 * error code, affected identifiers, a concrete recovery action, and a
 * commit-eligibility verdict (spec 2.12). Validation NEVER silently
 * repairs — recovery actions are returned for the caller to apply.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import type { IndexedMesh, ProfilePt } from "../adaptive";
import { meshVolume } from "../adaptive";
import { selfIntersects, signedArea, validateProfile } from "./forms";
import { buildEdges, COINCIDENT_TOL, type BRepSolid } from "./brep";

export type Severity = "info" | "warning" | "error";

export type GeometryErrorCode =
  | "open-profile"
  | "self-intersection"
  | "zero-length-edge"
  | "degenerate-face"
  | "invalid-shell"
  | "non-manifold-edge"
  | "inverted-volume"
  | "invalid-boolean"
  | "missing-reference"
  | "unresolved-host"
  | "unsolvable-constraint"
  | "invalid-formula";

export interface GeometryDiagnostic {
  code: GeometryErrorCode;
  severity: Severity;
  message: string;
  /** Element / face / edge identifiers affected. */
  affected: string[];
  /** Concrete recovery the caller can apply (spec 2.12). */
  recoveryAction: string;
  /**
   * Whether the model may be committed with this diagnostic present
   * (spec 2.12 "commit eligibility"): errors block, warnings do not.
   */
  commitEligible: boolean;
}

function diag(
  code: GeometryErrorCode,
  severity: Severity,
  message: string,
  affected: string[],
  recoveryAction: string,
): GeometryDiagnostic {
  return {
    code, severity, message, affected, recoveryAction,
    commitEligible: severity !== "error",
  };
}

/** Validate a 2D profile (open / degenerate / self-intersecting). */
export function validateProfileDiagnostics(profile: ProfilePt[], owner = "profile"): GeometryDiagnostic[] {
  const out: GeometryDiagnostic[] = [];
  if (profile.length >= 2) {
    const a = profile[0];
    const b = profile[profile.length - 1];
    const closed = Math.abs(a.u - b.u) <= COINCIDENT_TOL && Math.abs(a.v - b.v) <= COINCIDENT_TOL;
    if (!closed) {
      out.push(diag(
        "open-profile", "error",
        `${owner} is not closed (first and last points differ by more than ${COINCIDENT_TOL} m)`,
        [owner],
        "Close the profile by joining its endpoints before using it for a solid.",
      ));
    }
  }
  if (out.length === 0) {
    try {
      validateProfile(profile);
    } catch (err) {
      const code = (err as { code?: GeometryErrorCode }).code ?? "degenerate-face";
      out.push(diag(
        code === "self-intersection" ? "self-intersection" : "invalid-shell",
        "error",
        `${owner}: ${(err as Error).message}`,
        [owner],
        "Fix the profile geometry (remove crossings / duplicate points).",
      ));
    }
  }
  return out;
}

/** Validate a closed indexed mesh (faces, edges, manifoldness, volume). */
export function validateMeshDiagnostics(mesh: IndexedMesh, owner = "solid"): GeometryDiagnostic[] {
  const out: GeometryDiagnostic[] = [];
  // Degenerate faces + zero-length edges.
  for (let i = 0; i < mesh.faces.length; i++) {
    const [a, b, c] = mesh.faces[i];
    if (a === b || b === c || a === c) {
      out.push(diag("degenerate-face", "error", `${owner} face ${i} repeats a vertex`, [`${owner}:f${i}`], "Delete the degenerate face and rebuild the solid."));
      continue;
    }
    const va = mesh.vertices[a], vb = mesh.vertices[b], vc = mesh.vertices[c];
    if (!va || !vb || !vc) {
      out.push(diag("invalid-shell", "error", `${owner} face ${i} references missing vertices`, [`${owner}:f${i}`], "Rebuild the mesh from its parametric definition."));
      continue;
    }
    for (const [p, q] of [[va, vb], [vb, vc], [vc, va]] as const) {
      const l = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      if (l <= COINCIDENT_TOL) {
        out.push(diag("zero-length-edge", "error", `${owner} face ${i} has a zero-length edge (${l.toExponential(2)} m)`, [`${owner}:f${i}`], "Weld coincident vertices, then revalidate."));
        break;
      }
    }
  }
  // Manifold check on edge use counts.
  const use = new Map<string, { n: number; dir: number }>();
  for (let i = 0; i < mesh.faces.length; i++) {
    const [a, b, c] = mesh.faces[i];
    for (const [u, v] of [[a, b], [b, c], [c, a]] as const) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      const rec = use.get(key) ?? { n: 0, dir: 0 };
      rec.n++;
      rec.dir += u < v ? 1 : -1;
      use.set(key, rec);
    }
  }
  for (const [key, rec] of use) {
    if (rec.n !== 2) {
      out.push(diag(
        "non-manifold-edge", "error",
        `${owner} edge ${key} is used ${rec.n} times (manifold boundary requires exactly 2)`,
        [`${owner}:e${key}`],
        rec.n === 1 ? "Boundary edge: close the solid (missing face) or delete the fragment." : "Resolve the non-manifold junction before committing.",
      ));
    } else if (rec.dir !== 0) {
      out.push(diag(
        "invalid-shell", "warning",
        `${owner} edge ${key} has inconsistent winding (both uses in the same direction)`,
        [`${owner}:e${key}`],
        "Flip the affected face(s) so the shell has consistent outward orientation.",
      ));
    }
  }
  // Volume sanity (divergence theorem): NaN or inverted volume.
  if (out.length === 0) {
    const v = meshVolume(mesh);
    if (!Number.isFinite(v)) {
      out.push(diag("invalid-boolean", "error", `${owner} volume is not a finite number`, [owner], "Recompute the solid from its parametric definition."));
    } else if (v <= 0) {
      out.push(diag("inverted-volume", "warning", `${owner} volume is ${v.toFixed(6)} m³ (non-positive)`, [owner], "Reverse face winding so the shell is outward-oriented."));
    }
  }
  return out;
}

/** Validate a B-Rep solid's structural invariants (uses brep.buildEdges). */
export function validateSolidDiagnostics(solid: BRepSolid, owner?: string): GeometryDiagnostic[] {
  const label = owner ?? solid.id;
  buildEdges(solid);
  const out: GeometryDiagnostic[] = [];
  for (const [key, edge] of solid.edges) {
    if (edge.useCount !== 2) {
      out.push(diag(
        "non-manifold-edge", "error",
        `${label} edge ${key} used ${edge.useCount} times`,
        [`${label}:e${key}`],
        "Rebuild the shell boundary so every edge is shared by exactly two loops.",
      ));
    }
  }
  return out;
}

export interface HostRefContext {
  /** Host element ids referenced by the element. */
  hostId: string | null;
  /** Whether the host element exists in the document. */
  hostExists: boolean;
  /** Named family references the element expects. */
  requiredReferences?: string[];
  /** References actually resolvable. */
  availableReferences?: string[];
}

/** Reference/host diagnostics (spec 2.10/2.12: fragile references). */
export function validateReferenceDiagnostics(ctx: HostRefContext): GeometryDiagnostic[] {
  const out: GeometryDiagnostic[] = [];
  if (ctx.hostId && !ctx.hostExists) {
    out.push(diag(
      "unresolved-host", "error",
      `Host element '${ctx.hostId}' no longer exists`,
      [ctx.hostId],
      "Re-host the element, delete it, or restore the host via undo.",
    ));
  }
  if (ctx.requiredReferences && ctx.availableReferences) {
    const have = new Set(ctx.availableReferences);
    for (const ref of ctx.requiredReferences) {
      if (!have.has(ref)) {
        out.push(diag(
          "missing-reference", "error",
          `Required reference '${ref}' cannot be resolved`,
          [ref],
          "Re-select the reference, or let reference recovery map it by geometric signature.",
        ));
      }
    }
  }
  return out;
}

/** Constraint/formula outcome diagnostics (bridges to solver/param engine). */
export function validateAnalysisDiagnostics(args: {
  solverStatus?: "converged" | "unconverged" | "over-constrained";
  formulaProblems?: Array<{ parameter: string; message: string }>;
  owner?: string;
}): GeometryDiagnostic[] {
  const out: GeometryDiagnostic[] = [];
  const owner = args.owner ?? "element";
  if (args.solverStatus === "over-constrained") {
    out.push(diag(
      "unsolvable-constraint", "error",
      `${owner}: constraint system is over-constrained (negative degrees of freedom)`,
      [owner],
      "Remove one conflicting constraint, or prioritise constraints so the solver can relax the least important one.",
    ));
  } else if (args.solverStatus === "unconverged") {
    out.push(diag(
      "unsolvable-constraint", "warning",
      `${owner}: constraint solver did not converge; last valid state preserved`,
      [owner],
      "Reduce the edit size (move toward the target in steps) or relax constraints.",
    ));
  }
  for (const p of args.formulaProblems ?? []) {
    out.push(diag(
      "invalid-formula", "error",
      `${owner}: formula for '${p.parameter}' failed — ${p.message}`,
      [p.parameter],
      "Fix the formula, or clear it to make the parameter a plain value.",
    ));
  }
  return out;
}

/** Commit gate (spec 2.12): errors block commit; warnings do not. */
export function commitEligible(diags: GeometryDiagnostic[]): boolean {
  return diags.every((d) => d.commitEligible);
}

/** Signed-area helper re-exported for UI code that pre-checks rings. */
export function profileSignedArea(ring: ProfilePt[]): number {
  return signedArea(ring);
}
