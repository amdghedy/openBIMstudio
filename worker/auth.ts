/**
 * Sign-in primitives for the edge worker. Pure WebCrypto, no dependencies, so
 * they run in Workers and in Node tests.
 *
 *  - verifyIdToken : check a Google / Microsoft OpenID Connect ID token
 *                    (RS256 signature against the provider's published keys,
 *                    issuer, audience, expiry, optional nonce)
 *  - signSession / verifySession : tamper-proof session cookie value (HMAC-SHA-256)
 *  - userKey       : stable per-account storage key (never the email address)
 */

export type ProviderId = "google" | "microsoft";

export interface ProviderConfig {
  id: ProviderId;
  clientId: string;
  jwksUrl: string;
  /** True when `iss` is one this provider legitimately issues. */
  issuerOk(iss: string, claims: Record<string, unknown>): boolean;
}

export const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
export const MICROSOFT_JWKS = "https://login.microsoftonline.com/common/discovery/v2.0/keys";

export function providerConfig(id: ProviderId, clientId: string): ProviderConfig {
  if (id === "google") {
    return { id, clientId, jwksUrl: GOOGLE_JWKS, issuerOk: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com" };
  }
  return {
    id, clientId, jwksUrl: MICROSOFT_JWKS,
    // Microsoft puts the tenant id in the issuer: https://login.microsoftonline.com/{tid}/v2.0
    issuerOk: (iss, claims) => typeof claims.tid === "string" && iss === `https://login.microsoftonline.com/${claims.tid}/v2.0`,
  };
}

export interface Jwk { kid?: string; kty: string; n?: string; e?: string; alg?: string; use?: string; [k: string]: unknown }
export type JwksFetcher = (url: string) => Promise<{ keys: Jwk[] }>;

export interface VerifiedIdentity {
  provider: ProviderId;
  /** Provider-scoped stable subject (Microsoft: tenant + object id). */
  subject: string;
  email?: string;
  name?: string;
  picture?: string;
}
export type VerifyResult = { ok: true; identity: VerifiedIdentity } | { ok: false; reason: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str: string): Uint8Array<ArrayBuffer> {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const parseJson = (b64: string): Record<string, any> | null => {
  try { const v = JSON.parse(dec.decode(b64urlDecode(b64))); return v && typeof v === "object" ? v : null; } catch { return null; }
};

const SKEW_SECONDS = 60;

export async function verifyIdToken(
  token: string,
  provider: ProviderConfig,
  fetchJwks: JwksFetcher,
  opts: { nowSeconds?: number; nonce?: string } = {},
): Promise<VerifyResult> {
  if (typeof token !== "string" || token.length > 8192) return { ok: false, reason: "malformed token" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !p)) return { ok: false, reason: "malformed token" };
  const header = parseJson(parts[0]);
  const claims = parseJson(parts[1]);
  if (!header || !claims) return { ok: false, reason: "malformed token" };
  // Only RS256: refuses "none" and HMAC-with-public-key confusion attacks.
  if (header.alg !== "RS256") return { ok: false, reason: "unsupported algorithm" };
  if (typeof header.kid !== "string") return { ok: false, reason: "missing key id" };

  let jwks: { keys: Jwk[] };
  try { jwks = await fetchJwks(provider.jwksUrl); } catch { return { ok: false, reason: "could not load the provider's signing keys" }; }
  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) return { ok: false, reason: "unknown signing key" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: "bad signature" };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== "string" || !provider.issuerOk(claims.iss, claims)) return { ok: false, reason: "wrong issuer" };
  const aud = claims.aud;
  const audOk = typeof aud === "string" ? aud === provider.clientId : Array.isArray(aud) && aud.includes(provider.clientId);
  if (!audOk) return { ok: false, reason: "token is for a different app" };
  if (typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) return { ok: false, reason: "token expired" };
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_SECONDS > now) return { ok: false, reason: "token not yet valid" };
  if (typeof claims.iat === "number" && claims.iat - 300 > now) return { ok: false, reason: "token issued in the future" };
  if (typeof claims.sub !== "string" || !claims.sub) return { ok: false, reason: "missing subject" };
  if (opts.nonce !== undefined && claims.nonce !== opts.nonce) return { ok: false, reason: "nonce mismatch" };

  let subject = claims.sub;
  let email: string | undefined;
  if (provider.id === "google") {
    // Only trust the address when Google says it is verified.
    if (typeof claims.email === "string" && (claims.email_verified === true || claims.email_verified === "true")) email = claims.email;
  } else {
    subject = `${claims.tid}:${typeof claims.oid === "string" ? claims.oid : claims.sub}`;
    const e = typeof claims.email === "string" ? claims.email : typeof claims.preferred_username === "string" ? claims.preferred_username : undefined;
    email = e;
  }
  return {
    ok: true,
    identity: {
      provider: provider.id, subject, ...(email ? { email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name.slice(0, 120) } : {}),
      ...(typeof claims.picture === "string" && /^https:\/\//.test(claims.picture) ? { picture: claims.picture.slice(0, 500) } : {}),
    },
  };
}

/** Stable, opaque storage key for an account. Never derived from the email address. */
export async function userKey(provider: ProviderId, subject: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(`obs-user|${provider}|${subject}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/* ── Session cookie value ─────────────────────────────────────────────── */
export interface SessionPayload {
  /** user key */
  uid: string;
  provider: ProviderId;
  /** expiry, seconds since epoch */
  exp: number;
  name?: string;
  email?: string;
  picture?: string;
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

export async function signSession(p: SessionPayload, secret: string): Promise<string> {
  if (secret.length < 24) throw new Error("SESSION_SECRET must be at least 24 characters");
  const body = b64urlEncode(enc.encode(JSON.stringify(p)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(value: string | null | undefined, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SessionPayload | null> {
  if (!value || !secret || secret.length < 24) return null;
  const [body, sig, extra] = value.split(".");
  if (!body || !sig || extra !== undefined) return null;
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), b64urlDecode(sig), enc.encode(body)); } catch { return null; }
  if (!ok) return null;
  const p = parseJson(body) as Partial<SessionPayload> | null;
  if (!p || typeof p.uid !== "string" || typeof p.exp !== "number" || p.exp < nowSeconds) return null;
  if (p.provider !== "google" && p.provider !== "microsoft") return null;
  return p as SessionPayload;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
