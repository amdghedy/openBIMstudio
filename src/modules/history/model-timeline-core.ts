/**
 * Model history / time-travel — pure core (differentiation item 7).
 *
 * No DOM, no ctx, no IndexedDB: everything here is testable in Node.
 * The browser orchestration (reading the journal, the panel, restore)
 * lives in model-timeline.ts; the version store itself is the existing
 * project journal (src/modules/projects/project-journal.ts + store.ts),
 * which keeps the last 10 pre-save / pre-import / pre-restore snapshots
 * with archived model payloads. history.ts is undo/redo only — it holds
 * apply/revert closures, not snapshots — so it is NOT the version store.
 *
 * A journal checkpoint records the state BEFORE a save/import/restore, so
 * the timeline always shows the live current state as its first row
 * ("Current") followed by the retained versions, newest first.
 */

export interface ElementLike {
  id: string;
  [key: string]: unknown;
}

export interface DocLike {
  elements?: ElementLike[];
  models?: Array<{ id: string; [key: string]: unknown }>;
}

export interface ElementDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface ModelDiff {
  added: string[];
  removed: string[];
}

export interface ProjectDiff {
  elements: ElementDiff;
  models: ModelDiff;
}

/** What changed between two project states, by element/model id. */
export function diffProjectDocs(before: DocLike, after: DocLike): ProjectDiff {
  const beforeEls = new Map((before.elements ?? []).map((e) => [e.id, e]));
  const afterEls = new Map((after.elements ?? []).map((e) => [e.id, e]));
  const elements: ElementDiff = { added: [], removed: [], changed: [] };
  for (const [id, el] of afterEls) {
    if (!beforeEls.has(id)) elements.added.push(id);
    else if (JSON.stringify(beforeEls.get(id)) !== JSON.stringify(el)) elements.changed.push(id);
  }
  for (const id of beforeEls.keys()) {
    if (!afterEls.has(id)) elements.removed.push(id);
  }
  const beforeModels = new Set((before.models ?? []).map((m) => m.id));
  const afterModels = new Set((after.models ?? []).map((m) => m.id));
  const models: ModelDiff = {
    added: [...afterModels].filter((id) => !beforeModels.has(id)),
    removed: [...beforeModels].filter((id) => !afterModels.has(id)),
  };
  return { elements, models };
}

/** Short human summary, e.g. "+2 −1 ~1 elements · +1 model". */
export function formatDiff(d: ProjectDiff): string {
  const parts: string[] = [];
  const e = d.elements;
  const elParts: string[] = [];
  if (e.added.length) elParts.push(`+${e.added.length}`);
  if (e.removed.length) elParts.push(`−${e.removed.length}`);
  if (e.changed.length) elParts.push(`~${e.changed.length}`);
  if (elParts.length) parts.push(`${elParts.join(" ")} element${e.added.length + e.removed.length + e.changed.length === 1 ? "" : "s"}`);
  if (d.models.added.length) parts.push(`+${d.models.added.length} model${d.models.added.length === 1 ? "" : "s"}`);
  if (d.models.removed.length) parts.push(`−${d.models.removed.length} model${d.models.removed.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no changes";
}

export type TimelineReason = "project-save" | "model-import" | "before-restore" | "manual-version";

export const REASON_LABELS: Record<TimelineReason, string> = {
  "project-save": "before a save",
  "model-import": "before a model import",
  "before-restore": "before a restore",
  "manual-version": "manual version",
};

export interface VersionRow {
  id: number;
  createdAt: number;
  reason: TimelineReason;
  label?: string;
  elementCount: number;
  modelCount: number;
  missingModelCount: number;
  /** What changed to reach this version from the next older one. */
  diffFromPrevious: string;
}

/**
 * Build the timeline rows from the journal summaries (newest first) plus
 * the full journal records they came from (for the diffs). The oldest
 * version has no predecessor, so its diff reads "initial version".
 */
export function buildVersionRows(
  summaries: Array<{
    id: number;
    createdAt: number;
    reason: string;
    label?: string;
    elementCount: number;
    modelCount: number;
    missingModelCount: number;
  }>,
  docsById: Map<number, DocLike>,
): VersionRow[] {
  const rows: VersionRow[] = [];
  // summaries arrive newest first; the predecessor of row i is row i+1.
  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const older = summaries[i + 1];
    let diff = "initial version";
    if (older) {
      const before = docsById.get(older.id) ?? { elements: [], models: [] };
      const after = docsById.get(s.id) ?? { elements: [], models: [] };
      diff = formatDiff(diffProjectDocs(before, after));
    }
    rows.push({
      id: s.id,
      createdAt: s.createdAt,
      reason: (REASON_LABELS[s.reason as TimelineReason] ? s.reason : "project-save") as TimelineReason,
      label: s.label,
      elementCount: s.elementCount,
      modelCount: s.modelCount,
      missingModelCount: s.missingModelCount,
      diffFromPrevious: diff,
    });
  }
  return rows;
}

/** Stable content hash for "does the live state match this version?" */
export function contentHash(doc: DocLike): string {
  const els = (doc.elements ?? []).map((e) => JSON.stringify(e)).sort().join("|");
  const models = (doc.models ?? []).map((m) => m.id).sort().join("|");
  let h = 0;
  const s = els + "#" + models;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h);
}
