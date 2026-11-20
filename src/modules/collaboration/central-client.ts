/**
 * Central sync client — the browser (and Node) side of the server-
 * authoritative worksharing protocol (see server/central-model.mjs and
 * docs/engineering/COLLABORATION_SYNC.md).
 *
 * The client keeps:
 *  - `revision`: the last server sequence number it has applied;
 *  - an offline queue of ops submitted while not joined, replayed on
 *    (re)join. Replays are safe: every op carries a client-generated
 *    `opId` idempotency key and the server dedupes it, so a replayed op
 *    returns the original result instead of applying twice.
 *  - a live SSE subscription to the room's events channel, which carries
 *    `central-op` events; on any gap (missed sequence numbers) it
 *    re-syncs with GET /sync?since=<revision>.
 *
 * This client does NOT merge, order, or resolve anything locally: the
 * server is the only ordering authority. Local state is replaced by the
 * server's state whenever the two disagree (full-state re-sync).
 *
 * Auth reuses the realtime-client conventions: `__OPENBIM_COLLAB_TOKEN__`
 * (Bearer on POSTs) and the optional
 * `__OPENBIM_COLLAB_SSE_TOKEN_PROVIDER__` for the EventSource URL.
 * An `EventSource` factory can be injected (the Node tests pass a small
 * HTTP-based SSE reader); in the browser the global EventSource is used.
 *
 * The API base is read per request (not captured at module load) so a
 * client survives a server restart on a different port.
 */

function apiBase(): string {
  return String(
    (globalThis as any).__OPENBIM_COLLAB_API__ ||
      "http://localhost:4000/api",
  );
}

function collabToken(): string {
  return String((globalThis as any).__OPENBIM_COLLAB_TOKEN__ || "");
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = collabToken();
  return t ? { Authorization: `Bearer ${t}`, ...extra } : { ...extra };
}

export type CentralElement = {
  id: string;
  worksetId: string;
  version: number;
  createdBy: string;
  fields: Record<string, any>;
};

export interface CentralState {
  roomId: string;
  revision: number;
  elements: Record<string, CentralElement>;
  worksets: Record<string, any>;
  borrows: Record<string, any>;
  borrowRequests: any[];
  members: Record<string, any>;
  conflicts: any[];
  openConflictCount: number;
  totalConflicts: number;
}

export interface CentralOpResult {
  ok: boolean;
  duplicate?: boolean;
  revision: number;
  entry?: any;
  applied?: Record<string, any>;
  rejected?: Record<string, any>;
  conflicts?: any[];
  error?: string;
  status?: number;
}

type EventSourceLike = {
  close(): void;
  onopen: ((ev: any) => void) | null;
  onerror: ((ev: any) => void) | null;
  addEventListener(type: string, listener: (ev: any) => void): void;
};

