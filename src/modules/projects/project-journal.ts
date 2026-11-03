import type { ProjectDoc, ProjectModelMeta } from "./types";

export const PROJECT_RECOVERY_RETENTION = 10;

export type ProjectJournalReason = "project-save" | "model-import" | "before-restore";

export interface ProjectJournalRecord {
  id: number;
  projectId: string;
  createdAt: number;
  reason: ProjectJournalReason;
  doc: ProjectDoc;
}

export interface ProjectRecoverySnapshot {
  id: number;
  createdAt: number;
  reason: ProjectJournalReason;
  projectName: string;
  updatedAt: number;
  elementCount: number;
  modelCount: number;
}

/** Return the oldest journal record IDs that must be pruned to retain max entries. */
export function getProjectJournalPruneIds(
  ids: readonly number[],
  maxEntries = PROJECT_RECOVERY_RETENTION,
): number[] {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries must be a positive integer");
  }
  const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))];
  unique.sort((a, b) => b - a);
  return unique.slice(maxEntries).sort((a, b) => a - b);
}

/** Convert a stored snapshot into the small, UI-safe recovery-list row. */
export function summarizeProjectJournalRecord(
  record: ProjectJournalRecord,
): ProjectRecoverySnapshot {
  return {
    id: record.id,
    createdAt: record.createdAt,
    reason: record.reason,
    projectName: record.doc.name,
    updatedAt: record.doc.updatedAt,
    elementCount: record.doc.elements?.length ?? 0,
    modelCount: record.doc.models?.length ?? 0,
  };
}

/**
 * Prepare a restored ProjectDoc without pretending that model payloads are
 * included in the document snapshot. Missing linked IFC/FRAG blobs are marked
 * explicitly so the normal project-open verification can report them.
 */
export function prepareRecoveredProjectDocument(
  snapshot: ProjectDoc,
  availableModelIds: ReadonlySet<string>,
  restoredAt: number,
): { doc: ProjectDoc; missingModelIds: string[] } {
  const missingModelIds: string[] = [];
  const models: ProjectModelMeta[] = (snapshot.models ?? []).map((model) => {
    const recovered = { ...model };
    if (availableModelIds.has(model.id)) {
      delete recovered.missing;
    } else {
      recovered.missing = true;
      missingModelIds.push(model.id);
    }
    return recovered;
  });
  return {
    doc: { ...snapshot, updatedAt: restoredAt, models },
    missingModelIds,
  };
}
