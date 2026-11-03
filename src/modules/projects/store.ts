/** Raw IndexedDB persistence — no dependencies, local-first. */
import type { ProjectDoc, ProjectSummary } from "./types";
import {
  getProjectJournalPruneIds,
  prepareRecoveredProjectDocument,
  summarizeProjectJournalRecord,
  type ProjectJournalReason,
  type ProjectJournalRecord,
  type ProjectRecoverySnapshot,
} from "./project-journal";

const DB_NAME = "open-bim-studio";
const DB_VERSION = 2;
const S_PROJECTS = "projects";
const S_BLOBS = "modelBlobs";
const S_JOURNAL = "projectJournal";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(S_PROJECTS)) {
          db.createObjectStore(S_PROJECTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(S_BLOBS)) {
          const blobs = db.createObjectStore(S_BLOBS);
          blobs.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(S_JOURNAL)) {
          const journal = db.createObjectStore(S_JOURNAL, { keyPath: "id", autoIncrement: true });
          journal.createIndex("projectId", "projectId", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        reject(req.error ?? new Error("Unable to open the project database."));
      };
      req.onblocked = () => {
        // Existing tabs may still hold an older connection. Keep the request
        // pending; their onversionchange handlers close those connections.
      };
    });
    dbPromise = opening;
    void opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise!;
}

function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

/** Resolve only after the transaction commits, not merely after its last request succeeds. */
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed."));
  });
}


/**
 * Append the previous ProjectDoc inside the caller's IndexedDB transaction.
 * The journal is best-effort: quota pressure must not prevent the primary
 * project write. Snapshots are document-only; modelBlobs remain separate.
 */
function appendProjectSnapshot(
  tx: IDBTransaction,
  doc: ProjectDoc,
  reason: ProjectJournalReason,
): void {
  const journal = tx.objectStore(S_JOURNAL);
  const keysRequest = journal.index("projectId").getAllKeys(doc.id);
  const addSnapshot = () => {
    const request = journal.add({
      projectId: doc.id,
      createdAt: Date.now(),
      reason,
      doc,
    });
    request.onerror = (event) => {
      // Prevent an optional recovery checkpoint quota failure from aborting
      // the main project save in this shared transaction.
      event.preventDefault();
      event.stopPropagation();
      console.warn("[projects] recovery checkpoint could not be stored", request.error);
    };
  };

  keysRequest.onsuccess = () => {
    const ids = keysRequest.result.map((key) => Number(key));
    // Treat the next auto-increment key as newest while selecting records to prune.
    const pruneIds = getProjectJournalPruneIds([...ids, Number.MAX_SAFE_INTEGER]);
    for (const id of pruneIds) journal.delete(id);
    addSnapshot();
  };
  keysRequest.onerror = (event) => {
    event.preventDefault();
    event.stopPropagation();
    addSnapshot();
  };
}

export interface PutProjectOptions {
  /** Store the overwritten document as a recovery checkpoint. Defaults to true. */
  checkpoint?: boolean;
  reason?: ProjectJournalReason;
}

export async function putProject(doc: ProjectDoc, options: PutProjectOptions = {}): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_JOURNAL], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const request = projects.get(doc.id);
  request.onsuccess = () => {
    const previous = request.result as ProjectDoc | undefined;
    if (options.checkpoint !== false && previous && previous.updatedAt !== doc.updatedAt) {
      appendProjectSnapshot(tx, previous, options.reason ?? "project-save");
    }
    projects.put(doc);
  };
  await done;
}

export async function getProject(id: string): Promise<ProjectDoc | undefined> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readonly");
  const done = transactionDone(tx);
  const result = await reqAs(tx.objectStore(S_PROJECTS).get(id));
  await done;
  return result;
}

export async function listProjectDocs(): Promise<ProjectDoc[]> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readonly");
  const done = transactionDone(tx);
  const result = await reqAs(tx.objectStore(S_PROJECTS).getAll());
  await done;
  return result;
}

/**
 * Delete the project document and every associated model blob in one
 * read/write transaction. A crash or quota/storage error cannot leave a
 * half-deleted project behind.
 */
export async function deleteProjectRecord(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const journal = tx.objectStore(S_JOURNAL);
  const journalKeys = journal.index("projectId").getAllKeys(id);
  journalKeys.onsuccess = () => { for (const key of journalKeys.result) journal.delete(key); };
  const cursorRequest = blobs.index("projectId").openKeyCursor(IDBKeyRange.only(id));

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    blobs.delete(cursor.primaryKey);
    cursor.continue();
  };
  cursorRequest.onerror = () => {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
  };
  projects.delete(id);
  await done;
}

export async function putModelBlob(
  projectId: string,
  modelId: string,
  name: string,
  blob: Blob,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(S_BLOBS, "readwrite");
  const done = transactionDone(tx);
  const key = `${projectId}::${modelId}`;
  await reqAs(tx.objectStore(S_BLOBS).put({ key, projectId, modelId, name, blob }, key));
  await done;
}

