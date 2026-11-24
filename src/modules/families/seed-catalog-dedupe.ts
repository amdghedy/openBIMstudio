/**
 * Seed-catalog dedupe — pure helpers for the seed family catalog loader.
 *
 * No runtime imports (type-only), so the node suite can exercise this
 * logic without pulling in the family store or the project system.
 *
 * Background (new.family parity Item 1): the loader used to call
 * `familyStore.create()`, which always assigns a fresh random id and
 * discards the catalog id. Its "already present" check,
 * `familyStore.get(entry.id)`, could therefore never match a family
 * loaded on an earlier boot — and seed families are persisted to
 * localStorage, so every reload re-added the whole catalog on top of
 * the restored copies (service list grew 50 → 111 across one reload).
 *
 * The fix has two parts, both pinned here:
 *   1. Seed families are inserted with their catalog id preserved
 *      (`familyStore.createSeed`), so `get(entry.id)` matches on the
 *      next boot.
 *   2. Legacy copies already persisted under random ids are recognised
 *      by (origin "seed-catalog" + name + content signature) instead of
 *      by id, so they are not re-added — and exact duplicates left
 *      behind by earlier boots are removed, keeping one copy.
 *
 * A same-name family whose content differs from the catalog is a user
 * edit, not a duplicate: it is never skipped and never removed. Two
 * byte-identical copies are interchangeable, so removing the extra one
 * loses no family data (one identical copy remains).
 */

import type { FamilyDefinition } from "./types";

/** Minimal store surface the loader/dedupe logic needs. */
export interface SeedCatalogStoreView {
  get(id: string): FamilyDefinition | null;
  list(): FamilyDefinition[];
  remove(id: string): boolean;
}

/** One catalog index entry (mirrors `public/families/index.json`). */
export interface SeedCatalogEntry {
  id: string;
  name: string;
  path: string;
}

/**
 * Content signature of a family, ignoring identity fields. Two seed
 * copies loaded from the same catalog file have the same signature;
 * a user edit to parameters / geometry / types changes it.
 */
export function seedFamilySignature(def: FamilyDefinition): string {
  return JSON.stringify({
    name: def.name,
    category: def.category,
    ifcEntity: def.ifcEntity,
    sourceElementType: def.sourceElementType ?? null,
    group: def.group ?? null,
    parameters: def.parameters,
    geometry: def.geometry,
    types: def.types,
  });
}

/**
 * Find the family already in the store that IS this catalog entry, if
 * any: by catalog id first, else a seed-catalog copy with the same name
 * and the same content signature (a legacy copy persisted under a
 * random id by an earlier boot). Returns null when no such family
 * exists — including when a same-name family differs from the catalog
 * (a user edit), so the catalog copy is still added.
 */
export function findExistingSeedFamily(
  store: SeedCatalogStoreView,
  entry: SeedCatalogEntry,
  catalogDef: FamilyDefinition,
): FamilyDefinition | null {
  const byId = store.get(entry.id);
  if (byId) return byId;
  const wanted = seedFamilySignature(catalogDef);
  for (const fam of store.list()) {
    if (
      fam.origin === "seed-catalog" &&
      fam.name === entry.name &&
      seedFamilySignature(fam) === wanted
    ) {
      return fam;
    }
  }
  return null;
}

/**
 * Remove exact duplicate seed-catalog copies left behind by earlier
 * boots: for each catalog name, among the seed-catalog families with
 * that name whose content matches the catalog file, keep one (the
 * catalog-id copy when present, else the first) and remove the rest.
 * Copies whose content differs from the catalog (user edits) are
 * never removed. Returns the number of families removed.
 */
export function dedupeSeedCatalogCopies(
  store: SeedCatalogStoreView,
  catalogByName: Map<string, { id: string; def: FamilyDefinition }>,
): number {
  let removed = 0;
  for (const [name, catalog] of catalogByName) {
    const wanted = seedFamilySignature(catalog.def);
    const copies = store
      .list()
      .filter(
        (fam) =>
          fam.origin === "seed-catalog" &&
          fam.name === name &&
          seedFamilySignature(fam) === wanted,
      );
    if (copies.length <= 1) continue;
    const keep =
      copies.find((fam) => fam.id === catalog.id) ?? copies[0];
    for (const fam of copies) {
      if (fam.id === keep!.id) continue;
      if (store.remove(fam.id)) removed++;
    }
  }
  return removed;
}
