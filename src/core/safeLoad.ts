import { z } from "zod";

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: LoadError };
export type LoadError = { stage: "size" | "parse" | "schema" | "complexity"; file: string; issues: string[] };
export const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;

export interface SafeLoadLimits {
  maxDepth?: number;
  maxNodes?: number;
}

export function safeLoad<T>(file: string, raw: string,
  schema: z.ZodType<T>, maxBytes = DEFAULT_MAX_JSON_BYTES,
  limits: SafeLoadLimits = {}): LoadResult<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return { ok: false, error: { stage: "size", file, issues: ["Invalid JSON byte limit configuration."] } };
  }
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, error: { stage: "size", file, issues: [`JSON input exceeds the ${maxBytes}-byte limit.`] } };
  }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) {
    return { ok: false, error: { stage: "parse", file, issues: [e instanceof Error ? e.message : "Invalid JSON."] } };
  }

  // Iterative traversal avoids recursive stack growth on hostile nested JSON.
  const maxDepth = limits.maxDepth ?? 64;
  const maxNodes = limits.maxNodes ?? 250_000;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 ||
      !Number.isSafeInteger(maxNodes) || maxNodes < 1) {
    return { ok: false, error: { stage: "complexity", file, issues: ["Invalid JSON complexity limit configuration."] } };
  }
  const pending: Array<{ value: unknown; depth: number }> = [{ value: json, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++visited > maxNodes) {
      return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
    }
    if (current.depth > maxDepth) {
      return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxDepth}-level nesting limit.`] } };
    }
    if (Array.isArray(current.value)) {
      if (pending.length + visited + current.value.length > maxNodes) {
        return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
      }
      for (const child of current.value) pending.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      const record = current.value as Record<string, unknown>;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        if (pending.length + visited >= maxNodes) {
          return { ok: false, error: { stage: "complexity", file, issues: [`JSON input exceeds the ${maxNodes}-node complexity limit.`] } };
        }
        pending.push({ value: record[key], depth: current.depth + 1 });
      }
    }
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: { stage: "schema", file,
    issues: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`) } };
  return { ok: true, value: stripProtoKeys(parsed.data) };
}

/**
 * Defense in depth against prototype pollution (issue #90): no safeLoad
 * schema declares a `__proto__` field, so a `__proto__` own-key in a file
 * can never be legitimate data — but several schemas are deliberately
 * permissive (`.passthrough()`, `z.record`, `z.unknown()` elements), so one
 * would survive into the returned value. A consumer that later does
 * `Object.assign(target, value)` or a deep merge would then mutate the
 * target's prototype. Strip every `__proto__` own-key at any depth before
 * the value leaves safeLoad. `constructor` / `prototype` keys are left
 * alone: assigning them as own properties is inert, and no consumer in this
 * tree deep-merges untrusted data (verified: the only deep merge,
 * `i18n.deepMerge`, runs over shipped locale catalogues, never file data).
 * Iterative walk; the visited set guards against a cycle if a schema ever
 * returns a cyclic value.
 */
export function stripProtoKeys<T>(value: T): T {
  const seen = new Set<object>();
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "__proto__")) {
      delete record["__proto__"];
    }
    for (const key of Object.keys(record)) pending.push(record[key]);
  }
  return value;
}

export const LegacyProjectJsonSchema = z.object({
  id: z.string().trim().min(1),
  elements: z.array(z.unknown()).max(250_000),
}).passthrough();

export const ClashScenarioImportSchema = z.union([
  z.array(z.unknown()).max(200),
  z.object({ scenarios: z.array(z.unknown()).max(200) }).passthrough(),
]);

export const ProjectFileSchema = z.object({
  format: z.literal("obsproj"),
  version: z.number().int().min(1),
  savedAt: z.number().finite().default(0),
  app: z.string().min(1).default("Open BIM Studio"),
  doc: z.record(z.string(), z.unknown()),
  blobs: z.array(z.object({
    modelId: z.string().min(1),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    type: z.string(),
  })),
});

export const BcfManifestSchema = z.object({
  bcf_version: z.string().min(1),
  topics: z.array(z.object({ guid: z.string().min(1),
    title: z.string().min(1) })).default([]),
});

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  sdkVersion: z.number().int().positive(),
  capabilities: z.array(z.string().min(1)),
  integrity: z.string().optional(),
});

export const SavedViewsSchema = z.array(z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
  pos: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  target: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  projection: z.enum(["perspective", "orthographic"]),
  orthoZoom: z.number().finite().positive().optional(),
  createdAt: z.number().finite().nonnegative(),
})).max(64);

/**
 * Markups sidecar (`.markups.json`, written by the drawing editor's Save and
 * read back by its Load). Mirrors the `Markup` interface in
 * `src/features/cad-viewer.ts`: `kind` is the closed set the renderer
 * switches on, `pts` are finite drawing-plane coordinates, `text` is the
 * optional annotation. Unknown keys are stripped by zod's default object
 * behaviour, so a file carrying extra fields cannot smuggle state into the
 * editor. `version` is the writer's envelope version (1 today); it is
 * type-checked but not otherwise interpreted, as the legacy loader ignored it.
 */
export const MarkupsFileSchema = z.object({
  version: z.number().int().min(1).optional(),
  markups: z.array(z.object({
    kind: z.enum(["line", "note", "dim", "cloud", "stamp", "leader", "dimang", "dimarc", "dimdia", "dimrad", "dimcenter"]),
    pts: z.array(z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    })).max(10_000),
    text: z.string().max(10_000).optional(),
  })).max(10_000),
});

/**
 * GeoJSON envelope: deliberately permissive — the gis-core walker validates
 * geometry types, coerces coordinates to finite numbers and skips the rest.
 * The schema's job is only to prove the root is a GeoJSON-shaped object; the
 * size / depth / node bounds come from the safeLoad call site
 * (20 MB, depth 32, 2,000,000 nodes in parseGeoJson).
 */
export const GeoJsonSchema = z.object({
  type: z.string().min(1),
}).passthrough();
