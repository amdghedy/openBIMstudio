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
  return { ok: true, value: parsed.data };
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
