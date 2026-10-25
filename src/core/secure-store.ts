/**
 * Encrypted-at-rest storage for secrets (API keys, access tokens).
 *
 * The data is AES-GCM encrypted with a non-extractable key kept in IndexedDB, so the values in
 * localStorage (and in browser backups / disk dumps) are unreadable ciphertext. Reads are synchronous
 * from an in-memory copy loaded once at startup (`initSecureStore`).
 *
 * If WebCrypto or IndexedDB is unavailable the store falls back to plain localStorage so the app
 * still works, and says so in the console.
 */
import { decryptString, encryptString, generateStorageKey } from "./secret-crypto";

const PREFIX = "obs.secure.";
const DB = "obs-secure";
const STORE = "keys";

let key: CryptoKey | null = null;
let ready = false;
const mem = new Map<string, string>();
const pending = new Set<Promise<void>>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function loadOrCreateKey(): Promise<CryptoKey> {
  const db = await openDb();
  const existing = await new Promise<CryptoKey | undefined>((res, rej) => {
    const q = db.transaction(STORE).objectStore(STORE).get("storage-key");
    q.onsuccess = () => res(q.result as CryptoKey | undefined);
    q.onerror = () => rej(q.error);
  });
  if (existing) { db.close(); return existing; }
  const fresh = await generateStorageKey();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(fresh, "storage-key");
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
  return fresh;
}

export async function initSecureStore(): Promise<void> {
  if (ready) return;
  try {
    if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") throw new Error("WebCrypto/IndexedDB unavailable");
    key = await loadOrCreateKey();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const name = k.slice(PREFIX.length);
      try { mem.set(name, await decryptString(key, localStorage.getItem(k)!, name)); }
      catch { localStorage.removeItem(k); /* unreadable (key was reset): drop rather than keep garbage */ }
    }
  } catch (e) {
    key = null;
    console.warn("[secure-store] encryption unavailable, secrets stay in plain localStorage:", e);
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) mem.set(k.slice(PREFIX.length), localStorage.getItem(k) ?? "");
    }
  }
  ready = true;
}

export function secureEncryptionActive(): boolean { return !!key; }

export function secureGet(name: string): string | null {
  return mem.has(name) ? mem.get(name)! : null;
}

export function secureSet(name: string, value: string): void {
  mem.set(name, value);
  persist(name, value);
}

export function secureRemove(name: string): void {
  mem.delete(name);
  try { localStorage.removeItem(PREFIX + name); } catch { /* */ }
}

export function secureNames(prefix = ""): string[] {
  return [...mem.keys()].filter((k) => k.startsWith(prefix));
}

/** Resolves when every pending encrypted write has reached storage (used before unload / in tests). */
export async function secureFlush(): Promise<void> { await Promise.all([...pending]); }

function persist(name: string, value: string): void {
  if (!key) { try { localStorage.setItem(PREFIX + name, value); } catch { /* */ } return; }
  const k = key;
  const p = encryptString(k, value, name)
    .then((ct) => { if (mem.get(name) === value) localStorage.setItem(PREFIX + name, ct); })
    .catch((e) => console.warn("[secure-store] could not save", name, e))
    .finally(() => { pending.delete(p); });
  pending.add(p);
}

/**
 * One-time move of a legacy plaintext localStorage item into the encrypted store.
 * Returns the value (from the encrypted store if present, else the migrated legacy one).
 */
export function migrateLegacy(name: string, legacyKey: string): string | null {
  const cur = secureGet(name);
  if (cur != null) { try { localStorage.removeItem(legacyKey); } catch { /* */ } return cur; }
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(legacyKey); } catch { /* */ }
  if (legacy != null) {
    secureSet(name, legacy);
    try { localStorage.removeItem(legacyKey); } catch { /* */ }
  }
  return legacy;
}

/** Remove every stored secret (sign-out / "forget everything"). */
export function secureWipe(): void {
  for (const n of [...mem.keys()]) secureRemove(n);
}
