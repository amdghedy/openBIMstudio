/**
 * Group 1 Modify tools — full function catalogs for Move, Rotate, Mirror
 * (MODIFY GROUP 1 spec §4–§6, docs/MODIFY_GROUP1_SPEC_V71.md).
 *
 * Implements the uploaded Modify master prompt §5.1/§5.2/§5.3 mandated
 * catalogs ON TOP of the existing v0.68 IModifyCommand engines:
 *
 *   MoveTool    BeginMove, AcquireMoveBasePoint, ResolveMoveTarget,
 *               CalculateMoveVector, GenerateMovePreview,
 *               EvaluateMoveDependencies, ValidateMove, CommitMove,
 *               CancelMove, UndoMove, RedoMove                      (§4)
 *   RotateTool  BeginRotate, AcquireRotationAxis, AcquireRotationPivot,
 *               ResolveRotationAngle, GenerateRotationPreview,
 *               ValidateRotation, UpdateDependentOrientations,
 *               CommitRotation, CancelRotation                      (§5)
 *   MirrorTool  BeginMirror, AcquireMirrorPlane, CalculateMirrorTransform,
 *               GenerateMirrorPreview, ResolveMirroredOrientation,
 *               CloneRelationships, ValidateMirror, CommitMirror    (§6)
 *
 * Discipline:
 *  - Previews NEVER mutate the store (pending change sets only).
 *  - Validate gates Commit; a failed command leaves NO partial state.
 *  - Hosted dependents rigidly follow (same Δ / same pivot θ) — the tool
 *    is the sole geometry writer during commit; relationship reference
 *    geometry is refreshed afterwards so the registry stays coherent
 *    (deviation D-16).
 *  - Undo/redo delegate to TransactionService when wired; each command
 *    is ONE undoable unit.
 *  - A temporary snap/reference NEVER becomes persistent implicitly.
 *
 * Diagnostic codes: MOD-MOV-nnn / MOD-ROT-nnn / MOD-MIR-nnn.
 * Pure module: no DOM — safe to unit-test in Node.
 */

import {
  type ElementPatch, type ElementStore, type ModifyContext, type ModifyDiagnostic,
  type ModifyElement, type PendingChange,
} from "./command";
import type { RelationshipRegistry, GeometricReference } from "../relationships";
import { detectAlignmentConflict } from "../snapping/alignment";
import { rotateAboutAxis } from "./transform";
import type { TransactionService, TransactionChange } from "../transaction";

/** ElementStore that can also delete (needed to undo copy-creating commands). */
export interface RemovableElementStore extends ElementStore {
  remove?(id: string): boolean;
}

// ── shared plumbing ──────────────────────────────────────────────────────

type Pt2 = [number, number];

const LIN_TOL = 1e-9;   // solver-grade linear tolerance (spec A3)
const ANG_TOL = 1e-12;  // angular tolerance (spec A3)

function clonePatch(el: ModifyElement, patch: ElementPatch): ElementPatch {
  return JSON.parse(JSON.stringify(patch)) as ElementPatch;
}

/** Capture the inverse patch (current values of the fields a patch will touch). */
function inversePatch(el: ModifyElement, patch: ElementPatch): ElementPatch {
  const inv: ElementPatch = { reason: `${patch.reason ?? "edit"}-undo` };
  if (patch.position) inv.position = [...el.position] as Pt2;
  if (patch.rotationZ !== undefined) inv.rotationZ = el.rotationZ;
  if (patch.curve) inv.curve = el.curve
    ? { start: [...el.curve.start] as Pt2, end: [...el.curve.end] as Pt2 }
    : undefined;
  if (patch.params) inv.params = { ...(el.params ?? {}) };
  return inv;
}

/**
 * TransactionService apply handler: replays / reverses recorded changes
 * against the store. Change encodings:
 *   propertyPath "transform" → oldValue/newValue are ElementPatch (apply merge)
 *   propertyPath "element"   → oldValue null + newValue element = creation
 */
export function makeStoreApplyHandler(store: RemovableElementStore) {
  return (change: TransactionChange, reverse: boolean): void => {
    if (change.propertyPath === "element") {
      const el = (reverse ? change.oldValue : change.newValue) as ModifyElement | null;
      if (el) {
        store.insert(JSON.parse(JSON.stringify(el)) as ModifyElement);
      } else if (reverse && store.remove) {
        store.remove(change.elementId);
      }
      return;
    }
    const patch = (reverse ? change.oldValue : change.newValue) as ElementPatch | undefined;
    if (patch) store.apply(change.elementId, JSON.parse(JSON.stringify(patch)) as ElementPatch);
  };
}

