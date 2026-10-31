/**
 * Vercel Edge Function: /api/visits
 *
 * Same-origin proxy to the studio's ONE global visit counter, which lives on
 * the Cloudflare edge as a Durable Object (worker/index.ts). The Vercel build
 * is static and has no counter backend of its own, so this function lets the
 * Vercel deployment read and feed the same global count with a plain
 * same-origin request — no cross-origin fetch from the browser, no CORS
 * pitfalls, no per-site numbers.
 *
 * Visitor identity is forwarded (client IP + User-Agent), so a visitor still
 * counts once per 30-minute session across ALL deployments of the studio
 * (Cloudflare, Vercel, ...). The upstream worker prefers the forwarded
 * `x-obs-visitor-ip` header over `cf-connecting-ip` (Cloudflare overwrites
 * `cf-connecting-ip` with the connecting IP, which here would be Vercel's
 * egress node — identical for every visitor).
 */

const UPSTREAM = "https://openbimstudio.amdghedy.workers.dev/api/visits";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
} as const;

export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-max-age": "86400",
      },
    });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: JSON_HEADERS,
    });
  }
  const ip =
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "";
  try {
    const upstream = await fetch(UPSTREAM, {
      method: request.method,
      headers: {
        "x-obs-visitor-ip": ip,
        "user-agent": request.headers.get("user-agent") ?? "",
      },
    });
    return new Response(upstream.body, { status: upstream.status, headers: JSON_HEADERS });
  } catch (cause) {
    console.warn("[visits proxy] upstream unavailable:", cause);
    return new Response(JSON.stringify({ visits: null, loads: null, uniques: null }), {
      status: 503,
      headers: JSON_HEADERS,
    });
  }
}
