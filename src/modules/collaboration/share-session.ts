/**
 * Share-link session state — the client-side half of "share a live model
 * by link" (differentiation item 1).
 *
 * This module is deliberately tiny and dependency-free: it holds only the
 * current share session (room + role + token) so that the authoring gate
 * (authoring.ts) can ask "is this a view-only session?" without importing
 * the whole share feature (which would be a cycle: share-links imports the
 * authoring-adjacent project modules, authoring must not import it back).
 *
 * The token is decoded here for UI routing only (which room, which role).
 * It is NEVER trusted: the server verifies the signature, the expiry and
 * the revocation registry on every room/project request, and view-only is
 * enforced there. A tampered token only changes what the UI shows until
 * the first server call fails.
 */
export type ShareRole = "view" | "edit";

export interface ShareSession {
  room: string;
  role: ShareRole;
  /** The signed token, as carried in the share link. */
  token: string;
  /** Registry id (from the token payload); null when the session is the owner. */
  sid: string | null;
  /** Expiry from the token payload (epoch ms), or null when unknown. */
  expiresAt: number | null;
}

export interface DecodedShareToken {
  room: string;
  role: ShareRole;
  sid: string;
  exp: number;
}

let current: ShareSession | null = null;
const listeners = new Set<(session: ShareSession | null) => void>();

function dispatch(): void {
  try {
    window.dispatchEvent(new CustomEvent("obs:share-role", { detail: { session: current } }));
  } catch { /* non-DOM context (tests) */ }
  for (const fn of [...listeners]) {
    try { fn(current); } catch { /* listener failure must not break the session */ }
  }
}

export function getShareSession(): ShareSession | null {
  return current;
}

export function setShareSession(session: ShareSession | null): void {
  current = session;
  dispatch();
}

export function clearShareSession(): void {
  setShareSession(null);
}

/** True when the open model arrived through a view-only share link. */
export function isViewOnly(): boolean {
  return current?.role === "view";
}

export function onShareSessionChange(fn: (session: ShareSession | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function b64urlDecode(input: string): string | null {
  try {
    const s = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
    if (typeof atob === "function") {
      const bin = atob(padded);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Decode a share token's payload without verifying it (UI routing only). */
export function decodeShareToken(token: string): DecodedShareToken | null {
  try {
    const t = String(token || "");
    const dot = t.indexOf(".");
    if (dot <= 0 || t.indexOf(".", dot + 1) !== -1) return null;
    const raw = b64urlDecode(t.slice(0, dot));
    if (!raw) return null;
    const payload = JSON.parse(raw) as Partial<DecodedShareToken>;
    if (typeof payload.room !== "string" || !payload.room) return null;
    if (payload.role !== "view" && payload.role !== "edit") return null;
    if (typeof payload.sid !== "string" || !payload.sid) return null;
    if (typeof payload.exp !== "number") return null;
    return { room: payload.room, role: payload.role, sid: payload.sid, exp: payload.exp };
  } catch {
    return null;
  }
}
