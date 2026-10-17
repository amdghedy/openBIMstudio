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
        if (!db.objectStoreNames.contains(S_PROJECTS))
          db.createObjectStore(S_PROJECTS, { keyPath: "id" });
        if (!db.objectStoreNames.contains(S_BLOBS)) {
          const s = db.createObjectStore(S_BLOBS);
          s.createIndex("projectId", "projectId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function putProject(doc: ProjectDoc) {
  const db = await openDb();
  const t = db.transaction(S_PROJECTS, "readwrite");
  await reqAs(t.objectStore(S_PROJECTS).put(doc));
}

export async function getProject(id: string): Promise<ProjectDoc | undefined> {
  const db = await openDb();
  const t = db.transaction(S_PROJECTS, "readonly");
  return reqAs(t.objectStore(S_PROJECTS).get(id));
}

export async function listProjectDocs(): Promise<ProjectDoc[]> {
  const db = await openDb();
  const t = db.transaction(S_PROJECTS, "readonly");
  return reqAs(t.objectStore(S_PROJECTS).getAll());
}

export async function deleteProjectRecord(id: string) {
  const db = await openDb();
  const t = db.transaction(S_PROJECTS, "readwrite");
  await reqAs(t.objectStore(S_PROJECTS).delete(id));
}

export async function putModelBlob(projectId: string, modelId: string, name: string, blob: Blob) {
  const db = await openDb();
  const t = db.transaction(S_BLOBS, "readwrite");
  const key = `${projectId}::${modelId}`;
  await reqAs(t.objectStore(S_BLOBS).put({ key, projectId, modelId, name, blob }, key));
}

export async function getModelBlobs(projectId: string): Promise<{ modelId: string; name: string; blob: Blob }[]> {
  const db = await openDb();
  const t = db.transaction(S_BLOBS, "readonly");
  const idx = t.objectStore(S_BLOBS).index("projectId");
  const recs: any[] = await reqAs(idx.getAll(projectId));
  return recs.map((r) => ({ modelId: r.modelId, name: r.name, blob: r.blob }));
}

export async function deleteModelBlobs(projectId: string) {
  const db = await openDb();
  const t = db.transaction(S_BLOBS, "readwrite");
  const idx = t.objectStore(S_BLOBS).index("projectId");
  const keys: IDBValidKey[] = await reqAs(idx.getAllKeys(projectId));
  const s = t.objectStore(S_BLOBS);
  for (const k of keys) s.delete(k);
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