// legacy module-local state (formerly on window)
// eslint-disable-next-line no-unused-vars
let obsRealtimeClient: any;

import { decodeShareToken } from "./share-session";

const API_BASE = String(
  (globalThis as any).__OPENBIM_COLLAB_API__ ||
    "http://localhost:4000/api",
);

/**
 * Largest SSE event payload accepted before parsing (issue #90). Mirrors the
 * server's OBS_MAX_CHANGE_PAYLOAD (2 MB, server/index.mjs): the relay
 * bounds what it forwards, and the client drops anything larger rather than
 * parsing an unbounded event into project state.
 */
export const MAX_SSE_EVENT_BYTES = 2 * 1024 * 1024;
/** The collab-server base URL (overridable for tests / deployments). */
export function getCollabApiBase(): string {
  return API_BASE;
}

/* Optional auth for network deployments (remediation Phase 1.2).
 *  __OPENBIM_COLLAB_TOKEN__             → long-lived token; sent as Bearer on
 *                                         POSTs and as ?token= on the SSE URL
 *                                         (EventSource cannot set headers).
 *  __OPENBIM_COLLAB_SSE_TOKEN_PROVIDER__ → optional async () => string returning
 *                                         a SHORT-LIVED signed SSE token
 *                                         (preferred over ?token=; the server
 *                                         mints these via /server/sse-tokens.mjs).
 * Local-first default (loopback, no token) needs neither.
 */
function collabToken(): string {
  return String((globalThis as any).__OPENBIM_COLLAB_TOKEN__ || "");
}
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = collabToken();
  return t ? { Authorization: `Bearer ${t}`, ...extra } : { ...extra };
}

/** Master-token headers for calls that a share token must never make (e.g. minting shares). */
export function collabAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return authHeaders(extra);
}

type Any = Record<string, any>;

export interface PresenceUser {
  clientId: string;
  name: string;
  cursor?: Any | null;
  updatedAt?: number;
}

export interface RemoteChange {
  id?: string;
  clientId: string;
  type: string;
  payload?: Any;
  at?: string;
}

class RealtimeClient {
  roomId = "";
  clientId = "";
  name = "Guest";
  connected = false;
  /** "owner" when joined with the master token (or none); "view"/"edit" under a share link. */
  role: "owner" | "view" | "edit" = "owner";

  private es: EventSource | null = null;
  private hb: number | null = null;
  private shareToken = "";

