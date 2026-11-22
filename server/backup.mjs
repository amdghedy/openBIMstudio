import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BACKUP_KEEP = 5;
export const CORRUPT_KEEP = 3;

/** True when the file exists and parses as JSON. */
export function isValidJsonFile(filePath) {
  try { JSON.parse(fs.readFileSync(filePath, "utf8")); return true; } catch { return false; }
}

/** Move an unreadable file aside (never into the .bak rotation) so it can be inspected but cannot evict a known-good backup. */
export function quarantineCorrupt(filePath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${filePath}.${stamp}.${randomUUID().slice(0, 8)}.corrupt`;
  try { fs.renameSync(filePath, target); } catch { return null; }
  const dir = path.dirname(filePath), base = path.basename(filePath);
  const old = fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.`) && n.endsWith(".corrupt")).sort();
  for (const n of old.slice(0, Math.max(0, old.length - CORRUPT_KEEP))) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* best effort */ } }
  return target;
}

/**
 * Read JSON; if the live file is missing/corrupt (e.g. an interrupted write), fall back to the newest VALID backup.
 * The corrupt file is quarantined, never deleted. Returns { value, source: "file"|"backup"|"fallback", recoveredFrom? }.
 */
export function readJsonWithRecovery(filePath, fallback) {
  try { return { value: JSON.parse(fs.readFileSync(filePath, "utf8")), source: "file" }; } catch { /* try recovery */ }
  const existed = fs.existsSync(filePath);
  if (existed) quarantineCorrupt(filePath);
  for (const b of listBackups(filePath).reverse()) {
    try { return { value: JSON.parse(fs.readFileSync(b, "utf8")), source: "backup", recoveredFrom: b }; } catch { /* next */ }
  }
  return { value: fallback, source: "fallback" };
}

/**
 * Rotating, verified backups for the collaboration server's JSON stores
 * (`projects.json`, `rooms.json`) — issue #91.
 *
 * Contract:
 * - Names are timestamped AND collision-safe: an ISO stamp, a 6-digit
 *   per-process sequence, plus a random 8-hex suffix, so two backups
 *   taken in the same millisecond never collide and sort deterministically
 *   (`<base>.<stamp>.<seq6>.<uuid8>.bak`).
 * - Retention is bounded: at most BACKUP_KEEP (5) backups per file, pruned
 *   whenever a new verified backup is taken.
 * - A backup only counts as recoverable after read-back verification: the
 *   copy must be byte-identical to the source AND re-parse as a JSON
 *   object (the store shape). An unverifiable copy is deleted on the spot
 *   and never consumes a retention slot, so a corrupt live file can never
 *   evict the last known-good backup.
 * - Backup failure is fail-closed: `writeJsonWithBackup()` throws a coded
 *   `backup_failed` error BEFORE touching the live file, so a failed
 *   backup never lets a destructive write through. Callers must surface
 *   that failure (server `saveJson()` logs it loudly and returns
 *   `{ ok: false }`) instead of writing anyway.
 * - Interrupted writes cannot replace the last known-good copy: the live
 *   file is only ever replaced by an atomic temp-file + rename on the
 *   same filesystem. A crash leaves a stale `.tmp` file (inert litter —
 *   each write uses a unique temp name) and the previous live file intact.
 */
// Orders backups written by this process within the same millisecond; the random suffix
// alone would not. Scope: backups sort by mtime, then name (timestamp, this sequence, random).
// Across processes or restarts a same-millisecond tie is still decided by the sequence/random
// part and is not guaranteed chronological; the single-writer server is the supported case.
let backupSeq = 0;

function backupTarget(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(dir, `${base}.${stamp}.${String((backupSeq = (backupSeq + 1) % 1000000)).padStart(6, "0")}.${randomUUID().slice(0, 8)}.bak`);
}

function backupError(message, code) {
  return Object.assign(new Error(message), { code });
}

/**
 * Verify a backup (or live store file) by read-back: it must exist, be
 * non-empty, parse as JSON, and hold a JSON object — the shape of both
 * server stores. Returns `{ ok: true, value }` or `{ ok: false, error }`.
 * Never throws.
 */
export function verifyBackup(backupPath) {
  let raw;
  try {
    raw = fs.readFileSync(backupPath, "utf8");
  } catch (error) {
    return { ok: false, error };
  }
  if (!raw.trim()) {
    return { ok: false, error: backupError(`backup is empty: ${backupPath}`, "backup_empty") };
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: backupError(`backup is not a JSON object: ${backupPath}`, "backup_not_object") };
  }
  return { ok: true, value };
}

