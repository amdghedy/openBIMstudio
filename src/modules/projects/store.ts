/** Raw IndexedDB persistence — no dependencies, local-first. */
import type { ProjectDoc, ProjectSummary } from "./types";
export type { ProjectRecoverySnapshot, QuarantinedCheckpointSummary } from "./project-journal";
import {
  getModelBlobVersionKey,
  getUnreferencedModelBlobVersionKeys,
  getProjectJournalPruneIds,
  prepareRecoveredProjectDocument,
  summarizeProjectJournalRecord,
  validateRecoveryCheckpointRecord,
  getCheckpointQuarantineKey,
  selectCheckpointQuarantinePruneKeys,
  PROJECT_CHECKPOINT_QUARANTINE_KEEP,
  type ProjectJournalReason,
  type ProjectJournalRecord,
  type ProjectRecoverySnapshot,
  type QuarantinedCheckpointSummary,
} from "./project-journal";
import { normalizeProjectDoc, repairProjectDocInPlace } from "./project-schema";
import { buildProjectFile, suggestedFileName } from "./project-file";
import { backupProjectFile } from "./browser-recovery";
import { appendProjectDeletion, appendProjectState, type QuarantinedJournalRecord } from "./indexeddb-journal";

const DB_NAME = "open-bim-studio";
const DB_VERSION = 4;
const S_PROJECTS = "projects";
const S_BLOBS = "modelBlobs";
const S_JOURNAL = "projectJournal";
const S_JOURNAL_BLOBS = "projectJournalBlobs";
const S_OPERATION_JOURNAL = "projectOps";
const S_OPERATION_SNAPSHOTS = "projectOperationSnapshots";
const S_JOURNAL_QUARANTINE = "projectJournalQuarantine";

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
        if (!db.objectStoreNames.contains(S_JOURNAL_BLOBS)) {
          const archived = db.createObjectStore(S_JOURNAL_BLOBS, { keyPath: "key" });
          archived.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(S_OPERATION_JOURNAL)) {
          const ops = db.createObjectStore(S_OPERATION_JOURNAL, { keyPath: "key" });
          ops.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(S_OPERATION_SNAPSHOTS)) {
          const snapshots = db.createObjectStore(S_OPERATION_SNAPSHOTS, { keyPath: "key" });
          snapshots.createIndex("projectId", "projectId", { unique: false });
        }
        if (!db.objectStoreNames.contains(S_JOURNAL_QUARANTINE)) {
          const quarantine = db.createObjectStore(S_JOURNAL_QUARANTINE, { keyPath: "key" });
          quarantine.createIndex("projectId", "projectId", { unique: false });
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

let modelBlobVersionCounter = 0;
function nextModelBlobVersion(): string {
  modelBlobVersionCounter += 1;
  return `${Date.now()}-${modelBlobVersionCounter}-${Math.random().toString(36).slice(2)}`;
}

/** Remove archive versions no retained checkpoint references. */
function pruneUnreferencedModelBlobVersions(tx: IDBTransaction, projectId: string): void {
  const journal = tx.objectStore(S_JOURNAL);
  const archive = tx.objectStore(S_JOURNAL_BLOBS);
  const records = journal.index("projectId").getAll(projectId);
  records.onsuccess = () => {
    const referenced = new Set<string>();
    for (const record of records.result as ProjectJournalRecord[]) {
      for (const item of record.modelVersions ?? []) referenced.add(getModelBlobVersionKey(projectId, item.modelId, item.version));
    }
    const keys = archive.index("projectId").getAllKeys(projectId);
    keys.onsuccess = () => {
      const obsolete = getUnreferencedModelBlobVersionKeys(keys.result.map(String), referenced);
      for (const key of obsolete) archive.delete(key);
    };
  };
}

/** Snapshot document state and reference immutable model-payload versions. */
function appendProjectSnapshot(
  tx: IDBTransaction,
  doc: ProjectDoc,
  reason: ProjectJournalReason,
  suppliedBlobs?: Array<{ key: string; projectId: string; modelId: string; name: string; blob: Blob; version?: string }>,
  label?: string,
): void {
  const journal = tx.objectStore(S_JOURNAL);
  const archive = tx.objectStore(S_JOURNAL_BLOBS);
  const source = tx.objectStore(S_BLOBS);
  const existing = journal.index("projectId").getAllKeys(doc.id);
  const sourceRequest = suppliedBlobs ? null : source.index("projectId").getAll(doc.id);
  let existingIds: number[] = [];
  let existingReady = false;
  let modelBlobs = suppliedBlobs ?? [];
  let blobsReady = suppliedBlobs !== undefined;
  const append = () => {
    if (!existingReady || !blobsReady) return;
    const modelVersions = modelBlobs.map((model) => {
      const version = model.version || nextModelBlobVersion();
      if (!model.version) source.put({ ...model, version }, model.key);
      const key = getModelBlobVersionKey(doc.id, model.modelId, version);
      const getVersion = archive.get(key);
      getVersion.onsuccess = () => {
        if (!getVersion.result) archive.put({ key, projectId: doc.id, modelId: model.modelId, version, name: model.name, blob: model.blob });
      };
      return { modelId: model.modelId, version };
    });
    const available = new Set(modelVersions.map((x) => x.modelId));
    const missingModelIds = (doc.models ?? []).map((x) => x.id).filter((id) => !available.has(id));
    const request = journal.add({ projectId: doc.id, createdAt: Date.now(), reason, label, doc, modelVersions, archivedModelIds: [...available].sort(), missingModelIds });
    request.onsuccess = () => {
      const pruneIds = getProjectJournalPruneIds([...existingIds, Number(request.result)]);
      for (const id of pruneIds) journal.delete(id);
      pruneUnreferencedModelBlobVersions(tx, doc.id);
    };
  };
  existing.onsuccess = () => { existingIds = existing.result.map(Number); existingReady = true; append(); };
  if (sourceRequest) { sourceRequest.onsuccess = () => { modelBlobs = sourceRequest.result as typeof modelBlobs; blobsReady = true; append(); }; }
}

export async function putProject(doc: ProjectDoc): Promise<void> {
  // Structural repair before write: a persisted record is always a document
  // the opener can consume without further corruption triage.
  repairProjectDocInPlace(doc);
  await appendProjectState(doc);
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const request = projects.get(doc.id);
  request.onsuccess = () => {
    const previous = request.result as ProjectDoc | undefined;
    if (previous && previous.updatedAt !== doc.updatedAt) appendProjectSnapshot(tx, previous, "project-save");
    projects.put(doc);
  };
  request.onerror = () => { try { tx.abort(); } catch { /* transaction may already be inactive */ } };
  await done;
}

export async function getProject(id: string): Promise<ProjectDoc | undefined> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readonly");
  const done = transactionDone(tx);
  const result = await reqAs(tx.objectStore(S_PROJECTS).get(id));
  await done;
  if (result === undefined) return undefined;
  // Normalize what can be normalized; if even that fails, return the raw
  // record — corrupted data is reported, never silently discarded.
  const parsed = normalizeProjectDoc(result);
  if (parsed.ok) return parsed.doc;
  console.error("[projects] stored record is corrupted:", parsed.fatal, parsed.issues, id);
  return result;
}

