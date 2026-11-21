/**
 * Central binding — binds the server-authoritative central model
 * (`server/central-model.mjs` + `src/modules/collaboration/central-client.ts`)
 * to the live authoring model.
 *
 * What this module does (and the local `WorksharingEngine` does not):
 *  - pushes local authoring edits to the central room (debounced, so a drag
 *    produces one op, not one per mouse move);
 *  - applies remote central state to the local model: field updates,
 *    materialisation of elements created by other users, and removal of
 *    elements deleted by other users;
 *  - enforces central borrows in the authoring path: while joined, the
 *    edit guard (see `edit-guard.ts`) refuses edits/deletes of elements
 *    borrowed by another user, or in a workset owned by another user,
 *    with a reason naming the holder;
 *  - surfaces open merge conflicts (server value wins, both values kept)
 *    so the worksharing panel can offer an explicit resolution.
 *
 * What it deliberately does NOT do:
 *  - merge, order or resolve anything locally. The server is the only
 *    ordering authority; local state is replaced by the server's whenever
 *    the two disagree (central wins at join, central wins on a failed push).
 *  - move geometry. The field set is explicit (`SYNC_PARAM_KEYS` below);
 *    anything outside it (sweeps, hosted-opening cuts, `properties`,
 *    families) stays local-only for this rank.
 *
 * Identity: local element ids are opaque (`uid()`). Central element ids are
 * the id the element had when it was first pushed — i.e. the *creating*
 * client's local id. A client that materialises a remote element creates a
 * NEW local id for it and records the mapping (`centralToLocal` /
 * `localToCentral`); later pushes for that element use the central id, so
 * both clients keep editing the same central element under different local
 * ids. The mapping is rebuilt on every join from the central state.
 *
 * Divergence: if a remote field cannot be applied locally (validation
 * rejects it, or a referenced level does not exist in this project), the
 * local value is kept and the field is *pinned*: the push diff skips it
 * until the user edits it, so the stale local value is never pushed back
 * over the server's value. A notice is emitted for every pinned field.
 *
 * Unpushed local edits are never overwritten by a remote state update:
 * `applyCentralElement` only applies fields the server actually changed
 * since the last agreed state (`lastKnown`) AND the local user has not
 * changed since then. A field the local user edited but has not pushed
 * yet stays local and goes out with the next push (with a stale
 * baseRevision, so the server records a real conflict if the other side
 * changed the same field). The one exception is a server refusal (409):
 * there the server has already ruled on the local edit, so central wins
 * on every field and the local value is reverted.
 *
 * This module is DOM-free and THREE-free on purpose: the model adapter is
 * injected, so the binding compiles to CJS for the Node integration tests
 * (`tests/central-binding.test.cjs`) with a fake in-memory adapter. The
 * browser adapter lives in `authoring-adapter.ts`.
 */

import {
  CentralClient,
  centralClient,
  type CentralState,
} from "./central-client";
import {
  checkEditAllowed,
  registerEditGuard,
  withGuardSuspended,
  type EditGuardResult,
} from "./edit-guard";

