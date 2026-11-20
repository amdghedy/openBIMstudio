# Collaboration server backup & recovery (#91)

Source: `server/backup.mjs`, wired into `server/index.mjs` (`loadJson`,
`saveJson`, project PUT). This covers the **server stores only**
(`projects.json`, `rooms.json` under `OBS_DATA_DIR`, default
`server/data/`). Browser-side persistence (IndexedDB journal, recovery
snapshots in the Recovery UI) is a separate system — see issue #101;
this document does not cover it.

## What is backed up, and when

| Event | What happens |
|---|---|
| Server boot / store load (`loadJson`) | **Snapshot-on-load**: the exact bytes about to be parsed are copied to a timestamped backup first. The copy is verified by read-back before it counts toward retention. |
| Every server write (`saveJson` → `writeJsonWithBackup`) | **Backup-on-write**: the current live file is copied first, then the new state is written via temp file + atomic rename on the same filesystem. |
| Restore (`restoreBackup`) | The live file is preserved first (backed up if it parses, quarantined if it does not), then replaced atomically from a verified backup. |

Backups live next to the store file:
`projects.json.<ISO-stamp>.<8-hex>.bak`, e.g.
`projects.json.2026-11-20T14-01-51-556Z.b970c684.bak`.

## Naming, retention, verification

- **Names** are timestamped AND collision-safe: an ISO-8601 stamp plus a
  random 8-hex suffix, so two backups in the same millisecond never
  collide. Ordering is by file mtime, ties broken by name.
- **Retention is bounded: 5 backups per store file** (`BACKUP_KEEP = 5`
  in `server/backup.mjs`). Older backups are pruned whenever a new
  verified backup is taken. There is no unbounded growth.
- **Verification by read-back.** A backup only counts as recoverable
  after it is read back and re-parsed as a JSON object (the store
  shape), and the copy is checked byte-identical to its source. An
  unverifiable copy is deleted on the spot and never consumes a
  retention slot — so a corrupt live file can never evict the last
  known-good backup. `findLastVerifiedBackup()` walks backups
  newest-first and returns the first one that verifies; corrupt,
  truncated or empty backups are skipped, never served.
- **Interrupted writes cannot replace the last known-good copy.** The
  live file is only ever replaced by temp-file + rename. A crash
  mid-write leaves a stale `.tmp` file (inert litter — each write uses
  a unique temp name) and the previous live file intact.

## Fail-closed rule

If the pre-write backup fails — copy error, or the copy fails
read-back verification (e.g. the live file was corrupted out from
under the running server) — **the write is refused**:

- `writeJsonWithBackup()` throws a coded `backup_failed` error before
  any temp file is written; the live file is left untouched.
- `saveJson()` logs it loudly (`backup_failed_blocks_write`, plus a
  `[collab] WRITE BLOCKED …` line on stderr) and returns
  `{ ok: false }`.
- The project PUT returns **503** with an explicit message; the change
  stays in memory only and is lost on restart. Room presence writes
  keep serving from memory (presence is ephemeral) and log the same
  way. The last known-good file on disk is never overwritten to "fix"
  a failed backup.

This is a deliberate reversal of the old behaviour (log `backup_failed`
and write anyway). The old behaviour is what destroyed projects: a
corrupt store was silently emptied on load and the next save backed up
the corruption over the good copy.

## Corrupt load: what the server does on boot

1. The snapshot of the corrupt file fails verification and is deleted
   (`backup_on_load_failed`).
2. The parse failure is logged loudly (`load_corrupt` + a
   `[collab] CORRUPT …` line). The store is **never silently emptied**.
3. The last verified backup is restored automatically
   (`[collab] RESTORED … from verified backup …`) and served. Note
   the semantics: a backup holds the state *before* a write, so the
   restore returns the last verified pre-write state — data that only
   ever existed in the (now corrupt) live file cannot be invented back.
4. If no verified backup exists, the server starts from an empty store
   (`NO VERIFIED BACKUP …`) and the corrupt bytes are **quarantined**
   to `projects.json.corrupt.<stamp>.<8-hex>` (same for rooms) — never
   deleted, never backed up as if good. The quarantine sticks for the
   life of the process; the next successful save writes a fresh file.

