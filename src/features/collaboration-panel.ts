import { ctx } from "../core/context";
import { realtimeClient, type PresenceUser } from "../modules/collaboration/realtime-client";
import { makeDockable, type DockHandle } from "./dockable";

let panel: HTMLDivElement | null = null;
let dock: DockHandle | null = null;
let visible = false;
let userListEl: HTMLDivElement | null = null;
let statusEl: HTMLSpanElement | null = null;

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

  body.append(roomInput, nameInput, joinBtn, statusEl, listTitle, userListEl);
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
      alert("Please enter both Room ID and Name.");
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
}

export function openCollaborationPanel() {
  visible = true;
  if (dock) dock.show();
  else if (panel) panel.style.display = "flex";
}

export function closeCollaborationPanel() {
  visible = false;
  if (dock) dock.hide();
  else if (panel) panel.style.display = "none";
}