function cloneJson<T>(v: T): T {
  return v === undefined ? (undefined as unknown as T) : JSON.parse(JSON.stringify(v));
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The only fields the binding syncs. Scalar params go through the
 * validated `applyElementParamChange` path; `start`/`end`/`point`/`polygon`
 * are plan geometry (Vec2 arrays); `baseLevelId`/`topLevelId` are level
 * constraints, applied only when the level exists locally. `length` is
 * deliberately absent: it is derived from `start`/`end`.
 */
export const SYNC_PARAM_KEYS = [
  "height",
  "thickness",
  "elevation",
  "rotation",
  "width",
  "depth",
  "sillHeight",
  "offsetAlongHost",
  "frameThickness",
  "baseOffset",
  "topOffset",
  "endElevation",
  "start",
  "end",
  "point",
  "polygon",
  "baseLevelId",
  "topLevelId",
] as const;

export type CentralElementLike = {
  id: string;
  type: string;
  name: string;
  hostId?: string;
  params: Record<string, unknown>;
};

export interface CentralModelAdapter {
  listElements(): CentralElementLike[];
  getElement(id: string): CentralElementLike | null;
  getLevels(): Array<{ id: string }>;
  getActiveWorksetId(): string;
  /**
   * Apply central fields to a local element through the validated authoring
   * path. `fields` are central fields (a subset of the element's full field
   * map); only sync keys are applied. Returns which fields were skipped
   * (e.g. a level constraint whose level does not exist locally) so the
   * binding can pin them instead of echoing the stale local value back.
   */
  applyRemoteFields(
    id: string,
    fields: Record<string, unknown>,
  ): { ok: boolean; reason?: string; skippedFields?: string[] };
  /** Create a local element from central fields; returns the new LOCAL id. */
  createElementFromCentral(
    fields: Record<string, unknown>,
  ): Promise<string | null>;
  /** Remove a local element without pushing anything (remote delete). */
  removeElementLocal(id: string): boolean;
  subscribeLocalChanges(cb: () => void): () => void;
  /** Legacy local selection locks (workshare-locks); null when unguarded. */
  isLocallyLocked?(id: string): { locked: boolean; owner?: string } | null;
  onNotice?(kind: "info" | "warn" | "error", message: string): void;
}

export type CentralNoticeKind = "info" | "warn" | "error";

export interface CentralBindingStatus {
  joined: boolean;
  roomId: string;
  clientId: string;
  name: string;
  revision: number;
  members: Array<{ clientId: string; name: string; role: string }>;
  borrows: Record<string, { borrower: string; borrowerName?: string }>;
  openConflicts: any[];
  openConflictCount: number;
  queuedOps: number;
  localElements: number;
}

/** The central field map for a local element (root + synced params). */
export function elementToCentralFields(
  el: CentralElementLike,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    type: el.type,
    name: el.name,
  };
  if (el.hostId) fields.hostId = el.hostId;
  for (const k of SYNC_PARAM_KEYS) {
    const v = (el.params as any)[k];
    if (v !== undefined) fields[k] = cloneJson(v);
  }
  return fields;
}

/** Central fields that differ from the local element's fields. */
export function diffFields(
  localFields: Record<string, unknown>,
  centralFields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(centralFields)) {
    if (k !== "type" && k !== "name" && k !== "hostId" && !(SYNC_PARAM_KEYS as readonly string[]).includes(k)) continue;
    if (!fieldsEqual(localFields[k], v)) out[k] = cloneJson(v);
  }
  return out;
}

const PUSH_DEBOUNCE_MS = 400;

/** Active binding (set by `setupCentralBinding`); null when dormant. */
let activeBinding: CentralBinding | null = null;

export function setActiveCentralBinding(b: CentralBinding | null): void {
  activeBinding = b;
}

export function getActiveCentralBinding(): CentralBinding | null {
  return activeBinding;
}

export class CentralBinding {
  readonly client: CentralClient;
  readonly adapter: CentralModelAdapter;

  joined = false;
  roomId = "";

  private centralToLocal = new Map<string, string>();
  private localToCentral = new Map<string, string>();
  /** centralId -> fields as last agreed between local model and central. */
  private lastKnown = new Map<string, Record<string, unknown>>();
  /** centralId -> central element version already applied locally. */
  private appliedVersion = new Map<string, number>();
  /**
   * centralId -> field -> local value at the time the remote value could
   * not be applied. While the local value is unchanged from the pinned
   * value, the push diff skips the field (never echo a stale value back
   * over the server's). A user edit changes the local value, unpins the
   * field, and the new value pushes normally.
   */
  private pinnedFields = new Map<string, Map<string, unknown>>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pushing = false;
  private applyingRemote = false;
  private unsubLocal: (() => void) | null = null;
  private unregisterGuard: (() => void) | null = null;
  private statusListeners = new Set<(s: CentralBindingStatus) => void>();
  private conflictListeners = new Set<(conflicts: any[]) => void>();
  private noticeListeners = new Set<(kind: CentralNoticeKind, message: string) => void>();

