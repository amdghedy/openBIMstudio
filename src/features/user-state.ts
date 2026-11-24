/**
 * Per-account app preferences.
 *
 * Preferences (theme, language, units, region, currency, options, snap, last
 * project pointer) are kept in localStorage, which is shared by everyone who
 * uses the same browser. This module ties them to the signed-in account:
 *
 *  - The first time an account signs in, existing local preferences are
 *    uploaded as that account's settings (only when the browser has no other
 *    owner, or the same owner).
 *  - A returning account gets its saved settings back, on any device.
 *  - When a DIFFERENT account signs in on a browser last used by someone else,
 *    the previous user's preference keys are copied to a local backup
 *    (obs.acct.backup.<email>) before being cleared, so nothing is lost and
 *    the new user does not inherit (or auto-reopen) the previous user's state.
 *
 * Only whitelisted preference keys are synced. File contents are never
 * uploaded here; "recently opened/saved" cloud projects are tracked
 * server-side as metadata when a cloud project is saved or opened.
 */

/** Must match USER_PREF_KEYS in worker/auth.ts (the server ignores other keys). */
export const USER_PREF_KEYS: readonly string[] = [
  "obs.theme.mode", "obs.locale", "obs.units.system", "obs.units.config",
  "obs.region.profile", "obs.region.overrides", "obs.currency",
  "obs.selection-prefs.v1", "obs.options.v1", "obs.ui.visibility.v1", "obs.snap",
  "obs.projects.lastId",
];

const OWNER_KEY = "obs.acct.owner";
const BACKUP_PREFIX = "obs.acct.backup.";
const GUEST = "__guest__";
const RELOAD_GUARD = "obs.acct.reloadedFor";
const PUSH_INTERVAL_MS = 30_000;

type Prefs = Record<string, string>;

function readPrefs(): Prefs {
  const out: Prefs = {};
  for (const k of USER_PREF_KEYS) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) out[k] = v;
    } catch { /* private mode */ }
  }
  return out;
}

function writePrefs(prefs: Prefs): boolean {
  let changed = false;
  for (const k of USER_PREF_KEYS) {
    try {
      const cur = localStorage.getItem(k);
      const next = prefs[k];
      if (next == null) continue;
      if (cur !== next) { localStorage.setItem(k, next); changed = true; }
    } catch { /* */ }
  }
  return changed;
}

function clearPrefs(): void {
  for (const k of USER_PREF_KEYS) {
    try { localStorage.removeItem(k); } catch { /* */ }
  }
}

let activeEmail: string | null = null;
let lastPushed = "";
/** True only after the account's settings were read from the server; until then nothing is uploaded. */
let synced = false;
let timer: ReturnType<typeof setInterval> | null = null;

async function push(keepalive = false): Promise<void> {
  if (!activeEmail || !synced) return;
  const prefs = readPrefs();
  const body = JSON.stringify({ prefs });
  if (body === lastPushed) return;
  try {
    const res = await fetch("/api/user/state", {
      method: "PUT", credentials: "same-origin", keepalive,
      headers: { "content-type": "application/json" }, body,
    });
    if (res.ok) lastPushed = body;
  } catch { /* offline: retried on the next tick */ }
}

/** Upload any unsynced changes now (call before signing out). */
export function flushUserState(): Promise<void> {
  return push(true);
}

/** Stop syncing (after sign-out). Local data is left exactly as it is. */
export function stopUserStateSync(): void {
  activeEmail = null;
  synced = false;
  if (timer) { clearInterval(timer); timer = null; }
}

function backupGet(owner: string): Prefs | null {
  try {
    const raw = localStorage.getItem(BACKUP_PREFIX + owner);
    return raw ? (JSON.parse(raw) as Prefs) : null;
  } catch { return null; }
}

function backupSet(owner: string, prefs: Prefs): void {
  try { localStorage.setItem(BACKUP_PREFIX + owner, JSON.stringify(prefs)); } catch { /* */ }
}

/**
 * Explicit sign-out: the account's settings are synced and backed up locally,
 * and the browser goes back to the guest preferences it had before the first
 * sign-in (or defaults if the guest had none). Returns true when preferences
 * changed and the page should reload.
 */
export async function signOutRestoreGuest(): Promise<boolean> {
  const user = activeEmail;
  if (!user) return false;
  await push(true);
  backupSet(user, readPrefs());
  stopUserStateSync();
  const before = JSON.stringify(readPrefs());
  clearPrefs();
  const guest = backupGet(GUEST);
  if (guest) writePrefs(guest);
  try { localStorage.removeItem(OWNER_KEY); } catch { /* */ }
  try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* */ }
  return JSON.stringify(readPrefs()) !== before;
}

/**
 * Called when a user is known to be signed in. Returns true when settings
 * changed and the page should reload so every module re-reads them.
 *
 * Failure rule: if the server cannot be reached, nothing is uploaded and no
 * other account's settings are ever applied (a previous account's keys are
 * cleared before any network call).
 */
export async function startUserStateSync(email: string): Promise<boolean> {
  const user = email.trim().toLowerCase();
  if (!user) return false;
  activeEmail = user;
  synced = false;
  let owner: string | null = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* */ }

  // First account on a browser that has guest preferences: keep an untouched copy.
  if (!owner) {
    const guestPrefs = readPrefs();
    if (Object.keys(guestPrefs).length && !backupGet(GUEST)) backupSet(GUEST, guestPrefs);
  }

  // A different account last used this browser: back up its keys, then clear.
  let switched = false;
  if (owner && owner !== user) {
    backupSet(owner, readPrefs());
    clearPrefs();
    switched = true;
  }

  let fetched = false;
  let serverPrefs: Prefs | null = null;
  try {
    const res = await fetch("/api/user/state", { credentials: "same-origin" });
    if (res.ok) {
      serverPrefs = ((await res.json()) as { state: { prefs?: Prefs } | null }).state?.prefs ?? null;
      fetched = true;
    }
  } catch { /* offline */ }

  let reload = false;
  const own = backupGet(user);
  if (fetched && serverPrefs && Object.keys(serverPrefs).length) {
    synced = true;
    reload = writePrefs(serverPrefs);
    lastPushed = JSON.stringify({ prefs: readPrefs() });
  } else if (fetched) {
    // Server reachable, nothing saved for this account yet.
    synced = true;
    if (switched && own) reload = writePrefs(own);
    await push();
  } else if (switched && own) {
    // Offline: only this account's own backup may be applied; never upload.
    reload = writePrefs(own);
  }
  try { localStorage.setItem(OWNER_KEY, user); } catch { /* */ }

  if (!timer) {
    timer = setInterval(() => void push(), PUSH_INTERVAL_MS);
    window.addEventListener("pagehide", () => void push(true));
  }

  // Reload at most once per account per tab session so settings apply cleanly.
  if (reload || switched) {
    try {
      if (sessionStorage.getItem(RELOAD_GUARD) === user) return false;
      sessionStorage.setItem(RELOAD_GUARD, user);
    } catch { /* */ }
    return true;
  }
  return false;
}
