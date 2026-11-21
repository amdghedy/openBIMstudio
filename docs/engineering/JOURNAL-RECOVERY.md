# Journal replay — recovery contract (#101)

**Status:** implemented on `fix/recovery-journal-replay` (base `e8e5afb`),
completed on `fix/revit-rank4-backup-recovery` (base `eabab92`):
manual-open replay, corrupt-checkpoint quarantine, and deletion of the
blind `recoverProjectState()` helper. Proven by
`tests/e2e/recovery.spec.ts` (5 scenarios, Chromium),
`tests/e2e/recovery-manual-open.spec.ts` and
`tests/e2e/recovery-checkpoints.spec.ts` (Chromium),
`tests/journal-replay.test.cjs` (23 checks) and
`tests/project-checkpoint-quarantine.test.cjs` (23 checks). The
server-side backup contract lives in
`docs/engineering/SERVER-BACKUP-RECOVERY.md`; this document is the
browser-side twin. Neither is a substitute for the other: the server
backup guards the file on disk, the journal guards the save that never
reached the primary record.

## The journal

- Every project save writes the **whole document** as a
  `replace-state` entry in the `projectOps` IndexedDB store **before**
  the primary `projects` record is written (`store.putProject()`).
  The journal is therefore always at least as new as the primary
  record, never older.
- Entries are `{ seq, ts, kind, payload }`, `seq` per project,
  increasing. `delete` entries record intentional deletions so
  recovery never resurrects a deleted project.
- A snapshot is written every 500 entries (`core/journal.ts`) and
  older entries are compacted away.

## When replay runs

- **Only when a crash marker exists** (`localStorage
  obs.session.unsaved`) for the project being opened. A clean boot /
  a marker-less open never replays, even when the journal is ahead of
  the primary store — a journal-ahead state without a marker is left
  exactly alone (proven by `recovery.spec.ts`, "clean boot").
- The marker is written eagerly when the document first goes dirty
  in a save cycle and cleared on a clean save / clean unload, so a
  renderer crash, a killed browser, or power loss still leaves it
  (beforeunload never fires on those).
- Replay runs in the `project-crash-recovery` boot step in `main.ts`,
  **before** auto-reopen and **before** `openProject`: a crash that
  lost the primary write makes the project invisible to the project
  list, and `openProject` refuses a corrupt primary record outright,
  so replaying later would be too late on both counts.
- **Manual open replays too** (rank 4): `openProject` checks the
  marker for the project being opened and replays before loading the
  primary record — the retry path for a crash boot recovery failed to
  triage (marker kept). No marker for that project, no journal read:
  a clean open never touches the journal. Proven by
  `tests/e2e/recovery-manual-open.spec.ts`.
- The crash marker is cleared after triage. The two exceptions keep
  it, so the next boot (or the next manual open) retries: a restore
  write that failed, and a journal that could not be read at all.

## What replay does

1. Reads the primary record (the last known-good baseline) and the
   whole journal (newest snapshot + every entry).
2. Replays entries in `seq` order onto the snapshot with the
   validated core (`src/modules/projects/journal-replay.ts`):
   `replace-state` replaces the whole document, `delete` yields
   "deleted". Every applied payload must normalize to a project
   document for **this** project (`normalizeProjectDoc` + id match).
3. Writes the replayed document back with `putProject` **only** when
   it is newer than the primary record, or the primary record is
   missing/corrupt, or the same timestamp carries different bytes
   (the journal was written first in that save, so it wins the tie).
   `putProject` snapshots the previous primary record as a
   `project-save` checkpoint first, so a bad recovery is itself
   reversible via File → Recovery checkpoints…
4. Records the outcome in `localStorage obs.recovery.last` (summary
   only — never the document) and updates the recovery banner with
   the honest result.

## What replay refuses — and what happens instead

- **First unusable entry stops the replay.** The entry and every
  later entry (the tail) are moved to the `projectJournalQuarantine`
  IndexedDB store with the raw payload and the reason, and removed
  from the live op store. Nothing is silently dropped and nothing
  after the stop is applied — not even a later good entry or a
  `delete`. The state up to the last good entry is still recovered
  (partial recovery) and the banner says it was partial.
- **Unknown entry kinds stop the replay.** No replay semantics are
  invented for a kind the code does not know.
- **A corrupt snapshot does not poison the entries.** The snapshot
  is discarded, replay starts from empty over all entries, and the
  corruption is reported.
- **Missing sequence numbers are tolerated but recorded** (a later
  whole-document entry still supersedes). A sequence that goes
  backwards or repeats stops the replay.
- **A journal ending in `delete` suppresses auto-reopen.** The
  project is not resurrected, including when a crash mid-delete left
  a stale primary copy behind. The record stays on disk for a manual
  open / checkpoint restore.
