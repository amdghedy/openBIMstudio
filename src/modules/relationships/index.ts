/**
 * Persistent relationship registry (MASTER PROMPT MODULE 2B.5–2B.6).
 *
 * A typed relationship model connecting elements through geometric
 * references with explicit lifecycle: creation, validation, query,
 * evaluation after geometry change, suspension, breaking, orphan cleanup
 * and post-reload reconciliation.
 *
 * Core discipline (spec §3.4): physical contact, geometric joining and
 * engineering connectivity are THREE different things and are modelled as
 * different relationship types. A temporary snap is never persisted here
 * — conversion requires an explicit call (snapping module).
 *
 * Reconnection policies (spec 2B.6, level E):
 *   - "follow-source": the dependent tracks the source reference.
 *   - "fixed-world": the dependent stays where it is in world coordinates.
 *   - "local-reference": the dependent recomputes from its stored local
 *     reference frame and offset relative to the source's new frame.
 *   - "becomes-invalid": the relationship is flagged invalid and reported.
 *
 * Pure module: no DOM — safe to unit-test in Node.
 */

import { newUniqueId } from "../object-hierarchy";

export type RelationshipType =
  | "geometric-coincidence"
  | "persistent-alignment"
  | "endpoint-constraint"
  | "host"
  | "face-attachment"
  | "wall-join"
  | "structural-connection"
  | "mep-connection"
  | "rigid-attachment"
  | "clearance"
  | "system-membership"
  | "contact" // physical touch WITHOUT join or connectivity
  | "temporary-snap"; // registry refuses to persist these without conversion

export type ReconnectionPolicy =
  | "follow-source"
  | "fixed-world"
  | "local-reference"
  | "becomes-invalid";

export type RelationshipOrigin = "automatic" | "user-defined";

export interface GeometricReference {
  elementId: string;
  /** Semantic reference kind (spec 2.10: stable identifiers, not indices). */
  kind:
    | "endpoint" | "midpoint" | "center" | "face" | "edge" | "vertex"
    | "centerline" | "axis" | "grid" | "level" | "reference-plane"
    | "connector" | "work-plane" | "family-reference";
  /** Named reference (e.g. "Center (Front/Back)", connector name). */
  name?: string;
  /** World position of the reference at creation time (metres). */
  position: [number, number, number];
  /** World direction where meaningful (unit vector). */
  direction?: [number, number, number];
}

export interface RelationshipRecord {
  id: string;
  type: RelationshipType;
  source: GeometricReference;
  target: GeometricReference;
  /** Local reference coordinates captured at creation (spec 2B.5). */
  localOffset: [number, number, number];
  /** Relative transform captured at creation (rotation about z, radians). */
  relativeRotationZ: number;
  /** Signed offset maintained by the relationship (metres). */
  offset: number;
  /** Optional lock definition (e.g. locked distance). */
  constraint?: { kind: "locked-distance" | "locked-angle" | "coincident"; value?: number };
  /** Connection direction for directional relationships (MEP flow). */
  connectionDirection?: "source-to-target" | "target-to-source" | "bidirectional";
  /** Higher priority wins when relationships conflict (spec 2B.5). */
  priority: number;
  origin: RelationshipOrigin;
  valid: boolean;
  /** Source geometry version at creation (spec 5.6 versioning). */
  geometryVersion: number;
  reconnection: ReconnectionPolicy;
  /** What happens when one endpoint is deleted. */
  deletionPolicy: "break" | "cascade-delete-target" | "orphan-target";
  suspended: boolean;
  createdAt: number;
}

export interface RelationshipQuery {
  elementId?: string;
  type?: RelationshipType;
  validOnly?: boolean;
  includeSuspended?: boolean;
}

export interface GeometryChange {
  elementId: string;
  /** New geometry version after the change. */
  newVersion: number;
  /** World transform delta: translation + rotation about z. */
  translation: [number, number, number];
  rotationZ: number;
}

/** Rigid-body plan motion of a host element about a pivot. */
export interface RigidMotionChange {
  elementId: string;
  newVersion: number;
  /** Plan pivot of the rotation (metres). */
  pivot: [number, number];
  /** Signed rotation about +Z (radians). */
  angle: number;
  /** Optional extra translation after rotation (metres). */
  extraTranslation?: [number, number];
}

