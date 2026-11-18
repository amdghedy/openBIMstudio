import { Journal, type JournalStore, type Op } from "../../core/journal";
import type { ProjectDoc } from "./types";

const DB_NAME = "open-bim-studio";
const DB_VERSION = 3;
const S_OPS = "projectOps";
const S_SNAPSHOTS = "projectOperationSnapshots";

type StoredOp = Op & { key: string; projectId: string };
type StoredSnapshot = { key: string; projectId: string; seq: number; state: string; createdAt: number; formatVersion: 1 };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB journal request failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB journal transaction failed."));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB journal transaction aborted."));
  });
}

function openJournalDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(S_OPS)) {
        const ops = db.createObjectStore(S_OPS, { keyPath: "key" });
        ops.createIndex("projectId", "projectId", { unique: false });
      }
      if (!db.objectStoreNames.contains(S_SNAPSHOTS)) {
        const snapshots = db.createObjectStore(S_SNAPSHOTS, { keyPath: "key" });
        snapshots.createIndex("projectId", "projectId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("Unable to open the IndexedDB journal."));
    request.onblocked = () => reject(new Error("IndexedDB journal upgrade is blocked by another tab."));
  });
}

class ProjectJournalStore implements JournalStore {
  constructor(private readonly projectId: string) {}

  private async records<T>(storeName: string): Promise<T[]> {
    const db = await openJournalDb();
    const tx = db.transaction(storeName, "readonly");
    const result = await requestResult(tx.objectStore(storeName).index("projectId").getAll(this.projectId));
    await transactionDone(tx);
    db.close();
    return result as T[];
  }

  async loadNewestSnapshot(): Promise<{ seq: number; state: string } | null> {
    const snapshots = await this.records<StoredSnapshot>(S_SNAPSHOTS);
    snapshots.sort((a, b) => b.seq - a.seq);
    const latest = snapshots[0];
    return latest ? { seq: latest.seq, state: latest.state } : null;
  }

  async opsAfter(seq: number): Promise<Op[]> {
    const ops = await this.records<StoredOp>(S_OPS);
    return ops.filter((op) => op.seq > seq).sort((a, b) => a.seq - b.seq).map(({ key: _key, projectId: _projectId, ...op }) => op);
  }

  async latestSeq(): Promise<number> {
    const ops = await this.records<StoredOp>(S_OPS);
    return ops.reduce((max, op) => Math.max(max, op.seq), 0);
  }

  async appendLine(line: string): Promise<void> {
    const op = JSON.parse(line) as Op;
    const db = await openJournalDb();
    const tx = db.transaction(S_OPS, "readwrite");
    tx.objectStore(S_OPS).put({ ...op, projectId: this.projectId, key: `${this.projectId}:${op.seq}` } satisfies StoredOp);
    await transactionDone(tx);
    db.close();
  }

  async writeSnapshot(seq: number, state: string): Promise<void> {
    const db = await openJournalDb();
    const tx = db.transaction(S_SNAPSHOTS, "readwrite");
    tx.objectStore(S_SNAPSHOTS).put({ key: `${this.projectId}:${seq}`, projectId: this.projectId, seq, state, createdAt: Date.now(), formatVersion: 1 } satisfies StoredSnapshot);
    await transactionDone(tx);
    db.close();
  }

  async compactJournalBefore(seq: number): Promise<void> {
    const db = await openJournalDb();
    const tx = db.transaction(S_OPS, "readwrite");
    const store = tx.objectStore(S_OPS);
    const ops = await requestResult(store.index("projectId").getAll(this.projectId)) as StoredOp[];
    for (const op of ops) if (op.seq <= seq) store.delete(op.key);
    await transactionDone(tx);
    db.close();
  }
}

/** Append the complete project state before the primary project write. */
export async function appendProjectState(doc: ProjectDoc): Promise<void> {
  await withProjectJournalLock(doc.id, async () => {
    let latest: ProjectDoc | null = null;
    const journal = await openProjectJournal(doc.id, (value) => { latest = value; });
    await journal.append("replace-state", structuredClone(doc));
  });
}

/** Record an intentional deletion so recovery never resurrects a deleted project. */
export async function appendProjectDeletion(projectId: string): Promise<void> {
  await withProjectJournalLock(projectId, async () => {
    const journal = await openProjectJournal(projectId, () => undefined);
    await journal.append("delete", null);
  });
}

/** Recover the latest journal state, if the project was not intentionally deleted. */
export async function recoverProjectState(projectId: string): Promise<ProjectDoc | null> {
  let latest: ProjectDoc | null = null;
  await openProjectJournal(projectId, (value) => { latest = value; });
  return latest;
}

async function withProjectJournalLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) return locks.request(`obs:project-journal:${projectId}`, { mode: "exclusive" }, task);
  return task();
}

async function openProjectJournal(projectId: string, setLatest: (value: ProjectDoc | null) => void): Promise<Journal> {
  let latest: ProjectDoc | null = null;
  const journal = await Journal.open(
    new ProjectJournalStore(projectId),
    (op) => { if (op.kind === "replace-state") latest = op.payload as ProjectDoc; else if (op.kind === "delete") latest = null; setLatest(latest); },
    () => JSON.stringify(latest),
    (state) => { latest = JSON.parse(state) as ProjectDoc | null; setLatest(latest); },
  );
  return journal;
}
