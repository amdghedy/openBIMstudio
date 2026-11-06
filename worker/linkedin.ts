/**
 * LinkedIn member publishing for the OpenBIMStudio Cloudflare Worker.
 *
 * Uses LinkedIn's self-service Share on LinkedIn permission (w_member_social)
 * and OpenID Connect (openid profile). Tokens remain in a private Durable
 * Object and are never returned by an HTTP endpoint.
 *
 * Required Worker secrets/vars:
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET (secret)
 *   LINKEDIN_REDIRECT_URI (exact HTTPS callback URL)
 *   LINKEDIN_PUBLISH_SECRET (secret used by trusted publishing clients)
 * Optional:
 *   LINKEDIN_VERSION (defaults to the current configured API version)
 *
 * Routes:
 *   GET  /api/linkedin/connect   Start member OAuth consent
 *   GET  /api/linkedin/callback  OAuth callback
 *   GET  /api/linkedin/status    Authenticated connection status
 *   POST /api/linkedin/publish   Authenticated text post
 *   POST /api/linkedin/disconnect Authenticated token revocation locally
 *
 * LinkedIn access tokens are normally valid for 60 days. Programmatic refresh
 * tokens are not assumed because LinkedIn limits that capability to approved
 * partners. Reconnect through /api/linkedin/connect when the token expires.
 */

export interface LinkedInEnv {
  LINKEDIN_VAULT: LinkedInVaultNamespace;
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_REDIRECT_URI?: string;
  LINKEDIN_PUBLISH_SECRET?: string;
  LINKEDIN_VERSION?: string;
}

interface VaultStub {
  fetch(request: Request): Promise<Response>;
}

interface LinkedInVaultNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): VaultStub;
}

interface StoredToken {
  accessToken: string;
  personId: string;
  expiresAt: number;
  scope: string;
}

interface VaultState {
  value: string;
  expiresAt: number;
}

interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const STATE_KEY_PREFIX = "linkedin:oauth-state:";
const TOKEN_KEY = "linkedin:member-token";
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_COMMENTARY_LENGTH = 3000;
const API_VERSION_DEFAULT = "202610";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function html(message: string, status = 200): Response {
  const safe = message.replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[character] ?? character);
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>LinkedIn connection</title><body style="font:16px system-ui;max-width:620px;margin:12vh auto;padding:24px;color:#172033"><h1>OpenBIMStudio LinkedIn</h1><p>${safe}</p><p>You can close this window.</p></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function vault(env: LinkedInEnv): VaultStub {
  return env.LINKEDIN_VAULT.get(env.LINKEDIN_VAULT.idFromName("linkedin-member"));
}

async function vaultRequest<T>(env: LinkedInEnv, path: string, method: string, body?: unknown): Promise<T> {
  const response = await vault(env).fetch(new Request(`https://vault.internal${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  if (!response.ok) throw new Error("LinkedIn credential storage is unavailable.");
  return await response.json() as T;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

function oauthCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(/(?:^|;\s*)__Host-obs-linkedin-oauth=([^;]+)/);
  return match?.[1] ?? null;
}

function clearOAuthCookie(): string {
  return "__Host-obs-linkedin-oauth=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function configured(env: LinkedInEnv): boolean {
  return Boolean(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET && env.LINKEDIN_REDIRECT_URI);
}

function authorized(request: Request, env: LinkedInEnv): boolean {
  const expected = env.LINKEDIN_PUBLISH_SECRET ?? "";
  const supplied = request.headers.get("authorization") ?? "";
  return expected.length >= 32 && supplied.startsWith("Bearer ") &&
    constantTimeEqual(supplied.slice(7), expected);
}

async function startOAuth(env: LinkedInEnv): Promise<Response> {
  if (!configured(env)) {
    return json({ error: "LinkedIn OAuth is not configured. Set the required Worker secrets and redirect URL." }, 503);
  }
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await vaultRequest(env, "/state", "POST", { value: state, expiresAt: Date.now() + STATE_TTL_MS });
  const authorization = new URL("https://www.linkedin.com/oauth/v2/authorization");
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", env.LINKEDIN_CLIENT_ID!);
  authorization.searchParams.set("redirect_uri", env.LINKEDIN_REDIRECT_URI!);
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("scope", "openid profile w_member_social");
  return new Response(null, {
    status: 302,
    headers: {
      location: authorization.toString(),
      "set-cookie": `__Host-obs-linkedin-oauth=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
      "cache-control": "no-store",
    },
  });
}

