# Project Persistence & Recovery

How Open BIM Studio protects project data, what happens when something goes
wrong, and how to recover. This document describes the implementations in
`src/modules/projects/` (store, schema, persistence, file IO, journal) and the
recovery UI in `src/features/project-recovery.ts`.

---

## 1. Where your data lives

| Data | Location | Key / store |
| --- | --- | --- |
| Project document (elements, grids, levels, issues, metadata, views, constraints…) | IndexedDB `open-bim-studio`, store `projects` | keyed by project `id` |
| Linked / imported model payloads (IFC, FRAG, aux underlays) | IndexedDB `open-bim-studio`, store `modelBlobs` | index `projectId` |
| Recovery checkpoints (10 most recent pre-save states per project) | IndexedDB `open-bim-studio`, stores `projectJournal` + `projectJournalBlobs` | index `projectId` |
| Linked `.obsproj` file handle (Chrome/Edge “save to the same file”) | IndexedDB `obs-file-links` | keyed by project `id` |
| Unsaved-changes crash marker | `localStorage["obs.session.unsaved"]` | written while dirty, cleared on clean save/unload |
| API keys / secrets | `obs.secure.*` (AES-GCM, see `src/core/secure-store.ts`) | never plaintext |

The database schema version is **2** (stores above). Documents carry their own
`schemaVersion` (currently **2**) so the document format can evolve
independently of the database layout.

## 2. When data is written

- **Manual save** — Ctrl+S / File → Save / command palette → `saveProject()`.
- **Autosave** — every 25 s when the document is dirty. The autosave is
  skipped while a save is already running, while a project is opening/being
  created, and while the tab is hidden.
- **Model import** — `onModelImported()` writes the payload and the document
  metadata in one transaction.
- **Save to file** — `.obsproj` (see §6) via File → Save As, plus an automatic
  re-write of a linked file at most every 45 s after a save.
- Every write is repaired (`repairProjectDocInPlace`) and structurally valid
  before it reaches storage.

### Dirty tracking and the save status line

`markDirty()` bumps a **generation counter**. A save captures the counter when
it starts; the document is only declared clean if **no edit happened while the
write was running** — otherwise it stays dirty and the next autosave flushes
it. Edits made during a save can therefore never be silently declared saved.

The status bar shows the full state machine, never a lie:

| Status | Meaning |
| --- | --- |
| `● saved` (+ last-saved time on hover) | write committed to IndexedDB |
| `● saving…` | write in flight |
| `● unsaved` | edits not yet written |
| `⚠ save failed — click to retry` | the last write failed; clicking retries. Hover shows the reason (e.g. storage full). |

A failed save **always** keeps the document dirty, raises `obs:save-failed`,
and surfaces a message — autosave failures produce a throttled toast (at most
one per minute) so a background failure can never pass silently.

## 3. Failure modes and what the app does

### Browser refresh / close / crash with unsaved changes
- `beforeunload` warns with the browser-native confirmation.
- While the project is dirty, a synchronous crash marker is written to
  `localStorage` (also on `visibilitychange → hidden`, which covers mobile).
- On the next boot, if the marker is present, you get a banner: *"Previous
  session ended without a clean save"* plus a pointer to recovery
  checkpoints. The marker is cleared by the next clean save or a clean unload.

### Storage exhaustion (quota)
- `saveProject` detects `QuotaExceededError` (Chromium and Gecko variants).
- You are told storage is full and asked to free space or save a `.obsproj`
  backup; the document stays dirty and the status bar shows the failure.
- At boot the app requests persistent storage (`navigator.storage.persist`)
  and warns once when usage exceeds 90 % of the estimated quota.

### Corrupted / malformed project data
- Everything read from IndexedDB passes `normalizeProjectDoc`
  (`src/modules/projects/project-schema.ts`): missing collections are
  backfilled, bad timestamps repaired, nameless entries renamed — and **every
  repair is reported** as a toast on open.
