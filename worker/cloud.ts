/**
 * Account + cloud-project HTTP API for the edge worker.
 *
 *   GET    /api/auth/config            which sign-in providers are configured
 *   POST   /api/auth/login             { provider, credential } -> session cookie
 *   GET    /api/auth/me                current account or { user: null }
 *   POST   /api/auth/logout            clears the cookie
 *   GET    /api/cloud/projects         list the signed-in user's projects
 *   PUT    /api/cloud/projects/:id     upload (?name=…&baseUpdatedAt=…) body = project file
 *   GET    /api/cloud/projects/:id     download
 *   DELETE /api/cloud/projects/:id
 *
 * Storage is an R2 bucket bound as env.PROJECTS. Without it the project routes
 * answer 501 with a clear message; nothing is stored anywhere else.
 * Every user's objects live under `u/{userKey}/` so one account can never
 * address another's files.
 */
import {
  providerConfig, readCookie, signSession, userKey, verifyIdToken, verifySession,
  type JwksFetcher, type ProviderId, type SessionPayload,
} from "./auth";

export interface R2ObjectLike {
  key: string; size: number; uploaded: Date;
  customMetadata?: Record<string, string>;
  body?: ReadableStream | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}
export interface R2BucketLike {
  put(key: string, value: ArrayBuffer | ReadableStream | string, opts?: { customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<(R2ObjectLike & { body: ReadableStream }) | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; limit?: number; cursor?: string; include?: string[] }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}
export interface CloudEnv {
  PROJECTS?: R2BucketLike;
  SESSION_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  MICROSOFT_CLIENT_ID?: string;
}
export interface CloudDeps { fetchJwks?: JwksFetcher; now?: () => number }

export const COOKIE = "obs_session";
export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export const MAX_PROJECTS_PER_USER = 200;
export const SESSION_DAYS = 30;
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const defaultJwks: JwksFetcher = async (url) => {
  const r = await fetch(url, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!r.ok) throw new Error(`jwks ${r.status}`);
  return r.json() as Promise<{ keys: any[] }>;
};

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

function secureCookie(url: URL) { return url.protocol === "https:" ? "; Secure" : ""; }
const sessionCookie = (value: string, maxAge: number, url: URL) =>
  `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureCookie(url)}`;

/** State-changing requests must come from this origin and carry the custom header. */
function csrfOk(req: Request, url: URL): boolean {
  if (req.headers.get("x-obs-csrf") !== "1") return false;
  const origin = req.headers.get("origin");
  return !origin || origin === url.origin;
}

/** Returns a Response when the path belongs to the account API, otherwise null. */
export async function handleCloud(req: Request, env: CloudEnv, deps: CloudDeps = {}): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/auth/") && !url.pathname.startsWith("/api/cloud/")) return null;
  const nowS = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  const secretOk = !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 24;