/** Eligibility gate shared by all Group 1 tools (spec §1.3). */
function checkEligibility(ctx: ModifyContext, ids: string[], codePrefix: string): ModifyDiagnostic[] {
  const diags: ModifyDiagnostic[] = [];
  if (!ids.length) {
    diags.push({ severity: "error", code: `${codePrefix}-001`, message: "no selection", elementIds: [] });
    return diags;
  }
  for (const id of ids) {
    const el = ctx.store.get(id);
    if (!el) {
      diags.push({ severity: "error", code: `${codePrefix}-001`, message: `element '${id}' not found`, elementIds: [id] });
      continue;
    }
    if (el.pinned) {
      diags.push({ severity: "error", code: `${codePrefix}-002`, message: `element '${id}' is pinned (unpin it first)`, elementIds: [id] });
    }
    if (!el.editable) {
      diags.push({ severity: "error", code: `${codePrefix}-001`, message: `element '${id}' is not editable`, elementIds: [id] });
    }
    if (ctx.lockedElementIds?.has(id)) {
      diags.push({ severity: "error", code: `${codePrefix}-003`, message: `element '${id}' is locked by another user`, elementIds: [id] });
    }
  }
  return diags;
}

/** Hosted/attached dependents of `ids` per the registry (source = host). */
function hostedDependents(ctx: ModifyContext, ids: string[]): string[] {
  const reg = ctx.relationships;
  if (!reg) return [];
  const idSet = new Set(ids);
  const out: string[] = [];
  for (const id of ids) {
    for (const rec of reg.getRelationshipDependents(id)) {
      const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
      if (!hostKind) continue;
      const dep = rec.target.elementId;
      if (!idSet.has(dep) && !out.includes(dep)) out.push(dep);
    }
  }
  return out;
}

/** Refresh stored reference geometry after the tool moved host + dependent. */
function refreshRelationshipRefs(
  reg: RelationshipRegistry,
  hostId: string,
  depId: string,
  hostPos: Pt2,
  depPos: Pt2,
): void {
  for (const rec of reg.getRelationshipDependents(hostId)) {
    const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
    if (!hostKind || rec.target.elementId !== depId) continue;
    reg.updateRelationshipReference(rec.id, "source", {
      elementId: hostId,
      kind: rec.source.kind,
      position: [hostPos[0], hostPos[1], 0],
    } satisfies GeometricReference);
    reg.updateRelationshipReference(rec.id, "target", {
      elementId: depId,
      kind: rec.target.kind,
      position: [depPos[0], depPos[1], 0],
    } satisfies GeometricReference);
  }
}

/** Post-commit reconciliation for non-host relationships (alignments etc.). */
function reconcileNonHost(reg: RelationshipRegistry, id: string, dx: number, dy: number, drot: number): string[] {
  const notes: string[] = [];
  const v = reg.geometryVersion(id) + 1;
  reg.setGeometryVersion(id, v);
  const results = reg.evaluateRelationshipAfterGeometryChange({
    elementId: id,
    newVersion: v,
    translation: [dx, dy, 0],
    rotationZ: drot,
  });
  for (const r of results) {
    if (r.action !== "unchanged") {
      notes.push(`${r.elementId}: ${r.action}${r.note ? ` (${r.note})` : ""}`);
    }
  }
  return notes;
}

function recordTxn(
  txn: TransactionService,
  store: RemovableElementStore,
  name: string,
  entries: Array<{ elementId: string; before: ElementPatch | null; after: ElementPatch | null; newElement?: ModifyElement }>,
): string {
  // The tools apply their pending patches THEMSELVES (authoritative write,
  // deviation D-16). TransactionService.recordChange always replays a
  // change through the apply handler, so the wrapped handler skips the
  // FIRST forward replay of each freshly recorded change (already applied
  // by the tool) and applies every subsequent replay (undo reverse,
  // redo forward).
  const seenAtRecord = new Set<string>();
  const base = makeStoreApplyHandler(store);
  txn.setApplyHandler((change, reverse) => {
    if (!reverse && !seenAtRecord.has(change.id)) {
      seenAtRecord.add(change.id);
      return; // initial forward apply already performed by the tool
    }
    base(change, reverse);
  });
  txn.start({ name, source: "user" });
  for (const e of entries) {
    if (e.newElement) {
      txn.recordChange({
        elementId: e.newElement.id,
        propertyPath: "element",
        oldValue: null,
        newValue: e.newElement,
        source: "user",
      });
      continue;
    }
    txn.recordChange({
      elementId: e.elementId,
      propertyPath: "transform",
      oldValue: e.before,
      newValue: e.after,
      source: "user",
    });
  }
  txn.commit();
  return "committed";
}

// ── Move (spec §4) ───────────────────────────────────────────────────────

export interface MoveDependencyReport {
  /** Hosted/attached elements that rigidly follow (not themselves selected). */
  hosted: string[];
  /** Other registry-related elements (reconciled after commit by policy). */
  connected: string[];
}

export interface MoveCommitResult {
  ok: boolean;
  applied: number;
  diagnostics: ModifyDiagnostic[];
  /** Non-host relationship reconciliation notes (post-commit actions). */
  reconciliation: string[];
}

