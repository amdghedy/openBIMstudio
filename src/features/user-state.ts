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

import { OWNER_KEY } from "../core/account-scope";

/** Must match USER_PREF_KEYS in worker/auth.ts (the server ignores other keys). */
export const USER_PREF_KEYS: readonly string[] = [
  "obs.theme.mode", "obs.locale", "obs.units.system", "obs.units.config",
  "obs.region.profile", "obs.region.overrides", "obs.currency",
  "obs.selection-prefs.v1", "obs.options.v1", "obs.ui.visibility.v1", "obs.snap",
  "obs.projects.lastId",
  "obs.cad.ucs", "obs.cad.svgScale", "obs.cad.ribbon.tab", "obs.cad.ribbon.min", "obs.cad.insScale",
  "obs.cad.filletR", "obs.cad.chamferD", "obs.cad.snapUnit", "obs.cad.qat.hidden.v1", "obs.cad.hatchDefaults",
  "obs.cad.pageSetup", "obs.cad.nativeBlocks", "obs.cad.textStyles",
];

/** Local-only lists that follow the account on this browser (backed up and swapped, never uploaded). */
export const LOCAL_SCOPED_KEYS: readonly string[] = [
  "obs.nativeIfc.history.v1", "obs.plan.cmdHistory", "obs.recovery.last", "obs.session.unsaved",
  // 2D drawing zone: per-drawing view/hidden-entity sessions, block library, sheet sets, clipboard.
  "obs.cad.drawingSession.v1", "obs.cad.blocks", "obs.cad.sheetSet.v1", "obs.cad.copybase",
];
const ALL_KEYS: readonly string[] = [...USER_PREF_KEYS, ...LOCAL_SCOPED_KEYS];
const BACKUP_PREFIX = "obs.acct.backup.";
const GUEST = "__guest__";
const RELOAD_GUARD = "obs.acct.reloadedFor";
const PUSH_INTERVAL_MS = 30_000;

type Prefs = Record<string, string>;

function readKeys(keys: readonly string[]): Prefs {
  const out: Prefs = {};
  for (const k of keys) {
    try {
      const v = localStorage.getItem(k);
      if (v != null) out[k] = v;
    } catch { /* private mode */ }
  }
  return out;
}

/** Largest single value uploaded; bigger ones stay local (they would be rejected by the server). */
const MAX_SYNC_VALUE = 8 * 1024;

/** Synced preference keys only (what is uploaded), skipping oversized values. */
function readPrefs(): Prefs {
  const all = readKeys(USER_PREF_KEYS);
  for (const k of Object.keys(all)) if (all[k].length > MAX_SYNC_VALUE) delete all[k];
  return all;
}
/** Everything that follows an account on this browser (used for local backups). */
function readAll(): Prefs { return readKeys(ALL_KEYS); }

function writePrefs(prefs: Prefs, keys: readonly string[] = ALL_KEYS): boolean {
  let changed = false;
  for (const k of keys) {
    try {
      const cur = localStorage.getItem(k);
      const next = prefs[k];
      if (next == null) continue;
      if (cur !== next) { localStorage.setItem(k, next); changed = true; }
    } catch { /* */ }
  }
  return changed;
}

function clearPrefs(keys: readonly string[] = ALL_KEYS): void {
  for (const k of keys) {
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
  backupSet(user, readAll());
  stopUserStateSync();
  const before = JSON.stringify(readAll());
  clearPrefs();
  const guest = backupGet(GUEST);
  if (guest) writePrefs(guest);
  try { localStorage.removeItem(OWNER_KEY); } catch { /* */ }
  try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* */ }
  void before;
  return true; // the local-store scope changed: always reload
}

/** True when signing in as `email` (or being signed out, for null) would change this browser's local scope. */
export function accountScopeDiffers(email: string | null): boolean {
  let owner: string | null = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* */ }
  return (owner ?? null) !== (email ? email.trim().toLowerCase() : null);
}

/**
 * The session is gone (expired or ended elsewhere) but this browser still
 * carries an account scope: hand the browser back to the guest scope so the
 * next person does not see that account's local files. Returns true when the
 * page should reload. Only call after the server confirmed "not signed in".
 */
export function endStaleAccountScope(): boolean {
  let owner: string | null = null;
  try { owner = localStorage.getItem(OWNER_KEY); } catch { /* */ }
  if (!owner) return false;
  backupSet(owner, readAll());
  stopUserStateSync();
  clearPrefs();
  const guest = backupGet(GUEST);
  if (guest) writePrefs(guest);
  try { localStorage.removeItem(OWNER_KEY); } catch { /* */ }
  try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* */ }
  return true;
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

  // No account owns this browser right now: what is here is the guest's state. Keep a copy.
  // The guest's local lists and last-project pointer must not become the account's: they stay in the
  // guest copy (restored on sign-out) and are removed from the working keys. Guest appearance
  // preferences (theme, language, units) carry over; no files are claimed.
  if (!owner) {
    backupSet(GUEST, readAll());
    clearPrefs([...LOCAL_SCOPED_KEYS, "obs.projects.lastId"]);
  }

  // A different account last used this browser: back up its keys, then clear.
  let switched = false;
  if (owner && owner !== user) {
    backupSet(owner, readAll());
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
    if (switched && own) reload = writePrefs(own, LOCAL_SCOPED_KEYS) || reload; // this account's own local lists too
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

  // Reload at most once per account per tab session so settings and the local-store scope apply cleanly.
  if (reload || switched || owner !== user) {
    try {
      if (sessionStorage.getItem(RELOAD_GUARD) === user) return false;
      sessionStorage.setItem(RELOAD_GUARD, user);
    } catch { /* */ }
    return true;
  }
  return false;
}
