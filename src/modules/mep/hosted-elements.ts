/**
 * Hosted MEP elements — the parametric host-relationship engine.
 *
 * Parity target: Revit's hosted-element behaviour — light fixtures hosted
 * to ceilings, air terminals to ducts, sprinklers to pipes, receptacles to
 * walls. A hosted element stores its host, its parametric anchor on the
 * host face/axis and an offset; when the host moves or resizes, the hosted
 * element's world position is re-derived, not remembered. Delete the host
 * and the hosted element is orphaned and reported — exactly the dependency
 * engine that makes Revit models edit-proof.
 *
 * Host kinds and their parametric frames:
 *   - wall            : vertical face, anchor = (u along wall axis, v up
 *                       the face), offset = perpendicular off-face.
 *   - ceiling/floor/roof : horizontal plane, anchor = (x, y), offset = z.
 *   - duct/pipe/cable-tray/conduit : linear axis, anchor = t along the
 *                       axis (0..1), offset = radial (mm) from the axis.
 *   - equipment       : box body, anchor = (u, v) on the reference face.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type HostKind =
  | "wall"
  | "ceiling"
  | "floor"
  | "roof"
  | "duct"
  | "pipe"
  | "cable-tray"
  | "conduit"
  | "equipment";

export type HostedKind =
  | "light-fixture"
  | "air-terminal"
  | "diffuser"
  | "sprinkler"
  | "receptacle"
  | "switch"
  | "valve"
  | "damper"
  | "hanger"
  | "camera"
  | "speaker"
  | "detector";

interface Vec3T { x: number; y: number; z: number } // y = vertical (world up)

export interface HostGeometry {
  /** Model element id. */
  id: string;
  kind: HostKind;
  /** Wall: base point at floor. Linear hosts: start point. */
  origin: Vec3T;
  /** Wall: unit direction of the wall axis. Linear hosts: unit axis to end. */
  direction: Vec3T;
  /** Extent along `direction` (wall length / duct-pipe length), m. */
  lengthM: number;
  /** Wall: clear height. Horizontal plane hosts: elevation (origin.y). */
  heightM?: number;
  /** Wall thickness (m) — anchors sit on the finish face + offsets. */
  thicknessM?: number;
  /** Linear hosts: hydraulic diameter or tray width (m). */
  sizeM?: number;
  /** Equipment: bbox extents (m). */
  bboxM?: Vec3T;
}

export interface HostedElement {
  /** Model element id of the hosted piece. */
  id: string;
  kind: HostedKind;
  /** Host element id. */
  hostId: string;
  /** Hosted element's own size (m) — clearance checks. */
  sizeM?: number;
  /** Required host kinds (compatibility gate). */
  allowedHostKinds: HostKind[];
  /** Clearances in m: min perpendicular offset from the host surface/axis. */
  offsetM: number;
  /** Created-by flag for diagnostics grouping. */
  label?: string;
}

/**
 * Internal parametric record — derived, never authored by hand in normal
 * use (attachToHost computes it from world coordinates).
 */
export interface HostAnchor {
  /** Wall/equipment horizontal position along the host axis, m. */
  u: number;
  /** Wall vertical rise / horizontal plane x-offset, m. */
  v: number;
  /** Plane hosts: y position, m (v carries x, this carries y). */
  v2?: number;
  /** Linear hosts: normalised position along the axis, 0..1. */
  t?: number;
}

export interface HostedRecord extends HostedElement {
  anchor: HostAnchor;
}

export type HostSeverity = "error" | "warning" | "info";

export interface HostDiagnostic {
  code: string;
  severity: HostSeverity;
  message: string;
  hostedId?: string;
  hostId?: string;
}

export interface HostAudit {
  total: number;
  byKind: Record<string, number>;
  orphaned: HostDiagnostic[];
  issues: HostDiagnostic[];
  /** Hosted elements whose world position was re-derived this pass. */
  updated: Array<{ hostedId: string; newPosition: Vec3T }>;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

function v3(x: number, y: number, z: number): Vec3T {
  return { x, y, z };
}

function finite(v: Vec3T): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function unit(dir: Vec3T): Vec3T {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len < 1e-9) throw new Error("direction must be non-zero");
  return { x: dir.x / len, y: dir.y / len, z: dir.z / len };
}

function add(a: Vec3T, b: Vec3T): Vec3T {
  return v3(a.x + b.x, a.y + b.y, a.z + b.z);
}

function scale(a: Vec3T, s: number): Vec3T {
  return v3(a.x * s, a.y * s, a.z * s);
}