- **Journal absent:** recovery falls back to the primary record
  (or the welcome screen when there is none) and claims no replay.
- **Replay never throws.** A failed journal read, quarantine, or
  restore write is recorded in the outcome and boot continues with
  the primary record.

## What replay cannot recover

- Edits that never reached a save (or the 25 s autosave): they lived
  only in memory and no journal entry exists for them. The banner
  never claims otherwise — it reports how many journal entries were
  replayed.
- Model payloads (`.ifc`/`.rvt` blobs) are not journaled; the
  replayed document references them by id and the checkpoint system
  owns their retention. A recovered document whose models are missing
  marks them `missing` through the normal open path.

## Retention policy

| Store | Retention | Rule |
|---|---|---|
| `projectOps` | Until snapshotted (every 500 entries) | Compacted by `core/journal.ts` |
| `projectOperationSnapshots` | Newest only (per project) | `loadNewestSnapshot()` |
| `projectJournal` (checkpoints) | Newest 10 per project | `PROJECT_RECOVERY_RETENTION` |
| `projectJournalQuarantine` | Newest **50** per project | Oldest pruned on insert (`selectQuarantinePruneKeys`); a quarantined entry keeps its raw payload + reason as evidence |
| `obs.recovery.last` | Last outcome only | Overwritten on every crash boot |
| Crash marker `obs.session.unsaved` | Until triaged / clean save / clean unload | See "When replay runs" |

## Known limitations (not fixed here)

- **No quota-exhaustion or stale-tab scenario.** Filling storage to
  quota cannot be done deterministically in the test environment, and
  the stale-tab (`onblocked`) path needs a database version upgrade
  with another tab holding the old connection — no upgrade ships in
  this change. Both are recorded as not covered, not faked.
- **Ctrl+S did not save in the E2E probe runs** when a modelling tool
  was still mid-placement (the keypress never reached the shortcut
  handler); saving through the feature registry worked every time.
  The specs save through the registry. Whether Ctrl+S is genuinely
  broken or focus-dependent needs a separate look, outside #101.

## Corrupt checkpoints — quarantine, last known-good (rank 4)

Recovery checkpoints (`projectJournal`, newest 10 per project) are
validated before they are listed or restored
(`validateRecoveryCheckpointRecord` in
`src/modules/projects/project-journal.ts`: the stored document must
normalize and its `id` must match the owning project). A checkpoint
that fails is moved to the `projectJournalQuarantine` store (same
store the op-journal quarantine uses, key
`<projectId>:checkpoint:<id>`, raw record + reason kept as evidence,
newest 50 per project, pruned independently of op quarantines) and
excluded from the restorable list — so one corrupt checkpoint can
never hide the good ones or be offered as restorable, and the newest
verified checkpoint is always first: the offer is the last
known-good. Restore validates again before touching the live
document: a corrupt checkpoint is refused, quarantined, and the live
document and its blobs are left exactly as they were (no
"before-restore" snapshot is taken, because nothing was overwritten).
The Recovery UI names the quarantined checkpoints with their reason
instead of silently dropping them. A checkpoint with torn
collections (non-array `elements` etc.) is repaired by normalization
and still offered, not quarantined. Proven by
`tests/project-checkpoint-quarantine.test.cjs` (23 checks) and
`tests/e2e/recovery-checkpoints.spec.ts` (Chromium).

## Closed in rank 4 (were limitations of the #101 pass)

- **Manual open after a crash now replays.** `openProject` runs the
  validated recovery for the project being opened when its crash
  marker exists — see "When replay runs" above.
- **The recovery banner survives a slow boot.** The banner is created
  mid-boot (project-recovery step) but the outcome only lands at the
  end of boot (project-crash-recovery), and its 30 s auto-dismiss ran
  from creation — on a slow boot the banner was already gone when the
  outcome arrived, and `updateRecoveryBanner` silently no-opped, so
  the user never learned what was recovered (the #101 browser specs
  only passed because boot was fast enough). Now the outcome re-creates
  the banner if the timer already removed it — unless the user
  deliberately dismissed it — and restarts the 30 s clock from the
  outcome (`src/features/project-recovery.ts`: `createRecoveryBanner` /
  `scheduleBannerDismiss` / `updateRecoveryBanner`).
- **`recoverProjectState()` is deleted.** The blind `Journal.open`
  replay helper had no callers and could throw on a corrupt snapshot.
  Crash recovery uses the validated core only. The append path's
  snapshot restore is the tolerant `parseJournalSnapshotState`
  (`indexeddb-journal.ts`): a corrupt snapshot falls back to replaying
  the ops from empty (logged loudly) instead of breaking every future
  save — a throw there would have failed `putProject` on every save.
