import type { ProjectDoc } from "./types";
import { normalizeProjectDoc } from "./project-schema";

export const PROJECT_RECOVERY_RETENTION = 10;
export type ProjectJournalReason = "project-save" | "model-import" | "before-restore" | "manual-version";

/** Quarantined checkpoint retention: same newest-50 rule as the op-journal quarantine. */
export const PROJECT_CHECKPOINT_QUARANTINE_KEEP = 50;

export interface ProjectJournalRecord { id: number; projectId: string; createdAt: number; reason: ProjectJournalReason; label?: string; doc: ProjectDoc; modelVersions: Array<{ modelId: string; version: string }>; archivedModelIds: string[]; missingModelIds: string[]; }
export interface ProjectRecoverySnapshot { id: number; createdAt: number; reason: ProjectJournalReason; label?: string; projectName: string; updatedAt: number; elementCount: number; modelCount: number; archivedModelCount: number; missingModelCount: number; }
/** A checkpoint that failed validation and was moved to the quarantine
 *  store: kept as evidence with its reason, never silently dropped, and
 *  never offered as restorable. */
export interface QuarantinedCheckpointSummary { id: number; createdAt: number; reason: string; quarantinedAt: number; }

export function getModelBlobVersionKey(projectId: string, modelId: string, version: string): string {
  return `${projectId}::${modelId}::${version}`;
}

export function getUnreferencedModelBlobVersionKeys(archiveKeys: readonly string[], referencedKeys: ReadonlySet<string>): string[] {
  return archiveKeys.filter((key) => !referencedKeys.has(key)).sort();
}

export function getProjectJournalPruneIds(ids: readonly number[], maxEntries = PROJECT_RECOVERY_RETENTION): number[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("maxEntries must be a positive integer");
  const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  unique.sort((a, b) => b - a);
  return unique.slice(maxEntries).sort((a, b) => a - b);
}

export function summarizeProjectJournalRecord(record: ProjectJournalRecord): ProjectRecoverySnapshot {
  // Defensive: a corrupt record must never break the checkpoint list —
  // listing validates records first, but the summary itself must not
  // throw on a missing/malformed doc either. Corrupt records are
  // quarantined by the store; the summary only ever describes a record
  // that already passed validation.
  const doc = (record?.doc && typeof record.doc === "object" ? record.doc : null) as ProjectDoc | null;
  return {
    id: record.id, createdAt: record.createdAt, reason: record.reason, label: record.label,
    projectName: doc?.name ?? "Untitled project", updatedAt: doc?.updatedAt ?? record.createdAt,
    elementCount: doc?.elements?.length ?? 0, modelCount: doc?.models?.length ?? 0,
    archivedModelCount: record.archivedModelIds?.length ?? 0,
    missingModelCount: record.missingModelIds?.length ?? doc?.models?.length ?? 0,
  };
}

/**
 * Validate a stored recovery checkpoint before it is listed or restored.
 * A checkpoint whose document does not normalize is corrupt: it must be
 * quarantined, never offered as restorable, and never written over the
 * live document. The stored `doc.id` must also match the owning project
 * — a checkpoint for another project is a data-integrity fault, not a
 * restorable state.
 */
export function validateRecoveryCheckpointRecord(
  record: ProjectJournalRecord,
): { ok: true; doc: ProjectDoc } | { ok: false; reason: string } {
  if (!record || typeof record !== "object" || record.doc === null || typeof record.doc !== "object") {
    return { ok: false, reason: "checkpoint has no usable project document" };
  }
  const parsed = normalizeProjectDoc(record.doc);
  if (!parsed.ok) {
    return { ok: false, reason: `checkpoint document is corrupt: ${parsed.fatal}` };
  }
  if (parsed.doc.id !== record.projectId) {
    return { ok: false, reason: `checkpoint document belongs to project “${parsed.doc.id}”, not “${record.projectId}”` };
  }
  return { ok: true, doc: parsed.doc };
}

/** Quarantine-store key for a corrupt checkpoint. Namespaced apart from
 *  the op-journal quarantine keys (`<projectId>:<seq>`) so the two kinds
 *  can share one store without ever colliding. */
export function getCheckpointQuarantineKey(projectId: string, snapshotId: number): string {
  return `${projectId}:checkpoint:${snapshotId}`;
}

/**
 * Which existing checkpoint-quarantine keys to delete so that, after
 * adding `adding` new quarantined checkpoints, at most `keep` remain
 * for the project. Newest (highest checkpoint id) survive; op-journal
 * quarantines in the same store are never touched — the two kinds share
 * the store but prune independently (their `seq` counters are unrelated).
 */
export function selectCheckpointQuarantinePruneKeys(
  existing: Array<{ key: string; seq: number }>,
  adding: number,
  keep: number = PROJECT_CHECKPOINT_QUARANTINE_KEEP,
): string[] {
  if (keep < 1 || adding < 0) return [];
  const sorted = [...existing].sort((a, b) => (b.seq - a.seq) || (b.key < a.key ? 1 : -1));
  return sorted.slice(Math.max(0, keep - adding)).map((r) => r.key);
}

export function prepareRecoveredProjectDocument(snapshot: ProjectDoc, availableModelIds: ReadonlySet<string>, restoredAt: number): { doc: ProjectDoc; missingModelIds: string[] } {
  const missingModelIds: string[] = [];
  const models = (snapshot.models ?? []).map((model) => { const recovered = { ...model }; if (availableModelIds.has(model.id)) delete recovered.missing; else { recovered.missing = true; missingModelIds.push(model.id); } return recovered; });
  return { doc: { ...snapshot, updatedAt: restoredAt, models }, missingModelIds };
}