async function finishOAuth(request: Request, env: LinkedInEnv): Promise<Response> {
  if (!configured(env)) return html("LinkedIn OAuth is not configured on this deployment.", 503);
  const url = new URL(request.url);
  const providerError = url.searchParams.get("error");
  if (providerError) return new Response(await html("LinkedIn authorization was not completed. Return to OpenBIMStudio and try again.", 400).text(), {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearOAuthCookie() },
  });

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const browserState = oauthCookie(request);
  if (!code || !state || state.length > 256 || !browserState || !constantTimeEqual(state, browserState)) {
    return new Response(await html("The authorization response could not be verified in this browser. Please restart the connection.", 400).text(), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearOAuthCookie() },
    });
  }

  const consumed = await vaultRequest<{ valid: boolean }>(env, "/consume-state", "POST", { value: state });
  if (!consumed.valid) return new Response(await html("The authorization request expired. Please restart the connection.", 400).text(), {
    status: 400,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearOAuthCookie() },
  });

  const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.LINKEDIN_CLIENT_ID!,
      client_secret: env.LINKEDIN_CLIENT_SECRET!,
      redirect_uri: env.LINKEDIN_REDIRECT_URI!,
    }),
  });
  if (!tokenResponse.ok) {
    console.warn("[linkedin] OAuth token exchange failed:", tokenResponse.status);
    return html("LinkedIn could not complete authorization. Check the app credentials and exact callback URL, then try again.", 502);
  }

  const token = await tokenResponse.json() as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!token.access_token || !Number.isFinite(token.expires_in) || (token.expires_in ?? 0) <= 0) {
    return html("LinkedIn returned an incomplete token response. Please reconnect.", 502);
  }

  const profileResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) {
    console.warn("[linkedin] OpenID profile lookup failed:", profileResponse.status);
    return html("Authorization succeeded, but LinkedIn did not return the member identity. Confirm the OpenID Connect product and reconnect.", 502);
  }
  const profile = await profileResponse.json() as { sub?: string };
  if (!profile.sub || !/^[A-Za-z0-9_-]{1,128}$/.test(profile.sub)) {
    return html("LinkedIn returned an invalid member identifier. Please reconnect.", 502);
  }

  const stored: StoredToken = {
    accessToken: token.access_token,
    personId: profile.sub,
    expiresAt: Date.now() + token.expires_in * 1000,
    scope: token.scope ?? "unknown",
  };
  await vaultRequest(env, "/token", "POST", stored);
  return new Response(await html("Your personal LinkedIn profile is connected to OpenBIMStudio. The access token is stored privately on the server and was not displayed.").text(), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": clearOAuthCookie() },
  });
}

