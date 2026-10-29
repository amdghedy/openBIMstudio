/**
 * Production Revision Tracking Data Model & Store.
 *
 * Tracks project and sheet revision sequences, issued dates, approval status,
 * delta element changes, and cloud associations.
 */

export type RevisionStatus =
  | "draft"
  | "for-review"
  | "for-approval"
  | "issued-for-construction"
  | "as-built"
  | "superseded";

export interface RevisionRecord {
  id: string;
  sequence: number; // 1, 2, 3...
  sequenceLabel: string; // e.g. "Rev A", "Rev 01"
  description: string;
  date: string; // ISO YYYY-MM-DD
  issuedTo: string;
  issuedBy: string;
  checkedBy: string;
  approvedBy: string;
  status: RevisionStatus;
  sheetIds: string[]; // Specific sheets affected (or empty for project-wide)
  elementIds: string[]; // IDs of elements altered in this revision
}

export interface RevisionCloudDef {
  id: string;
  revisionId: string;
  points: [number, number][]; // 2D polygon vertices in drawing space
  viewId: string | null;
  sheetId: string | null;
  note?: string;
}

const STORAGE_KEY_REVS = "obs.revisions.records.v2";
const STORAGE_KEY_CLOUDS = "obs.revisions.clouds.v2";

let currentRevisions: RevisionRecord[] = [];
let currentClouds: RevisionCloudDef[] = [];
const changeListeners = new Set<() => void>();

export function loadRevisionStore(): void {
  try {
    const rawR = localStorage.getItem(STORAGE_KEY_REVS);
    const rawC = localStorage.getItem(STORAGE_KEY_CLOUDS);
    currentRevisions = rawR ? JSON.parse(rawR) : [];
    currentClouds = rawC ? JSON.parse(rawC) : [];
  } catch {
    currentRevisions = [];
    currentClouds = [];
  }
}

export function saveRevisionStore(): void {
  try {
    localStorage.setItem(STORAGE_KEY_REVS, JSON.stringify(currentRevisions));
    localStorage.setItem(STORAGE_KEY_CLOUDS, JSON.stringify(currentClouds));
  } catch {
    /* storage quota fallback */
  }
  changeListeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
}

export function onRevisionStoreChange(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

export function listAllRevisions(): RevisionRecord[] {
  if (!currentRevisions.length) loadRevisionStore();
  return currentRevisions.slice();
}

export function getSheetRevisions(sheetId: string): RevisionRecord[] {
  return listAllRevisions().filter(
    (r) => !r.sheetIds.length || r.sheetIds.includes(sheetId)
  );
}

export function addRevisionRecord(data: Partial<RevisionRecord>): RevisionRecord {
  const existing = listAllRevisions();
  const nextSeq = existing.length > 0 ? Math.max(...existing.map((e) => e.sequence)) + 1 : 1;

  const rec: RevisionRecord = {
    id: `rev-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    sequence: data.sequence ?? nextSeq,
    sequenceLabel: data.sequenceLabel ?? `Rev ${String(data.sequence ?? nextSeq).padStart(2, "0")}`,
    description: data.description || "General revisions",
    date: data.date || new Date().toISOString().slice(0, 10),
    issuedTo: data.issuedTo || "",
    issuedBy: data.issuedBy || "Author",
    checkedBy: data.checkedBy || "",
    approvedBy: data.approvedBy || "",
    status: data.status || "draft",
    sheetIds: data.sheetIds || [],
    elementIds: data.elementIds || [],
  };

  currentRevisions.push(rec);
  saveRevisionStore();
  return rec;
}

export function updateRevisionRecord(id: string, patch: Partial<RevisionRecord>): void {
  const target = currentRevisions.find((r) => r.id === id);
  if (!target) return;
  Object.assign(target, patch);
  saveRevisionStore();
}

export function removeRevisionRecord(id: string): void {
  currentRevisions = currentRevisions.filter((r) => r.id !== id);
  currentClouds = currentClouds.filter((c) => c.revisionId !== id);
  saveRevisionStore();
}

export function addRevisionCloudDef(cloud: Omit<RevisionCloudDef, "id">): RevisionCloudDef {
  const c: RevisionCloudDef = {
    ...cloud,
    id: `cloud-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
  };
  currentClouds.push(c);
  saveRevisionStore();
  return c;
}

export function listCloudsForView(viewId: string | null): RevisionCloudDef[] {
  if (!currentClouds.length) loadRevisionStore();
  return currentClouds.filter((c) => c.viewId === viewId);
}
