/**
 * Revision View Filter & Delta Compare Engine.
 *
 * Dispatches visual filters to highlight elements altered between revisions.
 */

import { listAllRevisions } from "./model";

export function getElementsChangedInRevision(revisionId: string): string[] {
  const rev = listAllRevisions().find((r) => r.id === revisionId);
  return rev ? rev.elementIds.slice() : [];
}

export function getElementsChangedBetween(fromRevId: string, toRevId: string): string[] {
  const revs = listAllRevisions();
  const fromIdx = revs.findIndex((r) => r.id === fromRevId);
  const toIdx = revs.findIndex((r) => r.id === toRevId);

  if (fromIdx === -1 || toIdx === -1) return [];

  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);

  const changed = new Set<string>();
  for (let i = start + 1; i <= end; i++) {
    for (const id of revs[i].elementIds) {
      changed.add(id);
    }
  }

  return Array.from(changed);
}

export function applyRevisionFilter(elementIds: string[], highlightColor: string = "#f59e0b"): void {
  window.dispatchEvent(
    new CustomEvent("obs-revision-filter", {
      detail: { elementIds, highlightColor },
    })
  );
}

export function clearRevisionFilter(): void {
  window.dispatchEvent(
    new CustomEvent("obs-revision-filter", {
      detail: { elementIds: [], clear: true },
    })
  );
}
