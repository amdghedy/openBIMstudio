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
 *   5. If the family is not already in the store, register via
 *      `familyStore.createSeed()` — which preserves the catalog id, so
 *      the "already present" check works across boots (see below)
 *   6. Emit a single change event after the batch
 *
 * Idempotence (new.family parity Item 1): `create()` assigns a fresh
 * random id, so the old loader's `get(entry.id)` check could never
 * match a family loaded on an earlier boot — and seed families are
 * persisted, so every reload re-added the whole catalog (50 → 111).
 * The loader now inserts with the catalog id preserved, recognises
 * legacy copies persisted under random ids by (origin + name +
 * content signature), and removes exact duplicates those boots left
 * behind. A same-name family whose content differs from the catalog
 * is a user edit and is never skipped or removed.
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
import {
  dedupeSeedCatalogCopies,
  findExistingSeedFamily,
} from "./seed-catalog-dedupe";

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

/** In-flight loader guard so repeated calls don't double-fetch. Cleared
 *  once the load settles, so a later call re-evaluates against the store
 *  (idempotent via the store, not via the memo — a failed first load
 *  must be retryable, and a second boot must see the persisted copies). */
let loading: Promise<number> | null = null;

/**
 * Fetch + register the seed catalog. Returns the number of new families
 * added (0 if catalog is already loaded or fetch failed).
 *
 * Safe to call multiple times — concurrent calls share the in-flight
 * promise, and a later call re-checks the store and adds nothing new.
 */
export async function loadSeedFamilyCatalog(): Promise<number> {
  if (loading) return loading;
  const p = doLoad();
  loading = p;
  p.finally(() => {
    if (loading === p) loading = null;
  });
  return p;
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
  // Catalog definitions by name, for the legacy-duplicate cleanup below.
  const catalogByName = new Map<string, { id: string; def: FamilyDefinition }>();

  for (const entry of entries) {
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
      // Stamp the seed-catalog origin so the family bridge
      // (modules/families/family-bridge.ts) does not export shipped
      // catalog families into the legacy editor's user library.
      // Note: `description` is preserved via the `description?: string`
      // extension point added to FamilyDefinition in the seed catalog
      // — but it's not part of the canonical schema, so we type-cast it
      // to a separate field the store ignores on persist.
      const def: FamilyDefinition = {
        id: fam.id,
        name: fam.name,
        category: fam.category,
        ifcEntity: fam.ifcEntity,
        sourceElementType: fam.sourceElementType,
        group: fam.group,
        origin: "seed-catalog",
        parameters: fam.parameters,
        geometry: fam.geometry,
        types: fam.types,
        schemaVersion: fam.schemaVersion,
        builtIn: false,
      };
      // Stash the description as a sibling property for the browser UI;
      // the store will persist any extra fields via JSON serialization.
      (def as FamilyDefinition & { description?: string }).description =
        (fam as FamilyDefinition & { description?: string }).description;
      catalogByName.set(entry.name, { id: entry.id, def });

      // Skip if this catalog family is already in the store — by
      // catalog id, or as a legacy copy persisted under a random id
      // (same name + same content). A same-name family whose content
      // differs is a user edit: it does not count as present.
      if (findExistingSeedFamily(familyStore, entry, def)) {
        skipped++;
        continue;
      }

      // createSeed preserves the catalog id, so the check above matches
      // on the next boot. create() would assign a fresh random id and
      // the catalog would be re-added on every reload.
      familyStore.createSeed(def);
      added++;
    } catch (e) {
      console.warn(`[families:library] failed to load ${entry.path}:`, e);
      failed++;
    }
  }

  // Stamp legacy copies: families persisted by earlier boots carry no
  // origin (the old skip check above could never match a stored id —
  // create() assigns a fresh uid — so earlier boots re-added the
  // catalog). Match by catalog name so the bridge's export rule (skip
  // seed-catalog) applies to them too. A user family that happens to
  // share a catalog name is stamped as well; the only consequence is
  // that it is not exported to the editor library — it stays fully
  // usable in the panel and browser.
  for (const entry of entries) {
    for (const fam of familyStore.list()) {
      if (fam.name === entry.name && fam.origin !== "seed-catalog") {
        try {
          familyStore.update(fam.id, { origin: "seed-catalog" });
        } catch { /* keep going */ }
      }
    }
  }

  // Clean up exact duplicates left by earlier boots (each reload used
  // to re-add the whole catalog under fresh random ids). Only
  // byte-identical seed copies are removed — one identical copy
  // remains — and a same-name user edit is never touched.
  const deduped = dedupeSeedCatalogCopies(familyStore, catalogByName);

  console.log(
    `[families:library] catalog loaded: ${added} added, ${skipped} skipped (already present), ${failed} failed, ${deduped} legacy duplicate(s) removed.`,
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