export class MoveTool {
  readonly name = "move";
  private ids: string[] = [];
  private basePoint: Pt2 | null = null;
  private translation: Pt2 = [0, 0];
  private pending: PendingChange[] = [];
  private diags: ModifyDiagnostic[] = [];
  private followerIds: string[] = [];
  private started = false;

  constructor(
    private ctx: ModifyContext,
    private txn?: TransactionService,
  ) {}

  GetDiagnostics(): ModifyDiagnostic[] {
    return [...this.diags];
  }

  BeginMove(ids: string[]): void {
    this.reset();
    const gate = checkEligibility(this.ctx, ids, "MOD-MOV");
    this.diags.push(...gate);
    if (gate.some((d) => d.severity === "error")) {
      throw new Error(`BeginMove: ${gate.find((d) => d.severity === "error")!.message}`);
    }
    this.ids = [...ids];
    this.started = true;
  }

  AcquireMoveBasePoint(p: Pt2): void {
    this.assertStarted("AcquireMoveBasePoint");
    this.basePoint = [p[0], p[1]];
  }

  /** Resolve the target (snapped upstream); axis constraint projects Δ (spec §4.2). */
  ResolveMoveTarget(p: Pt2, opts?: { axis?: "x" | "y" }): Pt2 {
    this.assertStarted("ResolveMoveTarget");
    if (!this.basePoint) {
      throw new Error("ResolveMoveTarget: call AcquireMoveBasePoint first");
    }
    let dx = p[0] - this.basePoint[0];
    let dy = p[1] - this.basePoint[1];
    if (opts?.axis === "x") dy = 0;
    if (opts?.axis === "y") dx = 0;
    this.translation = [dx, dy];
    return [this.translation[0], this.translation[1]];
  }

  /** Numeric displacement input (bypasses base/target acquisition). */
  SetNumericTranslation(d: Pt2): void {
    this.assertStarted("SetNumericTranslation");
    this.translation = [d[0], d[1]];
  }

  CalculateMoveVector(): Pt2 {
    this.assertStarted("CalculateMoveVector");
    return [this.translation[0], this.translation[1]];
  }

  EvaluateMoveDependencies(): MoveDependencyReport {
    this.assertStarted("EvaluateMoveDependencies");
    const hosted = hostedDependents(this.ctx, this.ids);
    const reg = this.ctx.relationships;
    const connected: string[] = [];
    if (reg) {
      const idSet = new Set([...this.ids, ...hosted]);
      for (const id of this.ids) {
        for (const other of reg.getRelatedElements(id)) {
          if (!idSet.has(other) && !connected.includes(other)) connected.push(other);
        }
      }
    }
    return { hosted, connected };
  }

  GenerateMovePreview(): PendingChange[] {
    this.assertStarted("GenerateMovePreview");
    this.pending = [];
    this.followerIds = [];
    const [dx, dy] = this.translation;
    for (const id of this.ids) {
      const el = this.ctx.store.get(id);
      if (!el) continue;
      this.pending.push({
        elementId: id,
        patch: {
          position: [el.position[0] + dx, el.position[1] + dy],
          curve: el.curve
            ? { start: [el.curve.start[0] + dx, el.curve.start[1] + dy], end: [el.curve.end[0] + dx, el.curve.end[1] + dy] }
            : undefined,
          reason: "move",
        },
      });
    }
    // hosted rigid follow (spec §4.3) — same Δ, de-duplicated
    const deps = this.EvaluateMoveDependencies();
    for (const fid of deps.hosted) {
      const fel = this.ctx.store.get(fid);
      if (!fel) continue;
      this.followerIds.push(fid);
      this.pending.push({
        elementId: fid,
        patch: {
          position: [fel.position[0] + dx, fel.position[1] + dy],
          curve: fel.curve
            ? { start: [fel.curve.start[0] + dx, fel.curve.start[1] + dy], end: [fel.curve.end[0] + dx, fel.curve.end[1] + dy] }
            : undefined,
          reason: "move-hosted-follow",
        },
      });
      this.diags.push({ severity: "info", code: "MOD-MOV-011", message: `hosted element '${fid}' follows the moved host`, elementIds: [fid] });
    }
    // locked-alignment conflicts BLOCK the move (spec §4.3, MOD-MOV-010)
    const reg = this.ctx.relationships;
    if (reg) {
      for (const id of this.ids) {
        for (const conflict of detectAlignmentConflict(reg, id, [dx, dy])) {
          this.diags.push({ severity: "error", code: "MOD-MOV-010", message: `move blocked: ${conflict.message}`, elementIds: [id] });
        }
      }
    }
    return this.pending.map((p) => ({ elementId: p.elementId, patch: clonePatch(this.ctx.store.get(p.elementId)!, p.patch) }));
  }

