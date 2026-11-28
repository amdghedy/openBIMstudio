import { ctx } from "../core/context";
import { realtimeClient, type PresenceUser } from "../modules/collaboration/realtime-client";
import {
  createShare,
  listShares,
  revokeShare,
  publishSnapshot,
  reloadSharedSnapshot,
  leaveShare,
  type ShareInfo,
} from "../modules/collaboration/share-links";
import { getShareSession, onShareSessionChange } from "../modules/collaboration/share-session";
import { makeDockable, type DockHandle } from "./dockable";
import { uiAlert } from "../core/notify";
import { fmtDateTime } from "../core/region";

let panel: HTMLDivElement | null = null;
let dock: DockHandle | null = null;
let visible = false;
let userListEl: HTMLDivElement | null = null;
let statusEl: HTMLSpanElement | null = null;
let shareRoleEl: HTMLDivElement | null = null;
let shareLinkInput: HTMLInputElement | null = null;
let shareListEl: HTMLDivElement | null = null;
let shareUpdateBanner: HTMLDivElement | null = null;
let shareLeaveBtn: HTMLButtonElement | null = null;
let refreshShareSectionFn: (() => void) | null = null;

function updatePresence(users: PresenceUser[]) {
  if (!userListEl) return;
  userListEl.innerHTML = "";
  
  if (!users.length) {
    userListEl.innerHTML = `<div style="color:#6b7280;font-size:11px;padding:4px">No active users.</div>`;
    return;
  }

  for (const u of users) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px;font-size:12px;color:#cbd5e1";
    
    const dot = document.createElement("span");
    dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#22c55e";
    
    const name = document.createElement("span");
    name.textContent = u.name + (u.clientId === realtimeClient.clientId ? " (You)" : "");
    name.style.cssText = u.clientId === realtimeClient.clientId ? "font-weight:700;color:#38bdf8" : "";

    row.append(dot, name);
    userListEl.appendChild(row);
  }
}

