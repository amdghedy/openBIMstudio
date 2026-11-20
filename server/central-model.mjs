/**
 * Central model — server-authoritative worksharing state machine.
 *
 * Pure module (no I/O, no timers): given a room state object and a client
 * request it validates the request, computes the deterministic effects, and
 * returns a journal entry that records exactly what changed. The store
 * (`server/central-store.mjs`) persists the entry (append + fsync) and then
 * applies its effects; the same `applyEffects` replays entries after a
 * restart, so the journal is the single source of truth for recovery.
 *
 * Consistency model — server-sequenced deterministic merge (NOT a CRDT):
 * the server is the single ordering authority: every accepted mutation gets
 * the next monotonic sequence number, and convergence follows from that
 * total order plus deterministic application. A CRDT was considered and
 * rejected: CRDTs pay for peer-to-peer convergence without a sequencer
 * (vector clocks, tombstones, per-character or per-key merge semantics),
 * and this server already provides a total order. What BIM element edits
 * need is not character-level convergence but (a) a defined winner when two
 * people change the same field, (b) preservation of both values for human
 * review, and (c) pre-emptive exclusion via borrowing so conflicts stay
 * rare. Field-level three-way merge on a server-assigned total order gives
 * all three with far less machinery, and every decision is recorded in the
 * journal + audit trail so it can be inspected afterwards.
 *
 * Element values are plain JSON field maps (`fields: { name, height, ... }`).
 * Each field tracks the sequence number and actor of its last write
 * (`fieldSeq` / `fieldActor`), which is what makes the three-way check
 * possible: a field changed by someone else after the client's base
 * revision is a conflict; a field untouched since the base applies cleanly.
 * Non-overlapping fields of the same element merge; overlapping fields keep
 * the server value and are recorded as open conflicts for explicit
 * resolution (POST /resolve). Nothing is silently overwritten.
 *
 * Borrowing / ownership is enforced here, at acceptance time, not in the
 * browser: an op on an element borrowed by someone else, or in a workset
 * owned by someone else, is rejected (409) before any state changes.
 *
 * Roles: `owner` (first member to join; manages members/worksets),
 * `editor` (submit ops, borrow, resolve), `viewer` (read-only).
 * Identity caveat: the server authenticates callers with one shared
 * OBS_SERVER_TOKEN, so `clientId` is self-asserted. Roles are enforced at
 * the API given the claimed clientId, but they are NOT proof of identity —
 * true per-user authentication does not exist on this server yet. Do not
 * deploy this as an access-control boundary against mutually untrusted
 * users; it is a coordination discipline for a trusted team on a shared
 * token. See docs/engineering/COLLABORATION_SYNC.md.
 */

export const BORROW_TTL_MS = 15 * 60_000;
export const MAX_JOURNAL_ENTRIES = 500;
export const MAX_FIELDS_PER_OP = 200;
export const MAX_FIELD_VALUE_BYTES = 64 * 1024;

export function emptyState(roomId) {
  const state = {
    roomId,
    revision: 0,
    elements: {}, // id -> { id, worksetId, version, createdByOpId, createdBy, fields, fieldSeq, fieldActor, deleted, deletedSeq }
    worksets: {}, // id -> { id, name, kind, owner, createdBy }
    borrows: {}, // elementId -> { elementId, borrower, borrowerName, grantedAt, expiresAt }
    borrowRequests: {}, // id -> { id, elementId, requestedBy, currentOwner, status, createdAt }
    members: {}, // clientId -> { clientId, name, role, joinedAt, lastSeen }
    conflicts: [], // { id, elementId, field, opId, actor, attemptedValue, winningValue, winningActor, seq, at, status, resolution }
    opIds: [], // opIds of retained journal entries (dedupe window = retained journal)
  };
  for (const d of defaultWorksets()) {
    state.worksets[d.id] = { ...d, owner: null, createdBy: "system" };
  }
  return state;
}

