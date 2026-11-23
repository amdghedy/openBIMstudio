/**
 * Family schema versioning and migration.
 *
 * `FamilyDefinition.schemaVersion` was 1 everywhere with no migrator:
 * a family saved by an older build (or hand-written JSON, or a project
 * file) loaded verbatim, so a parameter without a `scope`, a type value
 * naming a parameter the family no longer declares, or a family with no
 * types at all all reached the engine and the panel unchecked.
 *
 * Schema v2 is the "validated + normalised" schema. The v1 → v2 rules:
 *   1. `schemaVersion` missing or not a number is a pre-versioning save:
 *      assumed v1 (with a warning), then migrated.
 *   2. A parameter without a `scope` (or with an unknown scope) defaults
 *      to "instance". Instance-scope is the safe default: a type edit
 *      must never silently rewrite an instance's value (Slice 1).
 *   3. A parameter without a `type` is inferred from its default value
 *      (number → "number", string → "text", boolean → "boolean"); when
 *      the default gives no clue the family is unrecoverable and the
 *      migration throws.
 *   4. Type values naming parameters the family does not declare are
 *      stale (a parameter was removed, or the type came from another
 *      family): pruned, with a warning per type.
 *   5. A family with no types gets a "Default" type with empty values —
 *      the panel auto-selects types[0] and a typeless family cannot be
 *      placed or edited there.
 *   6. `builtIn` missing defaults to false.
 *   7. An unknown geometry kind is warned about and left exactly as-is:
 *      the engine returns null for unknown kinds, and the migrator must
 *      not invent geometry.
 * Unrecoverable (the migration throws, the caller decides what to do —
 * the store skips the entry, `create` rejects it): missing/empty `id`
 * or `name`, `parameters` not an array, `geometry` not an object with a
 * string `kind`, duplicate parameter names, duplicate type ids.
 * A family already at v2 that satisfies the rules is returned unchanged
 * (`migratedFrom: null`): migration is idempotent. A family stamped
 * NEWER than v2 is kept as-is with a warning — never downgraded, never
 * silently rewritten.
 *
 * Wiring: `FamilyStore` migrates on load (localStorage restore),
 * `create`, `update` and `duplicate`, so everything the store holds is
 * current-schema. The project-file restore path (Slice 4,
 * `restoreUserFamilies`) is NOT in this branch yet; when it lands it
 * must run each restored definition through this migrator the same way
 * `load()` does here.
 */
import type { FamilyDefinition, FamilyParameter, FamilyType } from "./types";

/** The schema version the current code writes. */
export const CURRENT_FAMILY_SCHEMA_VERSION = 2;

const CLASSIC_GEOMETRY_KINDS = new Set(["box", "cylinder", "extrusion", "composed", "custom"]);
const EXTENDED_GEOMETRY_KINDS = new Set(["sweep", "revolve", "loft", "void", "conditional", "nested", "array"]);
const KNOWN_GEOMETRY_KINDS = new Set([...CLASSIC_GEOMETRY_KINDS, ...EXTENDED_GEOMETRY_KINDS]);

export interface FamilyMigrationResult {
  family: FamilyDefinition;
  /**
   * The version the family came in at, or null when nothing changed
   * (already current, or newer than current and kept as-is).
   */
  migratedFrom: number | null;
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inferTypeFromDefault(def: unknown, paramName: string): FamilyParameter["type"] {
  if (typeof def === "number") return "number";
  if (typeof def === "string") return "text";
  if (typeof def === "boolean") return "boolean";
  throw new Error(
    `family migration: parameter "${paramName}" has no type and its default (${JSON.stringify(def)}) gives no clue`,
  );
}

/**
 * Migrate one stored family definition to the current schema. The input
 * is never mutated; the returned family is a deep clone. Throws on
 * unrecoverable input (see the module header).
 */
export function migrateFamilyDefinition(input: unknown): FamilyMigrationResult {
  const warnings: string[] = [];
  if (!isRecord(input)) throw new Error("family migration: definition is not an object");
  const family = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;

  const id = family.id;
  if (typeof id !== "string" || !id.trim()) throw new Error("family migration: definition has no id");
  const name = family.name;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error(`family migration: family "${String(id)}" has no name`);
  }
  if (!Array.isArray(family.parameters)) {
    throw new Error(`family migration: family "${String(id)}" has no parameters array`);
  }
  if (!isRecord(family.geometry) || typeof family.geometry.kind !== "string") {
    throw new Error(`family migration: family "${String(id)}" has no geometry with a kind`);
  }
  if (family.types !== undefined && !Array.isArray(family.types)) {
    throw new Error(`family migration: family "${String(id)}" has a non-array types field`);
  }

  // Version: missing/non-numeric is a pre-versioning save (assume v1).
  let from: number;
  const rawVersion = family.schemaVersion;
  if (typeof rawVersion === "number" && Number.isFinite(rawVersion)) {
    from = Math.floor(rawVersion);
  } else {
    warnings.push(`family "${String(id)}": no schemaVersion recorded; assuming v1`);
    from = 1;
  }
  if (from > CURRENT_FAMILY_SCHEMA_VERSION) {
    warnings.push(
      `family "${String(id)}": schema version ${from} is newer than this build understands (${CURRENT_FAMILY_SCHEMA_VERSION}); kept as-is`,
    );
    return { family: family as unknown as FamilyDefinition, migratedFrom: null, warnings };
  }