function newOpId(): string {
  if (typeof crypto !== "undefined" && typeof (crypto as any).randomUUID === "function") {
    return `op-${(crypto as any).randomUUID()}`;
  }
  return `op-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class CentralClient {
  roomId = "";
  clientId = "";
  name = "Guest";
  connected = false;
  joined = false;
  revision = 0;
  state: CentralState | null = null;

  private es: EventSourceLike | null = null;
  private hb: number | null = null;
  private queue: Array<{ opId: string; body: Record<string, any>; resolve: (r: CentralOpResult) => void }> = [];
  private onState: Array<(state: CentralState) => void> = [];
  private onConflict: Array<(conflicts: any[]) => void> = [];
  private eventSourceFactory: ((url: string) => EventSourceLike) | null;

  constructor(eventSourceFactory?: (url: string) => EventSourceLike) {
    this.eventSourceFactory = eventSourceFactory || null;
  }

  subscribeState(fn: (state: CentralState) => void): void {
    this.onState.push(fn);
  }

  subscribeConflicts(fn: (conflicts: any[]) => void): void {
    this.onConflict.push(fn);
  }

  private emitState(): void {
    if (!this.state) return;
    for (const fn of this.onState) {
      try { fn(this.state); } catch { /* listener failure must not break sync */ }
    }
  }

  private emitConflicts(conflicts: any[]): void {
    if (!conflicts.length) return;
    for (const fn of this.onConflict) {
      try { fn(conflicts); } catch { /* ignore */ }
    }
  }

  private applyEntry(entry: any): void {
    if (!entry || typeof entry.seq !== "number") return;
    if (!this.state) return;
    if (entry.seq <= this.revision) return; // already applied
    if (entry.seq !== this.revision + 1) {
      // Gap: do not apply out of order — re-sync from the server.
      void this.sync();
      return;
    }
    this.revision = entry.seq;
    // The entry is authoritative but partial; refresh full state lazily:
    // cheap correctness over incremental application — the server state is
    // small (element field maps), so a state fetch per applied op is
    // acceptable at human edit rates and cannot diverge.
    void this.fetchState();
    if (entry.conflicts && entry.conflicts.length) this.emitConflicts(entry.conflicts);
  }

  async join(roomId: string, name = "Guest"): Promise<boolean> {
    const target = String(roomId || "").trim();
    if (this.roomId && this.roomId !== target) {
      // Switching rooms: leave the old one properly.
      this.stop();
    } else if (this.roomId === target) {
      // Re-joining the same room (e.g. after a server restart): close the
      // stale stream but do NOT leave — leaving would drop the membership
      // (and the owner role) that the server persisted across the restart.
      this.closeStream();
    }
    this.roomId = target;
    this.name = String(name || "Guest").trim() || "Guest";
    this.clientId =
      this.clientId ||
      `u-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    if (!this.roomId) return false;

    const res = await this.post("join", { name: this.name });
    if (!res.ok) return false;
    this.joined = true;
    await this.fetchState();
    await this.openStream();
    await this.flushQueue();
    return true;
  }

  async fetchState(): Promise<CentralState | null> {
    try {
      const r = await fetch(
        `${apiBase()}/central/${encodeURIComponent(this.roomId)}/state`,
        { headers: authHeaders() },
      );
      if (!r.ok) return null;
      const state = (await r.json()) as CentralState;
      this.state = state;
      this.revision = state.revision;
      this.emitState();
      return state;
    } catch {
      return null;
    }
  }

  /** Catch up on entries since the last known revision. */
  async sync(): Promise<boolean> {
    try {
      const r = await fetch(
        `${apiBase()}/central/${encodeURIComponent(this.roomId)}/sync?since=${this.revision}`,
        { headers: authHeaders() },
      );
      if (!r.ok) return false;
      const data = await r.json();
      if (data.truncated && data.state) {
        this.state = data.state;
        this.revision = data.state.revision;
        this.emitState();
        return true;
      }
      for (const entry of data.entries || []) {
        if (entry.seq > this.revision) this.revision = entry.seq;
        if (entry.conflicts && entry.conflicts.length) this.emitConflicts(entry.conflicts);
      }
      await this.fetchState();
      return true;
    } catch {
      return false;
    }
  }

  private async openStream(): Promise<void> {
    let sseQuery = "";
    try {
      const provider = (globalThis as any).__OPENBIM_COLLAB_SSE_TOKEN_PROVIDER__;
      if (typeof provider === "function") {
        const sse = await provider();
        if (sse) sseQuery = `?sse=${encodeURIComponent(String(sse))}`;
      }
    } catch { /* fall through */ }
    if (!sseQuery && collabToken()) {
      sseQuery = `?token=${encodeURIComponent(collabToken())}`;
    }
    const url = `${apiBase()}/rooms/${encodeURIComponent(this.roomId)}/events${sseQuery}`;
    const factory =
      this.eventSourceFactory ||
      ((u: string) => new EventSource(u) as unknown as EventSourceLike);
    try {
      this.es = factory(url);
    } catch {
      this.connected = false;
      return;
    }
    this.es.onopen = () => {
      this.connected = true;
      void this.sync(); // catch up on anything missed while disconnected
      void this.flushQueue();
    };
    this.es.onerror = () => {
      this.connected = false;
    };
    this.es.addEventListener("central-op", (ev: MessageEvent) => {
      try {
        const entry = JSON.parse(String(ev.data || "{}"));
        this.applyEntry(entry);
      } catch { /* ignore malformed event */ }
    });
    this.es.addEventListener("presence", () => { /* presence is handled by realtime-client */ });

    this.hb = (globalThis as any).window
      ? (globalThis as any).window.setInterval(() => {
          void this.sync();
        }, 30000)
      : null;
  }

  private closeStream(): void {
    if (this.hb !== null) {
      try { (globalThis as any).window.clearInterval(this.hb); } catch { /* ignore */ }
      this.hb = null;
    }
    if (this.es) {
      try { this.es.close(); } catch { /* ignore */ }
      this.es = null;
    }
    this.connected = false;
  }

  stop(): void {
    this.closeStream();
    if (this.roomId && this.clientId && this.joined) {
      void this.post("leave", {}).catch(() => { /* offline tolerant */ });
    }
    this.joined = false;
    this.connected = false;
  }

  private async post(action: string, body: Record<string, any>): Promise<any> {
    const r = await fetch(
      `${apiBase()}/central/${encodeURIComponent(this.roomId)}/${action}`,
      {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ clientId: this.clientId, ...body }),
      },
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, status: r.status, error: data.error || `HTTP ${r.status}`, ...data };
    return { ok: true, ...data };
  }

  /**
   * Submit an element upsert. While disconnected the op is queued with its
   * opId and replayed on reconnect — the server dedupes by opId, so the
   * replay cannot double-apply.
   */
  async upsertElement(
    elementId: string,
    fields: Record<string, any>,
    opts: { worksetId?: string; baseRevision?: number } = {},
  ): Promise<CentralOpResult> {
    const opId = newOpId();
    const body = {
      opId,
      type: "upsert",
      elementId,
      fields,
      worksetId: opts.worksetId,
      baseRevision: opts.baseRevision ?? this.revision,
    };
    if (!this.joined) {
      return new Promise<CentralOpResult>((resolve) => {
        this.queue.push({ opId, body, resolve });
      });
    }
    let res: CentralOpResult;
    try {
      res = (await this.post("op", body)) as CentralOpResult;
    } catch (e) {
      // Network failure mid-flight: queue for replay on reconnect. The
      // opId is unchanged, so if the server did commit before the drop,
      // the replay dedupes instead of double-applying.
      return new Promise<CentralOpResult>((resolve) => {
        this.queue.push({ opId, body, resolve });
      });
    }
    if (res.ok && res.entry) {
      this.revision = Math.max(this.revision, res.revision || 0);
      if (res.conflicts) this.emitConflicts(res.conflicts);
      await this.fetchState();
    }
    return res;
  }

  async deleteElement(elementId: string): Promise<CentralOpResult> {
    const body = {
      opId: newOpId(),
      type: "delete",
      elementId,
      baseRevision: this.revision,
    };
    const res = await this.post("op", body);
    if (res.ok) {
      this.revision = Math.max(this.revision, res.revision || 0);
      await this.fetchState();
    }
    return res as CentralOpResult;
  }

  /** Replay queued offline ops. Each carries its original opId. */
  async flushQueue(): Promise<void> {
    while (this.queue.length) {
      const item = this.queue.shift()!;
      try {
        const res = await this.post("op", item.body);
        item.resolve(res as CentralOpResult);
      } catch (e) {
        item.resolve({ ok: false, revision: this.revision, error: String((e as any)?.message || e) });
      }
    }
  }

  async borrow(elementId: string): Promise<any> {
    return this.post("borrow", { elementId });
  }

  async relinquish(elementId: string): Promise<any> {
    return this.post("relinquish", { elementId });
  }

  async requestBorrow(elementId: string): Promise<any> {
    return this.post("borrow-request", { elementId });
  }

  async respondBorrow(requestId: string, grant: boolean, message?: string): Promise<any> {
    return this.post("borrow-respond", { requestId, grant, message });
  }

  async createWorkset(name: string, kind = "user-workset"): Promise<any> {
    return this.post("workset", { name, kind });
  }

  async setWorksetOwner(worksetId: string, owner: string | null): Promise<any> {
    return this.post("workset-owner", { worksetId, owner });
  }

  async resolveConflict(conflictId: string, choice: "mine" | "theirs" | { value: any }): Promise<any> {
    return this.post("resolve", { conflictId, choice });
  }

  async restore(revision: number): Promise<any> {
    const res = await this.post("restore", { revision });
    if (res.ok) await this.fetchState();
    return res;
  }

  async history(limit = 100): Promise<any> {
    try {
      const r = await fetch(
        `${apiBase()}/central/${encodeURIComponent(this.roomId)}/history?limit=${limit}`,
        { headers: authHeaders() },
      );
      return await r.json();
    } catch {
      return { ok: false, entries: [] };
    }
  }

  async audit(limit = 200): Promise<any> {
    try {
      const r = await fetch(
        `${apiBase()}/central/${encodeURIComponent(this.roomId)}/audit?limit=${limit}`,
        { headers: authHeaders() },
      );
      return await r.json();
    } catch {
      return { ok: false, entries: [] };
    }
  }
}

export const centralClient = new CentralClient();