export function defaultWorksets() {
  return [
    { id: "ws-levels-grids", name: "Shared Levels & Grids", kind: "system-workset" },
    { id: "ws-arch", name: "Architecture - Core & Shell", kind: "user-workset" },
    { id: "ws-interior", name: "Interior Partitions & Fitout", kind: "user-workset" },
    { id: "ws-struct", name: "Structural Framing & Foundation", kind: "user-workset" },
    { id: "ws-mep-hvac", name: "MEP - HVAC & Mechanical", kind: "user-workset" },
    { id: "ws-mep-elec", name: "MEP - Electrical & Lighting", kind: "user-workset" },
    { id: "ws-mep-plumb", name: "MEP - Plumbing & Drainage", kind: "user-workset" },
    { id: "ws-site", name: "Site & Topography", kind: "user-workset" },
  ];
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function fieldSizeOk(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v), "utf8") <= MAX_FIELD_VALUE_BYTES;
  } catch {
    return false;
  }
}

export function validateFields(fields) {
  if (!isPlainObject(fields)) return "fields must be an object";
  const keys = Object.keys(fields);
  if (keys.length === 0) return "fields must not be empty";
  if (keys.length > MAX_FIELDS_PER_OP) return `too many fields (max ${MAX_FIELDS_PER_OP})`;
  for (const k of keys) {
    if (typeof k !== "string" || k.length === 0 || k.length > 128) return `invalid field name ${JSON.stringify(k)}`;
    if (!fieldSizeOk(fields[k])) return `field ${JSON.stringify(k)} exceeds ${MAX_FIELD_VALUE_BYTES} bytes`;
  }
  return null;
}

function memberRole(state, clientId) {
  const m = state.members[clientId];
  return m ? m.role : null;
}

function requireRole(state, clientId, allowed) {
  const role = memberRole(state, clientId);
  if (!role) return { ok: false, status: 403, error: "not a member of this room (join first)" };
  if (!allowed.includes(role)) return { ok: false, status: 403, error: `role ${role} may not perform this action` };
  return { ok: true, role };
}

/** Remove expired borrows. Returns effect list (empty when nothing expired). Expired-borrow removal is itself journalled by the caller. */
export function sweepExpiredBorrows(state, now = Date.now()) {
  const effects = [];
  for (const [elementId, b] of Object.entries(state.borrows)) {
    if (Number(b.expiresAt || 0) <= now) {
      effects.push({ type: "delete-borrow", elementId, prev: clone(b) });
    }
  }
  return effects;
}

function borrowCheck(state, elementId, actor) {
  const b = state.borrows[String(elementId)];
  if (b) {
    if (b.borrower !== actor) {
      return { ok: false, status: 409, error: `element borrowed by ${b.borrower}`, code: "borrowed-by-other" };
    }
    // Holding the borrow permits the edit — that is what the borrow is
    // for, including inside a workset owned by someone else.
    return { ok: true };
  }
  const el = state.elements[String(elementId)];
  if (el && el.worksetId) {
    const ws = state.worksets[el.worksetId];
    if (ws && ws.owner && ws.owner !== actor) {
      return { ok: false, status: 409, error: `workset owned by ${ws.owner}; borrow the element first`, code: "workset-owned-by-other" };
    }
  }
  return { ok: true };
}

/**
 * Apply a list of effects to a state object (live path and journal replay
 * share this function, so replay reproduces the live result exactly).
 * Effects are self-contained: every effect carries the values to write, so
 * replay never consults the wall clock or re-runs validation.
 */
