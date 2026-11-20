# Journal replay — recovery contract (#101)

**Status:** implemented on `fix/recovery-journal-replay` (base `e8e5afb`).
Proven by `tests/e2e/recovery.spec.ts` (5 scenarios, Chromium) and
`tests/journal-replay.test.cjs` (21 checks). The server-side backup
contract lives in `docs/engineering/SERVER-BACKUP-RECOVERY.md`; this
document is the browser-side twin. Neither is a substitute for the
other: the server backup guards the file on disk, the journal guards
the save that never reached the primary record.

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

- **Only on boot, only when a crash marker exists**
  (`localStorage obs.session.unsaved`) for the project being reopened.
  A clean boot never replays, even when the journal is ahead of the
  primary store — a journal-ahead state on a clean boot is left
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
- The crash marker is cleared after triage. The two exceptions keep
  it, so the next boot retries: a restore write that failed, and a
  journal that could not be read at all.

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

- **Manual open after a crash does not replay.** Only the boot
  auto-reopen path runs recovery. Opening a different project from
  the welcome screen after a crash loads its primary record as-is;
  the banner points at the checkpoints. Wiring replay into
  `openProject` itself is a follow-up, not done here because it would
  put an IndexedDB journal read on every open.
- **No quota-exhaustion or stale-tab scenario.** Filling storage to
  quota cannot be done deterministically in the test environment, and
  the stale-tab (`onblocked`) path needs a database version upgrade
  with another tab holding the old connection — no upgrade ships in
  this change. Both are recorded as not covered, not faked.
- **`recoverProjectState()` still uses the blind `Journal.open`
  replay** (no payload validation, corrupt snapshot throws). It has
  no callers; a follow-up should route it through the validated core
  or delete it.
- **Ctrl+S did not save in the E2E probe runs** when a modelling tool
  was still mid-placement (the keypress never reached the shortcut
  handler); saving through the feature registry worked every time.
  The specs save through the registry. Whether Ctrl+S is genuinely
  broken or focus-dependent needs a separate look, outside #101.
