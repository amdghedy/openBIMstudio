import { handleFetchSheet, parseAllowedHosts } from "./fetch-sheet";
import { handleLinkedInRequest, LinkedInVault, type LinkedInEnv } from "./linkedin";
import { AuthVault, googleStartUrl, googleCallback, googleSetupPage, googleStatus, googlePopupCallbackPage, sendResetEmail, newOauthNonce, oauthNonceCookie, clearOauthNonceCookie, oauthStateValid, parseOauthState } from "./auth";

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

/** X-3 rate limits for the counter. Without one, a single client could
 *  POST in a loop and inflate `loads` without bound (and, by rotating
 *  the spoofable x-obs-visitor-ip header, `visits`/`uniques` too).
 *  Per-visitor: one counted POST per 10 s per visitor hash. Global:
 *  600 POSTs/min across the DO — far above this deployment's real
 *  traffic, low enough to bound a flood. */
const RATE_LIMIT_PER_VISITOR_MS = 10 * 1000;
const RATE_LIMIT_GLOBAL_PER_MIN = 600;

/** True when the value parses as an IP literal (v4 dotted quad or v6). */
function isIpLiteral(v: string): boolean {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(v) || (v.includes(":") && /^[0-9a-fA-F:]+$/.test(v));
}
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

interface Env extends LinkedInEnv {
  /** "1" switches on POST /api/fetch-sheet. Unset means the route is 404. */
  FETCH_SHEET_ENABLED?: string;
  /** Comma list of exact host names the link fetch may reach. Empty keeps it off. */
  FETCH_SHEET_ALLOWED_HOSTS?: string;
  /** Static Assets binding (wrangler.jsonc → assets.binding). */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** Durable Object namespace holding the visit counters. */
  COUNTER: CounterNamespace;
  /** Durable Object namespace holding accounts + cloud projects. */
  AUTH: CounterNamespace;
  /** Google OAuth credentials (Worker secrets — optional). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Transactional email for password resets (Worker secret — optional). When
   *  absent, the forgot-password flow returns the one-time code to the UI. */
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
}

/**
 * X-3: the `*` CORS grant belongs ONLY to the public visit counter —
 * any deployment origin (Cloudflare, Vercel, Netlify, …) reads and
 * feeds this one global counter from the browser. Auth / project /
 * user routes are same-origin cookie sessions (the UI fetches them
 * with credentials: "same-origin") and must never carry an ACAO
 * grant: a cross-origin caller gets nothing credentialed from them,
 * and the grant would mislabel a credentialed API as public.
 */
const PUBLIC_JSON = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
} as const;
/** Same-origin JSON: no ACAO header — same-origin fetches need none. */
const PRIVATE_JSON = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const CORS_PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-max-age": "86400",
} as const;

/** Same-origin JSON response (auth errors, vault errors). No CORS grant. */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: PRIVATE_JSON });
}

