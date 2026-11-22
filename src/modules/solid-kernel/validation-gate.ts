/**
 * Validation as a gate (K1).
 *
 * Until this module existed, `validateMeshDiagnostics` / `commitEligible`
 * (./validate) were exposed on the solids debug API and called only from
 * engine-ui demo dialogs and tests — zero call sites in authoring,
 * importer, cad-viewer, or ifc-semantics — so invalid solids could be
 * created, imported, and saved unvalidated. Every Boolean result and
 * every authored / imported solid now passes through this gate before it
 * is committed to the model.
 *
 * The gate is: WELD, then VALIDATE, then a typed verdict.
 *
 *   - `ok` — no error diagnostics: the welded mesh is committed as-is.
 *   - `quarantined` — the ONLY error diagnostics are non-manifold edges
 *     used 3+ times (junction / contact class) and the volume is finite
 *     and positive. This is the class PE-09 recorded for touching
 *     solids: when BOTH coincident skins of a zero-overlap contact
 *     survive in a mesh (raw soup, imported tessellation, three-csg-ts
 *     output), the shared edge is used 4x while the volume stays exact.
 *     Refusing that class outright would break legitimate geometry
 *     whose volume is exact, so it is ADMITTED but RECORDED in the
 *     quarantine registry (visible via `listQuarantinedSolids()` and
 *     the solids debug API) — never silently whitelisted.
 *     (Measured while building this gate: `generalBoolean` itself
 *     already resolves touching contacts — its coplanar pass gives
 *     single-copy skin ownership, so a touching-face union through the
 *     general kernel gates `ok` with no record. PE-09 skipped the
 *     watertight assertion for touching pairs without proving they
 *     fail; the gate proves the general-kernel leg clean. The
 *     quarantine class still fires for producers that keep both skins.)
 *     Path to hard refusal: fix coincident-contact merging in the
 *     producers that keep both skins, then promote this class to
 *     `refused`.
 *   - `refused` — any other error diagnostic (degenerate face,
 *     zero-length edge, invalid shell, missing vertices, non-finite
 *     volume, empty mesh, open shell: a non-manifold edge used exactly
 *     once). The mesh must NOT be committed; callers throw
 *     `ValidationGateError`, skip admission, or return null.
 *
 * `hardRefusal` marks the narrow unbuildable subset (empty mesh or
 * non-finite coordinates / volume): geometry that cannot render
 * correctly by any measure. The authoring commit path refuses only this
 * subset outright and quarantines the rest, because the commit path
 * legitimately produces non-solid meshes (imported native-twin
 * tessellation, curtain-wall mullion/panel assemblies, hosted
 * door/window parts) and no browser proof exists on this VM to allowlist
 * solid-candidate builders. Hard refusal for every invalid authored
 * mesh is the documented next step once each builder's output is
 * browser-proven. The kernel Boolean path and the solid-import path
 * hard-refuse every `refused` verdict: there the operands are closed
 * solids by contract (PE-09 proves the expected outputs) and skipping
 * a bad imported shape is the established `occtToParts` pattern.
 * EXCEPTION, measured while building this gate: the CONVEX kernel
 * (`booleanOp` in ./csg) is seam-inconsistent whenever its splitter
 * actually runs — every overlapping subtract / union / intersect gives
 * 12–26 non-manifold-edge diagnostics with exact volume (T-junctions
 * where split host faces meet), on both hand-built and generateVoid
 * operands. Hard refusal there would stop all void cutting (cutVoids
 * calls subtract per void), so convex results use quarantine-on-refusal
 * (`onRefused: 'quarantine'`): recorded with diagnostics, returned,
 * never silent. The GENERAL kernel gates clean on the same operands
 * and hard-refuses — except results produced from degenerate INPUT
 * (the operation itself recorded skipped degenerate triangles): the
 * PE-10 contract there is skip + record + return, and the degenerate
 * face corrupts the coplanar pass on coplanar operands, so those
 * results are quarantined, not refused. See the post-condition
 * comments in csg.ts and general-csg.ts.
 *
 * Validation NEVER silently repairs (validate.ts policy): the gate
 * returns the WELDED mesh — welding is the specified pre-step, using
 * the PE-10 weld tolerance — and reports everything it finds. The
 * volume-finiteness diagnostic comes from validate.ts itself (K2: the
 * volume check runs on every mesh); the gate only records the hard
 * refusal for a non-finite volume and does not synthesise a second
 * diagnostic with the same code.
 *
 * Pure module: no DOM, no three.js — safe to unit-test in Node.
 * (Import cycle note: this module imports `weldMesh` from
 * ./general-csg, and the kernel post-conditions import this module
 * back from ./csg and ./general-csg. The cycle is call-time only —
 * every cyclic binding is used inside a function body, never at module
 * top level — so it resolves in both ESM and CommonJS. The gate's own
 * verdicts match PE-09's `validateMeshDiagnostics(weldMesh(m))`
 * assertions exactly because it reuses those same two functions.)
 */

