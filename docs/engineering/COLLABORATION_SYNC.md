# Collaboration & Worksharing — Central Sync Design

**Status:** implemented on branch `fix/collaboration-worksharing` (base `e8e5afb`);
ModelGraph binding + enforced locks + two-user browser proof added on branch
`feat/revit-7-collaboration` (base `eabab92`, Revit parity rank 7 — see §9).
**Scope:** the server-authoritative sync protocol and its binding into the
live authoring model. The browser UI binding of remote ops into the live
ModelGraph is implemented in §9 (it was the remaining work of the first
change, now done).

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
- `src/modules/collaboration/central-binding.ts` (new, rank 7) — binds the
  central model to the live authoring model (§9).
- `src/modules/collaboration/authoring-adapter.ts` (new, rank 7) — browser
  adapter: validated `applyElementParamChange` path, level-skip, remote
  creation via `createElementByType`.
- `src/modules/collaboration/edit-guard.ts` (new, rank 7) — the choke point
  the authoring path consults; `withGuardSuspended` for remote applies.
- `src/modules/collaboration/central-binding-setup.ts` (new, rank 7) — boot
  wiring, `ctx.features.centralSync`.
- `src/features/authoring.ts` (rank 7) — guard consulted in
  `applyElementParamChange`, `deleteElements` / `removeElementById`,
  `transformElements`; `applyElementParamChange` exported on the authoring
  feature.
- `src/features/worksharing-panel.ts` (rank 7) — central section: join,
  sync, leave, borrow/relinquish, open-conflict list with mine/theirs
  resolve.
- `tests/central-binding.test.cjs` (new, rank 7) — 13 integration tests,
  two real bindings vs. a real spawned server (see §9).
- `tests/e2e/central-worksharing.spec.ts` (new, rank 7) — two-user Chromium
  E2E (see §9).
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
  `test:central-sync`, `test:central-binding` registered in CI.

## 6. Test evidence

Run on this VM (1.5 shared CPUs), work repo at
`~/workspace/openBIMstudio-work/collaboration/repo`, base `e8e5afb`:

| Suite | Result |
|---|---|
| `node tests/central-model.test.cjs` | **16 passed, 0 failed** |
| `node tests/central-sync.test.cjs` | **16 passed, 0 failed** (~13 s) |
| `node tests/central-binding.test.cjs` (rank 7) | **13 passed, 0 failed** — two real bindings (fake in-memory authoring models) vs. a real spawned server: field mapping, join/roles, create materialisation, edit propagation, different-field merge, borrow guard + 409 revert, workset-owner guard, genuine offline-replay conflict + `mine` resolve, offline queue exactly-once, remote delete, join divergence (central wins), pinned level constraint, unpushed-edit preservation (regression, see §9) |
| `npx playwright test tests/e2e/central-worksharing.spec.ts --project=chromium` (rank 7) | **1 passed, 0 failed** (5.0 min on this VM) — two real browser pages (Alice + Bob) vs. a real spawned server and the production bundle: wall propagates, borrow refuses via the property palette with a toast naming Bob, offline edit conflicts and resolves from the panel, both converge, zero page errors. The run forced two real fixes (see §9): a `waitForFunction` arg-misuse in the spec itself, and a stale-`fetchState` race in the client. Local-run note: on this shared VM port 3000 was held by another workstream's preview server, so the proof run used a temporary port-3001 config (deleted after the run); CI uses the committed port-3000 config. |
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

1. ~~**Bind the central element model to the live ModelGraph.**~~ Done in
   rank 7 (§9): `central-binding.ts` + `authoring-adapter.ts` +
   `edit-guard.ts`, panel surface, 13 integration tests + two-user
   Chromium E2E.
2. ~~**Browser E2E proof.**~~ Done in rank 7 (§9):
   `tests/e2e/central-worksharing.spec.ts` (Chromium; two pages through
   join → propagate → borrow-refuse → offline conflict → panel resolve).
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
   this change does not depend on it or duplicate it. The central
   client reuses the existing SSE token-provider hook when one is
   registered.
6. **Join-time central-wins discards pre-join local edits.** At join,
   central wins on every field of an element that exists on both sides
   (documented, tested by the Carol case). Edits made locally while not
   joined are lost for shared elements; only local-only elements push up.
   The offline queue covers ops submitted while joined-but-offline, not
   edits made before ever joining.
7. **Sync field set is explicit, not the whole model.** Only the 18 keys
   in `SYNC_PARAM_KEYS` travel; sweeps, hosted-opening cuts, `properties`,
   families and anything outside the set stays local-only. Growing the
   set means teaching the adapter each new field's validation path.

## 9. ModelGraph binding — Revit parity rank 7

**Branch:** `feat/revit-7-collaboration` (base `eabab92`).
**Rank scope:** central model + enforced locks + proven merge, and the Yjs
question resolved (correction, not wiring — see below).

### What the binding does

- **Local → central.** `CentralBinding` subscribes to authoring changes
  (`onAuthoringChange`) and pushes a debounced (400 ms) diff against
  `lastKnown` — the last field map agreed between local model and central.
  New local elements push up with the active workset; deletes push a
  central delete. `elementToCentralFields` carries only `type`/`name`/
  `hostId` + the 18 `SYNC_PARAM_KEYS` (scalar params, plan geometry,
  level constraints; `length` is derived and never travels).