  constructor(client: CentralClient = centralClient, adapter: CentralModelAdapter) {
    this.client = client;
    this.adapter = adapter;
    this.unregisterGuard = registerEditGuard((id) => this.editGuard(id));
    this.unsubLocal = adapter.subscribeLocalChanges(() => this.schedulePush());
    // Subscribe once: applyRemoteState / emitConflicts are no-ops until joined.
    this.client.subscribeState((s) => void this.applyRemoteState(s));
    this.client.subscribeConflicts((c) => this.emitConflicts(c));
  }

  subscribeStatus(fn: (s: CentralBindingStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  subscribeConflicts(fn: (conflicts: any[]) => void): () => void {
    this.conflictListeners.add(fn);
    return () => this.conflictListeners.delete(fn);
  }

  subscribeNotices(fn: (kind: CentralNoticeKind, message: string) => void): () => void {
    this.noticeListeners.add(fn);
    return () => this.noticeListeners.delete(fn);
  }

  private notice(kind: CentralNoticeKind, message: string): void {
    try {
      this.adapter.onNotice?.(kind, message);
    } catch { /* notice sink must never break sync */ }
    for (const fn of this.noticeListeners) {
      try { fn(kind, message); } catch { /* ignore */ }
    }
  }

  private emitStatus(): void {
    const s = this.getStatus();
    for (const fn of this.statusListeners) {
      try { fn(s); } catch { /* ignore */ }
    }
  }

  private emitConflicts(conflicts: any[]): void {
    if (!this.joined || !conflicts.length) return;
    for (const fn of this.conflictListeners) {
      try { fn(conflicts); } catch { /* ignore */ }
    }
  }

  getStatus(): CentralBindingStatus {
    const st = this.client.state;
    return {
      joined: this.joined,
      roomId: this.roomId,
      clientId: this.client.clientId,
      name: this.client.name,
      revision: this.client.revision,
      members: st
        ? Object.values(st.members).map((m: any) => ({ clientId: m.clientId, name: m.name, role: m.role }))
        : [],
      borrows: st ? { ...(st.borrows as any) } : {},
      openConflicts: st ? [...(st.conflicts as any[])] : [],
      openConflictCount: st ? st.openConflictCount : 0,
      queuedOps: (this.client as any).queue ? (this.client as any).queue.length : 0,
      localElements: this.adapter.listElements().length,
    };
  }

  memberName(clientId: string): string | null {
    const m = this.client.state?.members?.[clientId];
    return m ? String(m.name || "") : null;
  }

  /** The edit guard the authoring path consults (see edit-guard.ts). */
  editGuard(elementId: string): EditGuardResult {
    if (!this.joined || !this.client.state) return { allowed: true };
    const st = this.client.state;
    const centralId = this.localToCentral.get(elementId) ?? elementId;
    const b = (st.borrows as any)[centralId];
    if (b && b.borrower !== this.client.clientId) {
      const name = this.memberName(b.borrower) || b.borrowerName || b.borrower;
      return {
        allowed: false,
        reason: `borrowed by ${name} — borrow it (or request it) before editing`,
      };
    }
    const el = (st.elements as any)[centralId];
    if (el?.worksetId) {
      const ws = (st.worksets as any)[el.worksetId];
      if (ws?.owner && ws.owner !== this.client.clientId) {
        const owner = this.memberName(ws.owner) || ws.owner;
        return {
          allowed: false,
          reason: `workset "${ws.name}" is owned by ${owner} — borrow the element first`,
        };
      }
    }
    try {
      const local = this.adapter.isLocallyLocked?.(elementId);
      if (local?.locked) {
        return {
          allowed: false,
          reason: `locked by ${local.owner || "another user"}`,
        };
      }
    } catch { /* fall through */ }
    return { allowed: true };
  }

  /** Test/consumer helper: the guard result for a local element id. */
  checkEditAllowed(elementId: string): EditGuardResult {
    return checkEditAllowed(elementId);
  }

  /** Central id for a local element id (identity when never synced). */
  toCentralId(localId: string): string {
    return this.localToCentral.get(localId) ?? localId;
  }

  /** Local id for a central element id, if materialised locally. */
  toLocalId(centralId: string): string | undefined {
    return this.centralToLocal.get(centralId);
  }

  async join(roomId: string, name = "Guest"): Promise<boolean> {
    const ok = await this.client.join(roomId, name);
    if (!ok) return false;
    this.joined = true;
    this.roomId = roomId;
    await this.reconcileAfterJoin();
    this.emitStatus();
    return true;
  }

  async leave(): Promise<void> {
    this.joined = false;
    this.roomId = "";
    this.client.stop();
    this.emitStatus();
  }

  /** Stop entirely: leave, unregister the guard, drop the id map. */
  stop(): void {
    void this.leave();
    if (activeBinding === this) activeBinding = null;
    try { this.unregisterGuard?.(); } catch { /* ignore */ }
    this.unregisterGuard = null;
    try { this.unsubLocal?.(); } catch { /* ignore */ }
    this.unsubLocal = null;
    this.centralToLocal.clear();
    this.localToCentral.clear();
    this.lastKnown.clear();
    this.appliedVersion.clear();
    this.pinnedFields.clear();
  }

  /** Manual re-sync: pull server state, flush the offline queue, push local edits. */
  async syncNow(): Promise<void> {
    if (!this.joined) return;
    await this.client.sync();
    await this.client.flushQueue();
    await this.pushLocalChanges(true);
  }

  async borrow(elementId: string): Promise<any> {
    const centralId = this.localToCentral.get(elementId) ?? elementId;
    const r = await this.client.borrow(centralId);
    if (r?.ok) {
      await this.client.fetchState();
      this.emitStatus();
    }
    return r;
  }

  async relinquish(elementId: string): Promise<any> {
    const centralId = this.localToCentral.get(elementId) ?? elementId;
    const r = await this.client.relinquish(centralId);
    if (r?.ok) {
      await this.client.fetchState();
      this.emitStatus();
    }
    return r;
  }

  async requestBorrow(elementId: string): Promise<any> {
    const centralId = this.localToCentral.get(elementId) ?? elementId;
    return this.client.requestBorrow(centralId);
  }

  async resolveConflict(
    conflictId: string,
    choice: "mine" | "theirs" | { value: any },
  ): Promise<any> {
    const r = await this.client.resolveConflict(conflictId, choice);
    if (r?.ok) {
      await this.client.fetchState();
      const st = this.client.state;
      if (st) await this.applyRemoteState(st);
      this.emitStatus();
    }
    return r;
  }

  // ── Reconciliation ──────────────────────────────────────────────────

  private centralIdForLocal(localId: string): string {
    return this.localToCentral.get(localId) ?? localId;
  }

  private pinField(centralId: string, field: string, localValue: unknown): void {
    let m = this.pinnedFields.get(centralId);
    if (!m) {
      m = new Map();
      this.pinnedFields.set(centralId, m);
    }
    m.set(field, cloneJson(localValue));
  }

  private isPinned(centralId: string, field: string, localValue: unknown): boolean {
    const m = this.pinnedFields.get(centralId);
    if (!m || !m.has(field)) return false;
    if (!fieldsEqual(m.get(field), localValue)) {
      // The user edited the field since it was pinned: unpin, push it.
      m.delete(field);
      return false;
    }
    return true;
  }

  /** Join-time reconcile: central wins on divergence; local-only elements push up. */
  private async reconcileAfterJoin(): Promise<void> {
    const st = this.client.state;
    if (!st) return;
    this.applyingRemote = true;
    try {
      // Non-hosted elements first, hosted ones after (their host must exist locally).
      const ordered = [...Object.values(st.elements as any)].sort((a: any, b: any) => {
        const ah = a.fields?.hostId ? 1 : 0;
        const bh = b.fields?.hostId ? 1 : 0;
        return ah - bh;
      });
      for (const cel of ordered as any[]) {
        const centralId = cel.id;
        let localId = this.centralToLocal.get(centralId);
        if (!localId && this.adapter.getElement(centralId)) localId = centralId;
        if (localId && this.adapter.getElement(localId)) {
          const localEl = this.adapter.getElement(localId)!;
          const diff = diffFields(elementToCentralFields(localEl), cel.fields);
          if (Object.keys(diff).length) {
            const before = elementToCentralFields(localEl);
            const r = withGuardSuspended(() => this.adapter.applyRemoteFields(localId, diff));
            if (r.ok) {
              this.notice("info", `Updated ${localEl.name} from central (rev ${st.revision})`);
              for (const f of r.skippedFields || []) this.pinField(centralId, f, (before as any)[f]);
            } else {
              this.notice("warn", `Could not apply central values to ${localEl.name}: ${r.reason}`);
              for (const f of Object.keys(diff)) this.pinField(centralId, f, (before as any)[f]);
              for (const f of r.skippedFields || []) this.pinField(centralId, f, (before as any)[f]);
            }
          }
          this.centralToLocal.set(centralId, localId);
          this.localToCentral.set(localId, centralId);
          this.lastKnown.set(centralId, cloneJson(cel.fields));
          this.appliedVersion.set(centralId, cel.version);
          continue;
        }
        // Materialise a remote element locally.
        const fields = { ...cel.fields };
        if (fields.hostId && typeof fields.hostId === "string") {
          const hostLocal = this.centralToLocal.get(fields.hostId);
          if (!hostLocal) {
            this.notice("warn", `Central element ${centralId} needs its host first — it will materialise on the next sync`);
            continue;
          }
          fields.hostId = hostLocal;
        }
        const newLocalId = await this.adapter.createElementFromCentral(fields);
        if (!newLocalId) {
          this.notice("warn", `Central element ${centralId} (${String(cel.fields?.type || "?")}) could not be created locally — it stays central-only`);
          continue;
        }
        this.centralToLocal.set(centralId, newLocalId);
        this.localToCentral.set(newLocalId, centralId);
        this.lastKnown.set(centralId, cloneJson(cel.fields));
        this.appliedVersion.set(centralId, cel.version);
        // Apply the full field set (levels etc.) now that the element exists.
        const created = this.adapter.getElement(newLocalId);
        if (created) {
          const rest = diffFields(elementToCentralFields(created), cel.fields);
          if (Object.keys(rest).length) {
            const r = withGuardSuspended(() => this.adapter.applyRemoteFields(newLocalId, rest));
            if (!r.ok) {
              for (const f of Object.keys(rest)) this.pinField(centralId, f, (elementToCentralFields(created) as any)[f]);
            } else {
              for (const f of r.skippedFields || []) this.pinField(centralId, f, (elementToCentralFields(created) as any)[f]);
            }
          }
        }
      }
      // Local elements the central has never seen push up.
      for (const el of this.adapter.listElements()) {
        const centralId = this.centralIdForLocal(el.id);
        if (!st.elements[centralId] && !this.lastKnown.has(centralId)) {
          await this.pushElement(el, centralId, true);
        }
      }
      if (st.conflicts?.length) this.emitConflicts(st.conflicts);
    } finally {
      this.applyingRemote = false;
    }
  }

  /**
   * Fields the server changed since the last agreed state (`known`) that
   * the local user has NOT changed since then — i.e. genuine remote
   * changes. A field where local differs from `known` is an unpushed
   * local edit (or a both-sides change): it is left alone here so the
   * push sends it with a stale baseRevision and the server records a
   * real conflict, instead of silently discarding the local edit.
   */
  private remoteChangedFields(
    known: Record<string, unknown>,
    localFields: Record<string, unknown>,
    centralFields: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(centralFields)) {
      if (k !== "type" && k !== "name" && k !== "hostId" && !(SYNC_PARAM_KEYS as readonly string[]).includes(k)) continue;
      if (fieldsEqual(known[k], v)) continue; // server did not change it
      if (!fieldsEqual(localFields[k], known[k])) continue; // local edit (pushed or not) — keep local
      out[k] = cloneJson(v);
    }
    return out;
  }

  /**
   * Apply ONE central element to the local model, ignoring the version
   * check. Used by applyRemoteState (after its version gate) and by the
   * 409-revert paths in pushElement/pushDelete, where the server refused a
   * local change WITHOUT advancing the element version — the local model
   * diverged, but the version gate would (correctly for the steady state,
   * wrongly here) skip the re-apply.
   *
   * `force` is for the 409 paths only: the server has ruled on the local
   * edit (refused it), so central wins on every field and the local value
   * is reverted. The steady-state path (force off) applies only genuine
   * remote changes — see `remoteChangedFields` — so an unrelated remote
   * op never wipes out a pending local edit to another field.
   */
  private async applyCentralElement(cel: any, opts: { force?: boolean } = {}): Promise<void> {
    const centralId = cel.id;
    let localId = this.centralToLocal.get(centralId);
    if (!localId && this.adapter.getElement(centralId)) localId = centralId;
    if (localId && this.adapter.getElement(localId)) {
      const localEl = this.adapter.getElement(localId)!;
      const localFields = elementToCentralFields(localEl);
      const diff = opts.force
        ? diffFields(localFields, cel.fields)
        : this.remoteChangedFields(this.lastKnown.get(centralId) ?? {}, localFields, cel.fields);
      if (Object.keys(diff).length) {
        const before = elementToCentralFields(localEl);
        const r = withGuardSuspended(() => this.adapter.applyRemoteFields(localId, diff));
        if (!r.ok) {
          this.notice("warn", `Could not apply central values to ${localEl.name}: ${r.reason}`);
          for (const f of Object.keys(diff)) this.pinField(centralId, f, (before as any)[f]);
        } else {
          for (const f of r.skippedFields || []) this.pinField(centralId, f, (before as any)[f]);
        }
      }
      this.centralToLocal.set(centralId, localId);
      this.localToCentral.set(localId, centralId);
      this.lastKnown.set(centralId, cloneJson(cel.fields));
      this.appliedVersion.set(centralId, cel.version);
      return;
    }
    // New remote element (or a local delete that the server refused):
    // materialise it under a fresh local id.
    const fields = { ...cel.fields };
    if (fields.hostId && typeof fields.hostId === "string") {
      const hostLocal = this.centralToLocal.get(fields.hostId);
      if (!hostLocal) return; // host not local yet; next state update retries
      fields.hostId = hostLocal;
    }
    const newLocalId = await this.adapter.createElementFromCentral(fields);
    if (!newLocalId) {
      this.notice("warn", `Central element ${centralId} (${String(cel.fields?.type || "?")}) could not be created locally — it stays central-only`);
      return;
    }
    this.centralToLocal.set(centralId, newLocalId);
    this.localToCentral.set(newLocalId, centralId);
    this.lastKnown.set(centralId, cloneJson(cel.fields));
    this.appliedVersion.set(centralId, cel.version);
    const created = this.adapter.getElement(newLocalId);
    if (created) {
      const rest = diffFields(elementToCentralFields(created), cel.fields);
      if (Object.keys(rest).length) {
        const r = withGuardSuspended(() => this.adapter.applyRemoteFields(newLocalId, rest));
        if (!r.ok) {
          for (const f of Object.keys(rest)) this.pinField(centralId, f, (elementToCentralFields(created) as any)[f]);
        }
      }
    }
  }

  /** Apply a fresh central state to the local model (SSE / fetchState). */
  async applyRemoteState(state: CentralState): Promise<void> {
    if (!this.joined) return;
    if (this.applyingRemote) return;
    this.applyingRemote = true;
    try {
      // Remote deletes: known elements absent from the state are gone.
      for (const centralId of [...this.lastKnown.keys()]) {
        if ((state.elements as any)[centralId]) continue;
        const localId = this.centralToLocal.get(centralId);
        if (localId && this.adapter.getElement(localId)) {
          withGuardSuspended(() => this.adapter.removeElementLocal(localId));
          this.notice("info", `Removed an element deleted by another user`);
        }
        this.lastKnown.delete(centralId);
        this.appliedVersion.delete(centralId);
        this.pinnedFields.delete(centralId);
        if (localId) {
          this.centralToLocal.delete(centralId);
          this.localToCentral.delete(localId);
        }
      }
      const ordered = [...Object.values(state.elements as any)].sort((a: any, b: any) => {
        const ah = a.fields?.hostId ? 1 : 0;
        const bh = b.fields?.hostId ? 1 : 0;
        return ah - bh;
      });
      for (const cel of ordered as any[]) {
        const centralId = cel.id;
        const knownVersion = this.appliedVersion.get(centralId);
        if (knownVersion !== undefined && cel.version <= knownVersion) continue;
        await this.applyCentralElement(cel);
      }
      if ((state as any).conflicts?.length) this.emitConflicts((state as any).conflicts);
      this.emitStatus();
    } finally {
      this.applyingRemote = false;
    }
  }

  // ── Local → central ─────────────────────────────────────────────────

  private schedulePush(): void {
    if (!this.joined) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushLocalChanges(false);
    }, PUSH_DEBOUNCE_MS);
  }

  /** Diff the local model against lastKnown and push what changed. */
  async pushLocalChanges(immediate = false): Promise<void> {
    if (!this.joined) return;
    if (this.applyingRemote) {
      // A remote apply is in flight; re-schedule so nothing is lost.
      this.schedulePush();
      return;
    }
    if (this.pushing) {
      // A push is in flight — most often an op queued offline, awaiting
      // flush. Retry (once, 2 s) so an edit whose debounce already fired
      // is not lost until the next local change.
      if (!this.pushRetryTimer) {
        this.pushRetryTimer = setTimeout(() => {
          this.pushRetryTimer = null;
          void this.pushLocalChanges(false);
        }, 2000);
      }
      return;
    }
    if (this.pushRetryTimer) {
      clearTimeout(this.pushRetryTimer);
      this.pushRetryTimer = null;
    }
    if (!immediate && this.pushTimer) return; // a debounced run is pending
    this.pushing = true;
    try {
      const local = this.adapter.listElements();
      const seenCentral = new Set<string>();
      for (const el of local) {
        const centralId = this.centralIdForLocal(el.id);
        seenCentral.add(centralId);
        const fields = elementToCentralFields(el);
        const known = this.lastKnown.get(centralId);
        if (!known) {
          // Never pushed: brand-new local element.
          await this.pushElement(el, centralId, true);
          continue;
        }
        const changed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (!fieldsEqual(known[k], v) && !this.isPinned(centralId, k, v)) changed[k] = cloneJson(v);
        }
        if (Object.keys(changed).length) {
          await this.pushElement(el, centralId, false, changed);
        }
      }
      // Local deletes: known elements that are gone locally.
      for (const centralId of [...this.lastKnown.keys()]) {
        if (seenCentral.has(centralId)) continue;
        const localId = this.centralToLocal.get(centralId);
        const stillLocal = localId ? this.adapter.getElement(localId) : null;
        if (stillLocal) continue;
        await this.pushDelete(centralId);
      }
    } finally {
      this.pushing = false;
    }
  }

  private async pushElement(
    el: CentralElementLike,
    centralId: string,
    isNew: boolean,
    changed?: Record<string, unknown>,
  ): Promise<void> {
    const fields = changed ?? elementToCentralFields(el);
    const res = await this.client.upsertElement(centralId, fields, {
      worksetId: isNew ? this.adapter.getActiveWorksetId() : undefined,
      baseRevision: this.client.revision,
    });
    if (!res.ok) {
      if (res.status === 409) {
        // The server refused (borrowed by another user / workset owned):
        // central is authoritative — re-apply the central values for this
        // element. applyRemoteState would skip it (no version change), so
        // the per-element apply runs directly.
        this.notice(
          "warn",
          `Central refused the edit to ${el.name}: ${res.error || "locked by another user"} — local value reverted`,
        );
        await this.client.fetchState();
        const st = this.client.state;
        const centralEl = st?.elements?.[centralId];
        if (centralEl) await this.applyCentralElement(centralEl, { force: true });
      } else if (res.status === 403) {
        this.notice("warn", `Central refused the edit to ${el.name}: ${res.error || "not permitted"}`);
      }
      // Other failures (offline etc.) stay queued client-side; the next
      // sync retries. lastKnown is untouched, so the diff still sees it.
      return;
    }
    if (res.conflicts?.length) {
      this.notice(
        "warn",
        `Edit conflict on ${el.name}: the server kept the other value — resolve it in the Worksharing panel`,
      );
      this.emitConflicts(res.conflicts);
    }
    // The client already re-fetched state after a successful op; record
    // what central now holds (the server's values win on conflicted fields).
    const st = this.client.state;
    const centralEl = st?.elements?.[centralId];
    if (centralEl) {
      this.lastKnown.set(centralId, cloneJson(centralEl.fields));
      this.appliedVersion.set(centralId, centralEl.version);
      // Apply the server's values for any conflicted field locally, so the
      // local model shows the winning value immediately.
      const localEl = this.adapter.getElement(this.centralToLocal.get(centralId) ?? el.id);
      if (localEl) {
        const revert = diffFields(elementToCentralFields(localEl), centralEl.fields);
        if (Object.keys(revert).length) {
          const before = elementToCentralFields(localEl);
          const r = withGuardSuspended(() =>
            this.adapter.applyRemoteFields(this.centralToLocal.get(centralId) ?? el.id, revert),
          );
          if (!r.ok) {
            for (const f of Object.keys(revert)) this.pinField(centralId, f, (before as any)[f]);
          }
        }
      }
    } else {
      this.lastKnown.set(centralId, cloneJson(fields));
    }
    this.centralToLocal.set(centralId, this.centralToLocal.get(centralId) ?? el.id);
    this.localToCentral.set(el.id, centralId);
    this.emitStatus();
  }

  private async pushDelete(centralId: string): Promise<void> {
    const res = await this.client.deleteElement(centralId);
    if (!res.ok) {
      if (res.status === 409 || res.status === 404) {
        // Refused (delete conflict / already gone): central wins — the
        // element comes back locally. applyRemoteState would skip it (no
        // version change), so the per-element apply runs directly.
        this.notice("warn", `Central refused the delete: ${res.error || "conflict"} — the element stays`);
        await this.client.fetchState();
        const st = this.client.state;
        const centralEl = st?.elements?.[centralId];
        if (centralEl) await this.applyCentralElement(centralEl, { force: true });
      }
      return;
    }
    this.lastKnown.delete(centralId);
    this.appliedVersion.delete(centralId);
    this.pinnedFields.delete(centralId);
    const localId = this.centralToLocal.get(centralId);
    if (localId) {
      this.centralToLocal.delete(centralId);
      this.localToCentral.delete(localId);
    }
    this.emitStatus();
  }
}