- A document that cannot be made safe (not an object, no usable `id`, written
  by a **newer** schema version) is **refused** with the exact reasons and a
  pointer to recovery options. The raw record is **never deleted** — the
  journal still holds earlier checkpoints and a `.obsproj` backup remains
  importable.
- Malformed `.obsproj` files are refused before anything is written
  (truncated payloads, wrong magic, damaged header, future versions, invalid
  embedded documents). The file on disk is never modified by a failed import.

### Interrupted import / Save-As copy
- Document + all model payloads are written in **one** IndexedDB transaction
  (`importProjectWithBlobs`). A crash mid-import cannot leave metadata whose
  payloads were never written, and the “replace existing project” path no
  longer deletes payloads before the new data is committed.

## 4. How to recover

### Recovery checkpoints (primary path)
Every save that changes the document, every model import, and every restore
first snapshots the current state (10 kept per project, with immutable copies
of the referenced model payloads).

1. Open the affected project (File → Open Project…).
2. **File → Recovery checkpoints…** (also in the command palette: “Recovery
   checkpoints”).
3. Each entry shows its time, what triggered it, and how many elements /
   models / missing payloads it contains.
4. **Restore** — the current state is snapshotted first (`before-restore`),
   so a restore is itself reversible. The scene reloads afterwards; models
   whose payloads were not in the checkpoint appear in the “not loaded”
   banner.

### `.obsproj` file backups
File → Save As writes a portable `.obsproj` (document + all model payloads in
one file). File → “Save encrypted copy” writes an AES-256-GCM protected copy;
the password is never stored anywhere — if it is lost, the file cannot be
opened. Opening a `.obsproj` re-imports it into the browser's project list
(replace the existing copy or import as a separate copy).

### Export → JSON
File → Project → JSON writes a readable `.obs.json` backup of the document
(model payloads excluded — use `.obsproj` for full-fidelity backups).

## 5. For developers: schema versions and migrations

- Current document schema: `PROJECT_DOC_SCHEMA_VERSION = 2`
  (`src/modules/projects/project-schema.ts`).
- **Adding a migration**: append to `PROJECT_MIGRATIONS` (`2: (doc) => …`),
  bump the constant. Never rewrite an existing migration — already-persisted
  documents must keep migrating deterministically.
- `normalizeProjectDoc` must stay pure and dependency-free (tests compile it
  standalone); it must never throw, must record every repair as an issue, and
  must refuse only non-objects, missing identity, and future versions.
- The `.obsproj` container version (`project-file.ts`, `VERSION = 1`) is
  independent of the document schema; bump it only when the container layout
  changes, and keep the “newer version” refusal.
- Tests: `tests/project-persistence.test.cjs` (registered as
  `test:project-persistence` in `package.json` and `scripts/ci-unit-tests.mjs`)
  — 36 checks against the real compiled implementations and real sources,
  including fuzzing, a 30k-element large-project roundtrip, and ratchet
  assertions (no new `window.__obs*` globals, no `confirm(`/`prompt(`).

## 6. `.obsproj` file format

```
bytes 0..7    magic "OBSPROJ1"
bytes 8..11   uint32 LE: header length H
bytes 12..    H bytes UTF-8 JSON header
              { format, version, savedAt, app, doc, blobs:[{modelId,name,size,type}] }
then          each model payload back-to-back in header order
```

`doc` is the full project document (schema-versioned as above). Linked models
and metadata therefore travel together and are imported atomically into the
local database.

## 7. Guarantees summary

- No silent data loss: failed saves stay dirty and visible; repairs are
  announced; malformed inputs are refused with specifics; corrupt records are
  kept, never dropped.
- No destructive write without a prior checkpoint (journal retention 10).
- No half-written projects: documents + payloads commit in one transaction.
- No forced migrations: database schema unchanged (v2), document migrations
  are additive and versioned.