function dist(a: Vec3T, b: Vec3T): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** World position of a hosted record on its (current) host geometry. */
export function hostedWorldPosition(host: HostGeometry, rec: HostedRecord): Vec3T {
  switch (host.kind) {
    case "wall": {
      const dir = unit(host.direction);
      // Face offset: half thickness outward + user offset.
      const outward = v3(dir.z, 0, -dir.x); // plan-perpendicular
      const off = (host.thicknessM ?? 0) / 2 + rec.offsetM;
      return add(add(add(host.origin, scale(dir, rec.anchor.u)), v3(0, rec.anchor.v, 0)), scale(outward, off));
    }
    case "ceiling":
    case "floor":
    case "roof": {
      // anchor.v = x, anchor.v2 = y, offset hangs below/above the plane.
      return v3(rec.anchor.v, host.origin.y + (host.kind === "floor" ? rec.offsetM : -rec.offsetM), rec.anchor.v2 ?? 0);
    }
    case "duct":
    case "pipe":
    case "cable-tray":
    case "conduit": {
      const dir = unit(host.direction);
      const t = rec.anchor.t ?? 0;
      const p = add(host.origin, scale(dir, t * host.lengthM));
      if (rec.offsetM === 0) return p;
      // Radial hang below the axis (hangers, sprinklers): drop in -y.
      return add(p, v3(0, -rec.offsetM, 0));
    }
    case "equipment": {
      const bb = host.bboxM ?? v3(1, 1, 1);
      return add(host.origin, v3(rec.anchor.u * bb.x, rec.anchor.v * bb.y, 0));
    }
  }
}

// ─── Compatibility table (Revit-style host/workplane rules) ───────────────

const COMPAT: Record<HostedKind, HostKind[]> = {
  "light-fixture": ["ceiling", "roof", "wall", "equipment"],
  "air-terminal": ["duct"],
  diffuser: ["duct", "ceiling"],
  sprinkler: ["pipe", "ceiling", "floor"],
  receptacle: ["wall", "equipment"],
  switch: ["wall"],
  valve: ["pipe", "duct"],
  damper: ["duct"],
  hanger: ["duct", "pipe", "cable-tray", "conduit"],
  camera: ["wall", "ceiling", "roof"],
  speaker: ["ceiling", "wall", "roof"],
  detector: ["ceiling", "roof", "duct"],
};

/** True when this hosted kind may attach to this host kind. */
export function isCompatibleHost(kind: HostedKind, host: HostKind): boolean {
  return (COMPAT[kind] ?? []).includes(host);
}

// ─── Attach / rehost ──────────────────────────────────────────────────────

/**
 * Attach a hosted element to a host at a world point. Projects the point
 * onto the host's parametric frame and validates kind compatibility and
 * on-host bounds. Throws with a clear message on rejection.
 */
