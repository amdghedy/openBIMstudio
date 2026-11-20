# Collaboration & Worksharing — Central Sync Design

**Status:** implemented on branch `fix/collaboration-worksharing` (base `e8e5afb`).
**Scope:** the server-authoritative sync protocol. The browser UI binding of
remote ops into the live ModelGraph is explicitly *not* in this change (see
"Remaining work").

## 1. Audit verdict (revalidated 2026-11-20 against main `e8e5afb`)

**Before this change, openBIMstudio did NOT support durable multi-user
collaboration.** What existed was local/in-memory behaviour plus an
unsequenced broadcast channel:

| Claim / component | Evidence | Verdict |
|---|---|---|
| `WorksharingEngine` "Sync with Central, 3-way merge, central revision counters" | `src/modules/collaboration/worksharing-engine.ts:1-5` (header) vs. `syncWithCentral()` which moves `pendingTransactions` into a local `centralJournal` array (`:380-440`); no network call, no persistence | Local only. The type `SyncTransaction` existing is not a merge working. |
| Workset borrowing / locks enforced | `worksharing-engine.ts:canEditElement` / `borrowElement` consult in-memory `Map`s; `workshare-locks.ts` keeps locks in a module-local `Map`, cleared on disconnect, and nothing in the authoring path refuses an edit to a locked element | Advisory, unenforced |
| "Conflict semantics are last-writer-wins via Yjs updates" (registry `collaboration`) | `yjs@^13.6.14` and `y-websocket@^3.1.0` are declared (`package.json:340-341`) but **zero imports** of either exist in `src/`, `server/` or `tests/` (verified by grep). No Yjs doc, no Yjs update, no CRDT code anywhere | False claim. Corrected in the registry by this change |
| Server realtime sync | `server/index.mjs:172-299` — `POST /api/rooms/:room/change` appends an unsequenced change to `rooms.json` (whole-file JSON, last 500 kept, `GET` returns last 80) and broadcasts it over SSE. No ordering, no dedupe, no conflict detection, no ownership, no history beyond the 500-item window, no audit | Broadcast, not sync. Two clients can overwrite each other silently; a restart keeps only the last 500 raw changes with no element state to reconcile against |
| Presence | `realtime-client.ts` join/heartbeat + `presenceList` | Real, and kept as-is |

The legacy room/change path is **left untouched** (presence, selection locks
and the agent relay still use it). The central model is a new, parallel
protocol under `/api/central/:room/...` so existing behaviour cannot regress.

## 2. Architecture

```
  Client A ─┐
            │  POST /op { opId, baseRevision, elementId, fields }   (Bearer)
  Client B ─┤─► Node HTTP server ──► central-model (validate, sequence,
            │                         field-level 3-way merge, borrow/role
  Client C ─┘                         checks) ──► journal.jsonl (append +
                                        fsync) ──► snapshot.json (atomic,
                                        fsync + rename, backup rotation)
                                                  ──► SSE broadcast
                                                  `central-op` on the room
                                                  channel + audit.jsonl
```

One `CentralStore` per room under `<OBS_DATA_DIR>/central/<roomId>/`:

