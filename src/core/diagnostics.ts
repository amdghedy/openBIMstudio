/**
 * Diagnostics — ring-buffered warn/error capture for the whole app.
 */
import { ctx } from "./context";

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEvent {
  id: number;
  ts: number;
  level: DiagLevel;
  scope: string;
  message: string;
  error?: unknown;
}

const MAX_EVENTS = 500;
const listeners = new Set<(e: DiagEvent) => void>();

let counter = 0;
let events: DiagEvent[] = [];

function record(
  level: DiagLevel,
  scope: string,
  message: unknown,
  error?: unknown,
): DiagEvent {
  const ev: DiagEvent = {
    id: ++counter,
    ts: Date.now(),
    level,
    scope,
    message: typeof message === "string" ? message : String(message ?? ""),
    error,
  };
  events.push(ev);
  if (events.length > MAX_EVENTS) events.shift();

  const fn =
    level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  if (error !== undefined) fn(`[${scope}]`, message, error);
  else fn(`[${scope}]`, message);

  for (const l of listeners) {
    try {
      l(ev);
    } catch {
      /* */
    }
  }
  refreshBadge();
  return ev;
}

export const diagnostics = {
  info: (scope: string, message: unknown) => record("info", scope, message),
  warn: (scope: string, message: unknown, error?: unknown) =>
    record("warn", scope, message, error),
  error: (scope: string, message: unknown, error?: unknown) =>
    record("error", scope, message, error),
  list: (): readonly DiagEvent[] => events,
  clear: () => {
    events = [];
    refreshBadge();
  },
  counts: (): { info: number; warn: number; error: number } => {
    const out = { info: 0, warn: 0, error: 0 };
    for (const e of events) out[e.level]++;
    return out;
  },
  onEvent: (cb: (e: DiagEvent) => void): (() => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  installGlobalHandlers: () => {
    // main.ts already shows an overlay; we only ring-buffer here.
    window.addEventListener("error", (ev) => {
      record("error", "window.error", ev.message, ev.error);
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const reason = (ev as PromiseRejectionEvent).reason ?? "unhandled rejection";
      record("error", "window.unhandledrejection", reason);
    });
  },
};

let badge: HTMLDivElement | null = null;
let badgeClickInstalled = false;

function ensureBadge(): HTMLDivElement {
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = "obs-diag-badge";
  badge.style.cssText =
    "position:absolute;right:14px;bottom:40px;z-index:57;display:none;" +
    "min-width:22px;height:20px;padding:0 6px;border-radius:10px;" +
    "background:rgba(239,68,68,.85);color:#fff;" +
    "font:700 10.5px/20px ui-monospace,monospace;text-align:center;" +
    "cursor:pointer;pointer-events:auto;box-shadow:0 4px 12px rgba(0,0,0,.4)";
  badge.title = "Diagnostics";
  if (ctx.rightHost) ctx.rightHost.appendChild(badge);
  return badge;
}

function refreshBadge(): void {
  try {
    if (!ctx.rightHost) return;
    const el = ensureBadge();
    const c = diagnostics.counts();
    const n = c.warn + c.error;
    if (n === 0) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.textContent = String(n);
    el.style.background =
      c.error > 0 ? "rgba(239,68,68,.85)" : "rgba(245,158,11,.85)";
  } catch {
    /* */
  }
}

function installBadgeClick(): void {
  if (badgeClickInstalled) return;
  badgeClickInstalled = true;
  ensureBadge().addEventListener("click", () => openDiagnosticsPanel());
}

let panel: HTMLDivElement | null = null;

function openDiagnosticsPanel(): void {
  if (panel) {
    panel.style.display = "flex";
    renderPanel();
    return;
  }
  if (!ctx.rightHost) return;
  panel = document.createElement("div");
  panel.id = "obs-diag-panel";
  panel.style.cssText =
    "position:absolute;right:14px;top:14px;bottom:64px;width:420px;z-index:58;" +
    "display:flex;flex-direction:column;background:#1c1e28;" +
    "border:1px solid #2a2e3a;border-radius:10px;" +
    "box-shadow:0 16px 44px rgba(0,0,0,.55);color:#e8eaf0;" +
    "font:12px system-ui,sans-serif;overflow:hidden";
  panel.addEventListener("mousedown", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:9px 10px;" +
    "border-bottom:1px solid #1e2029;background:#181a23;flex-shrink:0";
  header.innerHTML = `<span style="font-weight:700;flex:1">Diagnostics</span>`;
  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  clearBtn.style.cssText =
    "padding:3px 9px;background:transparent;color:#9ca3af;" +
    "border:1px solid #2a2e3a;border-radius:5px;cursor:pointer;font-size:10.5px";
  clearBtn.onclick = () => {
    diagnostics.clear();
    renderPanel();
  };
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText =
    "padding:3px 8px;background:transparent;color:#9ca3af;" +
    "border:1px solid #2a2e3a;border-radius:5px;cursor:pointer;font-size:11px";
  closeBtn.onclick = () => {
    if (panel) panel.style.display = "none";
  };
  header.append(clearBtn, closeBtn);

  const body = document.createElement("div");
  body.style.cssText = "flex:1;overflow-y:auto;padding:8px";

  panel.append(header, body);
  ctx.rightHost.appendChild(panel);
  renderPanel();
}

function renderPanel(): void {
  if (!panel) return;
  const body = panel.querySelector("div:nth-child(2)") as HTMLElement;
  if (!body) return;
  body.innerHTML = "";

  const list = diagnostics.list();
  if (!list.length) {
    body.innerHTML =
      `<div style="padding:30px;text-align:center;color:#6b7280">No diagnostics recorded.</div>`;
    return;
  }

  for (const e of list.slice().reverse()) {
    const row = document.createElement("div");
    const color = e.level === "error" ? "#ef4444" : e.level === "warn" ? "#f59e0b" : "#38bdf8";
    row.style.cssText =
      "padding:7px 9px;margin-bottom:5px;border-radius:6px;" +
      `border-left:3px solid ${color};background:rgba(255,255,255,.02);font-size:11px;line-height:1.4`;
    const time = new Date(e.ts).toLocaleTimeString();
    const msg = String(e.message)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    row.innerHTML =
      `<div style="display:flex;gap:6px;align-items:baseline;font-size:10px;color:#6b7280">` +
      `<b style="color:${color}">${e.level.toUpperCase()}</b>` +
      `<span style="font-family:monospace">${e.scope}</span>` +
      `<span style="margin-left:auto">${time}</span></div>` +
      `<div style="margin-top:3px;word-break:break-word">${msg}</div>`;
    body.appendChild(row);
  }
}

export function setupDiagnostics(): void {
  ensureBadge();
  installBadgeClick();
  diagnostics.installGlobalHandlers();
  refreshBadge();
  (ctx.features as any).diagnostics = diagnostics;
  console.log("[diagnostics] ready");
}