import { meshVolume, type IndexedMesh, type Pt3 } from "../adaptive";
import { weldMesh } from "./general-csg";
import { WELD_MESH_TOLERANCE } from "./tolerance";
import {
  validateMeshDiagnostics,
  type GeometryDiagnostic,
  type GeometryErrorCode,
} from "./validate";

/** The gate's verdict for one mesh. */
export type GateVerdict = "ok" | "quarantined" | "refused";

export interface GateResult {
  verdict: GateVerdict;
  /** The welded mesh that was validated — commit this, never the raw input. */
  mesh: IndexedMesh;
  /** All diagnostics from validateMeshDiagnostics on the welded mesh, plus any gate-synthesised ones. */
  diagnostics: GeometryDiagnostic[];
  errors: GeometryDiagnostic[];
  warnings: GeometryDiagnostic[];
  /** Divergence-theorem volume of the welded mesh (may be 0 / NaN on refused meshes). */
  volume: number;
  /**
   * True only for the unbuildable subset of refusals (empty mesh or
   * non-finite coordinates / volume). The authoring commit path refuses
   * this subset outright and quarantines every other failure.
   */
  hardRefusal: boolean;
}

export interface GateOptions {
  /** Where the mesh came from, e.g. 'convex-kernel', 'authoring-commit', 'import:step'. Recorded, not validated. */
  source?: string;
  /** Registry id for the quarantine record; defaults to `owner`. */
  id?: string;
  /** Record a quarantined verdict in the registry (default true). */
  recordQuarantine?: boolean;
  /**
   * What `assertCommitEligible` does with a `refused` verdict.
   * Default `'throw'` (ValidationGateError). `'quarantine'` records the
   * refusal as quarantined (admitted: true) and returns the mesh — used
   * ONLY by the convex kernel (see its post-condition comment): its
   * splitter is seam-inconsistent on every overlapping operation, so
   * hard refusal there would stop all void cutting.
   */
  onRefused?: "throw" | "quarantine";
}

/** Typed refusal: a mesh the gate refused, with its diagnostics attached. */
export class ValidationGateError extends Error {
  readonly code = "validation-gate-refused" as const;
  readonly owner: string;
  readonly diagnostics: GeometryDiagnostic[];
  constructor(owner: string, diagnostics: GeometryDiagnostic[]) {
    super(
      `validation gate refused ${owner}: ${diagnostics
        .map((d) => `${d.code}: ${d.message}`)
        .join("; ")}`,
    );
    this.name = "ValidationGateError";
    this.owner = owner;
    this.diagnostics = diagnostics;
  }
}

function gateDiagnostic(
  code: GeometryErrorCode,
  message: string,
  owner: string,
  recoveryAction: string,
): GeometryDiagnostic {
  return {
    code,
    severity: "error",
    message,
    affected: [owner],
    recoveryAction,
    commitEligible: false,
  };
}

/** One-line-per-diagnostic summary for toasts / import warnings. */
export function summarizeGateDiagnostics(diagnostics: GeometryDiagnostic[]): string {
  return diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
}