  ValidateMove(): { ok: boolean; diagnostics: ModifyDiagnostic[] } {
    this.assertStarted("ValidateMove");
    const errors = this.diags.filter((d) => d.severity === "error");
    return { ok: errors.length === 0, diagnostics: [...this.diags] };
  }

  CommitMove(): MoveCommitResult {
    this.assertStarted("CommitMove");
    const v = this.ValidateMove();
    if (!v.ok) {
      return { ok: false, applied: 0, diagnostics: v.diagnostics, reconciliation: [] };
    }
    const store = this.ctx.store as RemovableElementStore;
    const entries: Array<{ elementId: string; before: ElementPatch | null; after: ElementPatch | null }> = [];
    let applied = 0;
    for (const p of this.pending) {
      const el = store.get(p.elementId);
      if (!el) continue;
      const before = inversePatch(el, p.patch);
      if (!store.apply(p.elementId, p.patch)) continue;
      applied += 1;
      entries.push({ elementId: p.elementId, before, after: clonePatch(el, p.patch) });
    }
    // relationship coherence: refresh host/dependent refs, reconcile others
    const reconciliation: string[] = [];
    const reg = this.ctx.relationships;
    if (reg) {
      const [dx, dy] = this.translation;
      for (const fid of this.followerIds) {
        const hostId = this.findHostOf(fid);
        if (hostId) {
          const hp = store.get(hostId)?.position;
          const fp = store.get(fid)?.position;
          if (hp && fp) refreshRelationshipRefs(reg, hostId, fid, hp, fp);
        }
      }
      for (const id of this.ids) {
        reconciliation.push(...reconcileNonHost(reg, id, dx, dy, 0));
      }
    }
    if (this.txn && entries.length) {
      recordTxn(this.txn, store, "Move", entries);
    } else if (!this.txn) {
      this.diags.push({ severity: "info", code: "MOD-MOV-020", message: "no transaction service wired — persistent undo unavailable", elementIds: [] });
    }
    this.started = false;
    return { ok: true, applied, diagnostics: [...this.diags], reconciliation };
  }

  CancelMove(): void {
    this.reset();
  }

  UndoMove(): boolean {
    if (!this.txn) {
      this.diags.push({ severity: "info", code: "MOD-MOV-020", message: "no transaction service wired — undo unavailable", elementIds: [] });
      return false;
    }
    return this.txn.undo();
  }

  RedoMove(): boolean {
    if (!this.txn) return false;
    return this.txn.redo();
  }

  private findHostOf(depId: string): string | null {
    const reg = this.ctx.relationships;
    if (!reg) return null;
    for (const rec of reg.queryRelationships({ elementId: depId })) {
      const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
      if (hostKind && rec.target.elementId === depId) return rec.source.elementId;
    }
    return null;
  }

  private assertStarted(who: string): void {
    if (!this.started) throw new Error(`MoveTool.${who}: command not started (call BeginMove first)`);
  }

  private reset(): void {
    this.ids = [];
    this.basePoint = null;
    this.translation = [0, 0];
    this.pending = [];
    this.followerIds = [];
    this.diags = [];
    this.started = false;
  }
}

// ── Rotate (spec §5) ─────────────────────────────────────────────────────

export interface RotateCommitResult {
  ok: boolean;
  applied: number;
  diagnostics: ModifyDiagnostic[];
  reconciliation: string[];
}

export class RotateTool {
  readonly name = "rotate";
  private ids: string[] = [];
  private axis: [number, number, number] = [0, 0, 1];
  private pivot: Pt2 | null = null;
  private angle = 0;
  private pending: PendingChange[] = [];
  private diags: ModifyDiagnostic[] = [];
  private followerIds: string[] = [];
  private started = false;

  constructor(
    private ctx: ModifyContext,
    private txn?: TransactionService,
  ) {}

  GetDiagnostics(): ModifyDiagnostic[] {
    return [...this.diags];
  }

  BeginRotate(ids: string[]): void {
    this.reset();
    const gate = checkEligibility(this.ctx, ids, "MOD-ROT");
    this.diags.push(...gate);
    if (gate.some((d) => d.severity === "error")) {
      throw new Error(`BeginRotate: ${gate.find((d) => d.severity === "error")!.message}`);
    }
    this.ids = [...ids];
    this.started = true;
  }