export function applyEffects(state, effects) {
  for (const e of effects) {
    switch (e.type) {
      case "set-element-field": {
        const el = state.elements[e.elementId];
        if (!el) break;
        if (e.remove) {
          delete el.fields[e.field];
          delete el.fieldSeq[e.field];
          delete el.fieldActor[e.field];
        } else {
          el.fields[e.field] = clone(e.value);
          el.fieldSeq[e.field] = e.seq;
          el.fieldActor[e.field] = e.actor;
        }
        el.version = e.version;
        el.deleted = false;
        break;
      }
      case "set-element": {
        if (e.element === null && e._drop) delete state.elements[e._drop];
        else if (e.element) state.elements[e.element.id] = clone(e.element);
        break;
      }
      case "set-element-workset": {
        const el = state.elements[e.elementId];
        if (el) el.worksetId = e.worksetId;
        break;
      }
      case "drop-element": {
        delete state.elements[e.elementId];
        break;
      }
      case "delete-element": {
        const el = state.elements[e.elementId];
        if (el) {
          el.deleted = true;
          el.deletedSeq = e.seq;
          el.version = e.version;
        }
        break;
      }
      case "set-workset": {
        state.worksets[e.workset.id] = clone(e.workset);
        break;
      }
      case "delete-workset": {
        delete state.worksets[e.worksetId];
        break;
      }
      case "set-borrow": {
        state.borrows[e.borrow.elementId] = clone(e.borrow);
        break;
      }
      case "delete-borrow": {
        delete state.borrows[e.elementId];
        break;
      }
      case "set-borrow-request": {
        state.borrowRequests[e.request.id] = clone(e.request);
        break;
      }
      case "set-member": {
        state.members[e.member.clientId] = clone(e.member);
        break;
      }
      case "delete-member": {
        delete state.members[e.clientId];
        break;
      }
      case "add-conflict": {
        state.conflicts.push(clone(e.conflict));
        break;
      }
      case "resolve-conflict": {
        const c = state.conflicts.find((x) => x.id === e.conflictId);
        if (c) {
          c.status = "resolved";
          c.resolution = clone(e.resolution);
        }
        break;
      }
      case "set-revision": {
        state.revision = e.revision;
        break;
      }
      case "add-op-id": {
        if (!state.opIds.includes(e.opId)) state.opIds.push(e.opId);
        break;
      }
      default:
        break;
    }
  }
  return state;
}

function nextSeq(state) {
  return state.revision + 1;
}

/**
 * Join (or re-join) a room. The first member becomes owner; later members
 * join as editors. A re-join refreshes lastSeen and never demotes anyone.
 * Returns { entry, effects } where entry is the journal entry to persist
 * (null when nothing changed — a pure re-join refresh still updates
 * lastSeen, so it is journalled as a member event).
 */
export function joinRoom(state, { clientId, name, now = Date.now() }) {
  const seq = nextSeq(state);
  const existing = state.members[clientId];
  const role = existing ? existing.role : Object.keys(state.members).length === 0 ? "owner" : "editor";
  const member = {
    clientId,
    name: String(name || "Guest").slice(0, 120),
    role,
    joinedAt: existing ? existing.joinedAt : now,
    lastSeen: now,
  };
  const effects = [
    { type: "set-member", member },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor: clientId, kind: "join", at: now,
    payload: { name: member.name, role },
    effects, applied: { role }, conflicts: [],
  };
  return { entry, effects };
}

export function leaveRoom(state, { clientId, now = Date.now() }) {
  const seq = nextSeq(state);
  const effects = [];
  // Relinquish the leaver's borrows so nobody is blocked by a gone client.
  for (const [elementId, b] of Object.entries(state.borrows)) {
    if (b.borrower === clientId) effects.push({ type: "delete-borrow", elementId, prev: clone(b) });
  }
  effects.push({ type: "delete-member", clientId });
  effects.push({ type: "set-revision", revision: seq });
  const entry = {
    seq, opId: null, actor: clientId, kind: "leave", at: now,
    payload: {}, effects, applied: { relinquishedBorrows: effects.filter((e) => e.type === "delete-borrow").length },
    conflicts: [],
  };
  return { entry, effects };
}

