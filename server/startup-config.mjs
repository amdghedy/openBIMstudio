/** Fail-closed startup configuration for the collaboration server (pure, unit-tested).
 *
 * Remediation program Phase 1.2 (docs/engineering/BASELINE.md §8.1):
 * non-loopback binding without a strong token used to print a warning and
 * continue. It must be refused instead.
 *
 * Policy:
 *  - Default bind is loopback (127.0.0.1). Token optional for local dev.
 *  - Any non-loopback bind REQUIRES OBS_SERVER_TOKEN (>= 16 chars) AND an
 *    explicit OBS_ALLOWED_ORIGINS list (no "*", at least one https:// or
 *    explicitly-listed http origin). Missing/weak → startup refused.
 *  - HTTPS itself is terminated by a reverse proxy in network deployments
 *    (documented in docs/engineering/BASELINE.md and deployment guide).
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "127.0.0.1.".slice(0, 9)]);

export function isLoopbackHost(host) {
  if (typeof host !== "string") return false;
  const h = host.trim().toLowerCase();
  return LOOPBACK.has(h) || h.startsWith("127.");
}

/** Minimum acceptable token strength: >= 16 chars, not a trivial repeat. */
export function tokenIsStrong(token) {
  if (typeof token !== "string") return false;
  const t = token.trim();
  if (t.length < 16) return false;
  if (/^(.)\1+$/.test(t)) return false; // "aaaaaaaaaaaaaaaa"
  if (/^(1234|password|secret|token|changeme|admin)/i.test(t)) return false;
  return true;
}

/** Parse and validate an explicit origin allow-list. Returns { ok, origins } . */
export function parseExplicitOrigins(raw) {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (!list.length) return { ok: false, reason: "OBS_ALLOWED_ORIGINS must list at least one origin" };
  if (list.includes("*")) return { ok: false, reason: "OBS_ALLOWED_ORIGINS must not contain '*'" };
  for (const o of list) {
    if (!/^https?:\/\//.test(o)) return { ok: false, reason: `origin not absolute: ${o}` };
    if (/\s/.test(o)) return { ok: false, reason: "origin contains whitespace" };
  }
  return { ok: true, origins: list };
}

/**
 * Decide whether the server may start. Pure — no process access.
 * @returns {{ ok: true, host: string, token: string, origins: string[] }
 *          | { ok: false, reason: string }}
 */
export function resolveStartupConfig({ host, token, allowedOrigins }) {
  const h = String(host ?? "127.0.0.1").trim();
  const loopback = isLoopbackHost(h);

  if (!loopback) {
    if (!token) {
      return {
        ok: false,
        reason:
          `Refusing to bind ${h}: non-loopback bind requires OBS_SERVER_TOKEN. ` +
          `Local development does not need this — remove HOST to bind 127.0.0.1.`,
      };
    }
    if (!tokenIsStrong(token)) {
      return {
        ok: false,
        reason:
          `Refusing to bind ${h}: OBS_SERVER_TOKEN is set but too weak ` +
          `(minimum 16 characters, not a trivial value).`,
      };
    }
    const origins = parseExplicitOrigins(allowedOrigins);
    if (!origins.ok) {
      return {
        ok: false,
        reason:
          `Refusing to bind ${h}: non-loopback mode requires an explicit ` +
          `origin allow-list (${origins.reason}).`,
      };
    }
    return { ok: true, host: h, token, origins: origins.origins };
  }

  // Loopback: token optional; explicit origins optional (local defaults apply).
  const origins = allowedOrigins ? parseExplicitOrigins(allowedOrigins) : { ok: true, origins: null };
  if (!origins.ok) return { ok: false, reason: origins.reason };
  return { ok: true, host: h, token: token || "", origins: origins.origins };
}