/**
 * Copy the current file to a timestamped recovery file before replacement.
 * A first-ever write has no source to copy and is intentionally successful.
 * The copy is verified by read-back (byte-identical to the source AND
 * re-parses as a JSON object) BEFORE retention pruning runs, so a bad copy
 * never evicts a good backup. Backup failures are returned to the caller
 * so the primary write policy can decide whether to continue — and the
 * policy is fail-closed (see `writeJsonWithBackup`).
 */
export function backupBeforeWrite(filePath, keep = BACKUP_KEEP) {
  const target = backupTarget(filePath);
  if (!fs.existsSync(filePath)) return { created: false, target, error: null };
  // Never rotate a corrupt file into the backups: it would evict the last known-good copy.
  // Fail closed (#91): report the corrupt live file as a verification failure
  // instead of backing it up. writeJsonWithBackup() then throws `backup_failed`
  // BEFORE touching the live file, so the corrupt bytes stay exactly in place
  // for the load path to quarantine (quarantineFile) — they are never deleted,
  // never backed up as if good, and never silently replaced. #244 quarantined
  // the corrupt file here and let the write proceed; refusing preserves its
  // intent (a corrupt file never evicts the last known-good backup) more
  // strongly, and keeps the refused write visible (503) instead of silent.
  // Quarantine still happens at the recovery layer: readJsonWithRecovery()
  // (quarantineCorrupt) and the server load/restore path (quarantineFile).
  if (!isValidJsonFile(filePath)) {
    return {
      created: false,
      target,
      error: backupError(`live file is not valid JSON, refusing to back it up: ${filePath}`, "backup_verification_failed"),
    };
  }
  try {
    fs.copyFileSync(filePath, target);
  } catch (error) {
    return { created: false, target, error };
  }
  // Verify the copy by read-back before it counts toward retention.
  try {
    const sourceBytes = fs.readFileSync(filePath);
    const backupBytes = fs.readFileSync(target);
    if (!sourceBytes.equals(backupBytes)) {
      throw backupError(`backup copy differs from source: ${target}`, "backup_verification_failed");
    }
  } catch (error) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
    return { created: false, target, error };
  }
  const verified = verifyBackup(target);
  if (!verified.ok) {
    try { fs.unlinkSync(target); } catch { /* best effort */ }
    return {
      created: false,
      target,
      error: backupError(
        `backup copy failed read-back verification: ${verified.error?.message || verified.error}`,
        "backup_verification_failed",
      ),
    };
  }
  pruneBackups(filePath, keep);
  return { created: true, target, error: null };
}

/**
 * Snapshot-on-load (#91): preserve the exact bytes about to be parsed,
 * before any parse or later save can touch them. Same copy + verify +
 * prune behaviour as `backupBeforeWrite`, under the name the load path
 * calls — a snapshot is only a snapshot if it verified.
 *
 * Dedup: when the newest verified backup is already byte-identical to
 * the live file, the bytes are already preserved and no new snapshot is
 * taken. Without this, every server boot consumes a retention slot with
 * a duplicate copy — five boots with no intervening save would evict
 * every distinct older state from the 5-slot rotation. Returns
 * `{ created, target, error, deduped }`.
 */
export function snapshotOnLoad(filePath, keep = BACKUP_KEEP) {
  try {
    const liveBytes = fs.readFileSync(filePath);
    const backups = listBackups(filePath);
    if (backups.length) {
      const newest = backups[backups.length - 1];
      if (verifyBackup(newest).ok) {
        try {
          if (fs.readFileSync(newest).equals(liveBytes)) {
            return { created: false, target: newest, error: null, deduped: true };
          }
        } catch { /* unreadable newest backup: fall through and snapshot */ }
      }
    }
  } catch { /* unreadable live file: backupBeforeWrite reports the failure */ }
  const result = backupBeforeWrite(filePath, keep);
  return { ...result, deduped: false };
}

/** Best-effort fsync of a directory after an atomic rename, so the rename
 * itself (not just the file bytes) survives an OS crash / power loss.
 * A process kill cannot lose a rename — the page cache survives it — so
 * this guards the harder failure, which no process-level test can
 * simulate; it must never fail a write on filesystems that reject it. */
function fsyncDir(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch { /* best effort durability only */ } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export function listBackups(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".bak"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => {
      const delta = fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
      return delta || a.localeCompare(b);
    });
}

export function pruneBackups(filePath, keep = BACKUP_KEEP) {
  const backups = listBackups(filePath);
  const remove = backups.slice(0, Math.max(0, backups.length - Math.max(1, keep)));
  for (const old of remove) {
    try { fs.unlinkSync(old); } catch { /* best effort retention cleanup */ }
  }
  return listBackups(filePath);
}