/** Read a project with explicit triage for the open path. */
export async function loadProjectDoc(id: string): Promise<
  { loaded: true; doc: ProjectDoc; issues: string[]; migrations: string[] } | { loaded: false; fatal: string; issues: string[]; raw: unknown }
> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readonly");
  const done = transactionDone(tx);
  const result = await reqAs(tx.objectStore(S_PROJECTS).get(id));
  await done;
  if (result === undefined) return { loaded: false, fatal: "Project not found.", issues: [], raw: undefined };
  const parsed = normalizeProjectDoc(result);
  if (parsed.ok) return { loaded: true, doc: parsed.doc, issues: parsed.issues, migrations: parsed.migrations };
  return { loaded: false, fatal: parsed.fatal, issues: parsed.issues, raw: result };
}

/**
 * Persist a project document together with its model payloads in ONE
 * transaction. Used by file import and Save-As copy so a crash can never
 * leave a document whose metadata references payloads that were never
 * written (or the reverse).
 */
export async function importProjectWithBlobs(
  doc: ProjectDoc,
  blobs: Array<{ modelId: string; name: string; blob: Blob }>,
  replace = false,
): Promise<void> {
  repairProjectDocInPlace(doc);
  await appendProjectState(doc);
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobsStore = tx.objectStore(S_BLOBS);
  if (replace) {
    const keys = blobsStore.index("projectId").getAllKeys(doc.id);
    keys.onsuccess = () => { for (const key of keys.result) blobsStore.delete(key); };
  }
  projects.put(doc);
  for (const b of blobs) {
    const key = `${doc.id}::${b.modelId}`;
    blobsStore.put({ key, projectId: doc.id, modelId: b.modelId, name: b.name, blob: b.blob }, key);
  }
  await done;
}

