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
 * Copy the current file to a timestamped recovery file before replacement.
 * A first-ever write has no source to copy and is intentionally successful.
 * Backup failures are returned to the caller so the primary write policy can
 * decide whether to continue; callers should not expose filesystem details.
 */
// Orders backups written by this process within the same millisecond; the random suffix
// alone would not. Scope: backups sort by mtime, then name (timestamp, this sequence, random).
// Across processes or restarts a same-millisecond tie is still decided by the sequence/random
// part and is not guaranteed chronological; the single-writer server is the supported case.
let backupSeq = 0;

export function backupBeforeWrite(filePath, keep = BACKUP_KEEP) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `${base}.${stamp}.${String((backupSeq = (backupSeq + 1) % 1000000)).padStart(6, "0")}.${randomUUID().slice(0, 8)}.bak`);
  if (!fs.existsSync(filePath)) return { created: false, target, error: null };
  // Never rotate a corrupt file into the backups: it would evict the last known-good copy.
  if (!isValidJsonFile(filePath)) return { created: false, target, error: null, skippedCorrupt: quarantineCorrupt(filePath) };
  try {
    fs.copyFileSync(filePath, target);
    pruneBackups(filePath, keep);
    return { created: true, target, error: null };
  } catch (error) {
    return { created: false, target, error };
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
 * Backup then atomically replace a JSON file. The temp file is created beside
 * the target so rename remains atomic on the same filesystem.
 */
export function writeJsonWithBackup(filePath, value, options = {}) {
  const keep = options.keep ?? BACKUP_KEEP;
  const backup = backupBeforeWrite(filePath, keep);
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temp, "w");
    try { fs.writeSync(fd, JSON.stringify(value, null, 2), null, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filePath);
    return { backup, atomic: true };
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}
