import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BACKUP_KEEP = 5;

/**
 * Copy the current file to a timestamped recovery file before replacement.
 * A first-ever write has no source to copy and is intentionally successful.
 * Backup failures are returned to the caller so the primary write policy can
 * decide whether to continue; callers should not expose filesystem details.
 */
export function backupBeforeWrite(filePath, keep = BACKUP_KEEP) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `${base}.${stamp}.${randomUUID().slice(0, 8)}.bak`);
  if (!fs.existsSync(filePath)) return { created: false, target, error: null };
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
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temp, filePath);
    return { backup, atomic: true };
  } catch (error) {
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}
