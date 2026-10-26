/**
 * Reference acquisition service — MODIFY GROUP 1 spec §3
 * (docs/MODIFY_GROUP1_SPEC_V71.md).
 *
 * Implements the uploaded Modify master prompt §4.2: typed acquisition of
 * faces, edges, vertices, centerlines, location lines, reference planes,
 * grids, levels, work planes, connectors, analytical axes and host
 * surfaces — each with a right-handed orthonormal canonical frame,
 * command-scoped (NON-persistent) lifetime, and stale/broken lifecycle
 * when owner geometry changes or the owner is deleted.
 *
 * Persistence rule (binding, spec §3.2): an acquired reference is a
 * temporary command input. It becomes persistent ONLY through an
 * explicit user action (e.g. Align-with-lock creating a
 * persistent-alignment relationship — existing AlignCommand behavior).
 *
 * Diagnostic codes: MOD-REF-nnn (spec §3.6).
 * Pure module: no DOM — safe to unit-test in Node.
 */

// ── Types (spec §3.1) ────────────────────────────────────────────────────

export type ReferenceKind =
  | "face"
  | "edge"
  | "vertex"
  | "centerline"
  | "location-line"
  | "reference-plane"
  | "grid"
  | "level"
  | "work-plane"
  | "connector"
  | "analytical-axis"
  | "host-surface";

export type Vec3 = [number, number, number];

export interface RefFrame {
  origin: Vec3;
  xAxis: Vec3;
  yAxis: Vec3;
  zAxis: Vec3;
}

export type ReferenceStatus = "valid" | "stale" | "broken";

export interface AcquiredReference {
  id: string;
  kind: ReferenceKind;
  /** Owning element, if any (datum references have none). */
  ownerElementId?: string;
  name?: string;
  frame: RefFrame;
  position?: Vec3;
  direction?: Vec3;
  /** Always false at acquisition — see persistence rule (spec §3.2). */
  persistent: false;
  geometryVersion: number;
  status: ReferenceStatus;
  /** Monotonic acquisition order — deterministic tie-breaks. */
  createdAt: number;
}

export interface AcquireInput {
  kind: ReferenceKind;
  ownerElementId?: string;
  name?: string;
  /** Feature position (pick point, vertex, connector position...). */
  position?: Vec3;
  /** Feature direction (tangent, normal, flow direction...). */
  direction?: Vec3;
  /** Surface normal for face/host-surface (alias of direction, semantic). */
  normal?: Vec3;
  /** Elevation for level references. */
  elevation?: number;
  geometryVersion?: number;
}

// ── Command eligibility (spec §3.4) ──────────────────────────────────────

/** Kinds each Group 1 command may consume. */
export const REFERENCE_ELIGIBILITY: Record<string, readonly ReferenceKind[]> = {
  move: [
    "vertex", "edge", "face", "host-surface", "centerline", "location-line",
    "reference-plane", "work-plane", "grid", "level", "connector", "analytical-axis",
  ],
  rotate: [
    "vertex", "edge", "face", "host-surface", "centerline", "location-line",
    "reference-plane", "work-plane", "grid", "connector",
  ],
  mirror: [
    "edge", "centerline", "location-line", "reference-plane", "work-plane", "grid",
  ],
};

// ── Vector helpers ───────────────────────────────────────────────────────

const EPS_LEN = 1e-12;

