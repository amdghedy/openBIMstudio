export type CrashEntry = {
  ts: string;
  source: 'window.onerror' | 'unhandledrejection' | 'boundary';
  message: string;
  stack?: string;
  tool?: string;
};
const KEY = 'obs.crashlog.v1';
const MAX = 50;

export function recordCrash(entry: Omit<CrashEntry, 'ts'>): void {
  const all = readAll();
  all.unshift({ ...entry, ts: new Date().toISOString() });
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX))); }
  catch { /* storage full: dropping old crashes is acceptable */ }
}

export function readAll(): CrashEntry[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CrashEntry[]; }
  catch { return []; } // a corrupt crash log must never itself crash the app
}

export function exportCrashReport(): string {
  return JSON.stringify(readAll(), null, 2);
}