/** Public-counter JSON response (visits errors): the one place `*` is served. */
function jsonPublic(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...PUBLIC_JSON, ...extraHeaders } });
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
    // X-3: rate-limit markers are short-lived — drop them once stale so
    // the limiter's keys cannot grow without bound.
    const rl = await this.storage.list({ prefix: "rl:" });
    for (const [key, value] of rl) {
      if (typeof value !== "number" || now - value > RATE_LIMIT_PER_VISITOR_MS) await this.storage.delete(key);
    }
    const minute = Math.floor(now / 60_000);
    const global = await this.storage.list({ prefix: "rlg:" });
    for (const [key] of global) {
      const m = Number(key.slice("rlg:".length));
      if (!Number.isFinite(m) || m < minute) await this.storage.delete(key);
    }
    await this.storage.setAlarm(now + SWEEP_INTERVAL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonPublic({ error: "method not allowed" }, 405);
    }
    try {
      if (request.method === "GET") return jsonPublic(await this.stats());

      const [salt, stats] = await Promise.all([this.salt(), this.stats()]);
      const now = Date.now();
      // Identity IP: direct visitors arrive via Cloudflare (cf-connecting-ip);
      // Vercel proxy visitors arrive with the real client IP forwarded in
      // x-obs-visitor-ip (Cloudflare replaces cf-connecting-ip with the
      // proxy's egress IP, which is identical for every Vercel visitor).
      // X-3: the forwarded header is trusted only as an IP literal — any
      // direct caller can send it, so a non-IP value falls back to
      // cf-connecting-ip (garbage can no longer mint a fresh visitor
      // identity). A well-formed IP still can — the global rate limit
      // below bounds that flood.
      const forwardedIp = (request.headers.get("x-obs-visitor-ip") ?? "").trim();
      const ip = forwardedIp && isIpLiteral(forwardedIp)
        ? forwardedIp
        : (request.headers.get("cf-connecting-ip") ?? "");
      const hash = await visitorHash(salt, ip, request.headers.get("user-agent") ?? "");
      // X-3: rate-limit before counting anything. A 429 here costs no
      // writes and counts nothing.
      const rateKey = `rl:${hash}`;
      const lastPost = await this.storage.get<number>(rateKey);
      if (typeof lastPost === "number" && now - lastPost < RATE_LIMIT_PER_VISITOR_MS) {
        return jsonPublic({ error: "Too many visit counts — try again shortly." }, 429, { "retry-after": "10" });
      }
      const minute = Math.floor(now / 60_000);
      const globalKey = `rlg:${minute}`;
      const globalCount = (await this.storage.get<number>(globalKey)) ?? 0;
      if (globalCount >= RATE_LIMIT_GLOBAL_PER_MIN) {
        return jsonPublic({ error: "Visit counter is busy — try again shortly." }, 429, { "retry-after": "60" });
      }
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
        // X-3: record the counted POST for both limiters.
        this.storage.put(rateKey, now),
        this.storage.put(globalKey, globalCount + 1),
      ];
      if (isNewVisit) writes.push(this.storage.put(KEY_VISITS, stats.visits));
      if (isNewVisitor) writes.push(this.storage.put(KEY_UNIQUES, stats.uniques), this.storage.put(`u:${hash}`, 1));
      await Promise.all(writes);

      // One hour after the first hit, start (or keep) the session sweeper.
      if (!(await this.storage.getAlarm())) await this.storage.setAlarm(now + SWEEP_INTERVAL_MS);
      return jsonPublic(stats);
    } catch (cause) {
      console.warn("[visits] count failed:", cause);
      return jsonPublic({ visits: null, loads: null, uniques: null }, 503);
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

export { LinkedInVault, AuthVault };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const linkedInResponse = await handleLinkedInRequest(request, env);
    if (linkedInResponse) return linkedInResponse;
    const url = new URL(request.url);
    // Draft cut-sheet link fetch. Answers 404 unless FETCH_SHEET_ENABLED is "1" and FETCH_SHEET_ALLOWED_HOSTS is set.
    const sheetResponse = await handleFetchSheet(request, {
      enabled: env.FETCH_SHEET_ENABLED === "1",
      allowedHosts: parseAllowedHosts(env.FETCH_SHEET_ALLOWED_HOSTS),
      admit: async (req) => {
        try {
          const stub = env.AUTH.get(env.AUTH.idFromName("global"));
          const r = await stub.fetch(new Request("https://do/api/auth/fetch-slot", { method: "POST", headers: { cookie: req.headers.get("cookie") || "" } }));
          return r.status === 200 ? "ok" : r.status === 429 ? "limited" : "signin";
        } catch { return "signin"; }
      },
    });
    if (sheetResponse) return sheetResponse;
    if (url.pathname === "/api/visits") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_PREFLIGHT });
      try {
        const stub = env.COUNTER.get(env.COUNTER.idFromName("global"));
        return stub.fetch(request);
      } catch (cause) {
        console.warn("[visits] counter unavailable:", cause);
        return jsonPublic({ visits: null, loads: null, uniques: null }, 503);
      }
    }
    // ── Cloud accounts + per-user project storage (same-origin, cookie sessions).
    if (url.pathname === "/api/auth/google/status") {
      return googleStatus(env);
    }
    if (url.pathname === "/api/auth/google/start") {
      const nonce = newOauthNonce();
      const start = googleStartUrl(request, env, nonce);
      // Not configured: a styled explanation page instead of raw JSON — this is
      // a top-level browser navigation, the user would otherwise see JSON.
      if (!start) return googleSetupPage(request);
      return new Response(null, { status: 302, headers: { location: start, "set-cookie": oauthNonceCookie(nonce), "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/auth/google/callback") {
      const popup = parseOauthState(new URL(request.url).searchParams.get("state")).popup;
      // CSRF guard: the state nonce must match the cookie set when this sign-in started.
      if (!oauthStateValid(request)) {
        const reason = "Google sign-in could not be verified (state-mismatch). Please start again.";
        const bad = popup ? googlePopupCallbackPage(false, reason) : googleSetupPage(request, { reason, status: 400 });
        bad.headers.append("set-cookie", clearOauthNonceCookie());
        return bad;
      }
      try {
        const info = await googleCallback(request, env);
        const stub = env.AUTH.get(env.AUTH.idFromName("global"));
        const upsert = await stub.fetch(new Request("https://do/api/auth/google-upsert", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: info.email, name: info.name, googleId: info.sub }),
        }));
        const setCookie = upsert.headers.get("set-cookie") ?? "";
        if (!upsert.ok) {
          const reason = "Google sign-in could not create the account (vault unavailable).";
          return popup
            ? googlePopupCallbackPage(false, reason)
            : googleSetupPage(request, { reason, status: 502 });
        }
        // Popup: tell the opener and close. Top-level: land with ?signedin=1 so
        // the app greets the returning user and remembers the account.
        // Cookie MUST be set on the popup HTML response or the opener sees
        // Google success but /api/auth/me stays null ("session did not stick").
        return popup
          ? (setCookie
              ? googlePopupCallbackPage(true, "", setCookie)
              : googlePopupCallbackPage(true))
          : (() => {
              const h = new Headers({ location: "/?signedin=1" });
              h.append("set-cookie", setCookie);
              h.append("set-cookie", clearOauthNonceCookie());
              return new Response(null, { status: 302, headers: h });
            })();
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : "error";
        if (code === "google-not-configured") return popup ? googlePopupCallbackPage(false, "Google sign-in is not configured on this deployment.") : googleSetupPage(request);
        console.warn("[auth] google callback failed:", cause);
        const reason = `Google sign-in failed (${code}). Please try again.`;
        return popup ? googlePopupCallbackPage(false, reason) : googleSetupPage(request, { reason, status: 502 });
      }
    }
    if (url.pathname === "/api/auth/forgot" && request.method === "POST") {
      // Orchestrated here (not the raw DO forward) so the worker can email the
      // reset link when RESEND_API_KEY exists, or return the one-time code to
      // the UI when the deployment has no mail delivery — X-3: the code is
      // never put in a URL (no ?reset= link, nothing in history, referers
      // or server logs); the UI opens the reset form directly with it.
      try {
        const raw = await request.text();
        const stub = env.AUTH.get(env.AUTH.idFromName("global"));
        const doRes = await stub.fetch(new Request("https://do/api/auth/forgot", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        }));
        const body = await doRes.json() as { ok?: boolean; hasAccount?: boolean; token?: string; error?: string } | null;
        if (!doRes.ok || !body?.ok) return json({ error: body?.error || "Could not start the password reset." }, doRes.status);
        if (body.hasAccount && body.token) {
          const email = (((JSON.parse(raw || "{}") as { email?: string }).email ?? "")).trim().toLowerCase();
          const resetUrl = `${url.origin}/?reset=${encodeURIComponent(body.token)}`;
          const mailed = await sendResetEmail(env, email, resetUrl);
          // The emailed link still carries ?reset= — email links cannot
          // avoid it — and the landing strips it from the address bar on
          // arrival (handleAuthUrlParams). The no-mail code never does.
          return json({ ok: true, mailSent: mailed, resetToken: mailed ? undefined : body.token });
        }
        return json({ ok: true, mailSent: false });
      } catch (cause) {
        console.warn("[auth] forgot failed:", cause);
        return json({ error: "Account service unavailable." }, 503);
      }
    }
    if (url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/projects") || url.pathname.startsWith("/api/user/")) {
      // X-3: same-origin cookie sessions never preflight, so this answers
      // 204 with NO CORS headers — a cross-origin preflight fails closed
      // instead of receiving an `*` grant.
      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      try {
        const stub = env.AUTH.get(env.AUTH.idFromName("global"));
        // Forward the original request (cookies intact) with the real pathname.
        return stub.fetch(new Request(`https://do${url.pathname}${url.search}`, request));
      } catch (cause) {
        console.warn("[auth] vault unavailable:", cause);
        return json({ error: "Account service unavailable." }, 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
