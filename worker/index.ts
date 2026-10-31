/**
 * Open BIM Studio edge worker.
 *
 * Serves the built SPA (dist/) through Cloudflare Static Assets and exposes
 * a tiny cumulative visit counter used by the Project Center status bar.
 *
 * API:
 *   POST /api/visits  -> increments the counter, returns the new total
 *   GET  /api/visits  -> reads the total without counting
 *
 * Storage is a SQLite-backed Durable Object (works on the Workers free
 * plan): the DO namespace is created automatically by `wrangler deploy`,
 * so no KV namespace or extra token permissions are needed.
 */

/** Minimal structural types — keeps the worker dependency-free. */
interface VisitStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

interface CounterStub {
  fetch(request: Request): Promise<Response>;
}

interface CounterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): CounterStub;
}

interface Env {
  /** Static Assets binding (wrangler.jsonc → assets.binding). */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** Durable Object namespace holding the cumulative visit count. */
  COUNTER: CounterNamespace;
}

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}

/** The single global DO instance persists the cumulative visit count. */
export class VisitCounter {
  private readonly storage: VisitStorage;

  constructor(state: { storage: VisitStorage }) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const current = (await this.storage.get<number>("visits")) ?? 0;
    const total = request.method === "POST" ? current + 1 : current;
    if (request.method === "POST") await this.storage.put("visits", total);
    return json({ visits: total });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/visits") {
      try {
        const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
        return stub.fetch(request);
      } catch (cause) {
        console.warn("[visits] counter unavailable:", cause);
        return json({ visits: null }, 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