function norm(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function unit(v: Vec3): Vec3 {
  const l = norm(v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Gram-Schmidt orthonormal frame from a primary x direction and a z hint. */
function orthonormalFrame(xHint: Vec3, zHint: Vec3, origin: Vec3): RefFrame {
  const z = unit(zHint);
  // project xHint into the plane ⟂ z; fall back to a non-parallel world axis
  let x: Vec3 = [
    xHint[0] - dot(xHint, z) * z[0],
    xHint[1] - dot(xHint, z) * z[1],
    xHint[2] - dot(xHint, z) * z[2],
  ];
  if (norm(x) < 1e-9) {
    const fallback: Vec3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    x = [
      fallback[0] - dot(fallback, z) * z[0],
      fallback[1] - dot(fallback, z) * z[1],
      fallback[2] - dot(fallback, z) * z[2],
    ];
  }
  const xu = unit(x);
  const y = cross(z, xu);
  return { origin, xAxis: xu, yAxis: y, zAxis: z };
}

const WORLD_X: Vec3 = [1, 0, 0];
const WORLD_Z: Vec3 = [0, 0, 1];

// ── Diagnostics ──────────────────────────────────────────────────────────

export interface ReferenceDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  referenceIds: string[];
}

// ── Service ──────────────────────────────────────────────────────────────

export class ReferenceService {
  private refs = new Map<string, AcquiredReference>();
  private diagnostics: ReferenceDiagnostic[] = [];
  private seq = 0;

  GetDiagnostics(): ReferenceDiagnostic[] {
    return [...this.diagnostics];
  }

  private diag(severity: ReferenceDiagnostic["severity"], code: string, message: string, referenceIds: string[] = []): void {
    this.diagnostics.push({ severity, code, message, referenceIds });
  }

  /**
   * Acquire a reference and build its canonical frame (spec §3.1 table).
   * Throws on degenerate input (MOD-REF-002 / MOD-REF-003).
   */
  Acquire(input: AcquireInput): AcquiredReference {
    if (!REFERENCE_KINDS.has(input.kind)) {
      this.diag("error", "MOD-REF-003", `unknown reference kind '${input.kind}'`);
      throw new Error(`Acquire: unknown reference kind '${input.kind}'`);
    }
    this.seq += 1;
    const id = `ref_${this.seq}_${input.kind}`;
    const version = input.geometryVersion ?? 0;
    let ref: AcquiredReference;

    // Degenerate frame inputs record MOD-REF-002 before rethrowing so
    // callers inspecting diagnostics see the reason (spec §3.6).
    try {
      switch (input.kind) {
      case "level": {
        const elev = input.elevation ?? input.position?.[2] ?? 0;
        if (!Number.isFinite(elev)) {
          this.diag("error", "MOD-REF-002", "level reference requires a finite elevation");
          throw new Error("Acquire(level): elevation must be finite");
        }
        ref = this.make(id, input, {
          frame: orthonormalFrame(WORLD_X, WORLD_Z, [0, 0, elev]),
          position: [0, 0, elev],
        }, version);
        break;
      }
      case "grid": {
        const p = input.position ?? [0, 0, 0];
        const d = requireDir(input.direction, "grid");
        ref = this.make(id, input, {
          frame: orthonormalFrame(d, WORLD_Z, [p[0], p[1], 0]),
          position: [p[0], p[1], 0],
          direction: unit(d),
        }, version);
        break;
      }
      case "reference-plane":
      case "work-plane": {
        const p = input.position ?? [0, 0, 0];
        const n = requireDir(input.normal ?? input.direction, input.kind);
        ref = this.make(id, input, {
          frame: orthonormalFrame(input.direction ?? WORLD_X, n, p),
          position: p,
          direction: unit(n),
        }, version);
        break;
      }
      case "face":
      case "host-surface": {
        const p = input.position;
        if (!p) {
          this.diag("error", "MOD-REF-002", `${input.kind} reference requires a pick position`);
          throw new Error(`Acquire(${input.kind}): pick position required`);
        }
        const n = requireDir(input.normal ?? input.direction, input.kind);
        ref = this.make(id, input, {
          frame: orthonormalFrame(WORLD_X, n, p),
          position: p,
          direction: unit(n),
        }, version);
        break;
      }
      case "edge": {
        const p = requirePos(input.position, "edge");
        const t = requireDir(input.direction, "edge");
        ref = this.make(id, input, {
          frame: orthonormalFrame(t, WORLD_Z, p),
          position: p,
          direction: unit(t),
        }, version);
        break;
      }
      case "vertex": {
        const p = requirePos(input.position, "vertex");
        ref = this.make(id, input, { frame: orthonormalFrame(WORLD_X, WORLD_Z, p), position: p }, version);
        break;
      }
      case "centerline":
      case "location-line":
      case "analytical-axis": {
        const p = requirePos(input.position, input.kind);
        const d = requireDir(input.direction, input.kind);
        ref = this.make(id, input, {
          frame: orthonormalFrame(d, WORLD_Z, p),
          position: p,
          direction: unit(d),
        }, version);
        break;
      }
      case "connector": {
        const p = requirePos(input.position, "connector");
        const d = requireDir(input.direction ?? input.normal, "connector");
        ref = this.make(id, input, {
          frame: orthonormalFrame(WORLD_X, d, p),
          position: p,
          direction: unit(d),
        }, version);
        break;
      }
      }
    } catch (e) {
      this.seq -= 1;
      this.diag("error", "MOD-REF-002", `degenerate reference input: ${String((e as Error).message)}`);
      throw e;
    }
    this.diag("info", "MOD-REF-001", `reference acquired: ${ref.kind}${ref.ownerElementId ? ` on '${ref.ownerElementId}'` : ""}`, [id]);
    return ref;
  }

  Get(id: string): AcquiredReference | undefined {
    const r = this.refs.get(id);
    return r ? { ...r } : undefined;
  }

  Status(id: string): ReferenceStatus {
    return this.refs.get(id)?.status ?? "broken";
  }

  All(): AcquiredReference[] {
    return [...this.refs.values()].map((r) => ({ ...r }));
  }

  /** Validate a reference for use by a named command (spec §3.4). */
  ValidateForCommand(refOrId: AcquiredReference | string, command: string): { ok: boolean; diagnostics: ReferenceDiagnostic[] } {
    const before = this.diagnostics.length;
    const ref = typeof refOrId === "string" ? this.refs.get(refOrId) : refOrId;
    if (!ref) {
      this.diag("error", "MOD-REF-005", `reference not found or broken`);
      return { ok: false, diagnostics: this.diagnostics.slice(before) };
    }
    if (ref.status === "broken") {
      this.diag("error", "MOD-REF-005", `reference '${ref.id}' is broken (owner deleted)`, [ref.id]);
      return { ok: false, diagnostics: this.diagnostics.slice(before) };
    }
    if (ref.status === "stale") {
      this.diag("error", "MOD-REF-004", `reference '${ref.id}' is stale (owner geometry changed) — re-acquire`, [ref.id]);
      return { ok: false, diagnostics: this.diagnostics.slice(before) };
    }
    const eligible = REFERENCE_ELIGIBILITY[command];
    if (eligible && !eligible.includes(ref.kind)) {
      this.diag("error", "MOD-REF-006", `reference kind '${ref.kind}' is not eligible for command '${command}'`, [ref.id]);
      return { ok: false, diagnostics: this.diagnostics.slice(before) };
    }
    return { ok: true, diagnostics: [] };
  }

  /** Owner geometry changed → owned references become stale (spec §3.3). */
  MarkGeometryChanged(ownerElementId: string, newVersion: number): number {
    let n = 0;
    for (const ref of this.refs.values()) {
      if (ref.ownerElementId === ownerElementId && ref.status === "valid") {
        ref.status = "stale";
        ref.geometryVersion = newVersion;
        n += 1;
      }
    }
    return n;
  }

  /** Owner deleted → owned references become broken (spec §3.3). */
  MarkOwnerDeleted(ownerElementId: string): number {
    let n = 0;
    for (const ref of this.refs.values()) {
      if (ref.ownerElementId === ownerElementId && ref.status !== "broken") {
        ref.status = "broken";
        n += 1;
      }
    }
    return n;
  }

  /** Command scope end — drop all command-scoped references. */
  Clear(): void {
    this.refs.clear();
    this.diagnostics = [];
  }

  private make(
    id: string,
    input: AcquireInput,
    extra: { frame: RefFrame; position?: Vec3; direction?: Vec3 },
    version: number,
  ): AcquiredReference {
    const ref: AcquiredReference = {
      id,
      kind: input.kind,
      ownerElementId: input.ownerElementId,
      name: input.name,
      frame: extra.frame,
      position: extra.position,
      direction: extra.direction,
      persistent: false,
      geometryVersion: version,
      status: "valid",
      createdAt: Date.now() + this.seq * 1e-3,
    };
    this.refs.set(id, ref);
    return { ...ref };
  }
}

export const REFERENCE_KINDS: ReadonlySet<ReferenceKind> = new Set<ReferenceKind>([
  "face", "edge", "vertex", "centerline", "location-line", "reference-plane",
  "grid", "level", "work-plane", "connector", "analytical-axis", "host-surface",
]);

function requirePos(p: Vec3 | undefined, kind: string): Vec3 {
  if (!p || !p.every(Number.isFinite)) {
    throw new Error(`Acquire(${kind}): finite position required`);
  }
  return p;
}

function requireDir(d: Vec3 | undefined, kind: string): Vec3 {
  if (!d || !d.every(Number.isFinite) || norm(d) < EPS_LEN) {
    throw new Error(`Acquire(${kind}): non-zero direction required (MOD-REF-002)`);
  }
  return d;
}
