/**
 * Lets features that hold unsaved editor state (3D project, 2D drawings) tell
 * the account code, without importing them, whether a page reload would lose work.
 */
const checks: Array<() => boolean> = [];

export function registerDirtyCheck(fn: () => boolean): void {
  checks.push(fn);
}

/** True when any registered editor reports unsaved changes. A check that throws counts as dirty (fail safe). */
export function anyUnsavedWork(): boolean {
  for (const fn of checks) {
    try { if (fn()) return true; } catch { return true; }
  }
  return false;
}
