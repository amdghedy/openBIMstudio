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
 *   f:<email>:<minute>             forgot-password rate-limit marker
 *   rt:<sha256(token)>             password-reset token {e,exp} — 30 min TTL,
 *                                  single-use; only the SHA-256 is stored so a
 *                                  vault snapshot cannot be replayed as a link
 *
 * API (all same-origin; cookies are HttpOnly so scripts can never read them):
 *   POST /api/auth/register   {email,password,name}
 *   POST /api/auth/login      {email,password}
 *   GET  /api/auth/me
 *   POST /api/auth/logout
 *   POST /api/auth/forgot     {email} → creates a reset token; the worker
 *                             emails it (RESEND_API_KEY) or returns a one-time
 *                             link for deployments without mail delivery
 *   POST /api/auth/reset      {token,password} → sets the new password and
 *                             signs the user in (session cookie)
 *   GET  /api/auth/google/status      → {configured:boolean} — lets the UI
 *         grey out / explain Google sign-in before navigating away
 *   GET  /api/auth/google/start        → 302 Google consent, or a friendly
 *         HTML setup page when GOOGLE_CLIENT_ID/SECRET are not configured;
 *         ?popup=1 marks the state so the callback can message the opener
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
const FORGOT_MAX_PER_MIN = 5;
const RESET_TTL_MS = 30 * 60 * 1000; // reset links live 30 minutes

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

