/**
 * Project document schema: versioning, validation and migration.
 *
 * Every untrusted ProjectDoc — a record read back from IndexedDB, a `.obsproj`
 * header, or a legacy `.obs.json` file — passes through `normalizeProjectDoc`
 * before it reaches the live session. The normalizer:
 *
 *   - never throws (malformed input is described, not discarded);
 *   - repairs what can be repaired and records every repair as an issue;
 *   - refuses only what makes identity impossible (not an object, no usable id)
 *     or documents written by a newer schema version;
 *   - preserves unknown fields so forward-compatible data survives round-trips.
 *
 * Pure and dependency-free so tests can compile it standalone.
 */
import type { ProjectDoc } from "./types";

/** Current schema version for persisted project documents. */
export const PROJECT_DOC_SCHEMA_VERSION = 2;

export interface ProjectParseOk {
  ok: true;
  doc: ProjectDoc;
  /** Human-readable repairs applied while normalizing. */
  issues: string[];
  /** Migration labels applied, e.g. "schema v1 → v2". */
  migrations: string[];
}
export interface ProjectParseFail {
  ok: false;
  issues: string[];
  /** The single reason the document cannot be opened at all. */
  fatal: string;
}
export type ProjectParseResult = ProjectParseOk | ProjectParseFail;

type AnyDoc = Record<string, unknown>;

/* ── primitive coercion helpers (never throw) ──────────────────────────── */

function isObject(v: unknown): v is AnyDoc {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pushUnique(target: string[], message: string): void {
  if (!target.includes(message)) target.push(message);
}

/* ── migration registry ────────────────────────────────────────────────── */

type Migration = (doc: AnyDoc, issues: string[]) => AnyDoc;

/**
 * Ordered migrations. `MIGRATIONS[n]` upgrades schema version n to n+1.
 * Add new migrations here; never rewrite old ones (already-persisted docs
 * must keep migrating deterministically).
 */
export const PROJECT_MIGRATIONS: Record<number, Migration> = {
  /**
   * v1 → v2: documents persisted before schema versioning existed. All the
   * structural backfills are performed by the normalizer itself; the migration
   * stamps the version so subsequent saves carry it.
   */
  1: (doc) => ({ ...doc, schemaVersion: 2 }),
};

/* ── normalization ─────────────────────────────────────────────────────── */

/**
 * Normalize an untrusted value into a valid ProjectDoc.
 * Returns `ok: false` only when identity or forward-compatibility is broken.
 */
export function normalizeProjectDoc(raw: unknown): ProjectParseResult {
  const issues: string[] = [];
  const migrations: string[] = [];

  if (!isObject(raw)) {
    return { ok: false, issues, fatal: "Project data is not an object." };
  }

  /* schema version + migrations first */
  let version = asFiniteNumber(raw.schemaVersion, 1);
  if (!Number.isInteger(version) || version < 1) {
    pushUnique(issues, `schemaVersion "${String(raw.schemaVersion)}" is invalid — treated as v1 (legacy).`);
    version = 1;
  }
  if (version > PROJECT_DOC_SCHEMA_VERSION) {
    return {
      ok: false,
      issues,
      fatal: `This project uses schema v${version}, but this app supports up to v${PROJECT_DOC_SCHEMA_VERSION}. Update the app to open it.`,
    };
  }
  let doc: AnyDoc = { ...raw };
  while (version < PROJECT_DOC_SCHEMA_VERSION) {
    const migrate = PROJECT_MIGRATIONS[version];
    if (!migrate) {
      return { ok: false, issues, fatal: `No migration path from schema v${version}.` };
    }
    doc = migrate(doc, issues);
    migrations.push(`schema v${version} → v${version + 1}`);
    version = asFiniteNumber(doc.schemaVersion, version + 1);
  }

  /* identity — the one thing that cannot be invented */
  const id = typeof doc.id === "string" ? doc.id.trim() : "";
  if (!id) {
    return { ok: false, issues, fatal: "Project has no usable id." };
  }
  doc.id = id;

  if (asString(doc.name, "").trim() === "") {
    doc.name = "Untitled project";
    pushUnique(issues, "Project name was empty — set to “Untitled project”.");
  }

  const now = Date.now();
  const createdAt = asFiniteNumber(doc.createdAt, now);
  if (createdAt !== doc.createdAt) pushUnique(issues, "createdAt was missing or invalid — set to now.");
  const updatedAt = asFiniteNumber(doc.updatedAt, createdAt);
  if (updatedAt !== doc.updatedAt) pushUnique(issues, "updatedAt was missing or invalid — set to createdAt.");
  doc.createdAt = createdAt;
  doc.updatedAt = updatedAt;

  /* structural collections — missing arrays are backfilled, never fatal */
  for (const key of ["elements", "models", "grids", "levels", "issues"] as const) {
    if (!Array.isArray(doc[key])) {
      const was = doc[key];
      doc[key] = [];
      if (was !== undefined && was !== null) {
        pushUnique(issues, `“${key}” was corrupted (${typeof was}) — reset to empty.`);
      }
    }
  }

  /* model metadata: keep well-formed entries, report dropped ones by name */
  const models: unknown[] = [];
  let droppedModels = 0;
  for (const entry of asArray(doc.models)) {
    if (isObject(entry) && typeof entry.id === "string" && entry.id.trim() !== "") {
      const model: AnyDoc = { ...entry, id: entry.id.trim() };
      model.name = asString(entry.name, String(model.id));
      model.bytes = asFiniteNumber(entry.bytes, 0);
      models.push(model);
    } else {
      droppedModels += 1;
    }
  }
  if (droppedModels > 0) {
    pushUnique(issues, `${droppedModels} linked model entr${droppedModels === 1 ? "y" : "ies"} had no id and could not be kept.`);
  }
  doc.models = models;

  doc.schemaVersion = PROJECT_DOC_SCHEMA_VERSION;
  return { ok: true, doc: doc as unknown as ProjectDoc, issues, migrations };
}

/**
 * Repair a trusted, already-typed ProjectDoc in place before persisting it.
 * Returns the list of repairs (empty = the document was already clean).
 */
export function repairProjectDocInPlace(doc: ProjectDoc): string[] {
  const issues: string[] = [];
  if (!doc || typeof doc !== "object") return ["Project document is not an object."];
  if (typeof doc.id !== "string" || !doc.id.trim()) issues.push("id is empty.");
  if (typeof doc.name !== "string" || !doc.name.trim()) { doc.name = "Untitled project"; issues.push("name was empty."); }
  const now = Date.now();
  if (typeof doc.createdAt !== "number" || !Number.isFinite(doc.createdAt)) { doc.createdAt = now; issues.push("createdAt was invalid."); }
  if (typeof doc.updatedAt !== "number" || !Number.isFinite(doc.updatedAt)) { doc.updatedAt = doc.createdAt; issues.push("updatedAt was invalid."); }
  for (const key of ["elements", "models", "grids", "levels", "issues"] as const) {
    if (!Array.isArray((doc as unknown as AnyDoc)[key])) {
      (doc as unknown as AnyDoc)[key] = [];
      issues.push(`“${key}” was not an array — reset to empty.`);
    }
  }
  if ((doc as unknown as AnyDoc).schemaVersion !== PROJECT_DOC_SCHEMA_VERSION) {
    (doc as unknown as AnyDoc).schemaVersion = PROJECT_DOC_SCHEMA_VERSION;
  }
  return issues;
}

/** True when the error is a storage-quota failure (write did not happen). */
export function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /quota/i.test(msg);
}
