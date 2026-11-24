/**
 * Draft: "fetch a cut sheet from a link" for the family creator.
 *
 * POST /api/fetch-sheet  { "url": "https://...", "consent": true }
 *
 * DISABLED BY DEFAULT. The route answers 404 unless BOTH are set on the
 * Worker: FETCH_SHEET_ENABLED = "1" and FETCH_SHEET_ALLOWED_HOSTS = a comma
 * list of exact host names (no wildcards). Only those hosts can be fetched;
 * an empty list keeps the route off. Nothing here is deployed or switched on.
 *
 * Defences (unit-tested in tests/fetch-sheet-ssrf.test.cjs):
 *  - explicit host allow-list, re-checked on every redirect hop
 *  - https only, no credentials, port 443 only, overlong URLs refused
 *  - IP literals in any notation, localhost and internal-looking names refused
 *  - redirects followed by hand, max 3
 *  - streamed size cap, timeout, content-type allow-list, no cookies or
 *    caller headers sent, same-origin Origin check
 *  - signed-in session required, and a durable per-user rate limit kept in
 *    the account Durable Object (AuthVault), not in isolate memory
 *
 * Plainly stated limits:
 *  - Host-name checks are NOT a full SSRF defence. A Worker cannot see which
 *    IP a name resolves to. The allow-list is what carries the safety: only
 *    approve hosts you trust to resolve to public addresses. Cloudflare's
 *    own egress protections for this case are not verified here.
 *  - Cost and plan limits of the deployed account are not verified.
 *  - It has been exercised in a local Worker runtime only, never deployed.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const TIMEOUT_MS = 10_000;
export const ALLOWED_TYPES = ["application/pdf", "image/png", "image/jpeg", "text/plain"];

const BLOCKED_SUFFIXES = [
  ".localhost", ".local", ".localdomain", ".internal", ".intranet", ".lan", ".home", ".corp",
  ".home.arpa", ".test", ".invalid", ".example", ".onion", ".workers.dev", ".pages.dev",
];

export interface Verdict { ok: boolean; url?: URL; code?: string }

/** Anything that is, or could be parsed as, an IP address. */
function looksLikeIp(host: string): boolean {
  if (host.includes(":")) return true; // IPv6 (bracketed hosts lose brackets in URL.hostname, colons remain)
  const labels = host.split(".");
  const last = labels[labels.length - 1];
  // A real TLD is never all digits or 0x-hex; those forms are IPv4 spellings.
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/i.test(last)) return true;
  return false;
}

export function checkTarget(raw: unknown, allowed?: string[]): Verdict {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return { ok: false, code: "bad_url" };
  if (/[\u0000-\u0020\u007f-\u009f\\]/.test(raw)) return { ok: false, code: "bad_url" };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, code: "bad_url" }; }
  if (u.protocol !== "https:") return { ok: false, code: "not_https" };
  if (u.username || u.password) return { ok: false, code: "credentials_in_url" };
  if (u.port !== "" && u.port !== "443") return { ok: false, code: "bad_port" };
  let host = u.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "" || host.length > 253) return { ok: false, code: "bad_host" };
  if (looksLikeIp(host)) return { ok: false, code: "ip_literal" };
  if (!host.includes(".")) return { ok: false, code: "internal_host" };
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, code: "internal_host" };
  if (!host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return { ok: false, code: "bad_host" };
  if (allowed && !allowed.includes(host)) return { ok: false, code: "host_not_allowed" };
  return { ok: true, url: u };
}

/** Parse the FETCH_SHEET_ALLOWED_HOSTS variable: exact host names, comma separated. */
export function parseAllowedHosts(v: string | undefined): string[] {
  return (v || "").split(",").map((x) => x.trim().toLowerCase().replace(/\.$/, "")).filter((x) => x && !x.includes("*") && !x.includes("/") && !x.includes(":"));
}

export function typeAllowed(contentType: string | null): string | null {
  const base = (contentType || "").split(";")[0].trim().toLowerCase();
  return ALLOWED_TYPES.includes(base) ? base : null;
}

