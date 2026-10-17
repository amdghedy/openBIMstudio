/**
 * Semantic search over model elements.
 *
 * Element descriptions are embedded into vectors using either:
 *   • Ollama's /api/embeddings           — model nomic-embed-text (default)
 *   • OpenAI-compatible /v1/embeddings   — model text-embedding-3-small
 *
 * Vectors are stored in IndexedDB keyed by `${modelId}:${localId}` and
 * queried by cosine similarity against a natural-language prompt.
 *
 * Indexing is explicit — call buildIndex() from the UI. It is safe to
 * re-run; elements whose text has not changed are skipped.
 */
import { ctx } from "../core/context";
import { pMap } from "../core/p-map";

export type EmbeddingProvider = "ollama" | "openai";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  endpoint: string;
  model: string;
  apiKey?: string;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "ollama",
  endpoint: "http://localhost:11434",
  model: "nomic-embed-text",
};

const CFG_KEY = "obs.ai.embeddings.config";

export function loadEmbeddingConfig(): EmbeddingConfig {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (!raw) return { ...DEFAULT_EMBEDDING_CONFIG };
    const p = JSON.parse(raw);
    return {
      provider: p.provider === "openai" ? "openai" : "ollama",
      endpoint: String(p.endpoint || DEFAULT_EMBEDDING_CONFIG.endpoint),
      model: String(p.model || DEFAULT_EMBEDDING_CONFIG.model),
      apiKey: p.apiKey ? String(p.apiKey) : undefined,
    };
  } catch {
    return { ...DEFAULT_EMBEDDING_CONFIG };
  }
}

