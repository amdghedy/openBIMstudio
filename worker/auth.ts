/**
 * Cloud accounts + per-user project storage for Open BIM Studio.
 *
 * Everything lives in ONE SQLite-backed Durable Object ("AuthVault", global
 * instance) so the free plan needs no KV, no D1 and no R2 — same pattern as
 * the VisitCounter DO.
 *
 * Storage layout (KV-style keys):
 *   secret:v1                      per-deployment HMAC secret for session tokens
 *   u:<email>                      user record {email,name,salt,hash,provider,googleId,createdAt}
 *   p:<email>:<projectId>          project meta {id,name,updatedAt,size,chunks}
 *   c:<email>:<projectId>:<nnnn>   base64 chunk of the .obsproj project file
 *   t:<email>:<minute>             login rate-limit marker
 *
 * API (all same-origin; cookies are HttpOnly so scripts can never read them):
 *   POST /api/auth/register   {email,password,name}
 *   POST /api/auth/login      {email,password}
 *   GET  /api/auth/me
 *   POST /api/auth/logout
 *   GET  /api/auth/google/start        → 302 Google consent (needs GOOGLE_CLIENT_ID/SECRET)
 *   GET  /api/auth/google/callback     → upsert user, set cookie, 302 /
 *   GET  /api/projects                 → list of the signed-in user's cloud projects
 *   POST /api/projects                 → save {name, data(base64 .obsproj)} (upsert by name)
 *   GET  /api/projects/<id>            → {name, data} project file bytes
 *   DELETE /api/projects/<id>
 *
 * Passwords: PBKDF2-SHA-256, 100 000 iterations, 16-byte random salt — the
 * plain password never leaves the request handler and is never stored.
 * Sessions: HMAC-SHA-256 signed token (email + expiry), 30 days, HttpOnly.
 */

const COOKIE = "obs_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PBKDF2_ITERATIONS = 100_000;
/** base64 chunk size for project blobs — stays far below the 128 KiB DO value cap. */
const CHUNK_B64 = 100_000;
const MAX_PROJECT_B64 = 48 * 1024 * 1024; // ~36 MB raw project file
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_ATTEMPTS = 10;

/** KV-style DO storage (matches the VisitCounter pattern). */
interface AuthStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>>;
}

interface UserRecord {
  email: string;
  name: string;
  salt: string;
  hash: string;
  provider: "password" | "google";
  googleId?: string;
  createdAt: number;
}

interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  size: number;
  chunks: number;
}

interface AuthEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

