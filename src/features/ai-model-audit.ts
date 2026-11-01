/**
 * Deterministic checks over records read from the loaded IFC/Fragments model.
 * Findings are limited to the records supplied by the caller; no inference is
 * made about elements that could not be read.
 */
export interface ModelAuditRecord {
  localId: number;
  category: string;
  globalId?: string | null;
  name?: string | null;
}

export interface ModelAuditOptions {
  modelId: string;
  modelName: string;
  totalGeometryElementCount: number;
  scannedCount: number;
  readErrorCount?: number;
  truncated?: boolean;
}

export function auditModelRecords(
  records: ModelAuditRecord[],
  options: ModelAuditOptions,
) {
  const categoryCounts: Record<string, number> = {};
  const missingGlobalId: ModelAuditRecord[] = [];
  const globalIdMap = new Map<string, ModelAuditRecord[]>();

  for (const record of records) {
    const category = record.category || "Unknown";
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const globalId = String(record.globalId ?? "").trim();
    if (!globalId) {
      missingGlobalId.push(record);
      continue;
    }
    const matches = globalIdMap.get(globalId) ?? [];
    matches.push(record);
    globalIdMap.set(globalId, matches);
  }

  const duplicates = [...globalIdMap.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([globalId, matches]) => ({
      globalId,
      count: matches.length,
      elements: matches.slice(0, 20).map((record) => ({
        modelId: options.modelId,
        localId: record.localId,
        category: record.category,
        name: record.name ?? null,
      })),
    }));

  const findings = [];
  if (missingGlobalId.length) {
    findings.push({
      code: "MISSING_GLOBAL_ID",
      severity: "warning",
      count: missingGlobalId.length,
      elements: missingGlobalId.slice(0, 20).map((record) => ({
        modelId: options.modelId,
        localId: record.localId,
        category: record.category,
        name: record.name ?? null,
      })),
    });
  }
  if (duplicates.length) {
    findings.push({
      code: "DUPLICATE_GLOBAL_ID",
      severity: "error",
      count: duplicates.reduce((sum, item) => sum + item.count - 1, 0),
      duplicateGroups: duplicates.slice(0, 20),
    });
  }

  const readErrorCount = options.readErrorCount ?? 0;
  return {
    auditType: "deterministic-ifc-data-audit",
    source: {
      kind: "loaded-ifc-fragments-model",
      modelId: options.modelId,
      modelName: options.modelName,
    },
    scope: {
      elementPopulation: "geometry-bearing elements returned by getItemsIdsWithGeometry",
      totalGeometryElementCount: options.totalGeometryElementCount,
      scannedCount: options.scannedCount,
      truncated: !!options.truncated,
      readErrorCount,
      complete: !options.truncated && readErrorCount === 0 &&
        options.scannedCount === options.totalGeometryElementCount,
    },
    summary: {
      scanned: records.length,
      missingGlobalId: missingGlobalId.length,
      duplicateGlobalIdGroups: duplicates.length,
      categoryCounts,
      findingCount: findings.length,
    },
    findings,
    limitations: [
      "This audit covers geometry-bearing elements only, not every IFC entity in the file.",
      "A missing GlobalId is reported as a data-quality warning for the scanned element; project-specific exchange requirements may differ.",
      "Duplicate GlobalIds are checked within each model independently, not across federated models.",
      "Elements in failed read batches are excluded and reported through readErrorCount.",
    ],
  };
}
