// openbim-families:project-persistence
// User families travel with the project document.
//
// User families used to live only in localStorage
// (`obs.families.v1.<projectId>`), so a project opened on another machine
// lost its custom families while its instances kept dangling `familyId`s;
// `resolveParams` then returned null and the sync silently did nothing.
// This module holds the pure, testable half of the fix: validation,
// serialisation, and the missing-family scan. The store half lives in
// `store.ts` (`serializeUserFamilies` / `restoreUserFamilies`); the
// document half lives in `src/modules/projects/` (`userFamilies` on the
// project doc, written on save, restored on open).
//
// Only user families travel: built-ins are re-seeded on boot and are
// never written to the document. Restore is tolerant — an invalid entry
// is skipped and reported, never fatal — and the document always wins
// over the local copy for a family id it carries.
import type { FamilyDefinition } from "./types";
import type { AuthoredElement } from "../projects/types";

export interface SkippedFamily {
  id: string;
  reason: string;
}

export interface FamilyRestoreReport {
  restored: number;
  skipped: SkippedFamily[];
}

/**
 * Validate one family definition the way `looksLikeFamily` in
 * `library-loader.ts` does, plus the checks a document restore needs
 * (a types array when present, unique parameter names). Returns null
 * when the definition is usable, otherwise the reason it must be
 * skipped. Never throws.
 */
export function validateFamilyDefinition(def: unknown): string | null {
  if (!def || typeof def !== "object") return "not an object";
  const o = def as Partial<FamilyDefinition>;
  if (typeof o.id !== "string" || o.id.length === 0) return "missing id";
  if (typeof o.name !== "string" || o.name.length === 0) return "missing name";
  if (typeof o.ifcEntity !== "string" || o.ifcEntity.length === 0) return "missing ifcEntity";
  if (!Array.isArray(o.parameters)) return "parameters is not an array";
  if (!o.geometry || typeof o.geometry !== "object" || !("kind" in o.geometry)) {
    return "geometry has no kind";
  }
  if (o.builtIn) return "built-in families are re-seeded, not restored";
  const seen = new Set<string>();
  for (const p of o.parameters) {
    if (!p || typeof p.name !== "string" || p.name.length === 0) return "parameter without a name";
    if (seen.has(p.name)) return `duplicate parameter name "${p.name}"`;
    seen.add(p.name);
  }
  if (o.types !== undefined) {
    if (!Array.isArray(o.types)) return "types is not an array";
    for (const t of o.types) {
      if (!t || typeof t.id !== "string" || t.id.length === 0) return "type without an id";
      if (t.values !== undefined && (t.values === null || typeof t.values !== "object")) {
        return `type "${t.id}" has no values object`;
      }
    }
  }
  return null;
}

/** Split an unknown document payload into usable definitions and skips. */
export function partitionFamilyDefinitions(raw: unknown): {
  valid: FamilyDefinition[];
  skipped: SkippedFamily[];
} {
  const valid: FamilyDefinition[] = [];
  const skipped: SkippedFamily[] = [];
  if (!Array.isArray(raw)) {
    skipped.push({ id: "<document>", reason: "userFamilies is not an array" });
    return { valid, skipped };
  }
  for (const def of raw) {
    const reason = validateFamilyDefinition(def);
    if (reason) {
      const id = def && typeof def === "object" && typeof (def as any).id === "string"
        ? (def as any).id
        : "<unknown>";
      skipped.push({ id, reason });
      continue;
    }
    valid.push(def as FamilyDefinition);
  }
  return { valid, skipped };
}

/**
 * The user families that travel with the project: everything that is
 * not a built-in, deep-cloned so later edits cannot mutate the store
 * through the saved copy.
 */
export function serializeUserFamilies(families: FamilyDefinition[]): FamilyDefinition[] {
  return JSON.parse(JSON.stringify(families.filter((d) => !d.builtIn)));
}

export interface MissingFamilyRef {
  elementId: string;
  familyId: string;
}

/**
 * Elements whose `familyId` has no definition in the store. The
 * elements themselves are never dropped or altered here — the caller
 * reports the refs and keeps the elements with their `familyId` intact
 * so re-importing the family restores them.
 */
export function findMissingFamilies(
  elements: AuthoredElement[],
  hasFamily: (familyId: string) => boolean,
): MissingFamilyRef[] {
  const out: MissingFamilyRef[] = [];
  for (const el of elements ?? []) {
    if (!el.familyId) continue;
    if (!hasFamily(el.familyId)) out.push({ elementId: el.id, familyId: el.familyId });
  }
  return out;
}