const enc = new TextEncoder();

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    bin += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64decode(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  return b64decode(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** PBKDF2-SHA-256 → base64 hash. */
async function passwordHash(password: string, saltB64: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64decode(saltB64), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return b64encode(bits);
}

function randomB64(bytes = 16): string {
  return b64encode(crypto.getRandomValues(new Uint8Array(bytes)));
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/** The single global AuthVault DO — owns users, sessions and project blobs. */
export class AuthVault {
  private readonly storage: AuthStorage;
  private secretCache: string | null = null;

  constructor(state: { storage: AuthStorage }) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname; // worker forwards the full pathname
    try {
      if (path === "/api/auth/register" && request.method === "POST") return this.register(request);
      if (path === "/api/auth/login" && request.method === "POST") return this.login(request);
      if (path === "/api/auth/me" && request.method === "GET") return this.me(request);
      if (path === "/api/auth/logout" && request.method === "POST") return json({ ok: true }, 200, { "set-cookie": clearCookie() });
      if (path === "/api/auth/google-upsert" && request.method === "POST") return this.googleUpsert(request);
      if (path === "/api/projects" && request.method === "GET") return this.listProjects(request);
      if (path === "/api/projects" && request.method === "POST") return this.saveProject(request);
      if (path.startsWith("/api/projects/") && request.method === "GET") return this.loadProject(request, decodeURIComponent(path.slice("/api/projects/".length)));
      if (path.startsWith("/api/projects/") && request.method === "DELETE") return this.deleteProject(request, decodeURIComponent(path.slice("/api/projects/".length)));
      return json({ error: "not found" }, 404);
    } catch (cause) {
      console.warn("[auth] request failed:", cause);
      return json({ error: "internal error" }, 500);
    }
  }

  // ── sessions ────────────────────────────────────────────────────────────

  private async secret(): Promise<string> {
    if (this.secretCache) return this.secretCache;
    const existing = await this.storage.get<string>("secret:v1");
    if (existing) {
      this.secretCache = existing;
      return existing;
    }
    const fresh = randomB64(32);
    await this.storage.put("secret:v1", fresh);
    this.secretCache = fresh;
    return fresh;
  }

  private async signToken(email: string): Promise<string> {
    const payload = b64url(enc.encode(JSON.stringify({ e: email, exp: Date.now() + SESSION_TTL_MS })));
    const key = await hmacKey(await this.secret());
    const sig = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    return `${payload}.${sig}`;
  }

  private async readSession(request: Request): Promise<UserRecord | null> {
    const token = readCookie(request, COOKIE);
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const key = await hmacKey(await this.secret());
    const expected = b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
    if (sig.length !== expected.length || sig !== expected) return null;
    let parsed: { e?: string; exp?: number };
    try {
      parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    } catch {
      return null;
    }
    if (!parsed.e || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return (await this.storage.get<UserRecord>(`u:${parsed.e.toLowerCase()}`)) ?? null;
  }

  // ── auth handlers ───────────────────────────────────────────────────────

  private async register(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string; password?: string; name?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    const password = body?.password ?? "";
    const name = (body?.name ?? "").trim() || email.split("@")[0];
    if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const key = `u:${email}`;
    if (await this.storage.get(key)) return json({ error: "An account with this email already exists. Sign in instead." }, 409);
    const salt = randomB64(16);
    const user: UserRecord = {
      email,
      name: name.slice(0, 80),
      salt,
      hash: await passwordHash(password, salt),
      provider: "password",
      createdAt: Date.now(),
    };
    await this.storage.put(key, user);
    const token = await this.signToken(email);
    return json({ ok: true, user: publicUser(user) }, 200, { "set-cookie": sessionCookie(token) });
  }

  private async login(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    const password = body?.password ?? "";
    const user = await this.storage.get<UserRecord>(`u:${email}`);
    // Uniform error + rate limit so the endpoint cannot be used to enumerate accounts.
    const minute = Math.floor(Date.now() / RATE_WINDOW_MS);
    const rateKey = `t:${email}:${minute}`;
    const attempts = (await this.storage.get<number>(rateKey)) ?? 0;
    if (attempts >= RATE_MAX_ATTEMPTS) return json({ error: "Too many attempts. Wait a minute and try again." }, 429);
    await this.storage.put(rateKey, attempts + 1);
    if (!user || user.provider !== "password") return json({ error: "Wrong email or password." }, 401);
    const hash = await passwordHash(password, user.salt);
    if (hash !== user.hash) return json({ error: "Wrong email or password." }, 401);
    const token = await this.signToken(email);
    return json({ ok: true, user: publicUser(user) }, 200, { "set-cookie": sessionCookie(token) });
  }

  private async me(request: Request): Promise<Response> {
    const user = await this.readSession(request);
    return json({ user: user ? publicUser(user) : null });
  }

  /** Called by the worker after a successful Google code exchange. */
  private async googleUpsert(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string; name?: string; googleId?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    if (!validEmail(email)) return json({ error: "Google did not return a usable email." }, 400);
    const key = `u:${email}`;
    const existing = await this.storage.get<UserRecord>(key);
    const user: UserRecord = existing
      ? { ...existing, provider: existing.provider === "password" ? "password" : "google", googleId: body?.googleId ?? existing.googleId }
      : {
          email,
          name: (body?.name ?? email.split("@")[0]).slice(0, 80),
          salt: "",
          hash: "",
          provider: "google",
          googleId: body?.googleId,
          createdAt: Date.now(),
        };
    await this.storage.put(key, user);
    const token = await this.signToken(email);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
  }

  // ── project storage ─────────────────────────────────────────────────────

  private async requireUser(request: Request): Promise<UserRecord | Response> {
    const user = await this.readSession(request);
    if (!user) return json({ error: "Sign in first." }, 401);
    return user;
  }

  private async listProjects(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    if (user instanceof Response) return user;
    const metas = await this.storage.list({ prefix: `p:${user.email}:` });
    const projects = [...metas.values()].map((m) => {
      const meta = m as ProjectMeta;
      return { id: meta.id, name: meta.name, updatedAt: meta.updatedAt, size: meta.size };
    });
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    return json({ projects });
  }

  private async saveProject(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    if (user instanceof Response) return user;
    const body = await request.json().catch(() => null) as { name?: string; id?: string; data?: string } | null;
    const name = (body?.name ?? "").trim().slice(0, 120);
    const data = body?.data ?? "";
    if (!name) return json({ error: "Project name is required." }, 400);
    if (!data || data.length > MAX_PROJECT_B64) return json({ error: "Project payload missing or too large." }, 413);
    const id = (body?.id ?? "").trim() || (crypto.randomUUID?.() ?? `${Date.now()}-${randomB64(6)}`);
    const chunks = Math.ceil(data.length / CHUNK_B64);
    const metaKey = `p:${user.email}:${id}`;
    const previous = await this.storage.get<ProjectMeta>(metaKey);
    // Remove stale chunks when overwriting a bigger previous version.
    if (previous && previous.chunks > chunks) {
      for (let i = chunks; i < previous.chunks; i++) await this.storage.delete(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`);
    }
    for (let i = 0; i < chunks; i++) {
      await this.storage.put(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`, data.slice(i * CHUNK_B64, (i + 1) * CHUNK_B64));
    }
    const meta: ProjectMeta = { id, name, updatedAt: Date.now(), size: data.length, chunks };
    await this.storage.put(metaKey, meta);
    return json({ ok: true, project: { id: meta.id, name: meta.name, updatedAt: meta.updatedAt, size: meta.size } });
  }

  private async loadProject(request: Request, id: string): Promise<Response> {
    const user = await this.requireUser(request);
    if (user instanceof Response) return user;
    if (!/^[\w.-]{1,120}$/.test(id)) return json({ error: "Bad project id." }, 400);
    const meta = await this.storage.get<ProjectMeta>(`p:${user.email}:${id}`);
    if (!meta) return json({ error: "Project not found." }, 404);
    let data = "";
    for (let i = 0; i < meta.chunks; i++) {
      const chunk = await this.storage.get<string>(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`);
      if (chunk === undefined) return json({ error: "Project data is incomplete." }, 500);
      data += chunk;
    }
    return json({ project: { id: meta.id, name: meta.name, updatedAt: meta.updatedAt }, data });
  }

  private async deleteProject(request: Request, id: string): Promise<Response> {
    const user = await this.requireUser(request);
    if (user instanceof Response) return user;
    if (!/^[\w.-]{1,120}$/.test(id)) return json({ error: "Bad project id." }, 400);
    const meta = await this.storage.get<ProjectMeta>(`p:${user.email}:${id}`);
    if (!meta) return json({ ok: true });
    for (let i = 0; i < meta.chunks; i++) await this.storage.delete(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`);
    await this.storage.delete(`p:${user.email}:${id}`);
    return json({ ok: true });
  }
}

function publicUser(user: UserRecord): { email: string; name: string; provider: string } {
  return { email: user.email, name: user.name, provider: user.provider };
}

// ── Google OAuth 2.0 (worker-side helpers) ────────────────────────────────

/** Build the Google consent redirect. Returns null when credentials are missing. */
export function googleStartUrl(request: Request, env: AuthEnv): string | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const origin = new URL(request.url).origin;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange the consent code for the Google profile userinfo. Throws on failure. */
export async function googleCallback(request: Request, env: AuthEnv): Promise<{ email: string; name: string; sub?: string }> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error("google-not-configured");
  if (!code) throw new Error("missing-code");
  const origin = url.origin;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) throw new Error("token-exchange-failed");
  const accessToken = (await tokenRes.json() as { access_token?: string }).access_token;
  if (!accessToken) throw new Error("no-access-token");
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) throw new Error("userinfo-failed");
  const info = await infoRes.json() as { email?: string; name?: string; sub?: string };
  if (!info.email) throw new Error("no-email");
  return { email: info.email, name: info.name ?? info.email.split("@")[0], sub: info.sub };
}

export function googleSetupNeeded(): Response {
  return json(
    {
      error: "Google sign-in is not configured on this deployment yet.",
      hint: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets, then retry. Email accounts work right now.",
    },
    503,
  );
}
