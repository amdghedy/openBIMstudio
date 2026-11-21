/**
 * Type-catalog <-> family synchronisation.
 *
 * The catalog parser (`type-catalog.ts`) and the family store
 * (`store.ts`) existed side by side with no connection: importing a
 * catalog never created or updated family types, and no family could
 * export its types as a catalog. This module is the bridge, in both
 * directions.
 *
 * Import semantics (Revit type-catalog behaviour):
 * - The catalog's family is matched by id by the caller; this module
 *   never guesses which family a catalog belongs to.
 * - Each catalog row is matched to an existing type by NAME
 *   (case-insensitive, trimmed). A match UPDATES that type's values
 *   (catalog values overwrite, other values are preserved); no match
 *   CREATES a type.
 * - A catalog column naming a parameter the family does not declare
 *   is skipped for every row and reported once in
 *   `unknownParameters` — a catalog must not invent family parameters.
 * - A catalog value whose JSON type does not fit the family
 *   parameter's declared type is skipped for that row and reported in
 *   `skippedValues`.
 *
 * Export semantics: `catalogFromFamily` builds the `TypeCatalog` for a
 * family (parameters in declaration order, types with their values),
 * which `TypeCatalogManager.toCSV` then serialises.
 */
import type { FamilyDefinition, FamilyParameter, FamilyType, ParameterType } from "./types";
import type { TypeCatalog, TypeCatalogEntry } from "./type-catalog";

/** Minimal surface of the family store this sync needs. */
export interface FamilyTypeStore {
  get(familyId: string): FamilyDefinition | null;
  createType(familyId: string, name: string, values: Record<string, any>): FamilyType | null;
  updateType(familyId: string, typeId: string, patch: Partial<FamilyType>): FamilyType | null;
}

// Compile-time proof that the real family store satisfies this
// interface (import type is erased; no runtime dependency on the store).
import type { familyStore } from "./store";
const _familyStoreSatisfiesSync: FamilyTypeStore = null as unknown as typeof familyStore;
void _familyStoreSatisfiesSync;

export interface SkippedCatalogValue {
  typeName: string;
  parameter: string;
  reason: string;
}

export interface CatalogSyncReport {
  familyId: string;
  familyName: string;
  /** Names of types created by this import. */
  created: string[];
  /** Names of types updated by this import. */
  updated: string[];
  /** Catalog columns naming parameters the family does not declare. */
  unknownParameters: string[];
  /** Individual values skipped (type mismatch), with reasons. */
  skippedValues: SkippedCatalogValue[];
}

/** Family parameter types that hold numeric values. */
const NUMERIC_FAMILY_TYPES: ReadonlySet<ParameterType> = new Set([
  "length", "angle", "number", "integer", "area", "volume",
]);

/** Family parameter type -> catalog parameter type. */
const FAMILY_TO_CATALOG_TYPE: Record<ParameterType, TypeCatalog["parameters"][number]["type"]> = {
  length: "length",
  angle: "angle",
  number: "number",
  integer: "integer",
  text: "string",
  area: "area",
  volume: "volume",
  boolean: "yesno",
  material: "string",
  colour: "string",
  "family-type": "string",
};

function valueFitsFamilyType(value: unknown, param: FamilyParameter): boolean {
  if (NUMERIC_FAMILY_TYPES.has(param.type)) return typeof value === "number";
  if (param.type === "text" || param.type === "material" || param.type === "colour" || param.type === "family-type") {
    return typeof value === "string";
  }
  if (param.type === "boolean") return typeof value === "boolean";
  return true;
}

/**
 * Apply a parsed type catalog to a family: create missing types,
 * update existing ones by name. Returns a report of what changed
 * and what was skipped. Throws when the family does not exist.
 */
export function syncCatalogToFamily(
  catalog: TypeCatalog,
  familyId: string,
  store: FamilyTypeStore,
): CatalogSyncReport {
  const family = store.get(familyId);
  if (!family) throw new Error(`Cannot sync type catalog: family "${familyId}" does not exist.`);
  const byName = new Map(family.parameters.map((p) => [p.name.toLowerCase(), p]));
  const unknownParameters = catalog.parameters
    .filter((p) => !byName.has(p.name.toLowerCase()))
    .map((p) => p.name);
  const unknown = new Set(unknownParameters.map((n) => n.toLowerCase()));

  const report: CatalogSyncReport = {
    familyId: family.id,
    familyName: family.name,
    created: [],
    updated: [],
    unknownParameters,
    skippedValues: [],
  };

  for (const entry of catalog.types) {
    const values: Record<string, any> = {};
    for (const [name, value] of Object.entries(entry.values)) {
      if (unknown.has(name.toLowerCase())) continue;
      const param = byName.get(name.toLowerCase());
      if (!param) continue;
      if (!valueFitsFamilyType(value, param)) {
        report.skippedValues.push({
          typeName: entry.typeName,
          parameter: param.name,
          reason: `catalog value ${JSON.stringify(value)} does not fit family parameter type "${param.type}"`,
        });
        continue;
      }
      values[param.name] = value;
    }
    // Re-fetch per row: a store may replace the family object on
    // mutation, and the merge below must see the current values.
    const current = store.get(familyId);
    if (!current) throw new Error(`Cannot sync type catalog: family "${familyId}" disappeared during sync.`);
    const existing = current.types.find(
      (t) => t.name.trim().toLowerCase() === entry.typeName.trim().toLowerCase(),
    );
    if (existing) {
      store.updateType(current.id, existing.id, { values: { ...existing.values, ...values } });
      report.updated.push(existing.name);
    } else {
      const created = store.createType(current.id, entry.typeName, values);
      if (created) report.created.push(created.name);
    }
  }
  return report;
}

/** Build the type catalog for a family (parameters + all its types). */
export function catalogFromFamily(family: FamilyDefinition): TypeCatalog {
  return {
    familyName: family.name,
    parameters: family.parameters.map((p) => ({
      name: p.name,
      type: FAMILY_TO_CATALOG_TYPE[p.type],
    })),
    types: family.types.map((t): TypeCatalogEntry => {
      const values: Record<string, string | number | boolean> = {};
      for (const p of family.parameters) {
        const v = t.values[p.name];
        if (v !== undefined) values[p.name] = v as string | number | boolean;
      }
      return { typeName: t.name, values };
    }),
  };
}
