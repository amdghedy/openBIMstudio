/**
 * Browser-side recovery copies for destructive project-file operations.
 *
 * This is deliberately separate from the live project database: a failed
 * migration, file overwrite, or delete must still leave an independently
 * recoverable copy. Copies are best-effort and never block the primary action.
 */

export const BROWSER_RECOVERY_KEEP = 5;
export const BROWSER_RECOVERY_MAX_BYTES = 256 * 1024 * 1024;
const DB_NAME = "obs-project-recovery";
const DB_VERSION = 1;
const STORE = "files";

type RecoveryReason = "before-file-overwrite" | "before-import-replace" | "before-delete";
export interface BrowserRecoveryCopy {
  id?: number;
  projectId: string;
  projectName: string;
  fileName: string;
  reason: RecoveryReason;
  createdAt: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("projectId", "projectId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open browser recovery storage."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Browser recovery transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Browser recovery transaction aborted."));
  });
}


/** Which stored backup ids to delete so at most `keep` newest remain (after a pending add). */
export function selectBrowserRecoveryDeletes(
  existing: Array<{ id?: number; createdAt: number }>,
  keep: number = BROWSER_RECOVERY_KEEP,
): number[] {
  if (keep < 1) return [];
  const sorted = [...existing].sort((a, b) => (b.createdAt - a.createdAt) || ((b.id ?? 0) - (a.id ?? 0)));
  // After adding one new record, drop from index keep-1 onward among the previous set.
  return sorted.slice(Math.max(0, keep - 1)).map((r) => r.id).filter((id): id is number => id !== undefined);
}

/**
 * Cheap integrity gate for a file about to become a "known-good" recovery copy. A truncated or zeroed existing file
 * must not be stored, or five bad overwrites would evict the last good backup.
 * JSON-looking files must end with "}"; all-NUL heads are rejected; other formats (zip, encrypted) pass unchanged.
 */
export function backupBytesLookIntact(head: Uint8Array, tail: Uint8Array): boolean {
  if (!head.length) return false;
  if (head.every((b) => b === 0)) return false;
  let i = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) i = 3;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x0a || head[i] === 0x0d || head[i] === 0x09)) i++;
  if (head[i] === 0x7b /* { */) {
    let j = tail.length - 1;
    while (j >= 0 && (tail[j] === 0x20 || tail[j] === 0x0a || tail[j] === 0x0d || tail[j] === 0x09 || tail[j] === 0)) j--;
    return j >= 0 && tail[j] === 0x7d /* } */;
  }
  return true;
}

async function blobLooksIntact(blob: Blob): Promise<boolean> {
  const n = Math.min(4096, blob.size);
  const head = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - n)).arrayBuffer());
  return backupBytesLookIntact(head, tail);
}

/** Store a recovery copy and retain only the newest five copies per project. */
export async function backupProjectFile(copy: Omit<BrowserRecoveryCopy, "id" | "createdAt">): Promise<boolean> {
  if (!copy.projectId || !copy.projectName || !copy.fileName || !copy.blob.size || copy.blob.size > BROWSER_RECOVERY_MAX_BYTES) return false;
  try {
    if (!(await blobLooksIntact(copy.blob))) {
      console.warn("[project-recovery] not backing up a truncated/corrupt file; last known-good copies are kept");
      return false;
    }
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const index = store.index("projectId");
    const existing = index.getAll(copy.projectId);
    existing.onsuccess = () => {
      const records = (existing.result as BrowserRecoveryCopy[]).sort((a, b) => (b.createdAt - a.createdAt) || ((b.id ?? 0) - (a.id ?? 0)));
      store.add({ ...copy, createdAt: Date.now() });
      for (const id of selectBrowserRecoveryDeletes(records, BROWSER_RECOVERY_KEEP)) store.delete(id);
    };
    await transactionDone(tx);
    return true;
  } catch (error) {
    console.warn("[project-recovery] browser backup unavailable", error);
    return false;
  }
}

/** Best-effort copy of the current linked file before it is overwritten. */
export async function backupExistingFileHandle(
  handle: { getFile?: () => Promise<File>; name?: string },
  projectId: string,
  projectName: string,
): Promise<boolean> {
  try {
    if (typeof handle.getFile !== "function") return false;
    const file = await handle.getFile();
    if (!file.size) return false;
    return backupProjectFile({
      projectId, projectName, fileName: file.name || handle.name || "project.obsproj",
      reason: "before-file-overwrite", blob: file,
    });
  } catch (error) {
    console.warn("[project-recovery] linked-file backup failed", error);
    return false;
  }
}

export async function listBrowserRecoveryCopies(projectId: string): Promise<BrowserRecoveryCopy[]> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).index("projectId").getAll(projectId);
    const result = await new Promise<BrowserRecoveryCopy[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await transactionDone(tx);
    return result.sort((a, b) => (b.createdAt - a.createdAt) || ((b.id ?? 0) - (a.id ?? 0)));
  } catch { return []; }
}
