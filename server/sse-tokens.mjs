/** Short-lived signed SSE tokens (pure, unit-tested). Remediation Phase 1.2.
 *
 * Query-string bearer tokens leak into logs, proxies, and browser history.
 * Both SSE routes accept these short-lived HMAC tokens as `?sse=` (or a
 * Bearer header) — the long-lived `?token=` form is refused everywhere
 * since #92 item 5 (room route) and the agent-scope work that followed
 * (agent route). Mint one from POST /api/rooms/:id/sse-token (room scope)
 * or POST /api/agent/sse-token (agent scope).
 *
 * Scopes: a token is bound to a (room, scope) pair. Room tokens have
 * scope "room" and the room id; agent tokens have scope "agent" and the
 * reserved room "__agent__" (which can never be a real room id — validId
 * rejects a leading underscore — so no room mint can ever produce one).
 * A token minted for one scope never opens the other route.
 *
 *   token = base64url(payloadJson) + "." + base64url(HMAC-SHA256(payloadJson, secret))
 *   payloadJson = { room, sub, scope, exp }   (exp = epoch ms)
 *
 * Replay window == TTL (stateless); short TTLs keep replay exposure small.
 * The long-lived OBS_SERVER_TOKEN must never be put in a URL.
 */
import crypto from "node:crypto";

function b64url(buf) { return Buffer.from(buf).toString("base64url"); }

function hmac(payloadStr, secret) {
  return crypto.createHmac("sha256", secret).update(payloadStr).digest();
}

export const SSE_TOKEN_DEFAULT_TTL_MS = 5 * 60_000;
/** Reserved (room, scope) pair for agent-relay SSE tokens. */
export const AGENT_SSE_ROOM = "__agent__";
export const AGENT_SSE_SCOPE = "agent";
export const ROOM_SSE_SCOPE = "room";

export function issueSseToken(secret, { room, sub = "client", scope = ROOM_SSE_SCOPE, ttlMs = SSE_TOKEN_DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!secret) throw new Error("SSE tokens require a server secret (OBS_SERVER_TOKEN)");
  if (!room || typeof room !== "string") throw new Error("room required");
  if (scope !== ROOM_SSE_SCOPE && scope !== AGENT_SSE_SCOPE) throw new Error("unknown SSE token scope");
  // Scopes are bound to their subject: an agent token may only ever be
  // minted for the reserved agent subject, and a room token may never be
  // minted for it. This keeps a future mint-endpoint bug from crossing the
  // room/agent boundary at issuance time (verify enforces it again).
  if (scope === AGENT_SSE_SCOPE && room !== AGENT_SSE_ROOM) throw new Error("agent SSE tokens require the agent room");
  if (scope === ROOM_SSE_SCOPE && room === AGENT_SSE_ROOM) throw new Error("room SSE tokens cannot use the agent room");
  const payload = { room, sub: String(sub).slice(0, 64), scope, exp: now + Math.max(1_000, ttlMs) };
  const payloadStr = JSON.stringify(payload);
  return `${b64url(payloadStr)}.${b64url(hmac(payloadStr, secret))}`;
}

/**
 * @returns {{ ok: true, payload: object } | { ok: false, reason:
 *   "malformed" | "bad-signature" | "expired" | "wrong-room" | "wrong-scope" }}
 */
export function verifySseToken(token, secret, { room, scope, now = Date.now() } = {}) {
  const t = String(token ?? "");
  const dot = t.indexOf(".");
  if (dot <= 0 || t.indexOf(".", dot + 1) !== -1) return { ok: false, reason: "malformed" };
  const payloadStr = Buffer.from(t.slice(0, dot), "base64url").toString("utf8");
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
  if (!payload || typeof payload.exp !== "number" || typeof payload.room !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.scope !== undefined && typeof payload.scope !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (room && payload.room !== room) return { ok: false, reason: "wrong-room" };
  // Tokens minted before scopes existed carry no scope field; they count as
  // room-scope (the only scope that existed), so old room tokens keep
  // working for their 5-minute lifetime and can never open the agent route.
  if (scope && (payload.scope ?? ROOM_SSE_SCOPE) !== scope) return { ok: false, reason: "wrong-scope" };
  return { ok: true, payload };
}
