const API_BASE = String(
  (globalThis as any).__OPENBIM_COLLAB_API__ ||
    "http://localhost:4000/api",
);

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

  private es: EventSource | null = null;
  private hb: number | null = null;

  async join(roomId: string, name = "Guest"): Promise<boolean> {
    this.stop();

    this.roomId = String(roomId || "").trim();
    this.name = String(name || "Guest").trim() || "Guest";
    this.clientId =
      this.clientId ||
      `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    if (!this.roomId) {
      return false;
    }

    try {
      await fetch(`${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          name: this.name,
        }),
      });
    } catch {
      // Server may be offline; still attempt SSE.
    }

    const url = `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/events`;

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
        const presence = JSON.parse(String(ev.data || "[]")) as PresenceUser[];
        this.dispatch("obs:presence", { presence, roomId: this.roomId });
      } catch {
        // ignore malformed event
      }
    });

    this.es.addEventListener("change", (ev: MessageEvent) => {
      try {
        const change = JSON.parse(String(ev.data || "{}")) as RemoteChange;

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
          headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: this.clientId }),
        },
      ).catch(() => {
        // offline tolerant
      });
    }

    this.connected = false;
    this.dispatch("obs:live-disconnected", { roomId: this.roomId });
  }

  async sendChange(type: string, payload: Any = {}): Promise<boolean> {
    if (!this.roomId || !this.clientId) {
      return false;
    }

    try {
      const res = await fetch(
        `${API_BASE}/rooms/${encodeURIComponent(this.roomId)}/change`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

(globalThis as Any).__obsRealtimeClient = realtimeClient;

export function setupRealtimeClient(): void {
  console.log("[realtime-client] ready. Use __obsRealtimeClient.join(roomId, name)");
}