/**
 * Share a live model by link — differentiation item 1.
 *
 * A share link opens one model (one room) in any browser with no account,
 * no licence and no install. The link carries a signed, single-room,
 * role-scoped token (server/share-tokens.mjs); the server verifies the
 * signature, the expiry and the revocation registry on every room/project
 * request, and enforces view-only there. This module is the client half:
 * link creation, snapshot publish/load, live update propagation and the
 * view-only mirror in the UI.
 *
 * LIVE MODEL, HONESTLY SNAPSHOT-BASED. The shared model is a published
 * snapshot of the project document (the exact .obsproj format File → Save
 * uses), stored with PUT /api/projects/:room. The owner (or any edit-link
 * holder) re-publishes on every save; the server broadcasts a "snapshot"
 * change on the room; view-link holders reload automatically, edit-link
 * holders are offered a reload when they have unsaved local edits. The
 * newest published version wins — concurrent edits to the same model are
 * last-publish-wins, NOT merged. There is no CRDT here and none is claimed
 * (resolving the Yjs question is differentiation item 2).
 *
 * ROLES. "view": read the snapshot, follow presence, send selection locks.
 * "edit": everything view can do, plus publish snapshots and post changes.
 * The server enforces both (403 on PUT /api/projects/:id and on POST
 * /change for view); the client only mirrors the role with a banner and
 * disabled tools — never the authority.
 *
 * DEPLOYMENT. A share link is `${app origin}/?share=<token>`; the joiner's
 * browser fetches the snapshot and the live stream from the collab server
 * (globalThis.__OPENBIM_COLLAB_API__, default http://localhost:4000/api).
 * On localhost the link is localhost-only. A public link needs the collab
 * server deployed on a public URL with a strong OBS_SERVER_TOKEN and an
 * origin allow-list, and the app built with that API base — the link itself
 * carries no server address, so it cannot conjure one.
 *
 * NO PROJECT YET. A fresh authoring session has no project, and
 * createProject() clears the scene — so createShare() adopts the live scene
 * as a project (adoptSceneAsProject) instead of refusing. The adopted
 * project carries the authored elements; model files imported while detached
 * were never stored, so they do not travel with it.
 *
 * RELOAD REPLACES. Loading a snapshot into a browser that already holds
 * that project would normally stop at importProjectFile's "Project already
 * exists" confirm dialog. Share reloads pass replaceExisting: true — the
 * snapshot IS the newer version of the same project, and the pre-replace
 * backup in importProjectFile still runs, so the older version is kept.
 */
import { ctx } from "../../core/context";
import { getCurrentProject, saveProject, isDirty, adoptSceneAsProject } from "../projects/projects";
import * as store from "../projects/store";
import { buildProjectFile } from "../projects/project-file";
import { importProjectFile } from "../projects/project-file-io";
import { realtimeClient, getCollabApiBase, collabAuthHeaders } from "./realtime-client";
import {
  setShareSession,
  getShareSession,
  decodeShareToken,
  isViewOnly,
  type ShareRole,
  type ShareSession,
} from "./share-session";

export type { ShareRole };

export interface ShareInfo {
  sid: string;
  room: string;
  role: ShareRole;
  createdAt: number;
  expiresAt: number;
}

export interface CreatedShare extends ShareInfo {
  token: string;
  link: string;
}

const SHARE_PARAM = "share";

let installed = false;
/** Shares known on this server for any room (refreshed on boot + after create/revoke). */
let knownShares: ShareInfo[] = [];
/** UpdatedAt of the snapshot currently loaded in this browser. */
let lastSnapshotAt = 0;
/** Newer published version waiting for an edit-link holder to reload. */
let pendingUpdateAt: number | null = null;
let publishing = false;
let publishQueued = false;

function toast(kind: string, message: string): void {
  try {
    window.dispatchEvent(new CustomEvent("obs-toast", { detail: { kind, message, timeout: 2600 } }));
  } catch {
    console.log(`[share-links] ${message}`);
  }
}

function collabName(): string {
  try {
    return localStorage.getItem("obs.collab.name") || "Guest";
  } catch {
    return "Guest";
  }
}

