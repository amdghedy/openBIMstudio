/** Signed, single-room, role-scoped share tokens (pure, unit-tested).
 *
 * A share link opens one model (one room) in any browser with no account
 * and no licence. The link carries a token, not the long-lived
 * OBS_SERVER_TOKEN:
 *
 *   token = base64url(payloadJson) + "." + base64url(HMAC-SHA256(payloadJson, secret))
 *   payloadJson = { room, role, sid, exp }   (exp = epoch ms)
 *
 *   room  — the room (model) this link opens.
 *   role  — "view" (read-only: presence + SSE + room reads) or "edit"
 *           (view + POST /change). The server enforces the role on every
 *           room route; the client only mirrors it in the UI.
 *   sid   — share id. The server keeps a registry (shares.json) keyed by
 *           sid so a link can be REVOKED before it expires; a token whose
 *           sid has no live registry record does not authenticate.
 *   exp   — expiry. Default TTL 7 days, clamped to [1 minute, 90 days].
 *
 * URL trade-off (same documented trade-off as the SSE ?token= form):
 * the token travels in the link URL, so it can land in browser history,
 * proxy logs and referrer headers. That is acceptable here because the
 * token is single-room, role-scoped, short-lived relative to the master
 * token, and revocable — unlike the master token, which must never be
 * put in a URL. Share creation itself always requires the master token.
 */
import crypto from "node:crypto";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

function hmac(payloadStr, secret) {
  return crypto.createHmac("sha256", secret).update(payloadStr).digest();
}

export const SHARE_ROLES = ["view", "edit"];
export const SHARE_TOKEN_DEFAULT_TTL_MS = 7 * 24 * 60 * 60_000;
export const SHARE_TOKEN_MAX_TTL_MS = 90 * 24 * 60 * 60_000;
export const SHARE_TOKEN_MIN_TTL_MS = 60_000;

export function isShareRole(role) {
  return role === "view" || role === "edit";
}

export function clampShareTtlMs(ttlMs) {
  const n = Number(ttlMs);
  if (!Number.isFinite(n)) return SHARE_TOKEN_DEFAULT_TTL_MS;
  return Math.min(SHARE_TOKEN_MAX_TTL_MS, Math.max(SHARE_TOKEN_MIN_TTL_MS, Math.floor(n)));
}

export function issueShareToken(secret, { room, role, sid, ttlMs = SHARE_TOKEN_DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!secret) throw new Error("Share tokens require a server secret (OBS_SERVER_TOKEN)");
  if (!room || typeof room !== "string") throw new Error("room required");
  if (!isShareRole(role)) throw new Error("role must be 'view' or 'edit'");
  if (!sid || typeof sid !== "string") throw new Error("sid required");
  const payload = { room, role, sid: String(sid).slice(0, 128), exp: now + clampShareTtlMs(ttlMs) };
  const payloadStr = JSON.stringify(payload);
  return `${b64url(payloadStr)}.${b64url(hmac(payloadStr, secret))}`;
}

/**
 * @returns {{ ok: true, payload: object } | { ok: false, reason:
 *   "malformed" | "bad-signature" | "expired" | "wrong-room" | "bad-role" }}
 */
export function verifyShareToken(token, secret, { room, now = Date.now() } = {}) {
  const t = String(token ?? "");
  const dot = t.indexOf(".");
  if (dot <= 0 || t.indexOf(".", dot + 1) !== -1) return { ok: false, reason: "malformed" };
  // Strict base64url: Node's decoder silently drops non-alphabet characters,
  // so a garbage part must be rejected here instead of verifying against
  // whatever the lenient decode produced.
  const head = t.slice(0, dot);
  const tail = t.slice(dot + 1);
  if (Buffer.from(head, "base64url").toString("base64url") !== head ||
      Buffer.from(tail, "base64url").toString("base64url") !== tail) {
    return { ok: false, reason: "malformed" };
  }
  const payloadStr = Buffer.from(head, "base64url").toString("utf8");
  let expected;
  try {
    expected = hmac(payloadStr, secret);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const given = Buffer.from(t.slice(dot + 1), "base64url");
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "bad-signature" };
  let payload;
  try { payload = JSON.parse(payloadStr); } catch { return { ok: false, reason: "malformed" }; }
  if (!payload || typeof payload.exp !== "number" || typeof payload.room !== "string" ||
      typeof payload.sid !== "string" || !payload.sid) {
    return { ok: false, reason: "malformed" };
  }
  if (!isShareRole(payload.role)) return { ok: false, reason: "bad-role" };
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (room && payload.room !== room) return { ok: false, reason: "wrong-room" };
  return { ok: true, payload };
}