/** Undirected edge use counts of a mesh (`"min:max"` -> uses). */
export function edgeUseCounts(mesh: IndexedMesh): Map<string, number> {
  const use = new Map<string, number>();
  for (const [a, b, c] of mesh.faces) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

// ── Quarantine registry ──────────────────────────────────────────────────

/**
 * A solid that was admitted (or refused admission) with error
 * diagnostics on record. Quarantined solids are MARKED (here), EXCLUDED
 * from downstream use by their caller (a refused import part never
 * enters the admitted parts list; a refused Boolean result is never
 * returned; a quarantined authored element is listed here and warned
 * about at commit time), and VISIBLE via `listQuarantinedSolids()` and
 * the solids debug API.
 *
 * In-memory only: the checkpoint/journal quarantine infrastructure
 * (`src/modules/projects/*`, `src/features/project-recovery.ts`) is for
 * journal ops and checkpoints, not elements — no element-level
 * quarantine existed before this module, so this registry is the new
 * infrastructure. Persisting it into the project document is follow-up
 * work, not done here.
 */
export interface QuarantinedSolid {
  /** Registry id (element id, part name, or owner label). */
  id: string;
  owner: string;
  source: string;
  /** 'quarantined' = admitted with diagnostics on record; 'refused' = not admitted. */
  disposition: "quarantined" | "refused";
  admitted: boolean;
  diagnostics: Array<{ code: GeometryErrorCode; message: string }>;
  volume: number;
  /** Epoch ms when the record was written. */
  at: number;
  /**
   * How many times this id+owner was recorded (re-records replace the
   * entry and bump this instead of growing the registry — the convex
   * kernel records on every overlapping Boolean, so the registry stays
   * a current flagged set, not a log).
   */
  occurrences: number;
}

const quarantinedSolids: QuarantinedSolid[] = [];

export function recordQuarantinedSolid(entry: Omit<QuarantinedSolid, "at" | "occurrences">): QuarantinedSolid {
  const existing = quarantinedSolids.findIndex((q) => q.id === entry.id && q.owner === entry.owner);
  if (existing >= 0) {
    const full: QuarantinedSolid = { ...entry, at: Date.now(), occurrences: quarantinedSolids[existing].occurrences + 1 };
    quarantinedSolids[existing] = full;
    return full;
  }
  const full: QuarantinedSolid = { ...entry, at: Date.now(), occurrences: 1 };
  quarantinedSolids.push(full);
  return full;
}

/** Copy of the registry, oldest first. */
export function listQuarantinedSolids(): QuarantinedSolid[] {
  return [...quarantinedSolids];
}

export function isQuarantined(id: string): boolean {
  return quarantinedSolids.some((q) => q.id === id && q.disposition === "quarantined");
}

/** Remove the record for one id (used when a later rebuild proves the mesh valid again). */
export function clearQuarantinedSolid(id: string): boolean {
  const before = quarantinedSolids.length;
  for (let i = quarantinedSolids.length - 1; i >= 0; i--) {
    if (quarantinedSolids[i].id === id) quarantinedSolids.splice(i, 1);
  }
  return quarantinedSolids.length !== before;
}

/** Test seam + explicit user clear. */
export function clearQuarantinedSolids(): void {
  quarantinedSolids.length = 0;
}

// ── The gate ─────────────────────────────────────────────────────────────

/**
 * Weld (PE-10 weld tolerance) then validate. Never throws for invalid
 * geometry — it returns the `refused` verdict and lets the caller
 * decide (throw, skip, return null). Quarantined verdicts are recorded
 * in the registry unless `recordQuarantine` is false.
 */
export function gateSolid(mesh: IndexedMesh, owner = "solid", opts: GateOptions = {}): GateResult {
  const source = opts.source ?? "gate";
  const welded = weldMesh(mesh, WELD_MESH_TOLERANCE);
  const diagnostics: GeometryDiagnostic[] = [...validateMeshDiagnostics(welded, owner)];

  // Gate's own checks: validate.ts reports the volume diagnostics
  // itself (K2), so the gate only derives hard refusal from them.
  let hardRefusal = false;
  let hasNonFiniteCoordinate = false;
  for (const v of welded.vertices) {
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
      hasNonFiniteCoordinate = true;
      break;
    }
  }
  if (welded.faces.length === 0) {
    hardRefusal = true;
    diagnostics.push(
      gateDiagnostic(
        "invalid-shell",
        `${owner} has no faces after welding (empty solid)`,
        owner,
        "Rebuild the solid from its parametric definition.",
      ),
    );
  }
  const volume = meshVolume(welded);
  if (!Number.isFinite(volume)) {
    // Non-finite volume is already reported by validateMeshDiagnostics
    // above (K2: the volume check runs on every mesh) — the gate only
    // records the hard refusal, it does not synthesise a second
    // diagnostic with the same code.
    hardRefusal = true;
  }
  if (hasNonFiniteCoordinate) {
    hardRefusal = true;
    diagnostics.push(
      gateDiagnostic(
        "invalid-shell",
        `${owner} has non-finite vertex coordinates`,
        owner,
        "Rebuild the solid from its parametric definition.",
      ),
    );
  }

  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity !== "error");

  let verdict: GateVerdict;
  if (errors.length === 0) {
    verdict = "ok";
  } else if (!hardRefusal && errors.every((d) => d.code === "non-manifold-edge")) {
    // Junction / contact class only: every offending edge is used 3+
    // times (shared contact), never exactly once (open shell). Volume
    // must be finite and positive — a touching union is volume-exact.
    const use = edgeUseCounts(welded);
    const junctionOnly = errors.every((d) => {
      const key = d.affected[0]?.replace(`${owner}:e`, "") ?? "";
      const n = use.get(key);
      return n !== undefined && n >= 3;
    });
    verdict = junctionOnly && Number.isFinite(volume) && volume > 0 ? "quarantined" : "refused";
  } else {
    verdict = "refused";
  }

  // The gate agrees with validate.ts's commitEligible verdict (errors
  // block) except for the documented junction-only class, which the gate
  // quarantines instead of refusing.

  if (verdict === "quarantined" && opts.recordQuarantine !== false) {
    recordQuarantinedSolid({
      id: opts.id ?? owner,
      owner,
      source,
      disposition: "quarantined",
      admitted: true,
      diagnostics: errors.map((d) => ({ code: d.code, message: d.message })),
      volume,
    });
  }
  return { verdict, mesh: welded, diagnostics, errors, warnings, volume, hardRefusal };
}

