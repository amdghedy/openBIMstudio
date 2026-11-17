import { z } from "zod";

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: LoadError };
export type LoadError = { stage: "size" | "parse" | "schema"; file: string; issues: string[] };
export const DEFAULT_MAX_JSON_BYTES = 8 * 1024 * 1024;

export function safeLoad<T>(file: string, raw: string,
  schema: z.ZodType<T>, maxBytes = DEFAULT_MAX_JSON_BYTES): LoadResult<T> {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    return { ok: false, error: { stage: "size", file, issues: [`JSON input exceeds the ${maxBytes}-byte limit.`] } };
  }
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) {
    return { ok: false, error: { stage: "parse", file, issues: [e instanceof Error ? e.message : "Invalid JSON."] } };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: { stage: "schema", file,
    issues: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "<root>"}: ${i.message}`) } };
  return { ok: true, value: parsed.data };
}

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