  /** Group 1 rotates in the plan (world ±Z); out-of-plane axes are Group 6 (D-16). */
  AcquireRotationAxis(axis?: [number, number, number]): void {
    this.assertStarted("AcquireRotationAxis");
    const a = axis ?? [0, 0, 1];
    const l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-15) {
      this.diags.push({ severity: "error", code: "MOD-ROT-002", message: "zero-length rotation axis", elementIds: [] });
      throw new Error("AcquireRotationAxis: zero-length axis (MOD-ROT-002)");
    }
    const z = Math.abs(a[2] / l);
    if (z < 1 - 1e-9) {
      this.diags.push({ severity: "error", code: "MOD-ROT-022", message: "out-of-plane rotation requires the 3-D element model (Group 6)", elementIds: [] });
      throw new Error("AcquireRotationAxis: out-of-plane axis not supported in Group 1 (MOD-ROT-022)");
    }
    this.axis = a[2] > 0 ? [0, 0, 1] : [0, 0, -1];
  }

  AcquireRotationPivot(p: Pt2): void {
    this.assertStarted("AcquireRotationPivot");
    this.pivot = [p[0], p[1]];
  }

  /**
   * Resolve the angle from numeric input or two points (spec §5.2).
   * opts.snapStep: angular snap θ' = round(θ/s)·s (spec §5.2, default off
   * for programmatic use — deviation D-15).
   */
  ResolveRotationAngle(
    input: { angle?: number; start?: Pt2; end?: Pt2 },
    opts?: { snapStep?: number },
  ): number {
    this.assertStarted("ResolveRotationAngle");
    if (!this.pivot) throw new Error("ResolveRotationAngle: call AcquireRotationPivot first");
    let theta: number;
    if (typeof input.angle === "number") {
      theta = input.angle;
    } else if (input.start && input.end) {
      const a0 = Math.atan2(input.start[1] - this.pivot[1], input.start[0] - this.pivot[0]);
      const a1 = Math.atan2(input.end[1] - this.pivot[1], input.end[0] - this.pivot[0]);
      theta = a1 - a0;
    } else {
      throw new Error("ResolveRotationAngle: provide angle or start+end points");
    }
    if (opts?.snapStep && opts.snapStep > 0) {
      const snapped = Math.round(theta / opts.snapStep) * opts.snapStep;
      this.diags.push({ severity: "info", code: "MOD-ROT-023", message: `angular snap: ${theta} → ${snapped}`, elementIds: [] });
      theta = snapped;
    }
    this.angle = theta;
    return theta;
  }

  GenerateRotationPreview(): PendingChange[] {
    this.assertStarted("GenerateRotationPreview");
    if (!this.pivot) throw new Error("GenerateRotationPreview: pivot not acquired");
    this.pending = [];
    this.followerIds = [];
    const c = Math.cos(this.angle);
    const s = Math.sin(this.angle);
    const [qx, qy] = this.pivot;
    const rot2 = (p: Pt2): Pt2 => [qx + (p[0] - qx) * c - (p[1] - qy) * s, qy + (p[0] - qx) * s + (p[1] - qy) * c];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id);
      if (!el) continue;
      if (Math.hypot(el.position[0] - qx, el.position[1] - qy) < LIN_TOL) {
        this.diags.push({ severity: "info", code: "MOD-ROT-020", message: `element '${id}' coincides with the pivot — rotation-invariant position`, elementIds: [id] });
      }
      this.pending.push({
        elementId: id,
        patch: {
          position: rot2(el.position),
          rotationZ: el.rotationZ + this.angle,
          curve: el.curve
            ? { start: rot2(el.curve.start), end: rot2(el.curve.end) }
            : undefined,
          reason: "rotate",
        },
      });
    }
    // hosted dependents rotate about the SAME pivot (spec §5.3)
    const deps = hostedDependents(this.ctx, this.ids);
    for (const fid of deps) {
      const fel = this.ctx.store.get(fid);
      if (!fel) continue;
      this.followerIds.push(fid);
      this.pending.push({
        elementId: fid,
        patch: {
          position: rot2(fel.position),
          rotationZ: fel.rotationZ + this.angle,
          curve: fel.curve
            ? { start: rot2(fel.curve.start), end: rot2(fel.curve.end) }
            : undefined,
          reason: "rotate-hosted-follow",
        },
      });
      this.diags.push({ severity: "info", code: "MOD-ROT-024", message: `hosted element '${fid}' rotates with its host about the same pivot`, elementIds: [fid] });
    }
    // constraint proximity warnings (spec §5.5)
    const reg = this.ctx.relationships;
    if (reg && Math.abs(this.angle) > ANG_TOL) {
      for (const id of this.ids) {
        for (const conflict of detectAlignmentConflict(reg, id, [c, s])) {
          this.diags.push({ severity: "warning", code: "MOD-ROT-010", message: `rotation may violate ${conflict.kind}: ${conflict.message}`, elementIds: [id] });
        }
      }
    }
    return this.pending.map((p) => ({ elementId: p.elementId, patch: clonePatch(this.ctx.store.get(p.elementId)!, p.patch) }));
  }

  ValidateRotation(): { ok: boolean; diagnostics: ModifyDiagnostic[] } {
    this.assertStarted("ValidateRotation");
    if (Math.abs(this.angle) < ANG_TOL) {
      this.diags.push({ severity: "info", code: "MOD-ROT-021", message: "zero-angle rotate rejected as no-op", elementIds: [] });
    }
    const errors = this.diags.filter((d) => d.severity === "error");
    return { ok: errors.length === 0, diagnostics: [...this.diags] };
  }

  /** UpdateDependentOrientations — exposed for callers that reconcile manually. */
  UpdateDependentOrientations(): string[] {
    return [...this.followerIds];
  }

  CommitRotation(): RotateCommitResult {
    this.assertStarted("CommitRotation");
    const v = this.ValidateRotation();
    if (!v.ok) {
      return { ok: false, applied: 0, diagnostics: v.diagnostics, reconciliation: [] };
    }
    if (Math.abs(this.angle) < ANG_TOL) {
      return { ok: false, applied: 0, diagnostics: v.diagnostics, reconciliation: [] };
    }
    const store = this.ctx.store as RemovableElementStore;
    const entries: Array<{ elementId: string; before: ElementPatch | null; after: ElementPatch | null }> = [];
    let applied = 0;
    for (const p of this.pending) {
      const el = store.get(p.elementId);
      if (!el) continue;
      const before = inversePatch(el, p.patch);
      if (!store.apply(p.elementId, p.patch)) continue;
      applied += 1;
      entries.push({ elementId: p.elementId, before, after: clonePatch(el, p.patch) });
    }
    const reconciliation: string[] = [];
    const reg = this.ctx.relationships;
    if (reg) {
      for (const fid of this.followerIds) {
        const hostId = this.findHostOf(fid);
        if (hostId) {
          const hp = store.get(hostId)?.position;
          const fp = store.get(fid)?.position;
          if (hp && fp) refreshRelationshipRefs(reg, hostId, fid, hp, fp);
        }
      }
      for (const id of this.ids) {
        reconciliation.push(...reconcileNonHost(reg, id, 0, 0, this.angle));
      }
    }
    if (this.txn && entries.length) {
      recordTxn(this.txn, store, "Rotate", entries);
    }
    this.started = false;
    return { ok: true, applied, diagnostics: [...this.diags], reconciliation };
  }

  CancelRotation(): void {
    this.reset();
  }

  private findHostOf(depId: string): string | null {
    const reg = this.ctx.relationships;
    if (!reg) return null;
    for (const rec of reg.queryRelationships({ elementId: depId })) {
      const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
      if (hostKind && rec.target.elementId === depId) return rec.source.elementId;
    }
    return null;
  }

  private assertStarted(who: string): void {
    if (!this.started) throw new Error(`RotateTool.${who}: command not started (call BeginRotate first)`);
  }

  private reset(): void {
    this.ids = [];
    this.pivot = null;
    this.angle = 0;
    this.pending = [];
    this.followerIds = [];
    this.diags = [];
    this.started = false;
  }
}

