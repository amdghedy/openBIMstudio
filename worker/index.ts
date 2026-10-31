/**
 * Open BIM Studio edge worker.
 *
 * Serves the built SPA (dist/) through Cloudflare Static Assets and exposes
 * a tiny global visit counter used by the Project Center status bar.
 *
 * API:
 *   POST /api/visits  -> increments the cumulative counter, returns the total
 *   GET  /api/visits  -> reads the total without counting
 *
 * Storage is Cloudflare KV (binding VISITS). If the binding is missing or
 * errors, the endpoint degrades gracefully and the UI hides the counter.
 */

/** Minimal structural types — keeps the worker dependency-free. */
interface VisitKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface Env {
  /** Static Assets binding (wrangler.jsonc → assets.binding). */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** KV namespace backing the cumulative visit counter. */
  VISITS?: VisitKV;
}

const VISIT_KEY = "visits";
const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}

async function readTotal(kv: VisitKV): Promise<number> {
  const raw = await kv.get(VISIT_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function handleVisits(request: Request, env: Env): Promise<Response> {
  const kv = env.VISITS;
  if (!kv) return json({ visits: null, configured: false }, 503);
  try {
    if (request.method === "POST") {
      // KV is eventually consistent; for this low-traffic counter a
      // read-modify-write keeps the implementation dependency-free.
      const total = (await readTotal(kv)) + 1;
      await kv.put(VISIT_KEY, String(total));
      return json({ visits: total });
    }
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    return json({ visits: await readTotal(kv) });
  } catch (cause) {
    console.warn("[visits] counter unavailable:", cause);
    return json({ visits: null }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/visits") return handleVisits(request, env);
    return env.ASSETS.fetch(request);
  },
};