## Manual restore procedure

Use this when the automatic restore picked the wrong backup, when the
server is stopped, or when you need to inspect before restoring.

1. **Stop the server.** Never restore under a running server — it
   holds the store in memory and its next save would overwrite your
   restore.
2. **List the backups** (newest last):
   `ls -lt <data-dir>/projects.json.*.bak`
3. **Verify the candidate** — it must parse as a JSON object:
   `node -e "const v=require('./projects.json.<stamp>.<hex>.bak'); console.log(Object.keys(v))"`
   (run from the data dir; a backup that does not parse is not
   recoverable — pick the next older one).
4. **Preserve the current live file** before replacing it:
   `cp projects.json projects.json.before-manual-restore.<date>` if it
   parses, or move it aside if it does not — do not delete it.
5. **Copy the verified backup over the live file**:
   `cp projects.json.<stamp>.<hex>.bak projects.json`
6. **Start the server** and confirm: `GET /api/projects/<id>` returns
   the restored project, and the boot log shows a load snapshot being
   taken, not a `CORRUPT` line.
7. If the corrupt bytes are in a `*.corrupt.*` quarantine file, keep
   that file until you are sure nothing in it is needed — it is the
   only copy of whatever was there.

There is no restore HTTP endpoint by design: restoring is an operator
action, taken with the server stopped, so a bad restore cannot be
triggered remotely or race a running server.

## Operational logging (grep the server log for these)

| Marker | Meaning |
|---|---|
| `BACKUP-ON-LOAD FAILED` / `backup_on_load_failed` | No new load snapshot was taken; the load still proceeds. Investigate disk/permissions. |
| `CORRUPT <file>` / `load_corrupt` | Live file unparseable or wrong-shaped; automatic restore attempted. |
| `RESTORED <file> from verified backup …` | Automatic restore succeeded; the served state is the last verified backup. |
| `NO VERIFIED BACKUP for <file>` | No recoverable backup; started empty. Check the quarantine file. |
| `QUARANTINED corrupt <file> as …` | Corrupt bytes preserved aside; not deleted. |
| `RESTORE FAILED` / `restore_failed` | Automatic restore could not run; server started empty, corrupt bytes quarantined. Restore manually. |
| `WRITE BLOCKED for <file>` / `backup_failed_blocks_write` | A write was refused to protect the last known-good copy. Fix the backup problem (disk full, permissions, corrupt live file) — do not work around it by deleting backups. |

## What this does NOT cover

- Browser persistence: `localStorage` sites in `cad-viewer.ts`,
  `plan-view-panel.ts` snapshots, `clash.ts` scenario writes, and the
  IndexedDB journal/recovery vault are separate write paths with their
  own (browser) recovery story — issue #101. This PR deliberately
  scopes to the server path, which is fully mapped; the browser write
  sites still need their own inventory.
- Point-in-time recovery finer than the last write: backups are
  pre-write snapshots, not a journal. Anything written after the last
  backup and then lost to corruption is gone.
- Off-machine copies: backups live in the same directory as the
  store. A disk failure that takes the store takes the backups too —
  copy the data dir elsewhere for real disaster recovery.

## Tests

- `tests/server-backup.test.cjs` (`test:server-backup`): rotation to
  exactly 5, timestamped collision-safe names, duplicate timestamps,
  read-back verification, corrupt backups, interrupted writes (stale
  temp, corrupt live file), snapshot-on-load, quarantine, restore /
  rollback including refusal cases.
- `tests/server-backup-on-load.test.cjs`
  (`test:server-backup-on-load`): spawned-server integration —
  snapshot on load, corrupt boot serves the last verified backup,
  simulated failed write refused with 503 with the last known-good
  recoverable across restarts, corrupt store with no backup starts
  empty with the bytes quarantined.
- Both run in CI via `scripts/ci-unit-tests.mjs`. Note the pre-existing
  `tests/server-backup.test.cjs` had no npm script and was not in CI
  before this change; it is wired in here.