// ── Mirror (spec §6) ─────────────────────────────────────────────────────

export interface MirrorTransform {
  /** Mirror-line anchor point Q. */
  q: Pt2;
  /** Unit direction d of the mirror line; φ = atan2(d.y, d.x). */
  d: Pt2;
  phi: number;
  /** Reflect a point: X' = Q + M(X − Q), M = 2ddᵀ − I. */
  reflectPoint(p: Pt2): Pt2;
  /** Reflect an orientation: θ' = 2φ − θ. */
  reflectAngle(theta: number): number;
}

export interface MirroredOrientation {
  rotationZ: number;
  handFlipped: boolean;
  facingFlipped: boolean;
}

export interface MirrorCommitResult {
  ok: boolean;
  applied: number;
  createdIds: string[];
  clonedRelationships: number;
  diagnostics: ModifyDiagnostic[];
}

export class MirrorTool {
  readonly name = "mirror";
  private ids: string[] = [];
  private copy = true;
  private transform: MirrorTransform | null = null;
  private pending: PendingChange[] = [];
  private diags: ModifyDiagnostic[] = [];
  private createdIds: string[] = [];
  private started = false;

  constructor(
    private ctx: ModifyContext,
    private txn?: TransactionService,
  ) {}

  GetDiagnostics(): ModifyDiagnostic[] {
    return [...this.diags];
  }

  BeginMirror(ids: string[], copy = true): void {
    this.reset();
    const gate = checkEligibility(this.ctx, ids, "MOD-MIR");
    this.diags.push(...gate);
    if (gate.some((d) => d.severity === "error")) {
      throw new Error(`BeginMirror: ${gate.find((d) => d.severity === "error")!.message}`);
    }
    this.ids = [...ids];
    this.copy = copy;
    if (!copy) {
      this.diags.push({ severity: "info", code: "MOD-MIR-020", message: "move-mode mirror (originals transformed in place)", elementIds: [] });
    }
    this.started = true;
  }

