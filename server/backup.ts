// Rotating backup-on-load (Phase 0 / issue P0-03). Server/Node form.
// Browser build: OPFS equivalent per the plan (same contract, same KEEP policy).
// NOTE: excluded from `tsc --noEmit` until P0-03 wires it — this repo has no
// @types/node; 'fs' is a minimal writeFileSync shim in src/types/custom.d.ts,
// so fs/promises types do not resolve here. Import from 'node:fs/promises'
// once the Node-side type environment is decided.
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