| File | Contents | Durability |
|---|---|---|
| `snapshot.json` | Full room state (elements, worksets, borrows, requests, members, conflicts, revision) | `writeJsonWithBackup` — fsync + atomic rename + backup rotation (the #244 machinery) |
| `journal.jsonl` | Append-only transaction journal, one JSON object per line: `{ seq, opId, actor, kind, payload, prev, effects, applied, rejected, conflicts, at }` | `append + fsync` **before** the client is acked |
| `audit.jsonl` | Append-only audit trail: every accepted op, every rejection (with reason + status), role changes, borrows, restores | `append + fsync`; never compacted |

**Commit order** per mutation: (1) append journal entry + fsync,
(2) apply effects in memory, (3) rewrite snapshot, (4) broadcast,
(5) ack. A crash between (1) and (3) leaves a journal tail ahead of the
snapshot; `load()` replays that tail with the same `applyEffects` the live
path uses. A torn final journal line (crash mid-append) is skipped on load:
it was never fsynced, never acked, and the client retries with the same
`opId`, which the server dedupes.

**Retention:** the journal keeps the last 500 entries
(`OBS_CENTRAL_JOURNAL_MAX` overrides for tests). Older entries are compacted
away once a snapshot covers them. A client whose `since` is behind the
window gets `truncated: true` plus the full state instead of a partial log.

## 3. Consistency model — why not CRDT

**Chosen: server-sequenced deterministic merge (total order + field-level
three-way merge). Not a CRDT.**

The consistency requirement is: *two editors' changes to the same model must
converge to one defined state, with no silent loss, and a human must be able
to see and resolve the cases where the system had to choose.* A CRDT serves
a different requirement — peer-to-peer convergence with no ordering
authority (offline-first, multi-master, no single sequencer). This server
already *is* a single ordering authority: every accepted mutation gets the
next monotonic sequence number, so convergence follows from the total order
plus deterministic application. A CRDT would add vector clocks, tombstones
and per-key merge semantics to solve a problem the sequencer already solves,
and would still need exactly the same human-resolution step for the case
that matters in BIM (two people set the same wall height to different
values — no automatic merge is "correct"; someone must decide).

Rules:

- **Per-field last-write tracking.** Each element field records the
  sequence number and actor of its last write (`fieldSeq` / `fieldActor`).
  An op carries `baseRevision` (the last sequence the client had seen).
  A field changed by someone else after `baseRevision` *and* set to a
  different value is a **conflict**: the server value is kept, the attempt
  is recorded as an open conflict with both values and both actors, and the
  op is otherwise applied.
- **Non-overlapping fields merge.** Two clients editing different fields of
  the same element both land; neither is told there was a conflict.
- **Identical re-writes are no-ops**, never conflicts.
- **Deletes conflict** with any field change after the deleter's base.
- **Borrowing pre-empts most conflicts.** An op on an element borrowed by
  someone else, or in a workset owned by someone else, is rejected (409)
  before any state changes — the same rule the local engine had, now
  enforced at acceptance time on the server.
- **Resolution is explicit and journalled.** `POST /resolve` with `mine`
  (re-apply the attempted value as a new sequenced write), `theirs` (keep
  the server value) or `{ value }` (a third value). The decision is a
  journal entry and an audit record.
- **No silent overwrite anywhere.** Every accepted op records `applied`
  (what landed) and `rejected` (what conflicted); every rejected op records
  the reason in the audit trail.

## 4. Protocol (all under `/api/central/:room`, Bearer-gated by the existing `/api/` token policy)

| Endpoint | Purpose |
|---|---|
| `POST join` / `POST leave` | Membership. First member is `owner`; later members are `editor`. Leaving relinquishes the leaver's borrows so nobody is blocked by a gone client. |
| `POST role` | Owner sets `owner` / `editor` / `viewer` (owner cannot demote themselves). |
| `POST op` | `upsert` / `delete`. Body: `{ opId, elementId, fields?, worksetId?, baseRevision }`. `opId` is the client-generated idempotency key. |
| `GET state` | Full public state + revision. |
| `GET sync?since=N` | Journal entries with `seq > N`; `truncated: true` + full state when `N` is behind the retained window. |
| `GET history?limit=` | Journal entries (public view, no internal effects). |
| `GET audit?limit=` | Audit trail. |
| `POST workset` / `POST workset-owner` | Create a workset; owner-only assignment of a workset owner (`null` clears). |
| `POST borrow` / `POST relinquish` | Element borrow (15-min lease, refreshed by re-borrowing); relinquish (borrower or room owner). |
| `POST borrow-request` / `POST borrow-respond` | Request flow: the current holder (or room owner) grants/denies; a grant installs the borrow. |
| `POST resolve` | Resolve an open conflict (`mine` / `theirs` / `{ value }`). |
| `POST restore` | Revert element state to a revision inside the retained window by inverting journal entries (newest first) using each entry's recorded `prev`. Workset definitions, borrows, members and conflicts are NOT rewound; the restore is itself a new journal entry, so history is never rewritten. |

**Duplicate handling.** `opId` is deduped against the retained journal: a
redelivery returns the original entry with `duplicate: true` and does not
advance the revision. After compaction the window closes, but replays stay
safe: field ops are neutralised by the per-field sequence check (every field
they touch was written after their base), and element creates carry
`createdByOpId`, so a replayed create of an existing element is recognised.

**Reconnection.** The client keeps `revision`, subscribes to `central-op`
SSE events, and on any gap (`seq !== revision + 1`) re-syncs with
`GET /sync?since=<revision>`. Ops submitted while not joined (or while a
POST fails with a network error) are queued with their original `opId` and
replayed on (re)join — the server dedupe makes the replay safe.

**Restart recovery.** The server reloads the snapshot + journal tail on
first access to a room. Verified by SIGKILL mid-session and respawn (see §6).

**Permissions.** `viewer` is read-only (403 on op/borrow/workset/resolve/
restore); `editor` may edit, borrow and resolve; `owner` additionally
manages members and workset owners. **Identity caveat:** the server
authenticates callers with one shared `OBS_SERVER_TOKEN`, so `clientId` is
self-asserted. Roles are enforced at the API for the claimed clientId, but
they are NOT proof of identity. Treat this as a coordination discipline for
a trusted team on a shared token — not as an access-control boundary against
mutually untrusted users. True per-user authentication is out of scope for
this change (it belongs to #92).

**Limits.** Central op bodies are capped at 1 MB (separate from the server's
200 MB file-upload cap); at most 200 fields per op; at most 64 KB per field
value; borrow leases expire after 15 minutes (swept on access, the removal
itself journalled). Element state is generic field maps (`{ height, name,
… }`) — the mapping from these fields onto real model elements is the
remaining UI work below.

## 5. What changed (files)

- `server/central-model.mjs` (new) — pure state machine: sequencing,
  field-level merge, borrowing, roles, conflicts, restore. No I/O.
- `server/central-store.mjs` (new) — durable store: snapshot + fsynced
  journal + audit, crash replay, compaction.
- `server/index.mjs` — `/api/central/:room/...` routes (Bearer-gated,
  mutation-rate-limited, 1 MB body cap), `central-op` SSE broadcast.
- `src/modules/collaboration/central-client.ts` (new) — browser/Node
  client: join, ops with idempotency keys, offline queue + replay, SSE
  subscription with gap re-sync, borrow/workset/resolve/restore/history/
  audit wrappers. `EventSource` factory injectable for tests.
- `tests/central-model.test.cjs` (new) — 16 pure-model tests.
- `tests/central-sync.test.cjs` (new) — 16 integration tests, two real
  clients vs. a real spawned server (see §6).
- `src/features/feature-maturity.ts` — `collaboration` entry corrected:
  the Yjs last-writer-wins claim is removed; the entry now describes the
  central sync, its limits and the shared-token identity caveat. Status
  stays `limited` (see §7).
- `docs/engineering/ARCHITECTURE.md`, `docs/engineering/SERVER-ROUTE-AUDIT.md`
  — route table + pointer to this document.
- `src/modules/collaboration/worksharing-engine.ts` — header comment now
  states it is local-only and points at the durable path (no behaviour
  change).
- `package.json`, `scripts/ci-unit-tests.mjs` — `test:central-model`,
  `test:central-sync` registered in CI.

## 6. Test evidence

Run on this VM (1.5 shared CPUs), work repo at
`~/workspace/openBIMstudio-work/collaboration/repo`, base `e8e5afb`:

| Suite | Result |
|---|---|
| `node tests/central-model.test.cjs` | **16 passed, 0 failed** |
| `node tests/central-sync.test.cjs` | **16 passed, 0 failed** (~13 s) |
| `node tests/enterprise-collaboration.test.cjs` (`test:collab`) | **10 passed, 0 failed** (unchanged — local engine still covered) |
| `node tests/server-hardening.test.cjs` | **39 passed, 0 failed** (unchanged from the `e8e5afb` baseline) |
| `node tests/server-security.test.cjs` | **14 passed, 0 failed** (unchanged) |
| `node tests/feature-registry.test.cjs` | **11 passed, 0 failed** (registry entry still validates after the correction) |
| `npm run build` (`tsc && vite build`) | **exit 0** (~41 s; only the known pre-existing `THREE.TSL` / `NodeMaterial` `IMPORT_IS_UNDEFINED` warnings). `tsconfig.json` includes all of `src/`, so the new client is strict-typechecked by the build; a direct `npx tsc --noEmit --strict` on `central-client.ts` also passes |

Integration scenarios (all against a spawned `server/index.mjs` on an
ephemeral loopback port with an isolated data dir; clients are compiled
`CentralClient` instances plus raw `fetch` clients — no mocks):

1. Two clients join; first is owner, second editor.
2. Concurrent edits to **different** elements converge identically on both
   clients (same revision, same state).
3. Concurrent edits to the **same** element, **different** fields, merge
   with zero conflicts.
4. Concurrent edits to the **same** element, **same** field: second writer
   gets 1 conflict (attempted 3900, winning 3300), server keeps 3300, both
   clients converge to 3300, `openConflictCount` 1.
5. Conflict resolution `mine` applies 3900 as a new revision.
6. Duplicate op delivery (`op-dup-1` twice): second returns
   `duplicate: true`, revision advances exactly once, journal holds one
   entry with that `opId`.
7. Borrowing enforced across clients (409 for the non-holder), request →
   grant by the holder unblocks, relinquish frees; a bystander (neither
   holder nor room owner) gets 403 on `borrow-respond`.
8. Permissions: viewer gets 403 on op; owner restores editor, op succeeds.
9. Workset ownership: edits in an owned workset get 409 until the owner
   clears ownership.
10. Live SSE: a second client's event stream receives the `central-op`
    for the first client's op with the correct sequence number.
11. Disconnect/reconnect: a client that missed 2 ops catches up via
    `/sync?since=<rev>` (exactly those 2 entries, in order); `since=0`
    returns the full retained journal (one entry per sequence number).
12. **Server restart mid-session (SIGKILL + respawn, same data dir):**
    revision, element state, membership and owner role survive; the
    journal file's last entry matches the pre-kill revision; both clients
    re-join and keep editing (revision +3: two joins + one op).
13. Version history lists entries; restore to an earlier revision reverts
    the field and appears as a new `restore` entry (history not rewritten);
    restoring to the current revision is rejected (400).
14. Audit trail contains accepted ops, rejections (≥2) and role changes;
    the on-disk `audit.jsonl` is append-only.
15. Offline queue: an op submitted while not joined waits, then flushes
    exactly once on reconnect (same `opId` redelivery deduped).
16. Journal compaction (separate server, `OBS_CENTRAL_JOURNAL_MAX=10`,
    15 ops): journal file holds exactly 10 lines; `sync?since=0` returns
    `truncated: true` with the full 15-element state; restore to revision
    2 is refused (400).

## 7. Per-requirement status (§9, 13 requirements)

| Requirement | Status | Evidence / note |
|---|---|---|
| Server-authoritative state | **Met** | Single sequencer; clients hold no authority; `GET /state` is the server's state |
| Durable transaction journal | **Met** | `journal.jsonl`, append + fsync before ack; replay on load; compaction bounded at 500 |
| Independent client synchronisation | **Met** | Two real clients converge in every concurrent scenario (§6.2–4, §6.11) |
| Workset management | **Met** | 8 seeded defaults, create, owner assignment; enforced at op acceptance |
| Borrowing and ownership | **Met** | Leases with expiry, request/grant/deny, relinquish, leave-relinquishes; enforced server-side |
| Conflict detection | **Met** | Per-field sequence check; delete-vs-edit; recorded with both values |
| Conflict resolution | **Met** | `mine` / `theirs` / custom value, journalled + audited |
| Duplicate transaction handling | **Met** | `opId` dedupe in the retained window; post-compaction safety via sequence check + `createdByOpId` |
| Reconnection | **Met** | `sync?since`, SSE gap re-sync, offline queue + replay (protocol-level; browser auto-reconnect relies on EventSource) |
| Version history | **Met** | Journal is the history (`GET /history`); restore inverts entries within the retained window |
| Permissions | **Partial** | Roles enforced at the API (owner/editor/viewer), but identity is a self-asserted `clientId` under one shared server token — not an access-control boundary. True per-user auth needs #92 work |
| Audit trail | **Met** | Append-only `audit.jsonl`: accepts, rejections (reason + status), roles, borrows, restores |
| Restart recovery | **Met** | SIGKILL + respawn test; snapshot + journal-tail replay |

## 8. Remaining work (for the user / follow-ups)

1. **Bind the central element model to the live ModelGraph.** The server
   syncs generic field maps; nothing yet translates a `central-op` into a
   wall/door edit in the running app, and nothing yet turns a local authoring
   edit into a central op. That binding (element-id mapping, applying remote
   fields, surfacing conflicts in the worksharing panel) is the next step
   and needs the §8 core-model work to be stable first.
2. **Browser E2E proof.** Two-browser (or two-tab) test driving the real
   UI through a join → concurrent edit → conflict → resolve flow.
3. **Per-user authentication** (#92): replace the shared token + self-
   asserted `clientId` with real identities before treating roles as a
   security boundary.
4. **Scale story:** single Node process, whole-state snapshots, 500-entry
   journal window. Fine for a small team; not a claim about tens of
   concurrent editors or large models (no load test run).
5. **Item-5 note (not this workstream):** `docs/engineering/BASELINE.md`
   and `SERVER-ROUTE-AUDIT.md` previously described signed SSE tokens as
   shipped; on main `issueSseToken` is still never called and there is no
   mint endpoint. The item-5 patch (`fix/fail-closed-sse`) addresses that;
   this change does not depend on it and does not duplicate it. The central
   client reuses the existing SSE token-provider hook when one is
   registered.
