/** Short-lived signed SSE tokens (pure, unit-tested). Remediation Phase 1.2.
 *
 * Query-string bearer tokens leak into logs, proxies, and browser history.
 * The server keeps accepting `?token=` ONLY on the SSE events route for
 * EventSource (which cannot set headers), and prefers these short-lived
 * HMAC tokens instead:
 *
 *   token = base64url(payloadJson) + "." + base64url(HMAC-SHA256(payloadJson, secret))
 *   payloadJson = { room, sub, exp }   (exp = epoch ms)
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

export function issueSseToken(secret, { room, sub = "client", ttlMs = SSE_TOKEN_DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!secret) throw new Error("SSE tokens require a server secret (OBS_SERVER_TOKEN)");
  if (!room || typeof room !== "string") throw new Error("room required");
  const payload = { room, sub: String(sub).slice(0, 64), exp: now + Math.max(1_000, ttlMs) };
  const payloadStr = JSON.stringify(payload);
  return `${b64url(payloadStr)}.${b64url(hmac(payloadStr, secret))}`;
}

/**
 * @returns {{ ok: true, payload: object } | { ok: false, reason:
 *   "malformed" | "bad-signature" | "expired" | "wrong-room" }}
 */
export function verifySseToken(token, secret, { room, now = Date.now() } = {}) {
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
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (room && payload.room !== room) return { ok: false, reason: "wrong-room" };
  return { ok: true, payload };
}