export function saveEmbeddingConfig(cfg: EmbeddingConfig): void {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* */
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   IndexedDB
   ═════════════════════════════════════════════════════════════════════════ */
const DB_NAME = "obs-ai-embeddings";
const DB_VERSION = 1;
const STORE = "vectors";

interface StoredVector {
  key: string;
  modelId: string;
  localId: number;
  text: string;
  hash: string;
  vector: Float32Array;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: "key" });
          s.createIndex("modelId", "modelId", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function reqAs<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function getStoredForModel(modelId: string): Promise<Map<string, StoredVector>> {
  const db = await openDb();
  const t = db.transaction(STORE, "readonly");
  const idx = t.objectStore(STORE).index("modelId");
  const recs: StoredVector[] = await reqAs(idx.getAll(modelId));
  const m = new Map<string, StoredVector>();
  for (const r of recs) m.set(r.key, r);
  return m;
}

async function putVectors(rows: StoredVector[]): Promise<void> {
  if (!rows.length) return;
  const db = await openDb();
  const t = db.transaction(STORE, "readwrite");
  const s = t.objectStore(STORE);
  for (const r of rows) s.put(r);
  await new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function clearIndex(modelId?: string): Promise<void> {
  const db = await openDb();
  const t = db.transaction(STORE, "readwrite");
  const store = t.objectStore(STORE);
  if (modelId) {
    const idx = store.index("modelId");
    const keys: IDBValidKey[] = await reqAs(idx.getAllKeys(modelId));
    for (const k of keys) store.delete(k);
  } else {
    await reqAs(store.clear());
  }
  await new Promise<void>((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export interface IndexStats {
  total: number;
  byModel: Record<string, number>;
  updatedAt: number | null;
}

export async function getIndexStats(): Promise<IndexStats> {
  const db = await openDb();
  const t = db.transaction(STORE, "readonly");
  const all: StoredVector[] = await reqAs(t.objectStore(STORE).getAll());
  const byModel: Record<string, number> = {};
  let updatedAt: number | null = null;
  for (const r of all) {
    byModel[r.modelId] = (byModel[r.modelId] ?? 0) + 1;
    if (!updatedAt || r.updatedAt > updatedAt) updatedAt = r.updatedAt;
  }
  return { total: all.length, byModel, updatedAt };
}

/* ═════════════════════════════════════════════════════════════════════════
   Embedding calls
   ═════════════════════════════════════════════════════════════════════════ */
async function embedBatchOllama(
  cfg: EmbeddingConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const url = joinUrl("/ollama", "/api/embeddings");

  // Ollama /api/embeddings is one-prompt-at-a-time. Bounded concurrency (4)
  // turns a large index from minutes into seconds without flooding Ollama.
  return pMap(texts, 4, async (text) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, prompt: text }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama embeddings ${res.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await res.json();
    const arr = json?.embedding;
    if (!Array.isArray(arr)) {
      throw new Error("Ollama embeddings: no vector in response");
    }
    return new Float32Array(arr);
  }, { signal });
}

async function embedBatchOpenAI(
  cfg: EmbeddingConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  const url = joinUrl(cfg.endpoint, "/v1/embeddings");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const CHUNK = 96;
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    chunks.push(texts.slice(i, i + CHUNK));
  }

  const chunkResults = await pMap(chunks, 3, async (batch) => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: batch }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embeddings ${res.status}: ${body.slice(0, 200)}`);
    }
    const json: any = await res.json();
    const data = json?.data;
    if (!Array.isArray(data)) throw new Error("Embeddings: no data array");
    return data.map((d: any) => new Float32Array(d?.embedding ?? []));
  }, { signal });

  const flat: Float32Array[] = [];
  for (const chunk of chunkResults) {
    for (const v of chunk) flat.push(v);
  }
  return flat;
}

async function embedBatch(
  cfg: EmbeddingConfig,
  texts: string[],
  signal?: AbortSignal,
): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (cfg.provider === "ollama") return embedBatchOllama(cfg, texts, signal);
  return embedBatchOpenAI(cfg, texts, signal);
}

export async function embedText(cfg: EmbeddingConfig, text: string): Promise<Float32Array> {
  const [v] = await embedBatch(cfg, [text]);
  return v;
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : "/" + path;
  return b + p;
}

/* ═════════════════════════════════════════════════════════════════════════
   Text extraction
   ═════════════════════════════════════════════════════════════════════════ */
function textFromElement(
  name: string,
  category: string,
  extra: Record<string, string>,
): string {
  const clean = category.replace(/^IFC/i, "");
  const parts = [name, clean];
  for (const v of Object.values(extra)) {
    if (v && v !== name) parts.push(v);
  }
  return parts.join(" · ").slice(0, 400);
}

function hashText(s: string): string {
  // Cheap FNV-1a. Good enough to detect changes.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/* ═════════════════════════════════════════════════════════════════════════
   Build index
   ═════════════════════════════════════════════════════════════════════════ */
export interface BuildProgress {
  phase: "reading" | "embedding" | "storing" | "done";
  current: number;
  total: number;
  skipped: number;
  modelId: string;
}

export interface BuildOptions {
  cfg?: EmbeddingConfig;
  modelIds?: string[];
  maxPerModel?: number;
  batchSize?: number;
  signal?: AbortSignal;
  onProgress?: (p: BuildProgress) => void;
}

const MAX_ELEMENTS_DEFAULT = 5000;
const BATCH_SIZE_DEFAULT = 64;

export async function buildIndex(opts: BuildOptions = {}): Promise<IndexStats> {
  const cfg = opts.cfg ?? loadEmbeddingConfig();
  const max = opts.maxPerModel ?? MAX_ELEMENTS_DEFAULT;
  const batch = opts.batchSize ?? BATCH_SIZE_DEFAULT;
  const modelIds = opts.modelIds ?? Array.from(ctx.fragments.list.keys());
  const onProg = opts.onProgress ?? (() => {});

  for (const modelId of modelIds) {
    const model = ctx.fragments.list.get(modelId);
    if (!model) continue;

    let ids: number[] = [];
    try {
      ids = ((await (model as any).getItemsIdsWithGeometry?.()) as number[]) ?? [];
    } catch {
      continue;
    }
    if (!ids.length) continue;
    if (ids.length > max) ids = ids.slice(0, max);

    const existing = await getStoredForModel(modelId);

    // Read names + attributes in chunks so the worker doesn't choke.
    const CHUNK = 500;
    const items: { id: number; text: string; hash: string }[] = [];

    onProg({ phase: "reading", current: 0, total: ids.length, skipped: 0, modelId });
    for (let i = 0; i < ids.length; i += CHUNK) {
      if (opts.signal?.aborted) break;
      const slice = ids.slice(i, i + CHUNK);
      let data: any[] = [];
      try {
        data = await (model as any).getItemsData(slice, {
          attributesDefault: false,
          attributes: ["Name", "ObjectType", "Tag", "Description", "PredefinedType"],
        });
      } catch {
        continue;
      }
      // Categories — read once per model, mapped later.
      let cats: Record<string, number[]> = {};
      try {
        cats = await (model as any).getItemsOfCategories([/.+/]);
      } catch {
        /* */
      }
      const catMap = new Map<number, string>();
      for (const [c, list] of Object.entries(cats ?? {})) {
        for (const id of (list as number[]) ?? []) catMap.set(id, c);
      }

      for (let j = 0; j < slice.length; j++) {
        const id = slice[j];
        const d = (data as any[])?.[j] ?? {};
        const name = String(
          d?.Name?.value ?? d?.ObjectType?.value ?? d?.Tag?.value ?? `#${id}`,
        );
        const extra: Record<string, string> = {};
        if (d?.ObjectType?.value) extra.objectType = String(d.ObjectType.value);
        if (d?.PredefinedType?.value) extra.predefinedType = String(d.PredefinedType.value);
        if (d?.Description?.value) extra.description = String(d.Description.value);
        const category = catMap.get(id) ?? "Unknown";
        const text = textFromElement(name, category, extra);
        items.push({ id, text, hash: hashText(text) });
      }

      onProg({
        phase: "reading",
        current: i + slice.length,
        total: ids.length,
        skipped: 0,
        modelId,
      });
      await new Promise((r) => setTimeout(r, 0));
    }

    // Which items need to be (re)embedded?
    const toEmbed: typeof items = [];
    for (const it of items) {
      const key = `${modelId}:${it.id}`;
      const prev = existing.get(key);
      if (prev && prev.hash === it.hash) continue;
      toEmbed.push(it);
    }

    const skipCount = items.length - toEmbed.length;
    if (!toEmbed.length) {
      onProg({
        phase: "done",
        current: items.length,
        total: items.length,
        skipped: skipCount,
        modelId,
      });
      continue;
    }

    // Embed in batches and store.
    for (let i = 0; i < toEmbed.length; i += batch) {
      if (opts.signal?.aborted) break;
      const slice = toEmbed.slice(i, i + batch);
      let vectors: Float32Array[] = [];
      try {
        vectors = await embedBatch(cfg, slice.map((s) => s.text), opts.signal);
      } catch (err) {
        console.error("[ai-embeddings] embed batch failed", err);
        throw err;
      }
      const rows: StoredVector[] = slice.map((s, j) => ({
        key: `${modelId}:${s.id}`,
        modelId,
        localId: s.id,
        text: s.text,
        hash: s.hash,
        vector: vectors[j],
        updatedAt: Date.now(),
      }));
      await putVectors(rows);
      onProg({
        phase: "embedding",
        current: i + slice.length,
        total: toEmbed.length,
        skipped: skipCount,
        modelId,
      });
    }
  }

  onProg({ phase: "done", current: 1, total: 1, skipped: 0, modelId: "" });
  return getIndexStats();
}

/* ═════════════════════════════════════════════════════════════════════════
   Query
   ═════════════════════════════════════════════════════════════════════════ */
export interface SemanticHit {
  modelId: string;
  localId: number;
  text: string;
  score: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function semanticSearch(
  query: string,
  limit = 20,
  cfg?: EmbeddingConfig,
): Promise<SemanticHit[]> {
  const conf = cfg ?? loadEmbeddingConfig();
  const qVec = await embedText(conf, query);

  const db = await openDb();
  const t = db.transaction(STORE, "readonly");
  const all: StoredVector[] = await reqAs(t.objectStore(STORE).getAll());
  if (!all.length) return [];

  const scored = all.map((r) => ({
    modelId: r.modelId,
    localId: r.localId,
    text: r.text,
    score: cosine(qVec, r.vector),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}