async function publish(request: Request, env: LinkedInEnv): Promise<Response> {
  if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);

  let body: { commentary?: unknown };
  try {
    body = await request.json() as { commentary?: unknown };
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }
  if (typeof body.commentary !== "string") return json({ error: "commentary must be a string." }, 400);
  const commentary = body.commentary.trim();
  if (!commentary || commentary.length > MAX_COMMENTARY_LENGTH) {
    return json({ error: `commentary must contain 1 to ${MAX_COMMENTARY_LENGTH} characters.` }, 400);
  }

  const stored = await vaultRequest<StoredToken | null>(env, "/token", "GET");
  if (!stored?.accessToken || !stored.personId) return json({ error: "No LinkedIn member is connected. Open /api/linkedin/connect first." }, 409);
  if (stored.expiresAt <= Date.now() + 60_000) {
    return json({ error: "The LinkedIn access token has expired or is about to expire. Reconnect at /api/linkedin/connect." }, 401);
  }

  const apiResponse = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      authorization: `Bearer ${stored.accessToken}`,
      "content-type": "application/json",
      "linkedin-version": env.LINKEDIN_VERSION || API_VERSION_DEFAULT,
      "x-restli-protocol-version": "2.0.0",
    },
    body: JSON.stringify({
      author: `urn:li:person:${stored.personId}`,
      commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  if (apiResponse.status !== 201) {
    const detail = (await apiResponse.text()).slice(0, 1200);
    console.warn("[linkedin] Post API rejected request:", apiResponse.status, detail);
    return json({ error: "LinkedIn rejected the post.", status: apiResponse.status, detail }, apiResponse.status >= 400 && apiResponse.status < 500 ? 422 : 502);
  }

  return json({
    published: true,
    postId: apiResponse.headers.get("x-restli-id"),
    publishedAt: new Date().toISOString(),
  }, 201);
}

/** Routes the LinkedIn endpoints; returns null when the path is not ours. */
export async function handleLinkedInRequest(request: Request, env: LinkedInEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/linkedin/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 405 });
  try {
    if (url.pathname === "/api/linkedin/connect" && request.method === "GET") return await startOAuth(env);
    if (url.pathname === "/api/linkedin/callback" && request.method === "GET") return await finishOAuth(request, env);
    if (url.pathname === "/api/linkedin/status" && request.method === "GET") {
      if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
      const stored = await vaultRequest<StoredToken | null>(env, "/token", "GET");
      return json({
        connected: Boolean(stored?.accessToken && stored.expiresAt > Date.now()),
        expiresAt: stored?.expiresAt ? new Date(stored.expiresAt).toISOString() : null,
        memberUrn: stored?.personId ? `urn:li:person:${stored.personId}` : null,
        scopes: stored?.scope ?? null,
      });
    }
    if (url.pathname === "/api/linkedin/publish" && request.method === "POST") return await publish(request, env);
    if (url.pathname === "/api/linkedin/disconnect" && request.method === "POST") {
      if (!authorized(request, env)) return json({ error: "Unauthorized." }, 401);
      await vaultRequest(env, "/token", "DELETE");
      return json({ disconnected: true });
    }
    return json({ error: "Not found." }, 404);
  } catch (cause) {
    console.warn("[linkedin] Request failed:", cause instanceof Error ? cause.message : "unknown error");
    return json({ error: "LinkedIn service temporarily unavailable." }, 503);
  }
}

/** Private credential/state store. Only the Worker can address this Durable Object. */
export class LinkedInVault {
  private readonly storage: StorageLike;

  constructor(state: { storage: StorageLike }) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/state") {
        const body = await request.json() as VaultState;
        if (typeof body.value !== "string" || typeof body.expiresAt !== "number") return json({ error: "invalid state" }, 400);
        if (!/^[A-Za-z0-9_-]{32,128}$/.test(body.value) || body.expiresAt <= Date.now() || body.expiresAt > Date.now() + STATE_TTL_MS + 60_000) return json({ error: "invalid state" }, 400);
        await this.storage.put(`${STATE_KEY_PREFIX}${body.value}`, body);
        return json({ stored: true });
      }
      if (request.method === "POST" && url.pathname === "/consume-state") {
        const body = await request.json() as { value?: string };
        if (typeof body.value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(body.value)) return json({ valid: false });
        const key = `${STATE_KEY_PREFIX}${body.value}`;
        const saved = await this.storage.get<VaultState>(key);
        if (saved) await this.storage.delete(key);
        return json({ valid: Boolean(saved && saved.expiresAt > Date.now() && saved.value === body.value) });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        const body = await request.json() as StoredToken;
        if (!body.accessToken || !body.personId || !Number.isFinite(body.expiresAt)) return json({ error: "invalid token" }, 400);
        await this.storage.put(TOKEN_KEY, body);
        return json({ stored: true });
      }
      if (url.pathname === "/token" && request.method === "GET") {
        return json(await this.storage.get<StoredToken>(TOKEN_KEY) ?? null);
      }
      if (url.pathname === "/token" && request.method === "DELETE") {
        await this.storage.delete(TOKEN_KEY);
        return json({ deleted: true });
      }
      return json({ error: "not found" }, 404);
    } catch {
      return json({ error: "vault operation failed" }, 500);
    }
  }
}
