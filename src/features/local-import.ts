/**
 * Explicit, non-destructive copy of the "unassigned" local files into the
 * signed-in account's own local lists.
 *
 * Before accounts existed, local projects (open-bim-studio), recent drawings
 * (obs-cad-recent) and file links (obs-file-links) lived under their plain
 * database names. Those stay as the guest/unassigned store; no account claims
 * them automatically. This module copies records from that store into the
 * current account's scoped databases when, and only when, the user asks.
 *
 *  - Source is only read. Nothing is deleted or modified there.
 *  - A record that already exists in the account database is never overwritten.
 *  - Only user-visible records are copied (project documents + model blobs,
 *    recent drawings, file links). Journals and recovery copies are derived
 *    data and are left behind.
 */
import { currentScopeOwner, scopedDbName } from "../core/account-scope";

export const COPY_PLAN: ReadonlyArray<{ db: string; stores: readonly string[] }> = [
  { db: "open-bim-studio", stores: ["projects", "modelBlobs"] },
  { db: "obs-cad-recent", stores: ["drawings"] },
  { db: "obs-file-links", stores: ["links"] },
];

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function dbExists(name: string): Promise<boolean> {
  const idb = indexedDB as IDBFactory & { databases?: () => Promise<Array<{ name?: string }>> };
  if (typeof idb.databases !== "function") return false;
  return (await idb.databases()).some((d) => d.name === name);
}

function openExisting(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Open the target at the source's version, creating the same stores/indexes when it does not exist yet. */
function openClone(name: string, src: IDBDatabase): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, src.version);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const storeName of Array.from(src.objectStoreNames)) {
        if (db.objectStoreNames.contains(storeName)) continue;
        const tx = src.transaction(storeName, "readonly");
        const from = tx.objectStore(storeName);
        const to = db.createObjectStore(storeName, { keyPath: from.keyPath ?? undefined, autoIncrement: from.autoIncrement });
        for (const idxName of Array.from(from.indexNames)) {
          const idx = from.index(idxName);
          to.createIndex(idxName, idx.keyPath, { unique: idx.unique, multiEntry: idx.multiEntry });
        }
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** True when there are unassigned local records that could be copied into the current account. */
export async function hasUnassignedLocalFiles(): Promise<boolean> {
  if (!currentScopeOwner()) return false;
  for (const { db, stores } of COPY_PLAN) {
    if (!(await dbExists(db))) continue;
    const src = await openExisting(db);
    try {
      for (const s of stores) {
        if (!src.objectStoreNames.contains(s)) continue;
        if ((await req(src.transaction(s, "readonly").objectStore(s).count())) > 0) return true;
      }
    } finally { src.close(); }
  }
  return false;
}

/** Copy the unassigned local records into the current account's databases. Returns how many records were copied. */
export async function importUnassignedLocalFiles(): Promise<number> {
  const owner = currentScopeOwner();
  if (!owner) throw new Error("Sign in first: files are copied into the signed-in account.");
  let copied = 0;
  for (const { db, stores } of COPY_PLAN) {
    if (!(await dbExists(db))) continue;
    const src = await openExisting(db);
    let dst: IDBDatabase | null = null;
    try {
      dst = await openClone(scopedDbName(db, owner), src);
      for (const s of stores) {
        if (!src.objectStoreNames.contains(s) || !dst.objectStoreNames.contains(s)) continue;
        const keys = (await req(src.transaction(s, "readonly").objectStore(s).getAllKeys())) as IDBValidKey[];
        for (const key of keys) {
          const value = await req(src.transaction(s, "readonly").objectStore(s).get(key));
          const store = dst.transaction(s, "readwrite").objectStore(s);
          if ((await req(store.count(key))) > 0) continue; // never overwrite
          await req(store.keyPath != null ? store.add(value) : store.add(value, key));
          copied++;
        }
      }
    } finally {
      src.close();
      dst?.close();
    }
  }
  return copied;
}
