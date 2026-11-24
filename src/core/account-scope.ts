/**
 * Per-account scope for this browser's local stores.
 *
 * The local project store, recent drawings, file links and browser recovery
 * copies live in IndexedDB. Without a scope every person who uses the same
 * browser sees the same lists. The scope is the account that is signed in
 * (obs.acct.owner, written by features/user-state.ts):
 *
 *  - Signed out / never signed in: the original database names. Everything
 *    that existed before accounts stays here as "unassigned" files; no
 *    account claims it automatically.
 *  - Signed in as <email>: "<name>@<hash>", a separate database per account.
 *
 * Nothing is moved or deleted when the scope changes. Copying the unassigned
 * files into an account is an explicit user action (features/local-import.ts).
 * The scope is read when a database is opened; changing account always
 * reloads the page first so every module opens the new scope.
 */
export const OWNER_KEY = "obs.acct.owner";

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The signed-in account of this browser tab session, or null for the unassigned/guest scope. */
export function currentScopeOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

/** Database name for the current scope. Guest/unassigned keeps the original name. */
export function scopedDbName(base: string, owner: string | null = currentScopeOwner()): string {
  return owner ? `${base}@${hash(owner.toLowerCase())}` : base;
}