  AcquireMirrorPlane(point: Pt2, dir: Pt2): void {
    this.assertStarted("AcquireMirrorPlane");
    const l = Math.hypot(dir[0], dir[1]);
    if (l < 1e-15) {
      this.diags.push({ severity: "error", code: "MOD-MIR-002", message: "zero-length mirror direction", elementIds: [] });
      throw new Error("AcquireMirrorPlane: zero-length direction (MOD-MIR-002)");
    }
    const d: Pt2 = [dir[0] / l, dir[1] / l];
    const q: Pt2 = [point[0], point[1]];
    const phi = Math.atan2(d[1], d[0]);
    const m00 = 2 * d[0] * d[0] - 1;
    const m01 = 2 * d[0] * d[1];
    const m10 = 2 * d[1] * d[0];
    const m11 = 2 * d[1] * d[1] - 1;
    this.transform = {
      q,
      d,
      phi,
      reflectPoint: (p: Pt2): Pt2 => {
        const vx = p[0] - q[0];
        const vy = p[1] - q[1];
        return [q[0] + m00 * vx + m01 * vy, q[1] + m10 * vx + m11 * vy];
      },
      reflectAngle: (theta: number): number => 2 * phi - theta,
    };
  }

  CalculateMirrorTransform(): MirrorTransform {
    this.assertStarted("CalculateMirrorTransform");
    if (!this.transform) throw new Error("CalculateMirrorTransform: call AcquireMirrorPlane first");
    return this.transform;
  }

  /** Orientation resolution (spec §6.2): θ' = 2φ − θ; hand/facing flip. */
  ResolveMirroredOrientation(el: ModifyElement): MirroredOrientation {
    const t = this.CalculateMirrorTransform();
    const out: MirroredOrientation = {
      rotationZ: t.reflectAngle(el.rotationZ),
      handFlipped: false,
      facingFlipped: false,
    };
    if (el.params && "hand" in el.params) {
      out.handFlipped = true;
    }
    if (el.params && "facing" in el.params) {
      out.facingFlipped = true;
    }
    return out;
  }

  GenerateMirrorPreview(): PendingChange[] {
    this.assertStarted("GenerateMirrorPreview");
    const t = this.CalculateMirrorTransform();
    this.pending = [];
    this.createdIds = [];
    for (const id of this.ids) {
      const el = this.ctx.store.get(id);
      if (!el) continue;
      const mirrored = this.mirrorElement(el, t);
      if (this.copy) {
        const newId = this.ctx.allocateId ? this.ctx.allocateId() : `${el.id}_mirrored`;
        const clone: ModifyElement = { ...mirrored, id: newId, pinned: false };
        this.createdIds.push(newId);
        this.pending.push({ elementId: el.id, patch: { reason: "mirror-copy-source" }, newElement: clone });
      } else {
        this.pending.push({
          elementId: el.id,
          patch: {
            position: mirrored.position,
            rotationZ: mirrored.rotationZ,
            curve: mirrored.curve,
            params: mirrored.params,
            reason: "mirror-move",
          },
        });
      }
    }
    // overlap warning (spec §6.5 MOD-MIR-003): a mirrored element lands on
    // a DIFFERENT original (its own reflection is its correct new place).
    if (this.copy) {
      for (const id of this.ids) {
        const el = this.ctx.store.get(id);
        if (!el) continue;
        const rp = t.reflectPoint(el.position);
        for (const otherId of this.ids) {
          if (otherId === id) continue;
          const other = this.ctx.store.get(otherId);
          if (!other) continue;
          if (Math.hypot(other.position[0] - rp[0], other.position[1] - rp[1]) < 1e-6) {
            this.diags.push({ severity: "warning", code: "MOD-MIR-003", message: `mirrored element '${id}' would coincide with original '${otherId}'`, elementIds: [id] });
          }
        }
      }
    }
    return this.pending;
  }

  /**
   * CloneRelationships (spec §6.3): clone registry records that touch
   * mirrored elements, remapping ids via `mapping` and mirroring
   * reference geometry. temporary-snap records are never cloned;
   * records between two mirrored elements are cloned exactly once.
   * Returns the number of cloned records.
   */
  CloneRelationships(mapping: Map<string, string>): number {
    const reg = this.ctx.relationships;
    if (!reg || this.copy === false) return 0;
    const t = this.transform;
    if (!t) return 0;
    const seen = new Set<string>();
    let cloned = 0;
    for (const id of this.ids) {
      for (const rec of reg.queryRelationships({ elementId: id })) {
        if (rec.type === "temporary-snap") continue;
        const srcMapped = mapping.get(rec.source.elementId);
        const tgtMapped = mapping.get(rec.target.elementId);
        const newSrc = srcMapped ?? rec.source.elementId;
        const newTgt = tgtMapped ?? rec.target.elementId;
        if (newSrc === newTgt) continue; // would be self-relationship
        const key = [rec.type, newSrc, newTgt].sort().join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        const mirrorRef = (r: GeometricReference, ownerId: string): GeometricReference => {
          const rp = t.reflectPoint([r.position[0], r.position[1]]);
          return { elementId: ownerId, kind: r.kind, position: [rp[0], rp[1], r.position[2]] };
        };
        reg.createRelationship({
          type: rec.type,
          source: mirrorRef(rec.source, newSrc),
          target: mirrorRef(rec.target, newTgt),
          offset: rec.offset,
          constraint: rec.constraint,
          reconnection: rec.reconnection,
          deletionPolicy: rec.deletionPolicy,
          priority: rec.priority,
          origin: rec.origin,
          connectionDirection: rec.connectionDirection,
        });
        cloned += 1;
      }
    }
    return cloned;
  }

