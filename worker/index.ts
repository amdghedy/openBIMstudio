/**
 * Open BIM Studio edge worker.
 *
 * Serves the built SPA (dist/) through Cloudflare Static Assets and exposes
 * an accurate, global visit counter used by the Project Center status bar.
 *
 * API:
 *   POST /api/visits -> counts one visit per visitor session, returns stats
 *   GET  /api/visits -> reads the current stats without counting
 *
 * Accuracy model (all counting happens server-side on Cloudflare's edge):
 *   - The visitor is identified by a salted SHA-256 of
 *     CF-Connecting-IP + User-Agent (no raw IPs or fingerprints stored).
 *   - A visitor counts as ONE visit per 30-minute session window, so
 *     refreshing or reopening tabs never inflates the counter, while a
 *     different person, device, browser or network counts separately.
 *   - `visits`  = cumulative visitor sessions (shown in the status bar)
 *     `loads`   = raw page loads (diagnostics only)
 *     `uniques` = all-time distinct visitors
 *
 * Storage is a SQLite-backed Durable Object (works on the Workers free
 * plan): the DO namespace is created automatically by `wrangler deploy`,
 * so no KV namespace or extra token permissions are needed. All requests
 * funnel through the single "global" DO instance, whose storage is
 * serialized, giving race-free global counting.
 */

/** Session window: repeat hits from the same visitor within this period are free. */
const SESSION_WINDOW_MS = 30 * 60 * 1000;
/** How often the alarm sweeper purges expired session markers. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Storage keys (v2 = accurate dedup model; v1 kept the raw refresh-inflated count). */
const KEY_VISITS = "visits:v2";
const KEY_LOADS = "loads:v2";
const KEY_UNIQUES = "uniques:v2";
const KEY_SALT = "salt:v2";

/** Minimal structural types — keeps the worker dependency-free. */
interface VisitStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
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
  /** Durable Object namespace holding the visit counters. */
  COUNTER: CounterNamespace;
}

const NO_STORE = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}

/** Salted SHA-256 hex digest of the visitor's IP + User-Agent. */
async function visitorHash(salt: string, ip: string, userAgent: string): Promise<string> {
  const payload = new TextEncoder().encode(`${salt}|${ip}|${userAgent}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** The single global DO instance persists the visit counters. */
export class VisitCounter {
  private readonly storage: VisitStorage;

  constructor(state: { storage: VisitStorage }) {
    this.storage = state.storage;
  }

  /** Periodically drop expired session markers so storage stays tiny. */
  async alarm(): Promise<void> {
    const now = Date.now();
    const markers = await this.storage.list({ prefix: "r:" });
    for (const [key, value] of markers) {
      if (typeof value !== "number" || now - value > SESSION_WINDOW_MS) await this.storage.delete(key);
    }
    await this.storage.setAlarm(now + SWEEP_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    try {
      if (request.method === "GET") return json(await this.stats());

      const [salt, stats] = await Promise.all([this.salt(), this.stats()]);
      const now = Date.now();
      const ip = request.headers.get("cf-connecting-ip") ?? "";
      const hash = await visitorHash(salt, ip, request.headers.get("user-agent") ?? "");
      const markerKey = `r:${hash}`;
      const lastSeen = await this.storage.get<number>(markerKey);
      const isNewVisit = typeof lastSeen !== "number" || now - lastSeen > SESSION_WINDOW_MS;
      const isNewVisitor = isNewVisit && !(await this.storage.get(`u:${hash}`));

      stats.loads += 1;
      if (isNewVisit) stats.visits += 1;
      if (isNewVisitor) stats.uniques += 1;

      const writes: Promise<void>[] = [
        this.storage.put(markerKey, now),
        this.storage.put(KEY_LOADS, stats.loads),
      ];
      if (isNewVisit) writes.push(this.storage.put(KEY_VISITS, stats.visits));
      if (isNewVisitor) writes.push(this.storage.put(KEY_UNIQUES, stats.uniques), this.storage.put(`u:${hash}`, 1));
      await Promise.all(writes);

      // One hour after the first hit, start (or keep) the session sweeper.
      if (!(await this.storage.getAlarm())) await this.storage.setAlarm(now + SWEEP_INTERVAL_MS);
      return json(stats);
    } catch (cause) {
      console.warn("[visits] count failed:", cause);
      return json({ visits: null, loads: null, uniques: null }, 503);
    }
  }

  private async stats(): Promise<{ visits: number; loads: number; uniques: number }> {
    const [visits, loads, uniques] = await Promise.all([
      this.storage.get<number>(KEY_VISITS),
      this.storage.get<number>(KEY_LOADS),
      this.storage.get<number>(KEY_UNIQUES),
    ]);
    return {
      visits: typeof visits === "number" ? visits : 0,
      loads: typeof loads === "number" ? loads : 0,
      uniques: typeof uniques === "number" ? uniques : 0,
    };
  }

  /** Random per-deployment salt so stored hashes can never be reversed to IPs. */
  private async salt(): Promise<string> {
    const existing = await this.storage.get<string>(KEY_SALT);
    if (existing) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    await this.storage.put(KEY_SALT, hex);
    return hex;
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
        return json({ visits: null, loads: null, uniques: null }, 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