  if (url.pathname === "/api/auth/config" && req.method === "GET") {
    return json({
      google: env.GOOGLE_CLIENT_ID && secretOk ? { clientId: env.GOOGLE_CLIENT_ID } : null,
      microsoft: env.MICROSOFT_CLIENT_ID && secretOk ? { clientId: env.MICROSOFT_CLIENT_ID } : null,
      storage: !!env.PROJECTS,
    });
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    if (!csrfOk(req, url)) return json({ error: "forbidden" }, 403);
    if (!secretOk) return json({ error: "Sign-in is not configured on this server (SESSION_SECRET missing)." }, 501);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "bad request" }, 400); }
    const provider = body?.provider as ProviderId;
    const clientId = provider === "google" ? env.GOOGLE_CLIENT_ID : provider === "microsoft" ? env.MICROSOFT_CLIENT_ID : undefined;
    if (!clientId) return json({ error: "That sign-in provider is not configured." }, 400);
    const res = await verifyIdToken(String(body?.credential ?? ""), providerConfig(provider, clientId), deps.fetchJwks ?? defaultJwks, {
      nowSeconds: nowS, ...(typeof body?.nonce === "string" ? { nonce: body.nonce } : {}),
    });
    if (!res.ok) return json({ error: `Sign-in rejected: ${res.reason}` }, 401);
    const id = res.identity;
    const payload: SessionPayload = {
      uid: await userKey(id.provider, id.subject), provider: id.provider, exp: nowS + SESSION_DAYS * 86400,
      ...(id.name ? { name: id.name } : {}), ...(id.email ? { email: id.email } : {}), ...(id.picture ? { picture: id.picture } : {}),
    };
    const value = await signSession(payload, env.SESSION_SECRET!);
    return json({ user: publicUser(payload) }, 200, { "set-cookie": sessionCookie(value, SESSION_DAYS * 86400, url) });
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    if (!csrfOk(req, url)) return json({ error: "forbidden" }, 403);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0, url) });
  }

  const session = secretOk ? await verifySession(readCookie(req.headers.get("cookie"), COOKIE), env.SESSION_SECRET!, nowS) : null;

  if (url.pathname === "/api/auth/me" && req.method === "GET") return json({ user: session ? publicUser(session) : null });

  if (url.pathname === "/api/cloud/projects" || url.pathname.startsWith("/api/cloud/projects/")) {
    if (!session) return json({ error: "Sign in first." }, 401);
    if (!env.PROJECTS) return json({ error: "Cloud storage is not enabled on this server (no R2 bucket bound as PROJECTS). See docs/ACCOUNTS.md." }, 501);
    const bucket = env.PROJECTS;
    const prefix = `u/${session.uid}/`;

    if (url.pathname === "/api/cloud/projects" && req.method === "GET") {
      const items: { id: string; name: string; size: number; updatedAt: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, limit: 500, cursor, include: ["customMetadata"] });
        for (const o of page.objects) {
          items.push({ id: o.key.slice(prefix.length), name: o.customMetadata?.name ?? o.key.slice(prefix.length), size: o.size, updatedAt: o.customMetadata?.updatedAt ?? o.uploaded.toISOString() });
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor && items.length < 1000);
      items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return json({ projects: items });
    }

    const id = decodeURIComponent(url.pathname.slice("/api/cloud/projects/".length));
    if (!PROJECT_ID_RE.test(id)) return json({ error: "bad project id" }, 400);
    const key = prefix + id;

    if (req.method === "GET") {
      const obj = await bucket.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      return new Response(obj.body, { headers: {
        "content-type": "application/octet-stream", "cache-control": "no-store",
        "x-obs-name": encodeURIComponent(obj.customMetadata?.name ?? id),
        "x-obs-updated-at": obj.customMetadata?.updatedAt ?? obj.uploaded.toISOString(),
      } });
    }
    if (req.method === "PUT") {
      if (!csrfOk(req, url)) return json({ error: "forbidden" }, 403);
      const len = Number(req.headers.get("content-length") ?? "");
      if (Number.isFinite(len) && len > MAX_PROJECT_BYTES) return json({ error: `Project is larger than ${MAX_PROJECT_BYTES / 1048576} MB.` }, 413);
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
      if (buf.byteLength > MAX_PROJECT_BYTES) return json({ error: `Project is larger than ${MAX_PROJECT_BYTES / 1048576} MB.` }, 413);
      const existing = await bucket.head(key);
      const base = url.searchParams.get("baseUpdatedAt");
      if (existing && base !== null && (existing.customMetadata?.updatedAt ?? existing.uploaded.toISOString()) !== base) {
        return json({ error: "This project was changed on another device. Reload it before saving.", conflict: true }, 409);
      }
      if (!existing) {
        const page = await bucket.list({ prefix, limit: MAX_PROJECTS_PER_USER + 1 });
        if (page.objects.length >= MAX_PROJECTS_PER_USER) return json({ error: `Limit of ${MAX_PROJECTS_PER_USER} cloud projects reached. Delete one first.` }, 409);
      }
      const name = (url.searchParams.get("name") ?? "Untitled").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 120) || "Untitled";
      const updatedAt = new Date((deps.now ? deps.now() : Date.now())).toISOString();
      await bucket.put(key, buf, { customMetadata: { name, updatedAt } });
      return json({ id, name, size: buf.byteLength, updatedAt });
    }
    if (req.method === "DELETE") {
      if (!csrfOk(req, url)) return json({ error: "forbidden" }, 403);
      await bucket.delete(key);
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

function publicUser(p: SessionPayload) {
  return { provider: p.provider, name: p.name ?? null, email: p.email ?? null, picture: p.picture ?? null };
}