export function setRole(state, { actor, clientId, role, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner"]);
  if (!gate.ok) return { error: gate };
  if (!["owner", "editor", "viewer"].includes(role)) {
    return { error: { ok: false, status: 400, error: "role must be owner, editor or viewer" } };
  }
  const target = state.members[clientId];
  if (!target) return { error: { ok: false, status: 404, error: "member not found" } };
  if (actor === clientId && role !== "owner") {
    return { error: { ok: false, status: 400, error: "the owner cannot demote themselves" } };
  }
  const seq = nextSeq(state);
  const member = { ...target, role };
  const effects = [
    { type: "set-member", member },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "set-role", at: now,
    payload: { clientId, role }, effects, applied: { role }, conflicts: [],
  };
  return { entry, effects };
}

/**
 * Submit an element upsert. `op` = { opId, actor, elementId, worksetId?,
 * fields, baseRevision }. Duplicate opId (within the retained journal) is
 * a replay: no state change, the original entry is returned with
 * `duplicate: true`. Field-level three-way merge: fields changed by someone
 * else after baseRevision keep the server value and become open conflicts.
 * Returns { entry, effects } on success, { error } on rejection, or
 * { duplicate, entry } on replay.
 */
export function submitUpsert(state, op) {
  const { opId, actor, elementId, fields } = op;
  const baseRevision = Number(op.baseRevision || 0);
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  if (!opId || typeof opId !== "string" || opId.length > 128) {
    return { error: { ok: false, status: 400, error: "opId (client-generated idempotency key) is required" } };
  }
  if (state.opIds.includes(opId)) return { duplicate: true };
  const fieldErr = validateFields(fields);
  if (fieldErr) return { error: { ok: false, status: 400, error: fieldErr } };
  const elId = String(elementId);
  if (!elId || elId.length > 128) return { error: { ok: false, status: 400, error: "elementId is required" } };
  const worksetId = op.worksetId !== undefined ? String(op.worksetId) : undefined;
  if (worksetId !== undefined && !state.worksets[worksetId]) {
    return { error: { ok: false, status: 400, error: `unknown workset ${worksetId}` } };
  }
  const existing = state.elements[elId];
  if (existing && existing.deleted) {
    // Re-creating a deleted element is a fresh add, not an edit of a tombstone.
  }
  if (existing && !existing.deleted) {
    const bc = borrowCheck(state, elId, actor);
    if (!bc.ok) return { error: bc };
  }
  const seq = nextSeq(state);
  const now = Date.now();
  const effects = [];
  const applied = {};
  const rejected = {};
  const conflicts = [];
  const isNew = !existing || existing.deleted;
  let version;
  // `prev` is what restoreToRevision inverts: the element state before this op.
  let prev;
  if (isNew) {
    prev = { existed: false };
    const el = {
      id: elId,
      worksetId: worksetId || (existing ? existing.worksetId : "ws-arch") || "ws-arch",
      version: 1,
      createdByOpId: opId,
      createdBy: actor,
      fields: {},
      fieldSeq: {},
      fieldActor: {},
      deleted: false,
    };
    if (!state.worksets[el.worksetId]) el.worksetId = "ws-arch";
    for (const [f, v] of Object.entries(fields)) {
      el.fields[f] = clone(v);
      el.fieldSeq[f] = seq;
      el.fieldActor[f] = actor;
      applied[f] = clone(v);
    }
    version = 1;
    effects.push({ type: "set-element", element: el });
  } else {
    version = existing.version + 1;
    prev = { existed: true, worksetId: existing.worksetId, fields: {} };
    for (const f of Object.keys(fields)) {
      // { present, value } wrapper: JSON drops `undefined`, so a missing
      // field must be explicit for the journal to round-trip it.
      prev.fields[f] = f in existing.fields
        ? { present: true, value: clone(existing.fields[f]) }
        : { present: false };
    }
    for (const [f, v] of Object.entries(fields)) {
      const lastSeq = Number(existing.fieldSeq[f] || 0);
      const current = existing.fields[f];
      if (lastSeq > baseRevision && JSON.stringify(current) !== JSON.stringify(v)) {
        // Someone else changed this field after the client's base: conflict.
        const conflict = {
          id: `cf-${seq}-${f}`,
          elementId: elId,
          field: f,
          opId,
          actor,
          attemptedValue: clone(v),
          winningValue: clone(current),
          winningActor: existing.fieldActor[f] || "unknown",
          seq,
          at: now,
          status: "open",
        };
        conflicts.push(conflict);
        rejected[f] = clone(current);
        effects.push({ type: "add-conflict", conflict });
      } else if (JSON.stringify(current) !== JSON.stringify(v)) {
        applied[f] = clone(v);
        effects.push({ type: "set-element-field", elementId: elId, field: f, value: clone(v), seq, actor, version });
      }
      // Identical value: no-op, no effect, no conflict.
    }
    if (worksetId !== undefined && worksetId !== existing.worksetId) {
      // Workset moves are applied as part of the same op (no field conflict:
      // the move itself is sequenced; a concurrent move loses to the earlier seq).
      const moved = { ...clone(existing), worksetId };
      // Preserve the field effects already queued by re-applying them onto moved:
      for (const e of effects) {
        if (e.type === "set-element-field") {
          moved.fields[e.field] = clone(e.value);
          moved.fieldSeq[e.field] = e.seq;
          moved.fieldActor[e.field] = e.actor;
        }
      }
      moved.version = version;
      moved.deleted = false;
      // Replace the field effects with a single whole-element effect.
      const keep = effects.filter((e) => e.type === "add-conflict");
      keep.push({ type: "set-element", element: moved });
      effects.length = 0;
      effects.push(...keep);
      applied.worksetId = worksetId;
    }
    if (Object.keys(applied).length === 0 && conflicts.length === 0 && worksetId === undefined) {
      // Pure no-op (all values identical): still journalled so the client
      // gets a sequence number, but nothing changes.
    }
  }
  effects.push({ type: "add-op-id", opId });
  effects.push({ type: "set-revision", revision: seq });
  const entry = {
    seq, opId, actor, kind: "upsert-element", at: now,
    payload: { elementId: elId, worksetId, fields: clone(fields), baseRevision },
    prev, effects, applied, rejected, conflicts,
  };
  return { entry, effects };
}

export function submitDelete(state, op) {
  const { opId, actor, elementId } = op;
  const baseRevision = Number(op.baseRevision || 0);
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  if (!opId || typeof opId !== "string") {
    return { error: { ok: false, status: 400, error: "opId is required" } };
  }
  if (state.opIds.includes(opId)) return { duplicate: true };
  const el = state.elements[String(elementId)];
  if (!el || el.deleted) return { error: { ok: false, status: 404, error: "element not found" } };
  const bc = borrowCheck(state, String(elementId), actor);
  if (!bc.ok) return { error: bc };
  // Delete conflicts with any field change after the client's base revision.
  const changedAfterBase = Object.values(el.fieldSeq).some((s) => Number(s) > baseRevision);
  const seq = nextSeq(state);
  const now = Date.now();
  if (changedAfterBase) {
    const conflict = {
      id: `cf-${seq}-delete`,
      elementId: String(elementId),
      field: null,
      opId,
      actor,
      attemptedValue: "delete",
      winningValue: "keep (modified by another user)",
      winningActor: "another user",
      seq,
      at: now,
      status: "open",
    };
    const effects = [
      { type: "add-conflict", conflict },
      { type: "add-op-id", opId },
      { type: "set-revision", revision: seq },
    ];
    const entry = {
      seq, opId, actor, kind: "delete-element", at: now,
      payload: { elementId: String(elementId), baseRevision },
      effects, applied: {}, rejected: { delete: "conflict" }, conflicts: [conflict],
    };
    return { entry, effects, deleteConflict: true };
  }
  const effects = [
    { type: "delete-element", elementId: String(elementId), seq, version: el.version + 1 },
    { type: "add-op-id", opId },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId, actor, kind: "delete-element", at: now,
    payload: { elementId: String(elementId), baseRevision },
    prev: { element: clone(el) },
    effects, applied: { deleted: true }, rejected: {}, conflicts: [],
  };
  return { entry, effects };
}

export function createWorkset(state, { actor, name, kind = "user-workset", now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const clean = String(name || "").trim().slice(0, 120);
  if (!clean) return { error: { ok: false, status: 400, error: "workset name is required" } };
  if (!["user-workset", "system-workset", "standards-workset", "view-workset"].includes(kind)) {
    return { error: { ok: false, status: 400, error: "invalid workset kind" } };
  }
  const seq = nextSeq(state);
  const workset = {
    id: `ws-${seq}-${Math.floor(Math.random() * 100000)}`,
    name: clean, kind, owner: null, createdBy: actor,
  };
  const effects = [
    { type: "set-workset", workset },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "create-workset", at: now,
    payload: { name: clean, kind }, effects, applied: { worksetId: workset.id }, conflicts: [],
  };
  return { entry, effects };
}

export function setWorksetOwner(state, { actor, worksetId, owner, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner"]);
  if (!gate.ok) return { error: gate };
  const ws = state.worksets[worksetId];
  if (!ws) return { error: { ok: false, status: 404, error: "workset not found" } };
  if (owner !== null && !state.members[owner]) {
    return { error: { ok: false, status: 400, error: "owner must be a room member" } };
  }
  const seq = nextSeq(state);
  const workset = { ...ws, owner: owner || null };
  const effects = [
    { type: "set-workset", workset },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "set-workset-owner", at: now,
    payload: { worksetId, owner: owner || null }, effects, applied: { owner: owner || null }, conflicts: [],
  };
  return { entry, effects };
}

export function borrowElement(state, { actor, elementId, actorName, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const el = state.elements[String(elementId)];
  if (!el || el.deleted) return { error: { ok: false, status: 404, error: "element not found" } };
  const existing = state.borrows[String(elementId)];
  if (existing && existing.borrower !== actor && Number(existing.expiresAt) > now) {
    return { error: { ok: false, status: 409, error: `element already borrowed by ${existing.borrower}`, code: "borrowed-by-other" } };
  }
  const ws = el.worksetId ? state.worksets[el.worksetId] : null;
  if (ws && ws.owner && ws.owner !== actor) {
    // Workset owned by someone else: borrowing needs a granted request.
    return { error: { ok: false, status: 409, error: `workset owned by ${ws.owner}; submit a borrow request`, code: "workset-owned-by-other" } };
  }
  const seq = nextSeq(state);
  const borrow = {
    elementId: String(elementId), borrower: actor,
    borrowerName: String(actorName || actor).slice(0, 120),
    grantedAt: now, expiresAt: now + BORROW_TTL_MS,
  };
  const effects = [
    { type: "set-borrow", borrow },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "borrow", at: now,
    payload: { elementId: String(elementId) }, effects, applied: { borrow }, conflicts: [],
  };
  return { entry, effects };
}

export function relinquishBorrow(state, { actor, elementId, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const b = state.borrows[String(elementId)];
  if (!b) return { error: { ok: false, status: 404, error: "no borrow on this element" } };
  if (b.borrower !== actor && gate.role !== "owner") {
    return { error: { ok: false, status: 403, error: "only the borrower or the room owner can relinquish" } };
  }
  const seq = nextSeq(state);
  const effects = [
    { type: "delete-borrow", elementId: String(elementId), prev: clone(b) },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "relinquish", at: now,
    payload: { elementId: String(elementId) }, effects, applied: {}, conflicts: [],
  };
  return { entry, effects };
}

export function submitBorrowRequest(state, { actor, elementId, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const el = state.elements[String(elementId)];
  if (!el || el.deleted) return { error: { ok: false, status: 404, error: "element not found" } };
  const currentOwner = (state.borrows[String(elementId)] || {}).borrower
    || (el.worksetId && state.worksets[el.worksetId] ? state.worksets[el.worksetId].owner : null)
    || "owner";
  if (currentOwner === actor) return { error: { ok: false, status: 400, error: "you already hold this element" } };
  const seq = nextSeq(state);
  const request = {
    id: `req-${seq}-${Math.floor(Math.random() * 100000)}`,
    elementId: String(elementId), requestedBy: actor, currentOwner,
    status: "pending", createdAt: now,
  };
  const effects = [
    { type: "set-borrow-request", request },
    { type: "set-revision", revision: seq },
  ];
  const entry = {
    seq, opId: null, actor, kind: "borrow-request", at: now,
    payload: { elementId: String(elementId) }, effects, applied: { requestId: request.id }, conflicts: [],
  };
  return { entry, effects };
}

export function respondBorrowRequest(state, { actor, requestId, grant, message, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const req = state.borrowRequests[requestId];
  if (!req) return { error: { ok: false, status: 404, error: "borrow request not found" } };
  if (req.status !== "pending") return { error: { ok: false, status: 409, error: `request already ${req.status}` } };
  if (req.currentOwner !== actor && gate.role !== "owner") {
    return { error: { ok: false, status: 403, error: "only the current owner (or room owner) can respond" } };
  }
  const seq = nextSeq(state);
  const request = {
    ...req, status: grant ? "granted" : "denied",
    responseMessage: String(message || "").slice(0, 280),
  };
  const effects = [{ type: "set-borrow-request", request }];
  if (grant) {
    effects.push({
      type: "set-borrow",
      borrow: {
        elementId: req.elementId, borrower: req.requestedBy, borrowerName: req.requestedBy,
        grantedAt: now, expiresAt: now + BORROW_TTL_MS,
      },
    });
  }
  effects.push({ type: "set-revision", revision: seq });
  const entry = {
    seq, opId: null, actor, kind: "borrow-respond", at: now,
    payload: { requestId, grant: !!grant }, effects,
    applied: { status: request.status }, conflicts: [],
  };
  return { entry, effects };
}

/**
 * Resolve an open conflict. `choice` is "theirs" (keep the server value),
 * "mine" (re-apply the attempted value as a new sequenced write), or
 * { value } (a third value chosen by the resolver). Resolution is itself a
 * journalled entry, so the decision is auditable.
 */
export function resolveConflict(state, { actor, conflictId, choice, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const conflict = state.conflicts.find((c) => c.id === conflictId);
  if (!conflict) return { error: { ok: false, status: 404, error: "conflict not found" } };
  if (conflict.status !== "open") return { error: { ok: false, status: 409, error: `conflict already ${conflict.status}` } };
  const seq = nextSeq(state);
  let resolution;
  const effects = [];
  if (choice === "theirs") {
    resolution = { choice: "theirs", value: clone(conflict.winningValue) };
  } else if (choice === "mine" || (isPlainObject(choice) && "value" in choice)) {
    if (conflict.field === null) {
      return { error: { ok: false, status: 400, error: "a delete conflict cannot be resolved with 'mine'; use 'theirs' or re-submit the delete" } };
    }
    const value = choice === "mine" ? clone(conflict.attemptedValue) : clone(choice.value);
    const el = state.elements[conflict.elementId];
    if (!el || el.deleted) return { error: { ok: false, status: 404, error: "element no longer exists" } };
    resolution = { choice: choice === "mine" ? "mine" : "custom", value: clone(value) };
    effects.push({
      type: "set-element-field",
      elementId: conflict.elementId, field: conflict.field, value: clone(value),
      seq, actor, version: el.version + 1,
    });
  } else {
    return { error: { ok: false, status: 400, error: "choice must be 'mine', 'theirs', or { value }" } };
  }
  effects.push({ type: "resolve-conflict", conflictId, resolution });
  effects.push({ type: "set-revision", revision: seq });
  const entry = {
    seq, opId: null, actor, kind: "resolve-conflict", at: now,
    payload: { conflictId, choice: resolution.choice }, effects,
    applied: { resolution }, conflicts: [],
  };
  return { entry, effects };
}

/**
 * Restore element state to a revision within the retained journal window.
 * Inverts journal entries after `revision` (newest first) using the
 * `prev` values each entry recorded. Only element field state (incl.
 * workset assignment and deletions) is restored; workset definitions,
 * borrows, members and conflicts are NOT rewound — the restore itself is a
 * new journal entry at the head, so history is never rewritten.
 * Returns { entry, effects, restoredTo } or { error }.
 */
export function restoreToRevision(state, entries, { actor, revision, now = Date.now() }) {
  const gate = requireRole(state, actor, ["owner", "editor"]);
  if (!gate.ok) return { error: gate };
  const target = Number(revision);
  if (!Number.isInteger(target) || target < 0 || target > state.revision) {
    return { error: { ok: false, status: 400, error: `revision must be between 0 and ${state.revision}` } };
  }
  if (entries.length === 0) {
    return { error: { ok: false, status: 400, error: `no journal entries are retained, so revision ${target} cannot be reconstructed (current revision is ${state.revision})` } };
  }
  const oldest = entries[0].seq;
  if (target < oldest - 1) {
    return { error: { ok: false, status: 400, error: `revision ${target} is no longer retained (oldest retained entry is seq ${oldest}; restore window is the last ${MAX_JOURNAL_ENTRIES} entries)` } };
  }
  if (target === state.revision) {
    return { error: { ok: false, status: 400, error: "already at that revision" } };
  }
  const seq = nextSeq(state);
  const effects = [];
  const restored = {};
  // Walk entries after the target, newest first, undoing element changes.
  const later = entries.filter((e) => e.seq > target).sort((a, b) => b.seq - a.seq);
  for (const e of later) {
    if (e.kind === "upsert-element") {
      const elId = e.payload.elementId;
      const prev = e.prev || {};
      if (prev.existed === false) {
        // Element was created by this entry: drop the record entirely.
        effects.push({ type: "drop-element", elementId: elId });
        restored[elId] = "removed (created after target)";
      } else if (prev.fields) {
        for (const [f, old] of Object.entries(prev.fields)) {
          if (!old || old.present === false) {
            // Field did not exist before this entry: remove it.
            effects.push({ type: "set-element-field", elementId: elId, field: f, value: undefined, seq, actor, version: (state.elements[elId]?.version || 1) + 1, remove: true });
          } else {
            effects.push({ type: "set-element-field", elementId: elId, field: f, value: clone(old.value), seq, actor, version: (state.elements[elId]?.version || 1) + 1 });
          }
        }
        if (prev.worksetId !== undefined && state.elements[elId] && state.elements[elId].worksetId !== prev.worksetId) {
          effects.push({ type: "set-element-workset", elementId: elId, worksetId: prev.worksetId, seq });
        }
        restored[elId] = "reverted";
      }
    } else if (e.kind === "delete-element" && e.applied && e.applied.deleted) {
      const elId = e.payload.elementId;
      const prev = e.prev || {};
      if (prev.element) {
        effects.push({ type: "set-element", element: clone(prev.element) });
        restored[elId] = "un-deleted";
      }
    }
  }
  effects.push({ type: "set-revision", revision: seq });
  const entry = {
    seq, opId: null, actor, kind: "restore", at: now,
    payload: { revision: target }, effects,
    applied: { restoredTo: target, elements: restored }, conflicts: [],
  };
  return { entry, effects };
}

/** Public (safe) view of a room for GET /state and /sync responses. */
export function publicState(state) {
  const elements = {};
  for (const [id, el] of Object.entries(state.elements)) {
    if (el.deleted) continue;
    elements[id] = {
      id: el.id, worksetId: el.worksetId, version: el.version,
      createdBy: el.createdBy, fields: clone(el.fields),
    };
  }
  return {
    roomId: state.roomId,
    revision: state.revision,
    elements,
    worksets: clone(state.worksets),
    borrows: clone(state.borrows),
    borrowRequests: Object.values(state.borrowRequests).filter((r) => r.status === "pending"),
    members: clone(state.members),
    conflicts: state.conflicts.filter((c) => c.status === "open"),
    openConflictCount: state.conflicts.filter((c) => c.status === "open").length,
    totalConflicts: state.conflicts.length,
  };
}
