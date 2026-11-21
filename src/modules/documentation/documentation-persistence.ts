/**
 * Documentation persistence — view templates, view bindings, revisions and
 * revision clouds travelling with the project file.
 *
 * Before this module, templates and revisions lived in localStorage only:
 * a project moved to another machine lost its view templates, its
 * per-view VG bindings and its whole revision history. The snapshot below
 * is stored as `ProjectDoc.documentation` (see projects/types.ts) and is
 * written on save / applied on open by modules/projects/projects.ts.
 *
 * The snapshot is untrusted input on the way back in (a .obsproj header or
 * an IndexedDB record can be hand-edited), so deserialization validates
 * every entry, drops what is malformed, records each drop as an issue, and
 * never throws. Prototype-polluting keys are refused at every level.
 *
 * Pure apart from the two stores it reads/writes; the validation helpers
 * are exported for node tests.
 */

import { viewTemplatesStore } from "../view-templates/view-templates-store";
import {
  serializeRevisions,
  replaceAllRevisions,
  type RevisionRecord,
  type RevisionCloudDef,
  type RevisionStatus,
} from "../revisions/model";

export const DOCUMENTATION_SNAPSHOT_VERSION = 1;

export interface DocumentationSnapshot {
  version: 1;
  viewTemplates: {
    templates: unknown[];
    bindings: Record<string, unknown>;
  };
  revisions: {
    revisions: RevisionRecord[];
    clouds: RevisionCloudDef[];
  };
}

const REVISION_STATUSES: RevisionStatus[] = [
  "draft",
  "for-review",
  "for-approval",
  "issued-for-construction",
  "as-built",
  "superseded",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function asDateString(v: unknown, fallback: string): string {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return fallback;
}

/** Validate one revision record from a project file; null when unusable. */
export function normalizeRevisionRecord(raw: unknown): RevisionRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  const seq = typeof raw.sequence === "number" && Number.isFinite(raw.sequence)
    ? Math.floor(raw.sequence)
    : null;
  if (seq === null) return null;
  const status: RevisionStatus = REVISION_STATUSES.includes(raw.status as RevisionStatus)
    ? (raw.status as RevisionStatus)
    : "draft";
  return {
    id: raw.id,
    sequence: seq,
    sequenceLabel:
      typeof raw.sequenceLabel === "string" && raw.sequenceLabel
        ? raw.sequenceLabel
        : `Rev ${String(seq).padStart(2, "0")}`,
    description: typeof raw.description === "string" ? raw.description : "General revisions",
    date: asDateString(raw.date, new Date().toISOString().slice(0, 10)),
    issuedTo: typeof raw.issuedTo === "string" ? raw.issuedTo : "",
    issuedBy: typeof raw.issuedBy === "string" ? raw.issuedBy : "Author",
    checkedBy: typeof raw.checkedBy === "string" ? raw.checkedBy : "",
    approvedBy: typeof raw.approvedBy === "string" ? raw.approvedBy : "",
    status,
    sheetIds: asStringArray(raw.sheetIds),
    elementIds: asStringArray(raw.elementIds),
    visible: raw.visible !== false,
  };
}

/** Validate one revision cloud from a project file; null when unusable. */
export function normalizeRevisionCloud(raw: unknown): RevisionCloudDef | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id) return null;
  if (typeof raw.revisionId !== "string" || !raw.revisionId) return null;
  if (!Array.isArray(raw.points) || raw.points.length < 3) return null;
  const points: [number, number][] = [];
  for (const p of raw.points) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    points.push([x, y]);
  }
  return {
    id: raw.id,
    revisionId: raw.revisionId,
    points,
    viewId: typeof raw.viewId === "string" ? raw.viewId : null,
    sheetId: typeof raw.sheetId === "string" ? raw.sheetId : null,
    note: typeof raw.note === "string" ? raw.note : undefined,
  };
}

/** Current documentation state as a plain-data snapshot for the project file. */
export function serializeDocumentation(): DocumentationSnapshot {
  const vt = viewTemplatesStore.serialize();
  const rev = serializeRevisions();
  return {
    version: 1,
    viewTemplates: { templates: vt.templates, bindings: vt.bindings },
    revisions: { revisions: rev.revisions, clouds: rev.clouds },
  };
}

export interface RestoreResult {
  /** True when the snapshot was an object we could apply (even partially). */
  applied: boolean;
  /** One line per dropped entry / repair, for the open log. */
  issues: string[];
  counts: { templates: number; bindings: number; revisions: number; clouds: number };
}

/**
 * Apply a project-file documentation snapshot to the live stores. Validates
 * everything, drops malformed entries with an issue each, never throws.
 * A snapshot with the wrong shape leaves the stores untouched.
 */
export function restoreDocumentation(data: unknown): RestoreResult {
  const empty: RestoreResult = {
    applied: false,
    issues: [],
    counts: { templates: 0, bindings: 0, revisions: 0, clouds: 0 },
  };
  if (!isRecord(data)) {
    return { ...empty, issues: ["documentation snapshot is not an object — kept current documentation"] };
  }
  if (data.version !== undefined && data.version !== 1) {
    return { ...empty, issues: [`documentation snapshot version ${String(data.version)} is not supported — kept current documentation`] };
  }
  const issues: string[] = [];

  // View templates + bindings (validated inside the store).
  let templateCount = 0;
  let bindingCount = 0;
  if (isRecord(data.viewTemplates)) {
    const vtIssues = viewTemplatesStore.restoreSnapshot(data.viewTemplates);
    issues.push(...vtIssues);
    templateCount = viewTemplatesStore.listTemplates().length;
    bindingCount = Object.keys(viewTemplatesStore.serialize().bindings).length;
  } else if (data.viewTemplates !== undefined) {
    issues.push("view templates section is not an object — kept current templates");
  }

  // Revisions + clouds.
  let revCount = 0;
  let cloudCount = 0;
  if (isRecord(data.revisions)) {
    const revs: RevisionRecord[] = [];
    const rawRevs = (data.revisions as Record<string, unknown>).revisions;
    if (Array.isArray(rawRevs)) {
      for (const raw of rawRevs) {
        const r = normalizeRevisionRecord(raw);
        if (r) revs.push(r);
        else issues.push("dropped a malformed revision record");
      }
    } else if (rawRevs !== undefined) {
      issues.push("revision list is not an array — kept current revisions");
    }
    const clouds: RevisionCloudDef[] = [];
    const rawClouds = (data.revisions as Record<string, unknown>).clouds;
    if (Array.isArray(rawClouds)) {
      for (const raw of rawClouds) {
        const c = normalizeRevisionCloud(raw);
        if (c) clouds.push(c);
        else issues.push("dropped a malformed revision cloud");
      }
    } else if (rawClouds !== undefined) {
      issues.push("revision cloud list is not an array — kept current clouds");
    }
    const applied = replaceAllRevisions(revs, clouds);
    revCount = applied.revisions;
    cloudCount = applied.clouds;
  } else if (data.revisions !== undefined) {
    issues.push("revisions section is not an object — kept current revisions");
  }

  return {
    applied: true,
    issues,
    counts: { templates: templateCount, bindings: bindingCount, revisions: revCount, clouds: cloudCount },
  };
}