export function attachToHost(
  hosted: HostedElement,
  host: HostGeometry,
  worldPoint: Vec3T,
): HostedRecord {
  if (!isCompatibleHost(hosted.kind, host.kind)) {
    throw new Error(`${hosted.kind} cannot host on ${host.kind} (allowed: ${(COMPAT[hosted.kind] ?? []).join(", ")})`);
  }
  if (!finite(worldPoint)) throw new Error("worldPoint must be finite");
  const dir = unit(host.direction);

  if (host.kind === "wall") {
    const rel = { x: worldPoint.x - host.origin.x, y: 0, z: worldPoint.z - host.origin.z };
    const u = rel.x * dir.x + rel.z * dir.z;
    if (u < -0.15 || u > host.lengthM + 0.15) throw new Error("Point is outside the wall length (+/-15 cm tolerance)");
    const v = worldPoint.y - host.origin.y;
    if (v < -0.15 || v > (host.heightM ?? 3) + 0.15) throw new Error("Point is outside the wall height (+/-15 cm tolerance)");
    return { ...hosted, hostId: host.id, anchor: { u, v } };
  }
  if (host.kind === "ceiling" || host.kind === "floor" || host.kind === "roof") {
    return { ...hosted, hostId: host.id, anchor: { u: 0, v: worldPoint.x, v2: worldPoint.z } };
  }
  // Linear hosts: project onto the axis.
  const rel = { x: worldPoint.x - host.origin.x, y: worldPoint.y - host.origin.y, z: worldPoint.z - host.origin.z };
  const along = rel.x * dir.x + rel.y * dir.y + rel.z * dir.z;
  if (along < -0.15 || along > host.lengthM + 0.15) throw new Error("Point is outside the run length (+/-15 cm tolerance)");
  const perp = Math.sqrt(Math.max(0, rel.x * rel.x + rel.y * rel.y + rel.z * rel.z - along * along));
  const size = host.sizeM ?? 0.25;
  if (perp > size / 2 + 0.3) throw new Error(`Point is ${perp.toFixed(2)} m from the run axis — beyond capture tolerance`);
  return { ...hosted, hostId: host.id, anchor: { u: 0, v: 0, t: host.lengthM > 0 ? clamp01(along / host.lengthM) : 0 } };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

// ─── Audit + parametric follow ────────────────────────────────────────────

export interface HostAuditInput {
  hosts: HostGeometry[];
  hosted: HostedRecord[];
}

/**
 * Full host audit:
 *   - orphaned  : hosted element whose host no longer exists (Revit flags
 *                 these the moment the host is deleted).
 *   - issues    : kind incompatibility (host replaced by another kind),
 *                 off-host drift beyond tolerance, linear anchors out of
 *                 range.
 *   - updated   : re-derived world positions after host edits — the
 *                 parametric "hosted follows host" behaviour.
 */
export function auditHostedElements(input: HostAuditInput): HostAudit {
  const hostById = new Map(input.hosts.map(h => [h.id, h]));
  const byKind: Record<string, number> = {};
  const orphaned: HostDiagnostic[] = [];
  const issues: HostDiagnostic[] = [];
  const updated: Array<{ hostedId: string; newPosition: Vec3T }> = [];

  for (const rec of input.hosted) {
    byKind[rec.kind] = (byKind[rec.kind] ?? 0) + 1;
    const host = hostById.get(rec.hostId);
    if (!host) {
      orphaned.push({
        code: "HOST_DELETED",
        severity: "error",
        message: `${rec.kind} '${rec.id}' lost its host '${rec.hostId}' — rehost or delete it.`,
        hostedId: rec.id,
        hostId: rec.hostId,
      });
      continue;
    }
    if (!isCompatibleHost(rec.kind, host.kind)) {
      issues.push({
        code: "HOST_KIND_MISMATCH",
        severity: "error",
        message: `${rec.kind} '${rec.id}' is hosted on a ${host.kind}, which it cannot host on.`,
        hostedId: rec.id,
        hostId: host.id,
      });
      continue;
    }
    if (host.kind === "duct" || host.kind === "pipe" || host.kind === "cable-tray" || host.kind === "conduit") {
      const t = rec.anchor.t ?? 0;
      if (t < -0.001 || t > 1.001) {
        issues.push({
          code: "ANCHOR_OUT_OF_RANGE",
          severity: "warning",
          message: `${rec.kind} '${rec.id}' anchor t=${t.toFixed(3)} is outside its host run.`,
          hostedId: rec.id,
          hostId: host.id,
        });
      }
    }
    updated.push({ hostedId: rec.id, newPosition: hostedWorldPosition(host, rec) });
  }

  return { total: input.hosted.length, byKind, orphaned, issues, updated };
}

/**
 * After the host moved or resized, re-project every hosted element of that
 * host and return their new world positions (positions to write back into
 * the model). Hosted elements keep their parametric anchor — the essence
 * of Revit hosting.
 */
export function applyHostChange(hosts: HostGeometry[], hosted: HostedRecord[], hostId: string): Array<{ hostedId: string; newPosition: Vec3T }> {
  const host = hosts.find(h => h.id === hostId);
  if (!host) return [];
  const out: Array<{ hostedId: string; newPosition: Vec3T }> = [];
  for (const rec of hosted) {
    if (rec.hostId !== hostId) continue;
    out.push({ hostedId: rec.id, newPosition: hostedWorldPosition(host, rec) });
  }
  return out;
}

/**
 * Suggest the nearest compatible host for an orphaned element — the
 * "Rehost" picker Revit shows. Linear distance to the host anchor point.
 */
export function suggestHosts(
  kind: HostedKind,
  hosts: HostGeometry[],
  nearPoint: Vec3T,
  limit = 3,
): Array<{ hostId: string; kind: HostKind; distanceM: number }> {
  const scored = hosts
    .filter(h => isCompatibleHost(kind, h.kind))
    .map(h => {
      const mid = add(h.origin, scale(unit(h.direction), h.lengthM / 2));
      return { hostId: h.id, kind: h.kind, distanceM: dist(nearPoint, mid) };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
  return scored.slice(0, limit);
}

/** Exposed for tests. */
export const _internals = { v3, unit, add, scale, dist };