  let changed = from !== CURRENT_FAMILY_SCHEMA_VERSION;

  // Parameters: scope defaults to instance (safe default), type is
  // inferred from the default value when missing.
  const paramNames = new Set<string>();
  const params = family.parameters as Array<Record<string, unknown>>;
  for (const p of params) {
    if (!isRecord(p) || typeof p.name !== "string" || !p.name.trim()) {
      throw new Error(`family migration: family "${String(id)}" has a parameter without a name`);
    }
    if (paramNames.has(p.name)) {
      throw new Error(`family migration: family "${String(id)}" declares parameter "${p.name}" twice`);
    }
    paramNames.add(p.name);
    if (p.scope !== "instance" && p.scope !== "type") {
      warnings.push(`family "${String(id)}": parameter "${p.name}" has no scope; defaulting to "instance"`);
      p.scope = "instance";
      changed = true;
    }
    if (typeof p.type !== "string" || !p.type.trim()) {
      const inferred = inferTypeFromDefault(p.default, p.name);
      warnings.push(`family "${String(id)}": parameter "${p.name}" has no type; inferred "${inferred}" from its default`);
      p.type = inferred;
      changed = true;
    }
  }

  // Types: assign an id when one is missing (the seed catalog's JSON
  // types carry names only), prune values naming undeclared parameters,
  // and ensure ≥ 1 type. A missing type id is recoverable — an id is an
  // internal identifier, and dropping the whole family over it (as an
  // earlier version of this migrator did) silently lost 2 of the 56
  // seed-catalog families in the browser. Duplicate ids still throw:
  // an identity collision is genuinely ambiguous.
  const types = (family.types ?? []) as Array<Record<string, unknown>>;
  // Validate and reserve all persisted IDs first. A generated ID must never
  // collide with an ID already stored on another type in this family.
  const typeIds = new Set<string>();
  for (const t of types) {
    if (!isRecord(t)) {
      throw new Error(`family migration: family "${String(id)}" has a type entry that is not an object`);
    }
    if (typeof t.id === "string" && t.id.trim()) {
      if (typeIds.has(t.id)) {
        throw new Error(`family migration: family "${String(id)}" has two types with id "${t.id}"`);
      }
      typeIds.add(t.id);
    }
  }

  // Canonicalize type values so IDs remain stable when catalog entries are
  // reordered, including same-name types with different parameter values.
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (isRecord(value)) return "{" + Object.keys(value).sort().map(k =>
      JSON.stringify(k) + ":" + canonical(value[k])
    ).join(",") + "}";
    return JSON.stringify(value) ?? "null";
  };
  const occurrences = new Map<string, number>();
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (typeof t.id !== "string" || !t.id.trim()) {
      const rawName = typeof t.name === "string" ? t.name.trim() : "";
      const normalizedName = rawName.toLocaleLowerCase("en-US").replace(/\\s+/g, " ");
      const slug = normalizedName
        .normalize("NFKD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `type-${i + 1}`;
      const fingerprint = `${String(id)}\\0${normalizedName}\\0${canonical(t.values ?? {})}`;
      const occurrence = occurrences.get(fingerprint) ?? 0;
      occurrences.set(fingerprint, occurrence + 1);
      const identity = `${fingerprint}\\0${occurrence}`;
      let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
      for (let c = 0; c < identity.length; c++) {
        const code = identity.charCodeAt(c);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ (code + c), 0x85ebca6b) >>> 0;
      }
      const baseId = `t_${slug}_${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
      let assigned = baseId, collision = 0;
      while (typeIds.has(assigned)) assigned = `${baseId}_${++collision}`;
      warnings.push(`family "${String(id)}": type "${String(t.name ?? i)}" has no id; assigned stable id "${assigned}"`);
      t.id = assigned;
      typeIds.add(assigned);
      changed = true;
    }
    const values: Record<string, unknown> = isRecord(t.values) ? t.values : (t.values = {});
    const stale = Object.keys(values).filter((k) => !paramNames.has(k));
    if (stale.length) {
      warnings.push(
        `family "${String(id)}": type "${String(t.name ?? t.id)}" drops stale values for undeclared parameters: ${stale.join(", ")}`,
      );
      for (const k of stale) delete values[k];
      changed = true;
    }
  }
  if (!types.length) {
    warnings.push(`family "${String(id)}": no types; adding a "Default" type`);
    types.push({ id: `t_${String(id)}-default`, name: "Default", values: {} });
    changed = true;
  }
  family.types = types as unknown as FamilyType[];

  // builtIn missing defaults to false (user family).
  if (typeof family.builtIn !== "boolean") {
    family.builtIn = false;
    changed = true;
  }

  // Unknown geometry kind: warn, leave exactly as-is.
  const kind = (family.geometry as Record<string, unknown>).kind as string;
  if (!KNOWN_GEOMETRY_KINDS.has(kind)) {
    warnings.push(`family "${String(id)}": unknown geometry kind "${kind}"; kept as-is (the engine cannot build it)`);
    changed = true;
  }

  family.schemaVersion = CURRENT_FAMILY_SCHEMA_VERSION;
  return {
    family: family as unknown as FamilyDefinition,
    migratedFrom: changed ? from : null,
    warnings,
  };
}