export function setupCollaborationPanel(): void {
  panel = document.createElement("div");
  panel.id = "obs-collab-panel";
  panel.style.cssText =
    "display:none;flex-direction:column;background:#1a1d27;color:#e8eaf0;" +
    "border:1px solid #2a2e3a;border-radius:10px;box-shadow:0 12px 36px rgba(0,0,0,.55);" +
    "font:12px system-ui,sans-serif;overflow:hidden;z-index:34;width:300px";
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;padding:8px 10px;border-bottom:1px solid #2a2e3a;" +
    "background:#12141b;cursor:grab;user-select:none";
  header.innerHTML = `<span style="font-weight:700;flex:1">Live Collaboration</span>`;
  
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = "background:transparent;border:none;color:#94a3b8;cursor:pointer";
  closeBtn.onclick = () => toggleCollaborationPanel();
  header.appendChild(closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:10px";

  const roomInput = document.createElement("input");
  roomInput.placeholder = "Room ID (e.g. project-123)";
  roomInput.style.cssText = "padding:6px 8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;color:#e8eaf0;font-size:12px";

  const nameInput = document.createElement("input");
  nameInput.placeholder = "Your Name";
  nameInput.value = localStorage.getItem("obs.collab.name") || "";
  nameInput.style.cssText = roomInput.style.cssText;

  const joinBtn = document.createElement("button");
  joinBtn.textContent = "Join Session";
  joinBtn.style.cssText =
    "padding:8px;background:#38bdf8;color:#0b0d12;border:none;border-radius:4px;font-weight:700;cursor:pointer";
  
  statusEl = document.createElement("span");
  statusEl.style.cssText = "font-size:11px;color:#f59e0b;text-align:center";
  statusEl.textContent = "Disconnected";

  const listTitle = document.createElement("div");
  listTitle.textContent = "Active Users";
  listTitle.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;margin-top:8px";

  userListEl = document.createElement("div");
  userListEl.style.cssText = "display:flex;flex-direction:column;gap:2px;min-height:40px";

  // ── Share this model by link ──────────────────────────────────────────
  const shareDivider = document.createElement("div");
  shareDivider.style.cssText = "border-top:1px solid #2a2e3a;margin-top:6px";

  const shareTitle = document.createElement("div");
  shareTitle.textContent = "Share this model";
  shareTitle.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;margin-top:10px";

  shareRoleEl = document.createElement("div");
  shareRoleEl.style.cssText = "font-size:11px;color:#94a3b8;line-height:1.5";

  const shareBtnRow = document.createElement("div");
  shareBtnRow.style.cssText = "display:flex;gap:6px";
  const shareViewBtn = document.createElement("button");
  shareViewBtn.textContent = "Copy view link";
  shareViewBtn.title = "Anyone with the link can open this model read-only";
  shareViewBtn.style.cssText = "flex:1;padding:7px;background:#0ea5e9;color:#04121d;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:12px";
  const shareEditBtn = document.createElement("button");
  shareEditBtn.textContent = "Copy edit link";
  shareEditBtn.title = "Anyone with the link can open and edit this model";
  shareEditBtn.style.cssText = shareViewBtn.style.cssText;
  shareBtnRow.append(shareViewBtn, shareEditBtn);

  shareLinkInput = document.createElement("input");
  shareLinkInput.readOnly = true;
  shareLinkInput.placeholder = "A share link appears here after you create one";
  shareLinkInput.style.cssText = "padding:6px 8px;background:#0e1017;border:1px solid #2a2e3a;border-radius:4px;color:#7dd3fc;font-size:11px;width:100%;box-sizing:border-box";

  const shareActionRow = document.createElement("div");
  shareActionRow.style.cssText = "display:flex;gap:6px";
  const shareCopyBtn = document.createElement("button");
  shareCopyBtn.textContent = "Copy link";
  shareCopyBtn.style.cssText = "flex:1;padding:7px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;font-weight:600;cursor:pointer;font-size:12px";
  const sharePublishBtn = document.createElement("button");
  sharePublishBtn.textContent = "Publish update";
  sharePublishBtn.title = "Publish the current model so everyone with the link sees the latest version";
  sharePublishBtn.style.cssText = shareCopyBtn.style.cssText;
  shareActionRow.append(shareCopyBtn, sharePublishBtn);

  shareUpdateBanner = document.createElement("div");
  shareUpdateBanner.style.cssText = "display:none;padding:8px;border:1px solid rgba(251,191,36,.4);background:rgba(251,191,36,.08);border-radius:6px;font-size:11px;color:#fcd34d;line-height:1.5";
  const shareUpdateText = document.createElement("span");
  shareUpdateText.textContent = "A newer version of this shared model was published. ";
  const shareReloadBtn = document.createElement("button");
  shareReloadBtn.textContent = "Reload now";
  shareReloadBtn.style.cssText = "padding:4px 8px;background:#f59e0b;color:#1c1005;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:11px";
  shareReloadBtn.onclick = async () => {
    shareReloadBtn.disabled = true;
    const ok = await reloadSharedSnapshot();
    shareReloadBtn.disabled = false;
    if (ok) void refreshShareSection();
  };
  shareUpdateBanner.append(shareUpdateText, shareReloadBtn);

  shareListEl = document.createElement("div");
  shareListEl.style.cssText = "display:flex;flex-direction:column;gap:2px;min-height:20px";

  shareLeaveBtn = document.createElement("button");
  shareLeaveBtn.textContent = "Leave shared view";
  shareLeaveBtn.style.cssText = "display:none;padding:7px;background:transparent;color:#f87171;border:1px solid rgba(248,113,113,.4);border-radius:4px;font-weight:600;cursor:pointer;font-size:12px";
  shareLeaveBtn.onclick = () => {
    leaveShare();
    void refreshShareSection();
  };

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        if (!shareLinkInput) return false;
        shareLinkInput.value = text;
        shareLinkInput.select();
        return document.execCommand("copy");
      } catch {
        return false;
      }
    }
  }

  async function createAndShowLink(role: "view" | "edit"): Promise<void> {
    shareViewBtn.disabled = true;
    shareEditBtn.disabled = true;
    try {
      const created = await createShare(role);
      if (shareLinkInput) shareLinkInput.value = created.link;
      const copied = await copyText(created.link);
      if (statusEl) {
        statusEl.textContent = copied ? "Share link copied to clipboard." : "Share link created — copy it from the field below.";
        statusEl.style.color = "#22c55e";
      }
    } catch (err) {
      uiAlert(err instanceof Error ? err.message : "Could not create the share link.");
    } finally {
      shareViewBtn.disabled = false;
      shareEditBtn.disabled = false;
      void refreshShareSection();
    }
  }

  shareViewBtn.onclick = () => void createAndShowLink("view");
  shareEditBtn.onclick = () => void createAndShowLink("edit");
  shareCopyBtn.onclick = async () => {
    if (!shareLinkInput?.value) {
      uiAlert("Create a share link first.");
      return;
    }
    const ok = await copyText(shareLinkInput.value);
    if (statusEl) {
      statusEl.textContent = ok ? "Share link copied to clipboard." : "Copy failed — select the link and copy it manually.";
      statusEl.style.color = ok ? "#22c55e" : "#f59e0b";
    }
  };
  sharePublishBtn.onclick = async () => {
    sharePublishBtn.disabled = true;
    // Save first: publishSnapshot reads the stored document, so an unsaved
    // edit would otherwise publish the previous version. The save itself
    // also triggers auto-publish when a share is active.
    try {
      const { saveProject } = await import("../modules/projects/projects");
      await saveProject(true);
    } catch { /* save errors surface through the app's own UI */ }
    const ok = await publishSnapshot();
    sharePublishBtn.disabled = false;
    if (statusEl) {
      statusEl.textContent = ok ? "Published — everyone with the link sees this version." : "Nothing to publish — create a share link first.";
      statusEl.style.color = ok ? "#22c55e" : "#f59e0b";
    }
    void refreshShareSection();
  };

  async function refreshShareSection(): Promise<void> {
    const session = getShareSession();
    if (shareRoleEl) {
      if (session) {
        shareRoleEl.textContent =
          session.role === "view"
            ? "Viewing a shared model — view-only. Editing is disabled for this link."
            : "Editing a shared model — your saves publish to everyone with the link.";
        shareRoleEl.style.color = session.role === "view" ? "#fbbf24" : "#4ade80";
      } else {
        shareRoleEl.textContent = "Share a link to this model — no install, no account, no licence for the person opening it.";
        shareRoleEl.style.color = "#94a3b8";
      }
    }
    if (shareLeaveBtn) shareLeaveBtn.style.display = session ? "" : "none";
    if (shareUpdateBanner) {
      const { getPendingUpdateAt } = await import("../modules/collaboration/share-links");
      shareUpdateBanner.style.display = session && session.role === "edit" && getPendingUpdateAt() ? "" : "none";
    }
    if (shareListEl) {
      // Only query the collab server while someone is looking at the
      // panel: its default API base is the dev server, so on a deployed
      // site this call fails for every visitor — and with the panel
      // hidden the list is invisible anyway.
      const shares: ShareInfo[] = panel && panel.style.display !== "none" ? await listShares() : [];
      shareListEl.innerHTML = "";
      if (!shares.length) {
        shareListEl.innerHTML = `<div style="color:#6b7280;font-size:11px;padding:4px">No active share links on this server.</div>`;
      }
      for (const s of shares) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px;font-size:11px;color:#cbd5e1";
        const label = document.createElement("span");
        label.style.flex = "1";
        label.textContent = `${s.role === "view" ? "View" : "Edit"} · room ${s.room} · expires ${fmtDateTime(s.expiresAt)}`;
        const revokeBtn = document.createElement("button");
        revokeBtn.textContent = "Revoke";
        revokeBtn.style.cssText = "padding:3px 8px;background:transparent;color:#f87171;border:1px solid rgba(248,113,113,.4);border-radius:4px;cursor:pointer;font-size:11px";
        revokeBtn.onclick = async () => {
          revokeBtn.disabled = true;
          await revokeShare(s.sid);
          void refreshShareSection();
        };
        row.append(label, revokeBtn);
        shareListEl.appendChild(row);
      }
    }
  }

  body.append(roomInput, nameInput, joinBtn, statusEl, listTitle, userListEl);
  body.append(shareDivider, shareTitle, shareRoleEl, shareBtnRow, shareLinkInput, shareActionRow, shareUpdateBanner, shareListEl, shareLeaveBtn);
  panel.append(header, body);
  ctx.rightHost.appendChild(panel);

  dock = makeDockable(panel, {
    id: "obs-collab-panel",
    host: ctx.rightHost,
    header,
    minWidth: 250,
    minHeight: 200,
    defaultDock: "right",
    defaultWidth: 280,
    defaultHeight: 400,
  });

  joinBtn.onclick = async () => {
    if (realtimeClient.connected) {
      realtimeClient.stop();
      statusEl!.textContent = "Disconnected";
      statusEl!.style.color = "#f59e0b";
      joinBtn.textContent = "Join Session";
      updatePresence([]);
      return;
    }

    const room = roomInput.value.trim();
    const name = nameInput.value.trim();
    if (!room || !name) {
      uiAlert("Please enter both Room ID and Name.");
      return;
    }

    localStorage.setItem("obs.collab.name", name);
    joinBtn.textContent = "Connecting...";
    
    const ok = await realtimeClient.join(room, name);
    if (ok) {
      statusEl!.textContent = `Connected to ${room}`;
      statusEl!.style.color = "#22c55e";
      joinBtn.textContent = "Leave Session";
    } else {
      statusEl!.textContent = "Failed to connect (is server running?)";
      statusEl!.style.color = "#ef4444";
      joinBtn.textContent = "Join Session";
    }
  };

  // Listen to the events dispatched by the realtime client
  window.addEventListener("obs:presence", (e: Event) => {
    const detail = (e as CustomEvent).detail;
    updatePresence(detail.presence || []);
  });

  // Share links: refresh the share section when the session or a pending update changes.
  window.addEventListener("obs:share-role", () => { void refreshShareSection(); });
  window.addEventListener("obs:share-update", () => { void refreshShareSection(); });
  onShareSessionChange(() => { void refreshShareSection(); });
  refreshShareSectionFn = () => { void refreshShareSection(); };
  void refreshShareSection();

  window.addEventListener("obs:remote-change", (e: Event) => {
    const detail = (e as CustomEvent).detail;
    const change = detail.change;
    if (change && change.type) {
      window.dispatchEvent(new CustomEvent("obs-toast", {
        detail: { message: `Sync: Remote user ${change.type}`, kind: "info" }
      }));
    }
  });

  (ctx.features as any).collaborationPanel = {
    toggle: toggleCollaborationPanel,
    open: openCollaborationPanel,
    close: closeCollaborationPanel,
    isVisible: () => visible
  };
}

export function toggleCollaborationPanel() {
  visible = !visible;
  if (dock) visible ? dock.show() : dock.hide();
  else if (panel) panel.style.display = visible ? "flex" : "none";
  if (visible) refreshShareSectionFn?.();
}

export function openCollaborationPanel() {
  visible = true;
  if (dock) dock.show();
  else if (panel) panel.style.display = "flex";
  refreshShareSectionFn?.();
}

export function closeCollaborationPanel() {
  visible = false;
  if (dock) dock.hide();
  else if (panel) panel.style.display = "none";
}