/**
 * Throwing form for kernel post-conditions: returns the welded mesh on
 * `ok` / `quarantined` (quarantine is recorded by `gateSolid`), throws
 * `ValidationGateError` on `refused` — unless `onRefused` is
 * `'quarantine'`, in which case the refusal is recorded as quarantined
 * (admitted) and the mesh is returned (convex kernel only).
 */
export function assertCommitEligible(mesh: IndexedMesh, owner = "solid", opts: GateOptions = {}): IndexedMesh {
  const result = gateSolid(mesh, owner, opts);
  if (result.verdict === "refused") {
    if (opts.onRefused === "quarantine") {
      recordQuarantinedSolid({
        id: opts.id ?? owner,
        owner,
        source: opts.source ?? "gate",
        disposition: "quarantined",
        admitted: true,
        diagnostics: result.errors.map((d) => ({ code: d.code, message: d.message })),
        volume: result.volume,
      });
      return result.mesh;
    }
    throw new ValidationGateError(owner, result.diagnostics);
  }
  return result.mesh;
}

/**
 * Import-leg form: same verdicts as `gateSolid`, but refused outcomes
 * are ALSO recorded (admitted: false) so a skipped part leaves evidence
 * instead of vanishing — the caller must still exclude it from the
 * admitted result. Quarantined outcomes are admitted with the record.
 */
export function gateImportedSolid(
  mesh: IndexedMesh,
  owner = "imported-solid",
  source = "import",
): GateResult {
  const result = gateSolid(mesh, owner, { source, id: owner });
  if (result.verdict === "refused") {
    recordQuarantinedSolid({
      id: owner,
      owner,
      source,
      disposition: "refused",
      admitted: false,
      diagnostics: result.errors.map((d) => ({ code: d.code, message: d.message })),
      volume: result.volume,
    });
  }
  return result;
}

// ── THREE / buffer-geometry conversion ───────────────────────────────────

/**
 * Convert a buffer-geometry position attribute (+ optional index) to an
 * IndexedMesh, applying a 4x4 column-major matrix (THREE
 * `matrixWorld.elements` layout) when given. Non-indexed geometry
 * (ExtrudeGeometry, three-csg-ts output) uses sequential triples.
 * Throws on non-finite coordinates / a malformed index — never returns
 * a silently wrong mesh. Pure: takes raw arrays, no three.js import,
 * so it is unit-testable in Node.
 */
export function threeGeometryToIndexedMesh(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null | undefined,
  matrixElements?: ArrayLike<number> | null,
): IndexedMesh {
  if (positions.length === 0 || positions.length % 3 !== 0) {
    throw new Error(
      `threeGeometryToIndexedMesh: positions length ${positions.length} is not a non-empty multiple of 3`,
    );
  }
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) {
      throw new Error(`threeGeometryToIndexedMesh: non-finite coordinate at index ${i}`);
    }
  }
  const m = matrixElements && matrixElements.length === 16 ? matrixElements : null;
  const vertices: Pt3[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (!m) {
      vertices.push({ x, y, z });
    } else {
      // Column-major: x' = m[0]x + m[4]y + m[8]z + m[12], etc.
      vertices.push({
        x: m[0] * x + m[4] * y + m[8] * z + m[12],
        y: m[1] * x + m[5] * y + m[9] * z + m[13],
        z: m[2] * x + m[6] * y + m[10] * z + m[14],
      });
    }
  }
  const faces: [number, number, number][] = [];
  if (index && index.length > 0) {
    if (index.length % 3 !== 0) {
      throw new Error(`threeGeometryToIndexedMesh: index length ${index.length} is not a multiple of 3`);
    }
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i];
      const b = index[i + 1];
      const c = index[i + 2];
      if (a < 0 || b < 0 || c < 0 || a >= vertices.length || b >= vertices.length || c >= vertices.length) {
        throw new Error(`threeGeometryToIndexedMesh: face ${i / 3} references a missing vertex`);
      }
      faces.push([a, b, c]);
    }
  } else {
    for (let i = 0; i < vertices.length; i += 3) {
      faces.push([i, i + 1, i + 2]);
    }
  }
  return { vertices, faces };
}
