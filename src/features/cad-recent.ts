/** Recent-drawings vault for the 2D drafting zone of the welcome screen.
 *
 *  Every drawing the engine opens or saves is recorded here with its bytes
 *  (IndexedDB), so the welcome screen can list real history and reopen a
 *  drawing with one click — the 2D counterpart of the 3D "Recent projects".
 *
 *  Design rules:
 *  - Zero dependencies, no DOM: safe to import from both cad-viewer and
 *    home-screen (and from static-analysis tests).
 *  - Fails soft everywhere: if IndexedDB is unavailable (private mode,
 *    storage quota, SSR) the history simply stays empty — never an error
 *    dialog, never a crash in the drawing engine.
 *  - Bytes above MAX_BYTES are not vaulted; the entry still appears in the
 *    history with a "reopen from your file" hint instead of an Open button.
 */

export type RecentFormat = "DWG" | "DXF" | "XML";

export interface RecentDrawing {
  name: string;
  format: RecentFormat;
  size: number;
  ts: number;
  /** true when the drawing bytes are vaulted and one-click reopen works. */
  hasBytes: boolean;
}

interface StoredDrawing extends RecentDrawing {
  blob?: Blob;
}

const DB_NAME = "obs-cad-recent";
const STORE = "drawings";
export const MAX_RECENT_DRAWINGS = 12;
/** Refuse to vault absurdly large files (24 MB) — history stays metadata-only. */
export const MAX_RECENT_BYTES = 24 * 1024 * 1024;

export function recentFormatOf(name: string): RecentFormat {
  if (/\.xml$/i.test(name)) return "XML";
  if (/\.dwg$/i.test(name)) return "DWG";
  return "DXF";
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "name" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore | null {
  try {
    return db.transaction(STORE, mode).objectStore(STORE);
  } catch {
    return null;
  }
}

function done(request: IDBRequest): Promise<void> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
  });
}

/** Record (or refresh) a drawing in the history. Fire-and-forget friendly. */
export async function recordRecentDrawing(input: {
  name: string;
  format?: RecentFormat;
  size?: number;
  blob?: Blob;
}): Promise<void> {
  const name = String(input.name ?? "").trim();
  if (!name) return;
  const db = await openDb();
  if (!db) return;
  const store = tx(db, "readwrite");
  if (!store) return;
  const blob = input.blob && input.blob.size <= MAX_RECENT_BYTES ? input.blob : undefined;
  const rec: StoredDrawing = {
    name,
    format: input.format ?? recentFormatOf(name),
    size: input.size ?? blob?.size ?? 0,
    ts: Date.now(),
    hasBytes: !!blob,
    blob,
  };
  // Upsert by name: reopening the same file refreshes it instead of duplicating.
  await done(store.put(rec));
  // Prune to MAX_RECENT_DRAWINGS, oldest first.
  try {
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const rows = (allReq.result ?? []) as StoredDrawing[];
      const stale = rows
        .sort((a, b) => a.ts - b.ts)
        .slice(0, Math.max(0, rows.length - MAX_RECENT_DRAWINGS));
      for (const row of stale) store.delete(row.name);
    };
  } catch {
    /* pruning is best-effort */
  }
}

/** History entries, newest first (metadata only — no blobs). */
export async function listRecentDrawings(): Promise<RecentDrawing[]> {
  const db = await openDb();
  if (!db) return [];
  const store = tx(db, "readonly");
  if (!store) return [];
  return new Promise((resolve) => {
    try {
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result ?? []) as StoredDrawing[];
        resolve(
          rows
            .sort((a, b) => b.ts - a.ts)
            .slice(0, MAX_RECENT_DRAWINGS)
            .map(({ name, format, size, ts, hasBytes }) => ({ name, format, size, ts, hasBytes })),
        );
      };
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/** Vaulted bytes for one-click reopen, if still present. */
export async function getRecentDrawingBlob(name: string): Promise<Blob | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  const store = tx(db, "readonly");
  if (!store) return undefined;
  return new Promise((resolve) => {
    try {
      const req = store.get(name);
      req.onsuccess = () => {
        const row = req.result as StoredDrawing | undefined;
        resolve(row?.blob ?? undefined);
      };
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Wipe the history (files on the user's computer are never touched). */
export async function clearRecentDrawings(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const store = tx(db, "readwrite");
  if (!store) return;
  await done(store.clear());
}
