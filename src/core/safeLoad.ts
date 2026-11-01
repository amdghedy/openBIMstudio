import { z } from 'zod';

export type LoadResult<T> = { ok: true; value: T } | { ok: false; error: LoadError };
export type LoadError = { stage: 'parse' | 'schema'; file: string; issues: string[] };

export function safeLoad<T>(file: string, raw: string,
  schema: z.ZodType<T>): LoadResult<T> {
  let json: unknown;
  try { json = JSON.parse(raw); }
  catch (e) { return { ok: false, error: { stage: 'parse', file, issues: [String(e)] } }; }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: { stage: 'schema', file,
    issues: parsed.error.issues.map((i) => i.path.join('.') + ': ' + i.message) } };
  return { ok: true, value: parsed.data };
}

export const ProjectFileSchema = z.object({
  formatVersion: z.number().int().min(1),
  elements: z.array(z.object({ id: z.string(), type: z.string(),
    props: z.record(z.unknown()) })),
});

export const BcfManifestSchema = z.object({
  bcf_version: z.literal('2.1'),
  topics: z.array(z.object({ guid: z.string(),
    title: z.string().min(1) })).default([]),
});

export const PluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string(),
  capabilities: z.array(z.enum(['read-model', 'write-model', 'export', 'network'])),
});