function b64decode(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
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

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
      if (path === "/api/auth/forgot" && request.method === "POST") return this.forgotPassword(request);
      if (path === "/api/auth/reset" && request.method === "POST") return this.resetPassword(request);
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

  // ── forgot / reset password ──────────────────────────────────────────────

  /**
   * Creates a single-use reset token for a password account. The DO returns
   * the raw token to the worker only; the worker decides whether to email it
   * (RESEND_API_KEY configured) or hand back a one-time link for deployments
   * without mail delivery. Responses are uniform for unknown emails so the
   * endpoint cannot enumerate accounts (the dev-link absence is the only hint,
   * acceptable for a single-owner deployment and rate-limited per minute).
   */
  private async forgotPassword(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    if (!validEmail(email)) return json({ error: "Enter a valid email address." }, 400);
    const minute = Math.floor(Date.now() / RATE_WINDOW_MS);
    const rateKey = `f:${email}:${minute}`;
    const attempts = (await this.storage.get<number>(rateKey)) ?? 0;
    if (attempts >= FORGOT_MAX_PER_MIN) return json({ error: "Too many reset requests. Wait a minute and try again." }, 429);
    await this.storage.put(rateKey, attempts + 1);
    const user = await this.storage.get<UserRecord>(`u:${email}`);
    if (!user || user.provider !== "password") return json({ ok: true, hasAccount: false });
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await this.storage.put(`rt:${await sha256hex(token)}`, { e: email, exp: Date.now() + RESET_TTL_MS });
    return json({ ok: true, hasAccount: true, token });
  }

  /** Consumes a reset token, sets the new password and signs the user in. */
  private async resetPassword(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { token?: string; password?: string } | null;
    const token = (body?.token ?? "").trim();
    const password = body?.password ?? "";
    if (!token) return json({ error: "This reset link is missing its code — request a new one." }, 400);
    if (password.length < 6) return json({ error: "Password must be at least 6 characters." }, 400);
    const recordKey = `rt:${await sha256hex(token)}`;
    const record = await this.storage.get<{ e: string; exp: number }>(recordKey);
    if (!record || typeof record.exp !== "number" || record.exp < Date.now()) {
      return json({ error: "This reset link has expired or was already used — request a new one." }, 400);
    }
    const user = await this.storage.get<UserRecord>(`u:${record.e}`);
    if (!user) return json({ error: "This account no longer exists." }, 400);
    // Single-use: burn the token before writing anything else.
    await this.storage.delete(recordKey);
    const salt = randomB64(16);
    user.salt = salt;
    user.hash = await passwordHash(password, salt);
    user.provider = "password";
    await this.storage.put(`u:${user.email}`, user);
    const session = await this.signToken(user.email);
    return json({ ok: true, user: publicUser(user) }, 200, { "set-cookie": sessionCookie(session) });
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

/** Cheap, side-effect-free probe so the UI can react before navigating away. */
export function googleStatus(env: AuthEnv): Response {
  return json({ configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Friendly full-page fallback for /api/auth/google/start (a top-level browser
 * navigation). Instead of raw JSON the user gets a styled page that explains
 * what works right now (email accounts) and exactly how the deployment owner
 * turns Google sign-in on.
 */
export function googleSetupPage(request: Request, opts: { reason?: string; status?: number } = {}): Response {
  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/google/callback`;
  const reason = opts.reason
    ? `<p class="reason">${esc(opts.reason)}</p>`
    : `<p class="reason">Google sign-in isn't configured on this deployment yet.</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Google sign-in — Open BIM Studio</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a0e14;color:#e2e8f0;font:14px/1.55 system-ui,-apple-system,sans-serif;padding:20px}
  .card{width:min(560px,100%);border-radius:14px;border:1px solid rgba(148,163,184,.25);
    background:#0d1219;box-shadow:0 24px 80px rgba(0,0,0,.6);padding:26px 28px}
  h1{margin:0 0 6px;font-size:19px;color:#f1f5f9}
  .reason{margin:0 0 14px;color:#fcd34d;font-size:13px}
  p{margin:8px 0}
  .ok{color:#7dd3fc}
  ol{margin:10px 0 4px;padding-left:22px}
  li{margin:7px 0}
  code{background:#0a0e14;border:1px solid rgba(148,163,184,.25);border-radius:6px;
    padding:1px 6px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#93c5fd;word-break:break-all}
  .uri{display:block;margin:6px 0 2px;padding:8px 10px;border-radius:8px;background:#0a0e14;
    border:1px solid rgba(56,189,248,.35);color:#7dd3fc;font:12px ui-monospace,monospace;word-break:break-all}
  .back{display:inline-block;margin-top:16px;padding:9px 16px;border-radius:8px;background:#0ea5e9;
    color:#04121d;font-weight:700;text-decoration:none;font-size:13px}
  .back:hover{background:#38bdf8}
  .fine{margin-top:14px;color:#64748b;font-size:12px}
</style>
</head>
<body>
<div class="card">
  <h1>Google sign-in isn't set up here yet</h1>
  ${reason}
  <p class="ok"><strong>You can sign in right now with an email account</strong> — open
  <a href="/" style="color:#38bdf8">Open BIM Studio</a>, press the <strong>Sign in</strong> button
  (top-left, next to the logo) and choose <strong>Create account</strong>. Cloud project
  saving and opening from any device work the same way.</p>
  <p>To switch on “Continue with Google”, the deployment owner does a one-time setup:</p>
  <ol>
    <li>In <a href="https://console.cloud.google.com/apis/credentials" style="color:#38bdf8">Google Cloud Console → APIs &amp; Services → Credentials</a>,
        create an <strong>OAuth client ID → Web application</strong> and add this
        <strong>Authorized redirect URI</strong>:
        <span class="uri">${esc(redirectUri)}</span></li>
    <li>Set the two Worker secrets (Cloudflare dashboard → Workers → openbimstudio → Settings →
        Variables and Secrets, or <code>npx wrangler secret put GOOGLE_CLIENT_ID</code> and
        <code>npx wrangler secret put GOOGLE_CLIENT_SECRET</code>):
        <span class="uri">GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET</span></li>
    <li>Redeploy / retry — the “Continue with Google” button starts working automatically.</li>
  </ol>
  <a class="back" href="/">← Back to Open BIM Studio</a>
  <p class="fine">Your projects are stored per account in a private cloud vault —
  sign in with the same account on any device to see them.</p>
</div>
</body>
</html>`;
  return new Response(html, {
    status: opts.status ?? 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Build the Google consent redirect. Returns null when credentials are missing. */
export function googleStartUrl(request: Request, env: AuthEnv): string | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const url = new URL(request.url);
  const origin = url.origin;
  // Popup flow: carry the marker in the OAuth `state` (Google echoes it back
  // verbatim) so the callback can message + close the opener window instead
  // of navigating the whole app away. `prompt=select_account` makes Google
  // list the previously used accounts, speeding up repeat sign-ins.
  const popup = url.searchParams.get("popup") === "1";
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: popup ? "popup" : "app",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Email the reset link through Resend when the deployment sets RESEND_API_KEY
 * (optional). Returns false when mail delivery is not configured — the caller
 * then falls back to showing the one-time link in the UI.
 */
export async function sendResetEmail(env: AuthEnv & { RESEND_API_KEY?: string; RESEND_FROM?: string }, to: string, resetUrl: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: env.RESEND_FROM || "Open BIM Studio <onboarding@resend.dev>",
        to: [to],
        subject: "Reset your Open BIM Studio password",
        html:
          `<p>Hi,</p><p>Use this one-time link within <strong>30 minutes</strong> to choose a new password:</p>` +
          `<p><a href="${esc(resetUrl)}">${esc(resetUrl)}</a></p>` +
          `<p>If you didn't request this, you can safely ignore this email — your current password keeps working.</p>`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Tiny self-closing page returned to the OAuth popup after Google consent:
 * it posts the result to the opener (same origin) and closes itself.
 */
export function googlePopupCallbackPage(ok: boolean, message = ""): Response {
  const payload = JSON.stringify({ type: "obs-oauth", ok, message }).replace(/</g, "\\u003c");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font:14px system-ui;background:#0a0e14;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center">
  <p>${ok ? "Signed in — closing this window..." : (esc(message) || "Sign-in failed — closing this window...")}</p>
  <p style="color:#64748b;font-size:12px">If this window doesn't close, close it and return to Open BIM Studio.</p>
</div>
<script>
  try { window.opener && window.opener.postMessage(${payload}, window.location.origin); } catch (e) {}
  setTimeout(function () { window.close(); }, 400);
</script>
</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