/**
 * Newest-first search for a backup that verifies by read-back. Corrupt,
 * truncated or otherwise unverifiable backups are skipped, never served.
 * Returns `{ path, value }` or `null` when no backup is recoverable.
 */
export function findLastVerifiedBackup(filePath) {
  const backups = listBackups(filePath);
  for (let i = backups.length - 1; i >= 0; i--) {
    const verified = verifyBackup(backups[i]);
    if (verified.ok) return { path: backups[i], value: verified.value };
  }
  return null;
}

/**
 * Move a corrupt/untrusted live file aside instead of deleting it or
 * letting the next save back it up as if it were good. The quarantined
 * bytes are preserved for forensics/manual recovery. Returns
 * `{ quarantined: true, target }` or `{ quarantined: false, target, error }`.
 * A missing file is not an error: there is nothing to quarantine.
 */
export function quarantineFile(filePath) {
  if (!fs.existsSync(filePath)) return { quarantined: false, target: null, error: null };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${filePath}.corrupt.${stamp}.${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(filePath, target);
    return { quarantined: true, target, error: null };
  } catch (error) {
    return { quarantined: false, target, error };
  }
}

/**
 * Restore a store file from a backup (#91). `backupPath` may name a
 * specific backup; when omitted the newest verified backup is used.
 * The backup is verified by read-back before anything is touched, and
 * the restore itself is atomic (temp file + rename) and verified by
 * read-back afterwards.
 *
 * The current live file is preserved first: if it parses, it is backed
 * up; if it does not parse, it is quarantined. If either preservation
 * step fails, the restore is refused — fail closed — and the live file
 * is left exactly as it was.
 *
 * Returns `{ ok: true, restoredFrom, value }` or `{ ok: false, restoredFrom, error }`.
 */
export function restoreBackup(filePath, backupPath = null) {
  const chosen = backupPath
    ? { path: backupPath, value: null }
    : findLastVerifiedBackup(filePath);
  if (!chosen) {
    return { ok: false, restoredFrom: null, error: backupError("no verified backup available", "no_verified_backup") };
  }
  const verified = verifyBackup(chosen.path);
  if (!verified.ok) {
    return { ok: false, restoredFrom: chosen.path, error: verified.error };
  }
  if (fs.existsSync(filePath)) {
    const current = verifyBackup(filePath);
    if (current.ok) {
      const backup = backupBeforeWrite(filePath);
      if (backup.error) {
        return {
          ok: false,
          restoredFrom: chosen.path,
          error: backupError(
            `refusing restore: could not back up the current live file: ${backup.error?.message || backup.error}`,
            "backup_failed",
          ),
        };
      }
    } else {
      const quarantined = quarantineFile(filePath);
      if (!quarantined.quarantined) {
        return {
          ok: false,
          restoredFrom: chosen.path,
          error: backupError(
            `refusing restore: could not quarantine the corrupt live file: ${quarantined.error?.message || quarantined.error}`,
            "quarantine_failed",
          ),
        };
      }
    }
  }
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, fs.readFileSync(chosen.path), "utf8");
    fs.renameSync(temp, filePath);
    fsyncDir(path.dirname(filePath));
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    return { ok: false, restoredFrom: chosen.path, error };
  }
  const restored = verifyBackup(filePath);
  if (!restored.ok) {
    return {
      ok: false,
      restoredFrom: chosen.path,
      error: backupError(
        `restored file failed read-back verification: ${restored.error?.message || restored.error}`,
        "backup_verification_failed",
      ),
    };
  }
  return { ok: true, restoredFrom: chosen.path, value: restored.value };
}

/**
 * Backup then atomically replace a JSON file. The temp file is created beside
 * the target so rename remains atomic on the same filesystem.
 *
 * Fail-closed (#91): if the pre-write backup fails — copy error, or the
 * copy fails read-back verification (e.g. the live file is already corrupt)
 * — this throws a coded `backup_failed` error BEFORE any temp file is
 * written and the live file is left untouched. Callers must not catch this
 * and write anyway; `saveJson()` in `server/index.mjs` converts it into a
 * loud log plus a `{ ok: false }` result and the caller returns 503.
 */
export function writeJsonWithBackup(filePath, value, options = {}) {
  const keep = options.keep ?? BACKUP_KEEP;
  const backup = backupBeforeWrite(filePath, keep);
  if (backup.error) {
    throw backupError(
      `pre-write backup failed, refusing to overwrite ${path.basename(filePath)}: ${backup.error?.message || backup.error}`,
      "backup_failed",
    );
  }
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "w");
    try { fs.writeSync(fd, JSON.stringify(value, null, 2), null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filePath);
    fsyncDir(path.dirname(filePath));
    return { backup, atomic: true };
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}