/** Authorization for collab-server calls: share token when under a link, else the master token (if any). */
function shareAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const session = getShareSession();
  if (session) return { Authorization: `Bearer ${session.token}`, ...extra };
  return collabAuthHeaders(extra);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the project data."));
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function serializeCurrentProjectBase64(): Promise<{ name: string; data: string; updatedAt: number }> {
  const cur = getCurrentProject();
  if (!cur) throw new Error("Open or create a project first.");
  const doc = (await store.getProject(cur.id)) ?? cur;
  const blobs = await store.getModelBlobs(cur.id);
  const blob = buildProjectFile(doc, blobs);
  const data = await blobToBase64(blob);
  return { name: doc.name || cur.id, data, updatedAt: doc.updatedAt ?? Date.now() };
}

async function putSnapshot(room: string, name: string, data: string): Promise<boolean> {
  const res = await fetch(`${getCollabApiBase()}/projects/${encodeURIComponent(room)}`, {
    method: "PUT",
    headers: shareAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Snapshot publish failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return true;
}

/**
 * Publish the current project as the room snapshot and broadcast the new
 * version. Reads the stored document (the caller must have saved first —
 * see maybeAutoPublish); it never calls saveProject itself, so the
 * obs:project-saved handler cannot loop.
 */
export async function publishSnapshot(): Promise<boolean> {
  const cur = getCurrentProject();
  if (!cur) return false;
  if (publishing) {
    publishQueued = true;
    return false;
  }
  publishing = true;
  try {
    const { name, data, updatedAt } = await serializeCurrentProjectBase64();
    await putSnapshot(cur.id, name, data);
    lastSnapshotAt = updatedAt;
    pendingUpdateAt = null;
    // Best-effort broadcast: the snapshot is published even if this client
    // is not currently joined to the room (viewers still get it on open).
    try {
      await realtimeClient.sendChange("snapshot", { updatedAt });
    } catch { /* broadcast is a notification, not the publish */ }
    return true;
  } catch (err) {
    console.warn("[share-links] publish failed", err);
    toast("error", err instanceof Error ? err.message : "Could not publish the shared model.");
    return false;
  } finally {
    publishing = false;
    if (publishQueued) {
      publishQueued = false;
      void publishSnapshot();
    }
  }
}

/** After a local save, re-publish when this project is shared (owner or edit-link holder). */
async function maybeAutoPublish(): Promise<void> {
  const cur = getCurrentProject();
  if (!cur) return;
  const session = getShareSession();
  const sharedHere =
    (session && session.room === cur.id && session.role === "edit") ||
    knownShares.some((s) => s.room === cur.id);
  if (!sharedHere) return;
  await publishSnapshot();
}

/**
 * Create a share link for the open project. Publishes the current snapshot
 * first, mints the token, joins the room as the owner (so later saves
 * broadcast), and returns the link to copy.
 */
export async function createShare(role: ShareRole, ttlMs?: number): Promise<CreatedShare> {
  // No project yet (fresh authoring session): adopt the live scene instead
  // of refusing — createProject() would clear the scene, destroying the
  // model being shared. See adoptSceneAsProject().
  const cur = getCurrentProject() ?? (await adoptSceneAsProject());
  if (role !== "view" && role !== "edit") throw new Error("role must be 'view' or 'edit'");
  // Flush live state into the stored document before serializing.
  await saveProject(true);
  const { name, data, updatedAt } = await serializeCurrentProjectBase64();
  await putSnapshot(cur.id, name, data);
  lastSnapshotAt = updatedAt;

  const res = await fetch(`${getCollabApiBase()}/shares`, {
    method: "POST",
    headers: collabAuthHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ room: cur.id, role, ...(ttlMs !== undefined ? { ttlMs } : {}) }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Could not create the share link (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const created = (await res.json()) as CreatedShare;
  // This browser now owns a share: the boot-time prefetch (see
  // shouldPrefetchShares) is worth its one call from now on.
  try { localStorage.setItem(HAS_SHARES_KEY, "1"); } catch { /* private browsing */ }
  knownShares = knownShares.filter((s) => s.sid !== created.sid);
  knownShares.push({
    sid: created.sid,
    room: created.room,
    role: created.role,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
  });
  created.link = `${location.origin}${location.pathname}?${SHARE_PARAM}=${encodeURIComponent(created.token)}`;

  // Join the room so later saves broadcast the new snapshot to viewers.
  try {
    if (realtimeClient.roomId !== cur.id || !realtimeClient.connected) {
      await realtimeClient.join(cur.id, collabName());
    }
  } catch { /* presence is best-effort; the link still works */ }

  toast("success", `Share link created (${role === "view" ? "view-only" : "can edit"}). Anyone with the link can open this model.`);
  return created;
}

/** Live shares on this server (metadata only — never tokens). */
export async function listShares(): Promise<ShareInfo[]> {
  try {
    const res = await fetch(`${getCollabApiBase()}/shares`, { headers: collabAuthHeaders() });
    if (!res.ok) return knownShares;
    const body = (await res.json()) as { shares?: ShareInfo[] };
    if (Array.isArray(body.shares)) knownShares = body.shares;
    return knownShares;
  } catch {
    return knownShares;
  }
}

export function getKnownShares(): ShareInfo[] {
  return [...knownShares];
}

export async function revokeShare(sid: string): Promise<boolean> {
  const res = await fetch(`${getCollabApiBase()}/shares/${encodeURIComponent(sid)}/revoke`, {
    method: "POST",
    headers: collabAuthHeaders(),
  });
  if (!res.ok) return false;
  knownShares = knownShares.filter((s) => s.sid !== sid);
  return true;
}

/** The newer published version an edit-link holder has not reloaded yet, if any. */
export function getPendingUpdateAt(): number | null {
  return pendingUpdateAt;
}

async function fetchSnapshot(room: string, headers: Record<string, string>): Promise<{ name: string; data: string; updatedAt: number }> {
  const res = await fetch(`${getCollabApiBase()}/projects/${encodeURIComponent(room)}`, { headers });
  if (res.status === 404) {
    throw new Error("This share link has no published model yet — ask the owner to open the model and create the link again.");
  }
  if (!res.ok) {
    throw new Error(`Could not load the shared model (${res.status}). The link may have expired or been revoked.`);
  }
  const proj = (await res.json()) as { name?: string; data?: string; updatedAt?: number | string };
  if (typeof proj.data !== "string" || !proj.data) {
    throw new Error("The shared model on the server is empty or unreadable.");
  }
  return {
    name: proj.name || room,
    data: proj.data,
    updatedAt: typeof proj.updatedAt === "number" ? proj.updatedAt : Date.parse(String(proj.updatedAt || "")) || 0,
  };
}

function snapshotToFile(name: string, data: string): File {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new File([bytes], `${name}.obsproj`, { type: "application/vnd.openbimstudio.project" });
}

/** Load the published snapshot for the open share session (view auto-reload, edit manual reload). */
export async function reloadSharedSnapshot(): Promise<boolean> {
  const session = getShareSession();
  if (!session) return false;
  try {
    const snap = await fetchSnapshot(session.room, { Authorization: `Bearer ${session.token}` });
    if (snap.updatedAt && snap.updatedAt <= lastSnapshotAt) {
      pendingUpdateAt = null;
      return true; // already on this version
    }
    // replaceExisting: the snapshot IS the newer version of this same
    // project. Without it, importProjectFile stops at its "Project already
    // exists" confirm dialog and the reload hangs forever waiting for a
    // click that never comes (view auto-reload would hang the same way).
    // The pre-replace backup in importProjectFile still runs.
    const ok = await importProjectFile(snapshotToFile(snap.name, snap.data), null, { replaceExisting: true });
    if (!ok) return false;
    lastSnapshotAt = snap.updatedAt;
    pendingUpdateAt = null;
    return true;
  } catch (err) {
    console.warn("[share-links] reload failed", err);
    toast("error", err instanceof Error ? err.message : "Could not reload the shared model.");
    return false;
  }
}

function onRemoteChange(ev: Event): void {
  const change = (ev as CustomEvent).detail?.change as
    | { type?: string; payload?: { updatedAt?: number } }
    | undefined;
  if (!change || change.type !== "snapshot") return;
  const session = getShareSession();
  if (!session) return;
  const updatedAt = typeof change.payload?.updatedAt === "number" ? change.payload.updatedAt : 0;
  if (updatedAt && updatedAt <= lastSnapshotAt) return;
  if (session.role === "view") {
    // Viewers follow the owner: a newer published version replaces the model.
    void reloadSharedSnapshot();
  } else {
    // Editors may have unsaved local edits — never clobber them silently.
    pendingUpdateAt = updatedAt || Date.now();
    try {
      window.dispatchEvent(new CustomEvent("obs:share-update", { detail: { updatedAt: pendingUpdateAt } }));
    } catch { /* */ }
    toast("info", "A newer version of this shared model was published — use Reload in the Collaboration panel to see it.");
  }
}

/**
 * Open a share link: load the published snapshot, join the room with the
 * share token, and set the session (view-only when the token says so).
 * Cleans ?share= from the address bar afterwards — the link stays available
 * in the Collaboration panel while the session is open.
 */
export async function openShareLink(token: string): Promise<boolean> {
  const decoded = decodeShareToken(token);
  if (!decoded) throw new Error("This share link is not valid. Ask the owner for a fresh link.");
  const headers = { Authorization: `Bearer ${token}` };
  const snap = await fetchSnapshot(decoded.room, headers);
  // replaceExisting: re-opening a link the browser already holds must not
  // stop at the "Project already exists" confirm dialog (see reload above).
  const ok = await importProjectFile(snapshotToFile(snap.name, snap.data), null, { replaceExisting: true });
  if (!ok) return false;
  lastSnapshotAt = snap.updatedAt;
  pendingUpdateAt = null;
  const session: ShareSession = {
    room: decoded.room,
    role: decoded.role,
    token,
    sid: decoded.sid,
    expiresAt: decoded.exp,
  };
  setShareSession(session);
  try {
    await realtimeClient.join(decoded.room, collabName(), { shareToken: token });
  } catch { /* snapshot is loaded; live presence is best-effort */ }
  try {
    const url = new URL(location.href);
    url.searchParams.delete(SHARE_PARAM);
    history.replaceState(null, "", `${url.pathname}${url.searchParams.toString() ? `?${url.searchParams}` : ""}${url.hash}`);
  } catch { /* address-bar cleanup is cosmetic */ }
  toast(
    "success",
    decoded.role === "view"
      ? "Opened a shared model (view-only — editing is disabled for this link)."
      : "Opened a shared model. Your edits publish to everyone with the link when you save.",
  );
  return true;
}

/** Leave the current share session (stops live updates; the loaded model stays open). */
export function leaveShare(): void {
  setShareSession(null);
  pendingUpdateAt = null;
  try {
    realtimeClient.stop();
  } catch { /* */ }
}

const HAS_SHARES_KEY = "obs.share.hasShares";

/**
 * Whether the boot-time share-list prefetch can possibly pay off. The
 * collab API defaults to the dev server (http://localhost:4000/api), so
 * from a deployed origin the call fails for every visitor on every load;
 * skip it there. And even against a reachable server the list only
 * matters when THIS browser has created a share before (it drives
 * auto-publish for the owner after a reload) — a first-time visitor has
 * nothing to learn, so skip the call for them too.
 */
function shouldPrefetchShares(): boolean {
  try {
    const base = getCollabApiBase();
    const localBase = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
    if (localBase && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return false;
    return localStorage.getItem(HAS_SHARES_KEY) === "1";
  } catch { return false; }
}

export function setupShareLinks(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("obs:project-saved", () => {
    void maybeAutoPublish();
  });
  window.addEventListener("obs:remote-change", onRemoteChange);
  // Best-effort: learn which rooms already have live shares (drives
  // auto-publish for the owner after a reload). Failures are ignored —
  // creating a share always refreshes this list.
  if (shouldPrefetchShares()) void listShares().catch(() => undefined);
  try {
    (ctx.features as Record<string, unknown>).shareLinks = {
      createShare,
      listShares,
      getKnownShares,
      revokeShare,
      publishSnapshot,
      openShareLink,
      reloadSharedSnapshot,
      leaveShare,
      getSession: getShareSession,
      isViewOnly,
      getPendingUpdateAt,
    };
  } catch { /* features registry unavailable during early boot */ }
  try {
    const params = new URLSearchParams(location.search);
    const token = params.get(SHARE_PARAM);
    if (token) {
      void openShareLink(token).catch((err: unknown) => {
        toast("error", err instanceof Error ? err.message : "Could not open this share link.");
      });
    }
  } catch { /* no URL (tests) */ }
}