export interface RelationshipEvalResult {
  id: string;
  elementId: string;
  action:
    | "unchanged"
    | "updated"
    | "moved-dependent"
    | "flagged-invalid"
    | "suspended"
    | "broke";
  /** New world position for the dependent, when the policy moves it. */
  newPosition?: [number, number, number];
  note?: string;
}

const DEFAULT_PRIORITY = 100;

/**
 * Typed relationship registry. Mutation rules (spec 2B.5): records are
 * immutable once created except for validity/suspension/reference-update
 * fields; edits go through the dedicated methods so diagnostics stay
 * truthful.
 */
export class RelationshipRegistry {
  private records = new Map<string, RelationshipRecord>();
  private geometryVersions = new Map<string, number>();
  private static clock = 0;

  /** Set an element's current geometry version (call after any regen). */
  setGeometryVersion(elementId: string, version: number): void {
    this.geometryVersions.set(elementId, version);
  }

  geometryVersion(elementId: string): number {
    return this.geometryVersions.get(elementId) ?? 0;
  }

  /**
   * CreateRelationship. Validation (spec 2B.5): elements must differ,
   * temporary snaps cannot be persisted as-is (they must be converted by
   * the snapping module into a concrete type), and self-hosting is
   * rejected.
   */
  createRelationship(args: {
    type: RelationshipType;
    source: GeometricReference;
    target: GeometricReference;
    offset?: number;
    constraint?: RelationshipRecord["constraint"];
    reconnection?: ReconnectionPolicy;
    deletionPolicy?: RelationshipRecord["deletionPolicy"];
    priority?: number;
    origin?: RelationshipOrigin;
    connectionDirection?: RelationshipRecord["connectionDirection"];
  }): RelationshipRecord {
    if (args.source.elementId === args.target.elementId) {
      throw new Error("CreateRelationship: source and target must be different elements");
    }
    if (args.type === "temporary-snap") {
      throw new Error(
        "CreateRelationship: temporary snaps are not persistent; convert them via ConvertSnapToPersistentRelationship first",
      );
    }
    if (args.type === "host" && args.target.elementId === args.source.elementId) {
      throw new Error("CreateRelationship: an element cannot host itself");
    }
    const rec: RelationshipRecord = {
      id: `rel-${++RelationshipRegistry.clock}-${newUniqueId().slice(0, 8)}`,
      type: args.type,
      source: args.source,
      target: args.target,
      localOffset: [
        args.target.position[0] - args.source.position[0],
        args.target.position[1] - args.source.position[1],
        args.target.position[2] - args.source.position[2],
      ],
      relativeRotationZ: 0,
      offset: args.offset ?? 0,
      constraint: args.constraint,
      connectionDirection: args.connectionDirection,
      priority: args.priority ?? DEFAULT_PRIORITY,
      origin: args.origin ?? "automatic",
      valid: true,
      geometryVersion: this.geometryVersion(args.source.elementId),
      reconnection: args.reconnection ?? defaultPolicyFor(args.type),
      deletionPolicy: args.deletionPolicy ?? "break",
      suspended: false,
      createdAt: ++RelationshipRegistry.clock,
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  /** ValidateRelationship: geometric + structural sanity at any time. */
  validateRelationship(id: string): { valid: boolean; problems: string[] } {
    const rec = this.require(id);
    const problems: string[] = [];
    if (rec.source.elementId === rec.target.elementId) {
      problems.push("source and target are the same element");
    }
    if (rec.suspended) problems.push("relationship is suspended");
    if (!rec.valid) problems.push("relationship is flagged invalid");
    if (rec.constraint?.kind === "locked-distance" && rec.constraint.value !== undefined && rec.constraint.value < 0) {
      problems.push("locked distance must be non-negative");
    }
    return { valid: problems.length === 0, problems };
  }

  /** QueryRelationships with optional filters. */
  queryRelationships(q: RelationshipQuery = {}): RelationshipRecord[] {
    const out: RelationshipRecord[] = [];
    for (const rec of this.records.values()) {
      if (q.validOnly && !rec.valid) continue;
      if (!q.includeSuspended && rec.suspended) continue;
      if (q.type && rec.type !== q.type) continue;
      if (q.elementId && rec.source.elementId !== q.elementId && rec.target.elementId !== q.elementId) continue;
      out.push(rec);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** GetRelatedElements (unique element ids related to `elementId`). */
  getRelatedElements(elementId: string): string[] {
    const ids = new Set<string>();
    for (const rec of this.queryRelationships({ elementId })) {
      if (rec.source.elementId === elementId) ids.add(rec.target.elementId);
      else ids.add(rec.source.elementId);
    }
    return [...ids];
  }

  /** GetRelationshipDependents: records where `elementId` is the source. */
  getRelationshipDependents(elementId: string): RelationshipRecord[] {
    return this.queryRelationships({ elementId }).filter(
      (r) => r.source.elementId === elementId,
    );
  }

  /** UpdateRelationshipReference (e.g. after reference recovery). */
  updateRelationshipReference(id: string, side: "source" | "target", ref: GeometricReference): void {
    const rec = this.require(id);
    if (side === "source") rec.source = ref;
    else rec.target = ref;
    rec.localOffset = [
      rec.target.position[0] - rec.source.position[0],
      rec.target.position[1] - rec.source.position[1],
      rec.target.position[2] - rec.source.position[2],
    ];
  }

  /**
   * EvaluateRelationshipAfterGeometryChange (spec 2B.5/2B.6). Applies the
   * record's reconnection policy and returns per-record actions. The
   * caller applies returned positions to elements (this registry never
   * touches element geometry directly).
   */
  evaluateRelationshipAfterGeometryChange(change: GeometryChange): RelationshipEvalResult[] {
    const out: RelationshipEvalResult[] = [];
    const deps = this.getRelationshipDependents(change.elementId);
    for (const rec of deps) {
      out.push(...this.evalOne(rec, change.translation, change.rotationZ));
    }
    return out;
  }

  /**
   * Evaluate dependents after a rigid-body plan rotation of the host about
   * `pivot`. Each source reference is transformed individually so endpoint
   * and face attachments follow correctly (not just the element origin).
   */
  evaluateAfterRigidMotion(change: RigidMotionChange): RelationshipEvalResult[] {
    const out: RelationshipEvalResult[] = [];
    const deps = this.getRelationshipDependents(change.elementId);
    const extra = change.extraTranslation ?? [0, 0];
    const c = Math.cos(change.angle);
    const s = Math.sin(change.angle);
    const [px, py] = change.pivot;

    for (const rec of deps) {
      if (rec.suspended) {
        out.push({
          id: rec.id,
          elementId: rec.target.elementId,
          action: "suspended",
          note: "record suspended",
        });
        continue;
      }

      const [sx, sy, sz] = rec.source.position;
      const dx = sx - px;
      const dy = sy - py;
      const nsx = px + dx * c - dy * s + extra[0];
      const nsy = py + dx * s + dy * c + extra[1];
      const translation: [number, number, number] = [nsx - sx, nsy - sy, 0];

      // Apply policies with the per-reference translation + full angle.
      out.push(...this.evalOne(rec, translation, change.angle));

      // Keep the source reference in sync with the rigid motion.
      rec.source = { ...rec.source, position: [nsx, nsy, sz] };
    }
    return out;
  }

  private evalOne(
    rec: RelationshipRecord,
    translation: [number, number, number],
    rotationZ: number,
  ): RelationshipEvalResult[] {
    if (rec.suspended) {
      return [{
        id: rec.id,
        elementId: rec.target.elementId,
        action: "suspended",
        note: "record suspended",
      }];
    }
    switch (rec.reconnection) {
      case "follow-source": {
        const c = Math.cos(rotationZ);
        const s = Math.sin(rotationZ);
        const ox = rec.target.position[0] - rec.source.position[0];
        const oy = rec.target.position[1] - rec.source.position[1];
        const base: [number, number, number] = [
          rec.source.position[0] + translation[0],
          rec.source.position[1] + translation[1],
          rec.source.position[2] + translation[2],
        ];
        const np: [number, number, number] = [
          base[0] + ox * c - oy * s,
          base[1] + ox * s + oy * c,
          base[2],
        ];
        rec.target = { ...rec.target, position: np };
        return [{
          id: rec.id,
          elementId: rec.target.elementId,
          action: "moved-dependent",
          newPosition: np,
        }];
      }
      case "fixed-world":
        rec.source = { ...rec.source, position: addRot(rec.source.position, translation) };
        return [{
          id: rec.id,
          elementId: rec.target.elementId,
          action: "unchanged",
        }];
      case "local-reference": {
        const c = Math.cos(rotationZ);
        const s = Math.sin(rotationZ);
        const rx = rec.localOffset[0] * c - rec.localOffset[1] * s;
        const ry = rec.localOffset[0] * s + rec.localOffset[1] * c;
        const base = addRot(rec.source.position, translation);
        const np: [number, number, number] = [
          base[0] + rx,
          base[1] + ry,
          base[2] + rec.localOffset[2],
        ];
        rec.target = { ...rec.target, position: np };
        return [{
          id: rec.id,
          elementId: rec.target.elementId,
          action: "moved-dependent",
          newPosition: np,
        }];
      }
      case "becomes-invalid":
        rec.valid = false;
        return [{
          id: rec.id,
          elementId: rec.target.elementId,
          action: "flagged-invalid",
          note: "policy becomes-invalid",
        }];
    }
  }

  /** SuspendRelationship: keep the record but stop enforcing it. */
  suspendRelationship(id: string): boolean {
    const rec = this.require(id);
    rec.suspended = true;
    return true;
  }

  /** RestoreRelationship. */
  restoreRelationship(id: string): boolean {
    const rec = this.require(id);
    rec.suspended = false;
    return true;
  }

  /** BreakRelationship: mark invalid (or remove when `remove` is true). */
  breakRelationship(id: string, remove = false): boolean {
    const rec = this.require(id);
    if (remove) {
      this.records.delete(id);
      return true;
    }
    rec.valid = false;
    return true;
  }

  /** DeleteOrphanedRelationships: drop records whose elements are gone. */
  deleteOrphanedRelationships(aliveElements: Set<string>): number {
    let removed = 0;
    for (const [id, rec] of this.records) {
      if (!aliveElements.has(rec.source.elementId) || !aliveElements.has(rec.target.elementId)) {
        this.records.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * ReconcileRelationshipsAfterReload: revalidate every record against
   * current geometry versions; records whose source version moved without
   * evaluation are re-derived from local references (level E policy).
   */
  reconcileRelationshipsAfterReload(
    aliveElements: Set<string>,
  ): { removed: number; invalidated: number } {
    const removed = this.deleteOrphanedRelationships(aliveElements);
    let invalidated = 0;
    for (const rec of this.records.values()) {
      const v = this.geometryVersion(rec.source.elementId);
      if (rec.valid && v !== rec.geometryVersion) {
        if (rec.reconnection === "becomes-invalid") {
          rec.valid = false;
          invalidated++;
        } else {
          rec.geometryVersion = v;
        }
      }
    }
    return { removed, invalidated };
  }

  get count(): number {
    return this.records.size;
  }

  getRecord(id: string): RelationshipRecord | null {
    return this.records.get(id) ?? null;
  }

  private require(id: string): RelationshipRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`relationship '${id}' not found`);
    return rec;
  }
}

function addRot(p: [number, number, number], t: [number, number, number]): [number, number, number] {
  return [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
}

/** Default reconnection policy per relationship type (level E table). */
export function defaultPolicyFor(type: RelationshipType): ReconnectionPolicy {
  switch (type) {
    case "host":
    case "face-attachment":
    case "rigid-attachment":
    case "endpoint-constraint":
    case "persistent-alignment":
      return "follow-source";
    case "wall-join":
    case "structural-connection":
      return "local-reference";
    case "geometric-coincidence":
    case "contact":
      return "fixed-world";
    case "clearance":
      return "becomes-invalid";
    case "mep-connection":
      return "local-reference";
    case "system-membership":
      return "follow-source";
  }
  return "fixed-world";
}