  /** Headers for room calls: the share token when under a link, else the master token. */
  private roomHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return this.shareToken
      ? { Authorization: `Bearer ${this.shareToken}`, ...extra }
      : authHeaders(extra);
  }

  async join(roomId: string, name = "Guest", opts: { shareToken?: string } = {}): Promise<boolean> {
    this.stop();

    this.roomId = String(roomId || "").trim();
    this.name = String(name || "Guest").trim() || "Guest";
    this.clientId =
      this.clientId ||
      `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    // Share-link join: the token is the credential and the role. The server
    // verifies it; the decoded role here only drives client-side mirrors.
    this.shareToken = String(opts.shareToken || "");
    this.role = "owner";
    if (this.shareToken) {
      const decoded = decodeShareToken(this.shareToken);
      if (!decoded || decoded.room !== this.roomId) {
        this.shareToken = "";
        return false;
      }
      this.role = decoded.role;
    }

    if (!this.roomId) {
      return false;
    }

    try {
      await fetch(`${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/join`, {
        method: "POST",
        headers: this.roomHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          clientId: this.clientId,
          name: this.name,
        }),
      });
    } catch {
      // Server may be offline; still attempt SSE.
    }

    let sseQuery = "";
    try {
      const provider = (globalThis as any).__OPENBIM_COLLAB_SSE_TOKEN_PROVIDER__;
      if (typeof provider === "function") {
        const sse = await provider();
        if (sse) sseQuery = `?sse=${encodeURIComponent(String(sse))}`;
      }
    } catch { /* fall through to unauthenticated/local behavior */ }
    if (!sseQuery && this.shareToken) {
      // Share links authenticate the event stream with ?share= (the server
      // verifies the token + the revocation registry per connection).
      sseQuery = `?share=${encodeURIComponent(this.shareToken)}`;
    }
    if (!sseQuery && collabToken()) {
      // Documented trade-off: long-lived token in the SSE URL (EventSource
      // limitation). Prefer the short-lived signed provider above.
      sseQuery = `?token=${encodeURIComponent(collabToken())}`;
    }

    const url = `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/events${sseQuery}`;

    try {
      this.es = new EventSource(url);
    } catch {
      this.connected = false;
      return false;
    }

    this.es.onopen = () => {
      this.connected = true;
      this.dispatch("obs:live-connected", { roomId: this.roomId });
    };

    this.es.onerror = () => {
      this.connected = false;
      this.dispatch("obs:live-disconnected", { roomId: this.roomId });
    };

    this.es.addEventListener("presence", (ev: MessageEvent) => {
      try {
        // Size bound before parse (issue #90): the server caps change
        // payloads at 2 MB (OBS_MAX_CHANGE_PAYLOAD); anything larger from
        // the relay is dropped, and a non-array presence payload is ignored.
        const raw = String(ev.data || "[]");
        if (raw.length > MAX_SSE_EVENT_BYTES) return;
        const presence = JSON.parse(raw) as PresenceUser[];
        if (!Array.isArray(presence)) return;
        this.dispatch("obs:presence", { presence, roomId: this.roomId });
      } catch {
        // ignore malformed event
      }
    });

    this.es.addEventListener("change", (ev: MessageEvent) => {
      try {
        const raw = String(ev.data || "{}");
        if (raw.length > MAX_SSE_EVENT_BYTES) return;
        const change = JSON.parse(raw) as RemoteChange;
        if (!change || typeof change !== "object" || Array.isArray(change)) return;
        if (typeof change.clientId !== "string" || typeof change.type !== "string") return;

        if (change.clientId === this.clientId) {
          return;
        }

        this.dispatch("obs:remote-change", { change, roomId: this.roomId });
      } catch {
        // ignore malformed event
      }
    });

    this.hb = window.setInterval(() => {
      void fetch(
        `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/heartbeat`,
        {
          method: "POST",
          headers: this.roomHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            clientId: this.clientId,
            name: this.name,
          }),
        },
      ).catch(() => {
        // offline tolerant
      });
    }, 10000);

    return true;
  }

  stop(): void {
    if (this.hb !== null) {
      window.clearInterval(this.hb);
      this.hb = null;
    }

    if (this.es) {
      try {
        this.es.close();
      } catch {
        // ignore
      }

      this.es = null;
    }

    if (this.roomId && this.clientId) {
      void fetch(
        `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/leave`,
        {
          method: "POST",
          headers: this.roomHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ clientId: this.clientId }),
        },
      ).catch(() => {
        // offline tolerant
      });
    }

    this.connected = false;
    this.shareToken = "";
    this.role = "owner";
    this.dispatch("obs:live-disconnected", { roomId: this.roomId });
  }

  async sendChange(type: string, payload: Any = {}): Promise<boolean> {
    if (!this.roomId || !this.clientId) {
      return false;
    }

    // Client mirror of the server rule: a view-only link may still send
    // selection locks (presence), but no model change. The server enforces
    // this with 403; refusing here keeps the UI honest before the round trip.
    if (this.role === "view" && type !== "lock" && type !== "unlock") {
      return false;
    }

    try {
      const res = await fetch(
        `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/change`,
        {
          method: "POST",
          headers: this.roomHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            clientId: this.clientId,
            type,
            payload,
          }),
        },
      );

      return res.ok;
    } catch {
      return false;
    }
  }

  getPresenceUrl(): string {
    return `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}`;
  }

  private dispatch(name: string, detail: Any): void {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      // ignore
    }
  }
}

export const realtimeClient = new RealtimeClient();

obsRealtimeClient = realtimeClient;

export function setupRealtimeClient(): void {
  console.log("[realtime-client] ready. Use __obsRealtimeClient.join(roomId, name)");
}