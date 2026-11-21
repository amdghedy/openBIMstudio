# Decision: backup-on-load must snapshot before parsing (#91)

**Decided:** 2026-11-20 (P0 hardening deep dive + hardening plan item 2).
**Recorded:** 2026-11-21, against `main` `bb0f55c`.

## Decision

A corrupt project load must never silently destroy the last known-good copy.
Concretely: snapshot on load (server and browser); on parse failure, log
loudly and serve the last verified backup instead of an empty store; a failed
pre-write backup must block the destructive write (or the write goes to a new
file, keeping the old one); backups are verified by read-back before they count
as recoverable; and there is a real restore path, not just a list of backups.

## Evidence (2026-11-20)

- The P0 dive (§2) traced the live failure: `loadJson()` in
  `server/index.mjs` parsed with a bare `JSON.parse` in a `try/catch` that
  silently returned `{}` on *any* failure; the first room join/heartbeat then
  called `saveJson()` → `writeJsonWithBackup()`, which backed up the *corrupt*
  file and atomically wrote `{}` over it. The `.bak` was a copy of the
  corruption and the good data was gone, with nothing logged.
- Backup-on-write already worked (`server/backup.mjs`: timestamped names with
  random suffix, newest 5 kept, atomic temp-file + rename) and browser
  recovery snapshots existed before destructive operations — but nothing
  snapshotted a load, nothing verified a backup, and no `restoreBackup`
  existed anywhere in the repo.
- The dive ranked #91 second because it is the only P0 whose failure mode is
  **irreversible data loss** of the user's sole project copy.

## Status (re-verified 2026-11-21)

- **Fix landed:** `e8e5afb` ("fix(recovery): corrupt files can no longer evict
  last known-good backups; server recovers from newest valid backup (#91)
  (#244)") is an ancestor of `bb0f55c`. `loadJson()` in `server/index.mjs`
  now goes through `readJsonWithRecovery()` instead of the bare parse, and
  logs a `store_recovered` entry when the file is not the source.
- **Not all of the decision is implemented:** `saveJson()` still logs
  `backup_failed` and continues with the write (fail-open on backup failure),
  and a repo-wide search still finds **no** `restoreBackup` function — the
  restore path and backup verification from the decision are still open.
- **Stale record:** `docs/engineering/ISSUES.md` P0-03's table row still says
  "backup-on-load not wired: `loadJson()` still returns `{}` on parse
  failure". That was true when the row was corrected (2026-11-20) and is no
  longer true after `e8e5afb`. The row needs updating when #91 is closed; it
  was left untouched by this change (item 21's scope is the decision notes,
  not another ISSUES.md reconciliation — see the PR description).
- **Tracker state unverified:** the unauthenticated GitHub API rate-limited
  when reading issue #91 on 2026-11-21, so whether #91 is closed is **not**
  established here. Evidence link TBD — do not treat the landed fix as a
  closed issue until the tracker says so.

## What would change this decision

#91 closes only on its own acceptance criteria: integration tests proving
backups on the required events (including load), rotation, interrupted writes,
corrupt backups and restore — including the simulated-failed-write recovery
test — with CI running them. Landing the load snapshot without the restore path
or the fail-closed write does not close it.