  ValidateMirror(): { ok: boolean; diagnostics: ModifyDiagnostic[] } {
    this.assertStarted("ValidateMirror");
    const errors = this.diags.filter((d) => d.severity === "error");
    return { ok: errors.length === 0, diagnostics: [...this.diags] };
  }

  CommitMirror(): MirrorCommitResult {
    this.assertStarted("CommitMirror");
    if (!this.pending.length) this.GenerateMirrorPreview();
    const v = this.ValidateMirror();
    if (!v.ok) {
      return { ok: false, applied: 0, createdIds: [], clonedRelationships: 0, diagnostics: v.diagnostics };
    }
    const store = this.ctx.store as RemovableElementStore;
    const t = this.transform!;
    const entries: Array<{ elementId: string; before: ElementPatch | null; after: ElementPatch | null; newElement?: ModifyElement }> = [];
    let applied = 0;
    const reg = this.ctx.relationships;
    const mapping = new Map<string, string>();
    for (const p of this.pending) {
      if (p.newElement) {
        mapping.set(p.elementId, p.newElement.id);
      }
    }
    for (const p of this.pending) {
      if (p.newElement) {
        store.insert(JSON.parse(JSON.stringify(p.newElement)) as ModifyElement);
        applied += 1;
        entries.push({ elementId: p.elementId, before: null, after: null, newElement: p.newElement });
        continue;
      }
      const el = store.get(p.elementId);
      if (!el) continue;
      const before = inversePatch(el, p.patch);
      if (!store.apply(p.elementId, p.patch)) continue;
      applied += 1;
      entries.push({ elementId: p.elementId, before, after: clonePatch(el, p.patch) });
    }
    // host remapping rule (spec §6.3, D-13): a mirrored copy of a hosted
    // element whose host is NOT mirrored detaches with MOD-MIR-010.
    if (reg && this.copy) {
      for (const [orig, copyId] of mapping) {
        for (const rec of reg.queryRelationships({ elementId: orig })) {
          const hostKind = rec.type === "host" || rec.type === "face-attachment" || rec.type === "rigid-attachment";
          if (hostKind && rec.target.elementId === orig && !mapping.has(rec.source.elementId)) {
            this.diags.push({ severity: "warning", code: "MOD-MIR-010", message: `mirrored copy '${copyId}' detached — its host '${rec.source.elementId}' was not mirrored`, elementIds: [copyId] });
          }
        }
      }
    }
    const cloned = this.CloneRelationships(mapping);
    if (this.txn && entries.length) {
      recordTxn(this.txn, store, "Mirror", entries);
    }
    this.started = false;
    return {
      ok: true,
      applied,
      createdIds: [...this.createdIds],
      clonedRelationships: cloned,
      diagnostics: [...this.diags],
    };
  }

  CancelMirror(): void {
    this.reset();
  }

  /**
   * World-space mirror (spec §6.2, world-curve convention): position is
   * reflected as a point, orientation maps θ' = 2φ − θ, and curve
   * endpoints (stored in WORLD coordinates — the platform's
   * authored-element convention, see engine-ui authoredElementStore)
   * are reflected directly. Hand/facing parameters flip because the
   * reflection is orientation-reversing.
   */
  private mirrorElement(el: ModifyElement, t: MirrorTransform): ModifyElement {
    const pos2 = t.reflectPoint(el.position);
    const orient = this.ResolveMirroredOrientation(el);
    const theta = orient.rotationZ;
    let curve: ModifyElement["curve"];
    if (el.curve) {
      curve = {
        start: t.reflectPoint(el.curve.start),
        end: t.reflectPoint(el.curve.end),
      };
    }
    const params = el.params ? { ...el.params } : undefined;
    if (params && "hand" in params) params.hand = params.hand === 0 ? 1 : 0;
    if (params && "facing" in params) params.facing = params.facing === 0 ? 1 : 0;
    return {
      ...el,
      position: pos2,
      rotationZ: theta,
      curve,
      params,
    };
  }

  private assertStarted(who: string): void {
    if (!this.started) throw new Error(`MirrorTool.${who}: command not started (call BeginMirror first)`);
  }

  private reset(): void {
    this.ids = [];
    this.transform = null;
    this.pending = [];
    this.diags = [];
    this.createdIds = [];
    this.started = false;
  }
}
