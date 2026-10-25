/** Security helpers for the collaboration server (pure, unit-tested). */
import crypto from "node:crypto";

const DEFAULT_ORIGINS = [
  "http://localhost:3000", "http://127.0.0.1:3000",
  "http://localhost:5173", "http://127.0.0.1:5173",
  "http://localhost:4173", "http://127.0.0.1:4173",
];

/** OBS_ALLOWED_ORIGINS="https://a.example,https://b.example" replaces the local defaults. */
export function parseAllowedOrigins(env = process.env.OBS_ALLOWED_ORIGINS) {
  const list = String(env ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);
  return new Set(list.length ? list : DEFAULT_ORIGINS);
}

/** null = no Origin header (non-browser client): allowed. false = browser from a disallowed site. */
export function originAllowed(origin, allowed) {
  if (!origin) return null;
  return allowed.has(String(origin).replace(/\/$/, ""));
}

export function corsHeaders(origin, allowed) {
  if (!origin || !allowed.has(String(origin).replace(/\/$/, ""))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  };
}

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-site",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

const RESERVED = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);
/** Project / room ids become object keys and file content keys: plain names only. */
export function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !RESERVED.has(id);
}

/** Constant-time bearer token check. `token` empty = auth disabled. SSE may pass ?token= . */
export function tokenOk(authHeader, queryToken, token) {
  if (!token) return true;
  const given = (/^Bearer\s+(.+)$/i.exec(authHeader || "")?.[1] ?? queryToken ?? "").toString();
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(String(token)).digest();
  return crypto.timingSafeEqual(a, b);
}

const UPLOAD_EXT = new Set([".rvt", ".nwd", ".nwc", ".ifc", ".dwg", ".dxf"]);
/**
 * Make a client-supplied file name safe to use on disk and in headers: base name only, plain
 * characters, bounded length. Returns null when the type is not an accepted upload.
 */
export function safeUploadName(raw) {
  let n = String(raw ?? "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^\.+/, "").trim();
  n = n.slice(-100);
  const dot = n.lastIndexOf(".");
  const ext = dot >= 0 ? n.slice(dot).toLowerCase() : "";
  if (!n || !UPLOAD_EXT.has(ext)) return null;
  return n;
}
