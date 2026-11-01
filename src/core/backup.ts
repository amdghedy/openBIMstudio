import { promises as fs } from 'fs';
const KEEP = 5;

export async function backupBeforeWrite(path: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path + '.' + stamp + '.bak';
  try { await fs.copyFile(path, target); }
  catch { /* first ever save: nothing to back up yet */ }
  await pruneOldBackups(path);
  return target;
}

async function pruneOldBackups(path: string) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash), base = path.slice(slash + 1);
  const names = (await fs.readdir(dir))
    .filter((f) => f.startsWith(base) && f.endsWith('.bak')).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP)))
    await fs.unlink(dir + '/' + old);
}