- **Central → local.** On SSE state updates (and on join), remote elements
  materialise via the history-wrapped `createElementByType` under a fresh
  local id (central id = the creating client's local id; the mapping is
  rebuilt on every join), remote deletes remove the local element, and
  remote field updates go through the validated
  `applyElementParamChange` path (anchor field + companion `extra`
  params), so a remote update gets the same validation, geometry rebuild
  and undo behaviour as a local edit. Level constraints apply only when
  the level exists locally; otherwise the field is reported skipped and
  the binding **pins** it (never echoes the stale local value back over
  the server's). Hosted elements are ordered after their host.
- **Enforced locks.** `edit-guard.ts` is the single choke point, consulted
  synchronously in `applyElementParamChange`, `deleteElements` /
  `removeElementById` and `transformElements` — so the property palette,
  modify bar, parametric tools, keyboard nudge and align all refuse the
  same way. While joined, an element borrowed by another user, or in a
  workset owned by another user, refuses with a reason naming the holder
  (e.g. `borrowed by Bob — borrow it (or request it) before editing`);
  the legacy local selection locks are consulted as a fallback. A delete
  cascade refuses as a whole if any member (host or hosted child) is
  refused; a transform moves the unrefused targets and leaves the refused
  ones in place. Remote application of authoritative central state
  bypasses the guards via `withGuardSuspended` (a server decision is not
  a user edit). The server enforces the same rule at acceptance time
  (409), so an edit that bypasses the guard (e.g. a stale UI) is still
  refused and reverted locally.
- **Merge, proven.** The merge itself stays on the server (§3). The
  binding proves it end to end: two clients editing different fields of
  the same element merge with zero conflicts; a genuine conflict (offline
  edit replayed after the other side landed) keeps the server value, both
  clients converge, the conflict is listed in the worksharing panel with
  both values, and resolving `mine`/`theirs` converges both clients on
  the chosen value.
- **Offline queue & replay.** Ops submitted while offline queue with
  their original `opId` and replay exactly once on reconnect
  (`syncNow` → `sync` + `flushQueue` + push); the server dedupes by
  `opId`. Verified in both the integration suite (one journal entry per
  replayed op) and the browser E2E (offline context → edit → reconnect →
  conflict → resolve).
- **Unpushed edits are never overwritten by a remote update.** This was a
  real bug found by the rank-7 test run, not a hypothetical: the first
  `central-binding` run failed 1/12 — a remote op touching an unrelated
  field (a level constraint) reverted Bob's pending height edit to the
  stale central value, because the remote apply diffed local-vs-central.
  The fix (`remoteChangedFields` + a `force` flag for the 409-revert
  paths): the steady-state apply only touches fields the server changed
  since `lastKnown` AND the local user has not changed since then. A
  both-sides change keeps the local value; the push then carries it with
  a stale `baseRevision` and the server records a real conflict. The
  409 paths keep central-wins (the server has ruled on that edit). Pinned
  by a regression test (12 → 13 tests); sensitivity-checked — the new
  test fails on the pre-fix code.
- **Stale `fetchState` responses never clobber newer state.** A second
  real race, also found by the rank-7 runs: `fetchState` is fired
  concurrently by the SSE entry handler, the onopen sync and the
  heartbeat, and the responses can resolve out of order. The client
  assigned every response unconditionally, so a slow pre-edit fetch
  could rewind the local model. The fix is a monotonic-revision guard
  in `fetchState` (and in `sync`'s truncated branch): a response with a
  revision older than the one already held is dropped, never emitted.
  Pinned by a `central-sync` regression test (16 → 17) that interleaves
  a slow stale response with a fast fresh one; sensitivity-checked.
- **The spec's own `waitForFunction` misuse.** Five height-convergence
  waits in the E2E passed the expected height as `waitForFunction`'s
  second argument — which Playwright treats as the function *argument*,
  not the expected value — so each wait returned as soon as the wall
  existed at any height. The symptom (Bob reading 3 right after the
  wait "for 3.3" passed) looked like a product bug; server-side polling
  proved the product was converging correctly and the wait was vacuous.
  All five waits are now real boolean predicates. The 90 s home-card
  wait, the DOM-click (instead of Playwright's stability-checked click)
  and the 600 s test timeout are timing tolerances for a loaded VM, not
  weakened assertions — the post-conditions are still asserted.

### The Yjs question — resolved by correction

`yjs@^13.6.14` / `y-websocket@^3.1.0` remain declared in `package.json`
but are imported nowhere in `src/`, `server/` or `tests/` (re-verified by
grep on this branch: the only matches are the two `package.json` lines
and the registry limitation that documents the fact). No CRDT is in use
and none is claimed. The registry's false "last-writer-wins via Yjs
updates" claim was corrected in the first collaboration change and the
correction stands: the consistency model is server-sequenced
deterministic merge (§3). Wiring Yjs in was rejected on purpose — a CRDT
solves peer-to-peer convergence with no ordering authority, and this
server already *is* a single ordering authority; Yjs would add vector
clocks/tombstones without changing the human-resolution step that matters
in BIM. The declared-but-unused dependencies are left in place (removing
them is lockfile churn with no behaviour change) and documented in the
registry limitation.

### Honest ceiling (Revit parity §10)

Small-team co-authoring works: a central model with revision counters
that mean something across clients, enforced locks with named reasons, a
proven merge with explicit conflict resolution, offline queue + replay,
restart recovery. What it is not: Revit-scale worksharing. No load test
has been run; the server is a single Node process with whole-state
snapshots; identity is a shared token with self-asserted `clientId`
(roles are coordination, not access control — #92); only 18 fields sync;
there is no element-level permission model, no enterprise audit beyond
the server `audit.jsonl`, and no multi-server story. The registry status
stays `limited` for exactly these reasons.
