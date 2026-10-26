/** Sliding-window rate limiter (pure, unit-tested). Remediation Phase 1.2.
 *
 * Keys are opaque (caller chooses: ip, token hash, route+ip, ...). The limiter
 * is deliberately generic so the server can layer several budgets:
 *   general HTTP requests, mutation-heavy room actions, SSE connections.
 */
import crypto from "node:crypto";

export function createRateLimiter({ windowMs = 60_000, max = 120, maxKeys = 10_000 } = {}) {
  const hits = new Map(); // key -> number[] (timestamps, ascending)

  function sweep(now) {
    for (const [k, arr] of hits) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (kept.length) hits.set(k, kept);
      else hits.delete(k);
    }
  }

  return {
    /** Record a hit for `key` at `now` and return the decision. */
    check(key, now = Date.now()) {
      if (typeof key !== "string" || !key) key = "(anonymous)";
      let arr = hits.get(key);
      if (!arr) { arr = []; hits.set(key, arr); }
      arr.push(now);
      // Bound memory: drop old entries; if a single key floods, cap the array.
      if (arr.length > max * 4) hits.set(key, arr.slice(-max * 4));
      if (hits.size > maxKeys) sweep(now);
      const window = arr.filter((t) => now - t < windowMs);
      const allowed = window.length <= max;
      const oldest = window.length ? window[0] : now;
      const retryAfterMs = allowed ? 0 : Math.max(0, windowMs - (now - oldest));
      return { allowed, count: window.length, retryAfterMs };
    },
    /** Current count for a key without recording a hit. */
    peek(key, now = Date.now()) {
      const arr = hits.get(key) || [];
      return arr.filter((t) => now - t < windowMs).length;
    },
    reset() { hits.clear(); },
  };
}

/** Stable, non-reversible rate-limit key for a request. Never log the token itself. */
export function clientKey(req, { route = "" } = {}) {
  const ip = req.socket?.remoteAddress || "unknown";
  return route ? `${route}|${ip}` : ip;
}

/** Correlation id: honour an incoming x-request-id, else mint one. */
export function correlationId(req) {
  const incoming = String(req.headers["x-request-id"] || "").trim();
  if (/^[A-Za-z0-9._-]{1,64}$/.test(incoming)) return incoming;
  return `req-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Structured security log. One JSON line per event.
 * Field hygiene (Phase 1.2): never include bearer tokens, query tokens,
 * APS credentials, project contents, or full client file names — callers
 * pass pre-sanitized fields only (this helper also truncates values).
 */
export function securityLog(logger, event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "boolean" || typeof v === "number") { safe[k] = v; continue; }
    let s = typeof v === "string" ? v : JSON.stringify(v);
    if (s && s.length > 120) s = s.slice(0, 117) + "...";
    safe[k] = s;
  }
  logger(JSON.stringify({ ts: new Date().toISOString(), level: "security", event, ...safe }));
}

/** Redact a file name for logs: keep extension + length, drop the name. */
export function redactFileName(name) {
  const n = String(name ?? "");
  const dot = n.lastIndexOf(".");
  const ext = dot >= 0 ? n.slice(dot).toLowerCase() : "(none)";
  return `${ext}(len=${n.length})`;
}
