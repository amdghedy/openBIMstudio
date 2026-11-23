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
 *                             emails it (Resend) when RESEND_API_KEY is set
 *   POST /api/auth/reset      {token,password} → sets the new password and
 *                             signs the user in
 *   GET  /api/auth/google/status      → {configured:boolean} — lets the UI
 *                                      hide the Google button when unset
 *   GET  /api/auth/google/start        → 302 to Google consent
 *   GET  /api/auth/google/callback     → exchange code, upsert user, set cookie
 *   GET  /api/projects
 *   POST /api/projects        {id,name,data} (base64)
 *   GET  /api/projects/:id
 *   DELETE /api/projects/:id
 *
 * Password hashing: PBKDF2-SHA-256, 100k iterations, 16-byte salt, 32-byte key.
 * Session tokens: HMAC-SHA-256 of {email,exp} with a vault-stored secret.
 */

export interface AuthEnv {
  AUTH: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
}

type AuthStorage = {
  get: <T = unknown>(key: string) => Promise<T | undefined>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: (opts?: { prefix?: string }) => Promise<Map<string, unknown>>;
};

interface UserRecord {
  email: string;
  name: string;
  salt?: string;
  hash?: string;
  provider?: string;
  googleId?: string;
  createdAt: number;
}

const COOKIE = "obs_session";
const RESET_TTL_MS = 30 * 60 * 1000;
const RATE_WINDOW_MS = 60_000;
const FORGOT_MAX_PER_MIN = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const enc = new TextEncoder();

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomB64(n: number): string {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function pbkdf2(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: b64urlDecode(saltB64), iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  return b64url(bits);
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setCookie(token: string): string {
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
    const path = url.pathname;
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
    const hash = await pbkdf2(password, salt);
    const user: UserRecord = { email, name, salt, hash, provider: "password", createdAt: Date.now() };
    await this.storage.put(key, user);
    const token = await this.signToken(email);
    return json({ user: { email, name } }, 201, { "set-cookie": setCookie(token) });
  }

  private async login(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    const password = body?.password ?? "";
    if (!validEmail(email) || !password) return json({ error: "Email and password are required." }, 400);
    const minute = Math.floor(Date.now() / 60_000);
    const rlKey = `t:${email}:${minute}`;
    const hits = Number((await this.storage.get<number>(rlKey)) ?? 0);
    if (hits >= 10) return json({ error: "Too many attempts. Wait a minute and try again." }, 429);
    await this.storage.put(rlKey, hits + 1);
    const user = await this.storage.get<UserRecord>(`u:${email}`);
    if (!user || !user.salt || !user.hash) return json({ error: "Wrong email or password." }, 401);
    const hash = await pbkdf2(password, user.salt);
    if (hash !== user.hash.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")) return json({ error: "Wrong email or password." }, 401);
    const token = await this.signToken(email);
    return json({ user: { email: user.email, name: user.name } }, 200, { "set-cookie": setCookie(token) });
  }

  private async me(request: Request): Promise<Response> {
    const user = await this.readSession(request);
    if (!user) return json({ user: null });
    return json({ user: { email: user.email, name: user.name } });
  }

  private async googleUpsert(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null) as { email?: string; name?: string; googleId?: string } | null;
    const email = (body?.email ?? "").trim().toLowerCase();
    const name = (body?.name ?? "").trim() || email.split("@")[0];
    const googleId = body?.googleId;
    if (!validEmail(email)) return json({ error: "invalid email" }, 400);
    const key = `u:${email}`;
    const existing = await this.storage.get<UserRecord>(key);
    const user: UserRecord = existing
      ? { ...existing, name: name || existing.name, provider: existing.provider === "password" ? "password" : "google", googleId: googleId ?? existing.googleId }
      : { email, name, provider: "google", googleId, createdAt: Date.now() };
    await this.storage.put(key, user);
    const token = await this.signToken(email);
    return json({ user: { email: user.email, name: user.name } }, 200, { "set-cookie": setCookie(token) });
  }

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
    user.hash = await pbkdf2(password, salt);
    user.provider = "password";
    await this.storage.put(`u:${user.email}`, user);
    const session = await this.signToken(user.email);
    return json({ ok: true, user: { email: user.email, name: user.name, provider: user.provider ?? "password" } }, 200, { "set-cookie": setCookie(session) });
  }

  private async listProjects(request: Request): Promise<Response> {
    const user = await this.readSession(request);
    if (!user) return json({ error: "Sign in required." }, 401);
    const prefix = `p:${user.email}:`;
    const map = await this.storage.list({ prefix });
    const projects = [...map.entries()].map(([k, v]) => {
      const meta = v as { id: string; name: string; updatedAt: number; size: number };
      return { id: meta.id, name: meta.name, updatedAt: meta.updatedAt, size: meta.size };
    });
    projects.sort((a, b) => b.updatedAt - a.updatedAt);
    return json({ projects });
  }

  private async saveProject(request: Request): Promise<Response> {
    const user = await this.readSession(request);
    if (!user) return json({ error: "Sign in required." }, 401);
    const body = await request.json().catch(() => null) as { id?: string; name?: string; data?: string } | null;
    const id = (body?.id ?? "").trim() || randomB64(12);
    const name = (body?.name ?? "Untitled").trim() || "Untitled";
    const data = body?.data ?? "";
    if (data.length > 8_000_000) return json({ error: "Project too large." }, 413);
    const chunkSize = 100_000;
    const chunks = Math.ceil(data.length / chunkSize) || 1;
    for (let i = 0; i < chunks; i++) {
      const part = data.slice(i * chunkSize, (i + 1) * chunkSize);
      await this.storage.put(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`, part);
    }
    const meta = { id, name, updatedAt: Date.now(), size: data.length, chunks };
    await this.storage.put(`p:${user.email}:${id}`, meta);
    return json({ ok: true, id });
  }

  private async loadProject(request: Request, id: string): Promise<Response> {
    const user = await this.readSession(request);
    if (!user) return json({ error: "Sign in required." }, 401);
    const meta = await this.storage.get<{ id: string; name: string; updatedAt: number; size: number; chunks: number }>(`p:${user.email}:${id}`);
    if (!meta) return json({ error: "Not found." }, 404);
    let data = "";
    for (let i = 0; i < meta.chunks; i++) {
      const part = await this.storage.get<string>(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`);
      data += part ?? "";
    }
    return json({ id: meta.id, name: meta.name, updatedAt: meta.updatedAt, data });
  }

  private async deleteProject(request: Request, id: string): Promise<Response> {
    const user = await this.readSession(request);
    if (!user) return json({ error: "Sign in required." }, 401);
    const meta = await this.storage.get<{ chunks?: number }>(`p:${user.email}:${id}`);
    if (!meta) return json({ error: "Not found." }, 404);
    const chunks = meta.chunks ?? 0;
    for (let i = 0; i < chunks; i++) await this.storage.delete(`c:${user.email}:${id}:${String(i).padStart(4, "0")}`);
    await this.storage.delete(`p:${user.email}:${id}`);
    return json({ ok: true });
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function googleStatus(env: AuthEnv): Response {
  return json({ configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
}

const GOOGLE_STATE_COOKIE = "__Host-obs_google_state";
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

/** A fresh browser-bound OAuth state, scoped to this host and short-lived. */
export function googleOAuthState(request: Request): string {
  const mode = new URL(request.url).searchParams.get("popup") === "1" ? "popup" : "app";
  return `${mode}.${b64url(crypto.getRandomValues(new Uint8Array(32)))}.${Date.now()}`;
}

export function googleOAuthStateCookie(state: string): string {
  return `${GOOGLE_STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearGoogleOAuthStateCookie(): string {
  return `${GOOGLE_STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Validate before exchanging any code or linking an account. Returns popup mode. */
export function validateGoogleOAuthState(request: Request): boolean {
  const state = new URL(request.url).searchParams.get("state") ?? "";
  const saved = readCookie(request, GOOGLE_STATE_COOKIE);
  const match = /^(app|popup)\.([A-Za-z0-9_-]{43})\.(\d{13})$/.exec(state);
  if (!saved || saved !== state || !match) throw new Error("invalid-oauth-state");
  const age = Date.now() - Number(match[3]);
  if (age < 0 || age > GOOGLE_STATE_TTL_MS) throw new Error("expired-oauth-state");
  return match[1] === "popup";
}

export function googleStartUrl(request: Request, env: AuthEnv, state = googleOAuthState(request)): string | null {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const origin = new URL(request.url).origin;
  const popup = new URL(request.url).searchParams.get("popup") === "1";
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function googleSetupPage(request: Request, opts?: { reason?: string; status?: number }): Response {
  const origin = new URL(request.url).origin;
  const reason = opts?.reason ?? "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Google sign-in setup</title>
<style>body{font:15px/1.5 system-ui;background:#0a0e14;color:#e2e8f0;max-width:640px;margin:48px auto;padding:0 20px}
a{color:#38bdf8}.uri{font-family:ui-monospace,monospace;background:#111827;padding:2px 6px;border-radius:4px}</style></head>
<body>
  <h1>Google sign-in</h1>
  ${reason ? `<p style="color:#fbbf24">${esc(reason)}</p>` : ""}
  <p>To switch on “Continue with Google”, the deployment owner does a one-time setup:</p>
  <ol>
    <li>Create an OAuth Web client in Google Cloud Console.</li>
    <li>Authorized JavaScript origins: <span class="uri">${esc(origin)}</span></li>
    <li>Authorized redirect URI: <span class="uri">${esc(origin)}/api/auth/google/callback</span></li>
    <li>Set Worker secrets <span class="uri">GOOGLE_CLIENT_ID</span> and <span class="uri">GOOGLE_CLIENT_SECRET</span></li>
    <li>Redeploy — the button starts working automatically.</li>
  </ol>
  <p><a href="/">← Back to Open BIM Studio</a></p>
</body></html>`;
  return new Response(html, { status: opts?.status ?? 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export async function sendResetEmail(env: AuthEnv, to: string, resetUrl: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.RESEND_FROM || "Open BIM Studio <onboarding@resend.dev>",
        to: [to],
        subject: "Reset your Open BIM Studio password",
        html:
          `<p>Click the link below to choose a new password (valid for 30 minutes):</p>` +
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
export function googlePopupCallbackPage(ok: boolean, message = "", setCookie = ""): Response {
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
  // Session cookie MUST be set on the popup response; without it the opener sees
  // Google success but /api/auth/me still returns null ("session did not stick").
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  return new Response(html, { headers });
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
  const info = await infoRes.json() as { email?: string; email_verified?: boolean; name?: string; sub?: string };
  if (!info.email || !validEmail(info.email)) throw new Error("no-email");
  if (info.email_verified !== true) throw new Error("unverified-email");
  if (!info.sub) throw new Error("no-google-subject");
  return { email: info.email, name: info.name ?? info.email.split("@")[0], sub: info.sub };
  }
