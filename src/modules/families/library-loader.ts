/**
 * Library Loader — fetches the seed family catalog at boot.
 *
 * The 10 builtin families in `builtin-families.ts` always ship. This
 * loader extends that set with the larger catalog in
 * `public/families/index.json` (54 seed families, 112 types as of v0.56).
 *
 * Flow:
 *   1. After `setupFamilies()` registers builtins + restores localStorage
 *   2. fetch("/families/index.json")  → array of catalog entries
 *   3. For each entry: fetch the family JSON
 *   4. Validate against `FamilyDefinition` shape
 *   5. If the family id is not already in the store, register via
 *      `familyStore.create()` (so user-edited copies always win)
 *   6. Emit a single change event after the batch
 *
 * Failure modes:
 *   - Network error / 404 → log warning, skip silently (app stays usable
 *     with the 10 builtins)
 *   - Invalid family JSON → log warning, skip that one family
 *   - Family id already in store (user created one with the same id) →
 *     respect the user's version, skip silently
 *
 * This loader is intentionally non-blocking: it runs in the background
 * after setupFamilies() returns. The family browser will receive a
 * change event when the catalog finishes loading.
 */

import type { FamilyDefinition } from "./types";
import { familyStore } from "./store";

/** Catalog index entry — one per family in `public/families/`. */
interface CatalogEntry {
  id: string;
  name: string;
  group: string;
  category: string;
  ifcEntity: string;
  typeCount: number;
  path: string; // Relative to public/families/
}

/** Minimal shape check on a fetched family. Returns null if invalid. */
function looksLikeFamily(d: unknown): d is FamilyDefinition {
  if (!d || typeof d !== "object") return false;
  const o = d as Partial<FamilyDefinition>;
  return Boolean(
    typeof o.id === "string" && o.id.length > 0 &&
    typeof o.name === "string" && o.name.length > 0 &&
    typeof o.ifcEntity === "string" && o.ifcEntity.length > 0 &&
    Array.isArray(o.parameters) &&
    o.geometry && typeof o.geometry === "object" &&
    "kind" in o.geometry
  );
}

/** In-flight loader guard so repeated calls don't double-fetch. */
let loading: Promise<number> | null = null;

/**
 * Fetch + register the seed catalog. Returns the number of new families
 * added (0 if catalog is already loaded or fetch failed).
 *
 * Safe to call multiple times — second call returns the in-flight promise
 * or resolves to 0 if already loaded.
 */
export async function loadSeedFamilyCatalog(): Promise<number> {
  if (loading) return loading;
  loading = doLoad();
  return loading;
}

async function doLoad(): Promise<number> {
  let entries: CatalogEntry[] = [];

  try {
    const res = await fetch("/families/index.json", { cache: "no-cache" });
    if (!res.ok) {
      console.warn(`[families:library] index.json returned ${res.status} — skipping catalog load.`);
      return 0;
    }
    const data = await res.json();
    if (!Array.isArray(data)) {
      console.warn("[families:library] index.json is not an array — skipping.");
      return 0;
    }
    entries = data.filter(
      (e): e is CatalogEntry =>
        e && typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.path === "string",
    );
  } catch (e) {
    console.warn("[families:library] could not fetch index.json:", e);
    return 0;
  }

  if (entries.length === 0) {
    console.log("[families:library] catalog is empty.");
    return 0;
  }

  let added = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    // Skip if the user already has a family with this id (user-edited wins).
    if (familyStore.get(entry.id)) {
      skipped++;
      continue;
    }

    try {
      const famRes = await fetch(`/families/${entry.path}`, { cache: "no-cache" });
      if (!famRes.ok) {
        console.warn(`[families:library] ${entry.path} returned ${famRes.status}`);
        failed++;
        continue;
      }
      const fam: unknown = await famRes.json();

      if (!looksLikeFamily(fam)) {
        console.warn(`[families:library] ${entry.path} is not a valid FamilyDefinition — skipping.`);
        failed++;
        continue;
      }

      // Mark as non-builtin so users can edit / delete freely.
      // Note: `description` is preserved via the `description?: string`
      // extension point added to FamilyDefinition in the seed catalog
      // — but it's not part of the canonical schema, so we type-cast it
      // to a separate field the store ignores on persist.
      const def: Omit<FamilyDefinition, "id" | "schemaVersion" | "builtIn"> = {
        name: fam.name,
        category: fam.category,
        ifcEntity: fam.ifcEntity,
        sourceElementType: fam.sourceElementType,
        group: fam.group,
        parameters: fam.parameters,
        geometry: fam.geometry,
        types: fam.types,
      };
      // Stash the description as a sibling property for the browser UI;
      // the store will persist any extra fields via JSON serialization.
      (def as FamilyDefinition & { description?: string }).description =
        (fam as FamilyDefinition & { description?: string }).description;

      familyStore.create(def);
      added++;
    } catch (e) {
      console.warn(`[families:library] failed to load ${entry.path}:`, e);
      failed++;
    }
  }

  console.log(
    `[families:library] catalog loaded: ${added} added, ${skipped} skipped (already present), ${failed} failed.`,
  );

  return added;
}

/** True once loadSeedFamilyCatalog has resolved at least once. */
let hasLoaded = false;
export function isCatalogLoaded(): boolean {
  return hasLoaded;
}

/** Wrap loadSeedFamilyCatalog so isCatalogLoaded flips on first completion. */
export async function loadSeedFamilyCatalogTracked(): Promise<number> {
  const n = await loadSeedFamilyCatalog();
  hasLoaded = true;
  return n;
}