/**
 * Persist an imported model payload and its project metadata atomically.
 * The project is looked up inside the same transaction so an import that
 * finishes after project deletion cannot recreate the deleted project.
 */
export async function putImportedModel(
  projectId: string,
  modelId: string,
  name: string,
  blob: Blob,
): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const request = projects.get(projectId);
  const key = `${projectId}::${modelId}`;
  let saved = false;

  request.onsuccess = () => {
    const doc = request.result as ProjectDoc | undefined;
    if (!doc) return;

    appendProjectSnapshot(tx, doc, "model-import");
    if (!Array.isArray(doc.models)) doc.models = [];
    const meta = doc.models.find((model) => model.id === modelId);
    if (meta) {
      meta.name = name;
      meta.bytes = blob.size;
      (meta as any).missing = false;
    } else {
      doc.models.push({ id: modelId, name, bytes: blob.size });
    }
    doc.updatedAt = Date.now();
    projects.put(doc);
    blobs.put({ key, projectId, modelId, name, blob }, key);
    saved = true;
  };
  request.onerror = () => {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
  };

  await done;
  return saved;
}

export async function getModelBlobs(
  projectId: string,
): Promise<{ modelId: string; name: string; blob: Blob }[]> {
  const db = await openDb();
  const tx = db.transaction(S_BLOBS, "readonly");
  const done = transactionDone(tx);
  const records: any[] = await reqAs(tx.objectStore(S_BLOBS).index("projectId").getAll(projectId));
  await done;
  return records.map((record) => ({
    modelId: record.modelId,
    name: record.name,
    blob: record.blob,
  }));
}

/** Retained for callers that intentionally remove only a project's model payloads. */
export async function deleteModelBlobs(projectId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(S_BLOBS, "readwrite");
  const done = transactionDone(tx);
  const blobs = tx.objectStore(S_BLOBS);
  const cursorRequest = blobs.index("projectId").openKeyCursor(IDBKeyRange.only(projectId));

  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    blobs.delete(cursor.primaryKey);
    cursor.continue();
  };
  cursorRequest.onerror = () => {
    try { tx.abort(); } catch { /* transaction may already be inactive */ }
  };
  await done;
}


/** List the retained document checkpoints, newest first. */
export async function listProjectRecoverySnapshots(projectId: string): Promise<ProjectRecoverySnapshot[]> {
  const db = await openDb();
  const tx = db.transaction(S_JOURNAL, "readonly");
  const done = transactionDone(tx);
  const records = await reqAs(tx.objectStore(S_JOURNAL).index("projectId").getAll(projectId)) as ProjectJournalRecord[];
  await done;
  return records
    .sort((a, b) => b.id - a.id)
    .map(summarizeProjectJournalRecord);
}

/**
 * Restore a document checkpoint atomically. This does not restore IFC/FRAG
 * payload bytes: models absent from modelBlobs are marked missing and reported.
 * The current document is checkpointed first so the restore itself is reversible.
 */
export async function restoreProjectSnapshot(
  projectId: string,
  snapshotId: number,
): Promise<{ restored: boolean; missingModelIds: string[] }> {
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const journal = tx.objectStore(S_JOURNAL);
  const snapshotRequest = journal.get(snapshotId);
  const currentRequest = projects.get(projectId);
  const blobsRequest = blobs.index("projectId").getAll(projectId);
  const result = { restored: false, missingModelIds: [] as string[] };
  let snapshotReady = false;
  let currentReady = false;
  let blobsReady = false;
  let applied = false;

  const applyWhenReady = () => {
    if (applied || !snapshotReady || !currentReady || !blobsReady) return;
    applied = true;
    const snapshot = snapshotRequest.result as ProjectJournalRecord | undefined;
    const current = currentRequest.result as ProjectDoc | undefined;
    if (!snapshot || snapshot.projectId !== projectId || !current) return;

    appendProjectSnapshot(tx, current, "before-restore");
    const availableIds = new Set<string>((blobsRequest.result as Array<{ modelId: string }>).map((item) => item.modelId));
    const recovered = prepareRecoveredProjectDocument(snapshot.doc, availableIds, Date.now());
    projects.put(recovered.doc);
    result.restored = true;
    result.missingModelIds = recovered.missingModelIds;
  };

  snapshotRequest.onsuccess = () => { snapshotReady = true; applyWhenReady(); };
  currentRequest.onsuccess = () => { currentReady = true; applyWhenReady(); };
  blobsRequest.onsuccess = () => { blobsReady = true; applyWhenReady(); };
  await done;
  return result;
}

export function summarize(doc: ProjectDoc): ProjectSummary {
  return {
    id: doc.id,
    name: doc.name,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    elementCount: doc.elements?.length ?? 0,
    modelCount: doc.models?.length ?? 0,
    issueCount: doc.issues?.length ?? 0,
    projectNumber: doc.projectNumber,
    client: doc.client,
    phase: doc.phase,
    status: doc.status,
    units: doc.units,
    template: doc.template,
  };
}
