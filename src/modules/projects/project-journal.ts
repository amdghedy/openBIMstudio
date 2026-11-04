import type { ProjectDoc } from "./types";

export const PROJECT_RECOVERY_RETENTION = 10;
export type ProjectJournalReason = "project-save" | "model-import" | "before-restore";

export interface ProjectJournalRecord { id: number; projectId: string; createdAt: number; reason: ProjectJournalReason; doc: ProjectDoc; modelVersions: Array<{ modelId: string; version: string }>; archivedModelIds: string[]; missingModelIds: string[]; }
export interface ProjectRecoverySnapshot { id: number; createdAt: number; reason: ProjectJournalReason; projectName: string; updatedAt: number; elementCount: number; modelCount: number; archivedModelCount: number; missingModelCount: number; }

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
  return { id: record.id, createdAt: record.createdAt, reason: record.reason, projectName: record.doc.name, updatedAt: record.doc.updatedAt, elementCount: record.doc.elements?.length ?? 0, modelCount: record.doc.models?.length ?? 0, archivedModelCount: record.archivedModelIds?.length ?? 0, missingModelCount: record.missingModelIds?.length ?? record.doc.models?.length ?? 0 };
}

export function prepareRecoveredProjectDocument(snapshot: ProjectDoc, availableModelIds: ReadonlySet<string>, restoredAt: number): { doc: ProjectDoc; missingModelIds: string[] } {
  const missingModelIds: string[] = [];
  const models = (snapshot.models ?? []).map((model) => { const recovered = { ...model }; if (availableModelIds.has(model.id)) delete recovered.missing; else { recovered.missing = true; missingModelIds.push(model.id); } return recovered; });
  return { doc: { ...snapshot, updatedAt: restoredAt, models }, missingModelIds };
}