/** Read a body but stop (and cancel) the moment it passes the cap. */
export async function readCapped(res: Response, cap = MAX_BYTES): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) { try { await res.body?.cancel(); } catch { /* */ } return null; }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface FetchResult { ok: boolean; bytes?: Uint8Array; type?: string; host?: string; code?: string }

/** Fetch with every hop validated. Sends no cookies and no caller headers. */
export async function safeFetch(rawUrl: string, allowed: string[], doFetch: FetchLike = (u, i) => fetch(u, i)): Promise<FetchResult> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = checkTarget(current, allowed);
    if (!verdict.ok) return { ok: false, code: hop === 0 ? verdict.code : "redirect_" + verdict.code };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(verdict.url!.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: ALLOWED_TYPES.join(", "), "user-agent": "OpenBIMStudio-sheet-fetch/1" },
        signal: ctl.signal,
      });
    } catch {
      clearTimeout(timer);
      return { ok: false, code: "unreachable" };
    }
    try {
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* */ }
        if (!loc) return { ok: false, code: "bad_redirect" };
        let next: string;
        try { next = new URL(loc, verdict.url!).toString(); } catch { return { ok: false, code: "bad_redirect" }; }
        current = next;
        continue;
      }
      if (res.status !== 200) { try { await res.body?.cancel(); } catch { /* */ } return { ok: false, code: "upstream_status" }; }
      const type = typeAllowed(res.headers.get("content-type"));
      if (!type) { try { await res.body?.cancel(); } catch { /* */ } return { ok: false, code: "type_not_allowed" }; }
      const bytes = await readCapped(res);
      if (!bytes) return { ok: false, code: "too_large" };
      return { ok: true, bytes, type, host: verdict.url!.hostname };
    } catch (e) {
      return { ok: false, code: ctl.signal.aborted ? "timeout" : "unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, code: "too_many_redirects" };
}

const STATUS: Record<string, number> = {
  bad_url: 400, not_https: 400, credentials_in_url: 400, bad_port: 400, bad_host: 400, ip_literal: 400, internal_host: 400,
  need_consent: 400, host_not_allowed: 403, bad_body: 400, signin: 401, cross_site: 403, rate_limited: 429,
  too_large: 413, type_not_allowed: 415, upstream_status: 502, unreachable: 502, bad_redirect: 502, too_many_redirects: 502, timeout: 504,
};

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
const err = (code: string) =>
  new Response(JSON.stringify({ error: code.replace(/^redirect_/, "redirect: ") }), {
    status: STATUS[code] ?? (code.startsWith("redirect_") ? 400 : 400),
    headers: { "content-type": "application/json", ...NO_STORE },
  });

export interface FetchSheetDeps {
  enabled: boolean;
  /** Exact host names this site may fetch from. Empty means the route stays off. */
  allowedHosts: string[];
  /** Signed-in check plus a durable per-user rate slot (kept in the account Durable Object). */
  admit: (request: Request) => Promise<"ok" | "signin" | "limited">;
  doFetch?: FetchLike;
}

/** Returns null when the path is not ours, so the caller falls through. */
export async function handleFetchSheet(request: Request, deps: FetchSheetDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/fetch-sheet") return null;
  if (!deps.enabled || deps.allowedHosts.length === 0) return new Response("Not found", { status: 404, headers: NO_STORE });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...NO_STORE } });
  const origin = request.headers.get("origin");
  if (!origin || origin !== url.origin) return err("cross_site");
  const verdict = await deps.admit(request);
  if (verdict === "signin") return err("signin");
  if (verdict === "limited") return err("rate_limited");
  let body: { url?: unknown; consent?: unknown };
  try {
    const text = await request.text();
    if (text.length > MAX_URL_LENGTH + 200) return err("bad_body");
    body = JSON.parse(text);
  } catch { return err("bad_body"); }
  if (!body || body.consent !== true) return err("need_consent");
  const result = await safeFetch(String(body.url ?? ""), deps.allowedHosts, deps.doFetch);
  if (!result.ok) return err(result.code || "unreachable");
  return new Response(result.bytes as unknown as BodyInit, {
    status: 200,
    headers: { "content-type": result.type as string, "content-disposition": "attachment", "x-fetched-host": result.host as string, ...NO_STORE },
  });
}
