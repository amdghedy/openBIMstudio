// Rotating backup-on-load (Phase 0 / issue P0-03). Server/Node form.
// Browser build: OPFS equivalent per the plan (same contract, same KEEP policy).
// Named imports from 'node:fs/promises' (stable across @types/node majors,
// unlike the legacy `import { promises } from 'fs'` form).
import { copyFile, readdir, unlink } from 'node:fs/promises';

const KEEP = 5;

export async function backupBeforeWrite(path: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path + '.' + stamp + '.bak';
  try { await copyFile(path, target); }
  catch { /* first ever save: nothing to back up yet */ }
  await pruneOldBackups(path);
  return target;
}

async function pruneOldBackups(path: string): Promise<void> {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash), base = path.slice(slash + 1);
  const names = (await readdir(dir))
    .filter((f: string) => f.startsWith(base) && f.endsWith('.bak')).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP)))
    await unlink(dir + '/' + old);
}
