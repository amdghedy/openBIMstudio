/** Raw IndexedDB persistence — no dependencies, local-first. */
import type { ProjectDoc, ProjectSummary } from "./types";

const DB_NAME = "open-bim-studio";
const DB_VERSION = 1;
const S_PROJECTS = "projects";
const S_BLOBS = "modelBlobs";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
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
        dbPromise = null;
        reject(req.error ?? new Error("Unable to open the project database."));
      };
      req.onblocked = () => {
        // Existing tabs may still hold an older connection. Keep the request
        // pending; their onversionchange handlers close those connections.
      };
    }).catch((error) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
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

export async function putProject(doc: ProjectDoc): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readwrite");
  const done = transactionDone(tx);
  await reqAs(tx.objectStore(S_PROJECTS).put(doc));
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
  const tx = db.transaction([S_PROJECTS, S_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
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
  const tx = db.transaction([S_PROJECTS, S_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const request = projects.get(projectId);
  const key = `${projectId}::${modelId}`;
  let saved = false;

  request.onsuccess = () => {
    const doc = request.result as ProjectDoc | undefined;
    if (!doc) return;

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