/** Best-effort storage usage estimate for quota observability. */
export async function estimateStorage(): Promise<{ usage: number; quota: number; supported: boolean }> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return { usage: 0, quota: 0, supported: false };
    }
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, supported: true };
  } catch {
    return { usage: 0, quota: 0, supported: false };
  }
}

export async function listProjectDocs(): Promise<ProjectDoc[]> {
  const db = await openDb();
  const tx = db.transaction(S_PROJECTS, "readonly");
  const done = transactionDone(tx);
  const result = await reqAs(tx.objectStore(S_PROJECTS).getAll());
  await done;
  // Normalize every record; corrupted ones are kept raw so the user (and the
  // journal) still see them instead of a project list that silently shrinks.
  return result.map((record) => {
    const parsed = normalizeProjectDoc(record);
    if (parsed.ok) return parsed.doc;
    console.error("[projects] stored record is corrupted:", parsed.fatal, record);
    return record as ProjectDoc;
  });
}

/**
 * Delete the project document and every associated model blob in one
 * read/write transaction. A crash or quota/storage error cannot leave a
 * half-deleted project behind.
 */
export async function deleteProjectRecord(id: string): Promise<void> {
  const current = await getProject(id);
  if (current) {
    const blobs = await getModelBlobs(id);
    await backupProjectFile({
      projectId: current.id,
      projectName: current.name,
      fileName: suggestedFileName(current),
      reason: "before-delete",
      blob: buildProjectFile(current, blobs),
    });
  }
  await appendProjectDeletion(id);
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const journal = tx.objectStore(S_JOURNAL);
  const archive = tx.objectStore(S_JOURNAL_BLOBS);
  const archiveKeys = archive.index("projectId").getAllKeys(id);
  archiveKeys.onsuccess = () => { for (const key of archiveKeys.result) archive.delete(key); };
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
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const request = projects.get(projectId);
  const key = `${projectId}::${modelId}`;
  request.onsuccess = () => {
    const previous = request.result as ProjectDoc | undefined;
    if (previous) appendProjectSnapshot(tx, previous, "model-import");
    blobs.put({ key, projectId, modelId, name, blob }, key);
  };
  request.onerror = () => { try { tx.abort(); } catch { /* transaction may already be inactive */ } };
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
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const request = projects.get(projectId);
  const key = `${projectId}::${modelId}`;
  let saved = false;

  request.onsuccess = () => {
    const doc = request.result as ProjectDoc | undefined;
    if (!doc) return;

    const previousDoc = { ...doc, models: (doc.models ?? []).map((model) => ({ ...model })) };
    appendProjectSnapshot(tx, previousDoc, "model-import");
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

/**
 * List retained recovery checkpoints, newest first — and quarantine the
 * damaged ones. A record whose document fails validation is moved to
 * the quarantine store (raw record + reason kept as evidence, newest 50
 * per project) and excluded from the list, so one corrupt checkpoint can
 * never hide the good ones or be offered as restorable. The newest
 * verified checkpoint is always first: the offer is the last known-good.
 */
export async function listProjectRecoverySnapshots(projectId: string): Promise<{ snapshots: ProjectRecoverySnapshot[]; quarantined: QuarantinedCheckpointSummary[] }> {
  const db = await openDb();
  const tx = db.transaction(S_JOURNAL, "readonly");
  const done = transactionDone(tx);
  const records = await reqAs(tx.objectStore(S_JOURNAL).index("projectId").getAll(projectId)) as ProjectJournalRecord[];
  await done;
  const snapshots: ProjectRecoverySnapshot[] = [];
  const corrupt: Array<{ record: ProjectJournalRecord; reason: string }> = [];
  for (const record of records.sort((a, b) => b.id - a.id)) {
    const checked = validateRecoveryCheckpointRecord(record);
    if (checked.ok) snapshots.push(summarizeProjectJournalRecord(record));
    else corrupt.push({ record, reason: checked.reason });
  }
  const quarantined: QuarantinedCheckpointSummary[] = [];
  if (corrupt.length) {
    // Repair in a second transaction: move each corrupt record out of
    // the live journal into the quarantine store (shared with the
    // op-journal quarantine, namespaced key, pruned independently).
    const qtx = db.transaction([S_JOURNAL, S_JOURNAL_QUARANTINE], "readwrite");
    const qdone = transactionDone(qtx);
    const quarantine = qtx.objectStore(S_JOURNAL_QUARANTINE);
    const existing = await reqAs(quarantine.index("projectId").getAll(projectId)) as QuarantinedJournalRecord[];
    const existingCheckpoints = existing.filter((r) => r.kind === "checkpoint").map((r) => ({ key: r.key, seq: r.seq }));
    const now = Date.now();
    for (const { record, reason } of corrupt) {
      console.error("[projects] recovery checkpoint is corrupt; quarantining it", projectId, record.id, reason);
      quarantine.put({
        key: getCheckpointQuarantineKey(projectId, record.id),
        projectId, seq: record.id, kind: "checkpoint", reason,
        raw: record, quarantinedAt: now,
      } satisfies QuarantinedJournalRecord);
      qtx.objectStore(S_JOURNAL).delete(record.id);
      quarantined.push({ id: record.id, createdAt: record.createdAt, reason, quarantinedAt: now });
    }
    for (const key of selectCheckpointQuarantinePruneKeys(existingCheckpoints, corrupt.length)) quarantine.delete(key);
    await qdone;
  }
  return { snapshots, quarantined };
}

/** Quarantined checkpoints for a project, newest first — the evidence of what listing or restore refused. */
export async function listQuarantinedRecoverySnapshots(projectId: string): Promise<QuarantinedCheckpointSummary[]> {
  const db = await openDb();
  const tx = db.transaction(S_JOURNAL_QUARANTINE, "readonly");
  const done = transactionDone(tx);
  const records = await reqAs(tx.objectStore(S_JOURNAL_QUARANTINE).index("projectId").getAll(projectId)) as QuarantinedJournalRecord[];
  await done;
  return records
    .filter((r) => r.kind === "checkpoint")
    .sort((a, b) => b.seq - a.seq)
    .map((r) => ({
      id: r.seq,
      createdAt: (r.raw as ProjectJournalRecord | null)?.createdAt ?? r.quarantinedAt,
      reason: r.reason, quarantinedAt: r.quarantinedAt,
    }));
}

/** Read the full journal records (with documents, for timeline diffs), newest first. */
export async function listProjectJournalRecords(projectId: string): Promise<ProjectJournalRecord[]> {
  const db = await openDb();
  const tx = db.transaction(S_JOURNAL, "readonly");
  const done = transactionDone(tx);
  const records = await reqAs(tx.objectStore(S_JOURNAL).index("projectId").getAll(projectId)) as ProjectJournalRecord[];
  await done;
  return records.sort((a, b) => b.id - a.id);
}

/**
 * Record an explicit timeline version of the given document (a manual
 * "Save version" or any caller that already flushed live state). Unlike
 * putProject this touches only the journal: no save-state change, no
 * updatedAt bump, no "project-save" side effect. Retention (10) and
 * model-blob archiving are the same as every other checkpoint.
 */
export async function recordProjectVersion(
  doc: ProjectDoc,
  reason: ProjectJournalReason,
  label?: string,
): Promise<number> {
  const db = await openDb();
  const tx = db.transaction([S_JOURNAL, S_JOURNAL_BLOBS, S_BLOBS], "readwrite");
  const done = transactionDone(tx);
  // appendProjectSnapshot writes via callbacks and returns nothing, so the
  // new record's id is read back as the newest record for this project.
  // Manual versions are user-initiated and serialized through the panel,
  // so no concurrent writer can interleave here.
  appendProjectSnapshot(tx, doc, reason, undefined, label);
  await done;
  const records = await listProjectJournalRecords(doc.id);
  return records[0]?.id ?? -1;
}

/** Restore a document and its matching archived model blobs in one transaction. */
export async function restoreProjectSnapshot(projectId: string, snapshotId: number): Promise<{ restored: boolean; missingModelIds: string[]; quarantined?: boolean; refusedReason?: string }> {
  const db = await openDb();
  const tx = db.transaction([S_PROJECTS, S_BLOBS, S_JOURNAL, S_JOURNAL_BLOBS, S_JOURNAL_QUARANTINE], "readwrite");
  const done = transactionDone(tx);
  const projects = tx.objectStore(S_PROJECTS);
  const blobs = tx.objectStore(S_BLOBS);
  const journal = tx.objectStore(S_JOURNAL);
  const archive = tx.objectStore(S_JOURNAL_BLOBS);
  const snapshotRequest = journal.get(snapshotId);
  const currentRequest = projects.get(projectId);
  const currentBlobsRequest = blobs.index("projectId").getAll(projectId);
  const archivedBlobsRequest = archive.index("projectId").getAll(projectId);
  const result = { restored: false, missingModelIds: [] as string[], quarantined: false as boolean | undefined, refusedReason: undefined as string | undefined };
  let ready = 0;
  let applied = false;
  const apply = () => {
    if (applied || ready !== 4) return;
    applied = true;
    const snapshot = snapshotRequest.result as ProjectJournalRecord | undefined;
    const current = currentRequest.result as ProjectDoc | undefined;
    if (!snapshot || snapshot.projectId !== projectId || !current) return;
    // Validate BEFORE touching the live document: a corrupt checkpoint
    // must never overwrite the last known-good. Refuse, quarantine the
    // record (raw + reason kept as evidence), and leave the live
    // document and its blobs exactly as they were — no "before-restore"
    // snapshot is taken, because nothing was overwritten.
    const checked = validateRecoveryCheckpointRecord(snapshot);
    if (!checked.ok) {
      console.error("[projects] refusing to restore a corrupt checkpoint; quarantining it", projectId, snapshotId, checked.reason);
      tx.objectStore(S_JOURNAL_QUARANTINE).put({
        key: getCheckpointQuarantineKey(projectId, snapshotId),
        projectId, seq: snapshotId, kind: "checkpoint", reason: checked.reason,
        raw: snapshot, quarantinedAt: Date.now(),
      } satisfies QuarantinedJournalRecord);
      journal.delete(snapshotId);
      result.quarantined = true;
      result.refusedReason = checked.reason;
      return;
    }
    const currentBlobs = currentBlobsRequest.result as Array<{ key: string; projectId: string; modelId: string; name: string; blob: Blob; version?: string }>;
    appendProjectSnapshot(tx, current, "before-restore", currentBlobs);
    const archived = archivedBlobsRequest.result as Array<{ key: string; modelId: string; version: string; name: string; blob: Blob }>;
    const requiredVersions = new Map((snapshot.modelVersions ?? []).map((x) => [x.modelId, x.version] as const));
    const archivedByKey = new Map(archived.map((x) => [x.key, x] as const));
    const restoredBlobs = [...requiredVersions.entries()]
      .map(([modelId, version]) => archivedByKey.get(getModelBlobVersionKey(projectId, modelId, version)))
      .filter((x): x is NonNullable<typeof x> => !!x);
    const available = new Set(restoredBlobs.map((x) => x.modelId));
    const recovered = prepareRecoveredProjectDocument(checked.doc, available, Date.now());
    for (const blob of currentBlobs) blobs.delete(blob.key);
    for (const blob of restoredBlobs) {
      const key = `${projectId}::${blob.modelId}`;
      blobs.put({ key, projectId, modelId: blob.modelId, name: blob.name, blob: blob.blob, version: blob.version }, key);
    }
    projects.put(recovered.doc);
    result.restored = true;
    result.missingModelIds = recovered.missingModelIds;
  };
  for (const request of [snapshotRequest, currentRequest, currentBlobsRequest, archivedBlobsRequest]) {
    request.onsuccess = () => { ready += 1; apply(); };
    request.onerror = () => { try { tx.abort(); } catch { /* transaction may already be inactive */ } };
  }
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
