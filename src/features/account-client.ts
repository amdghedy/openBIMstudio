/**
 * Browser client for the account + cloud-project API (worker/cloud.ts).
 * No DOM; `fetch` is injectable so it can be tested without a server.
 *
 * Only a signed-in session cookie (HttpOnly, set by the server) identifies the
 * user. No tokens or passwords are ever stored in the browser by this module.
 */
export interface AccountUser { provider: "google" | "microsoft"; name: string | null; email: string | null; picture: string | null }
export interface AccountConfig { google: { clientId: string } | null; microsoft: { clientId: string } | null; storage: boolean }
export interface CloudProject { id: string; name: string; size: number; updatedAt: string }
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class AccountError extends Error {
  constructor(message: string, readonly status = 0, readonly conflict = false) { super(message); }
}

const HDR = { "x-obs-csrf": "1" };
const BASE_KEY = "obs-cloud-base-v1"; // projectId -> updatedAt last seen on this device

export class AccountClient {
  constructor(private f: FetchLike = (i, init) => fetch(i, init), private store: Pick<Storage, "getItem" | "setItem"> | null = safeStorage()) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    try { r = await this.f(path, { credentials: "same-origin", ...init }); }
    catch { throw new AccountError("Could not reach the server. Check your connection."); }
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) throw new AccountError("Accounts are not available on this deployment (no account service answered).", r.status);
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new AccountError(body?.error ?? `Request failed (${r.status})`, r.status, !!body?.conflict);
    return body as T;
  }

  /** null = this deployment has no account service. */
  async config(): Promise<AccountConfig | null> {
    try { return await this.json<AccountConfig>("/api/auth/config"); } catch { return null; }
  }
  async me(): Promise<AccountUser | null> {
    try { return (await this.json<{ user: AccountUser | null }>("/api/auth/me")).user; } catch { return null; }
  }
  async login(provider: "google" | "microsoft", credential: string, nonce?: string): Promise<AccountUser> {
    const r = await this.json<{ user: AccountUser }>("/api/auth/login", {
      method: "POST", headers: { ...HDR, "content-type": "application/json" }, body: JSON.stringify({ provider, credential, ...(nonce ? { nonce } : {}) }),
    });
    return r.user;
  }
  async logout(): Promise<void> { await this.json("/api/auth/logout", { method: "POST", headers: HDR }); }

  async list(): Promise<CloudProject[]> { return (await this.json<{ projects: CloudProject[] }>("/api/cloud/projects")).projects; }

  /** Upload. Sends the version this device last saw so a newer copy from another device is never silently overwritten. */
  async save(id: string, name: string, blob: Blob, opts: { overwrite?: boolean } = {}): Promise<CloudProject> {
    const base = opts.overwrite ? null : this.readBase()[id];
    const q = new URLSearchParams({ name });
    if (base) q.set("baseUpdatedAt", base);
    const r = await this.json<CloudProject>(`/api/cloud/projects/${encodeURIComponent(id)}?${q}`, { method: "PUT", headers: HDR, body: blob });
    this.writeBase(id, r.updatedAt);
    return r;
  }

  async open(id: string): Promise<{ blob: Blob; name: string; updatedAt: string }> {
    let r: Response;
    try { r = await this.f(`/api/cloud/projects/${encodeURIComponent(id)}`, { credentials: "same-origin" }); }
    catch { throw new AccountError("Could not reach the server. Check your connection."); }
    if (!r.ok) {
      const body: any = await r.json().catch(() => ({}));
      throw new AccountError(body?.error ?? `Request failed (${r.status})`, r.status);
    }
    const updatedAt = r.headers.get("x-obs-updated-at") ?? "";
    const name = decodeURIComponent(r.headers.get("x-obs-name") ?? id);
    if (updatedAt) this.writeBase(id, updatedAt);
    return { blob: await r.blob(), name, updatedAt };
  }

  async remove(id: string): Promise<void> {
    await this.json(`/api/cloud/projects/${encodeURIComponent(id)}`, { method: "DELETE", headers: HDR });
    const b = this.readBase(); delete b[id]; this.store?.setItem(BASE_KEY, JSON.stringify(b));
  }

  private readBase(): Record<string, string> {
    try { return JSON.parse(this.store?.getItem(BASE_KEY) ?? "{}") || {}; } catch { return {}; }
  }
  private writeBase(id: string, at: string) {
    try { const b = this.readBase(); b[id] = at; this.store?.setItem(BASE_KEY, JSON.stringify(b)); } catch { /* storage unavailable: conflict check is skipped */ }
  }
}

function safeStorage(): Storage | null { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } }

/** Cloud ids must satisfy the server's pattern; project uuids already do. */
export function cloudIdFor(projectId: string): string | null {
  return /^[A-Za-z0-9_-]{8,64}$/.test(projectId) ? projectId : null;
}

export function randomNonce(): string {
  const a = new Uint8Array(16); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parse the fragment Microsoft's popup returns (#id_token=…&state=…). */
export function parseAuthFragment(hash: string): { idToken?: string; state?: string; error?: string } {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  return { idToken: p.get("id_token") ?? undefined, state: p.get("state") ?? undefined, error: p.get("error_description") ?? p.get("error") ?? undefined };
}
