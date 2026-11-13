/**
 * AI Agent Bridge — the channel that lets external AI clients issue orders
 * DIRECTLY into the openBIMstudio engines (2D drawing editor + BIM workspace).
 *
 * Four sources are wired, all funneling through the same audited log:
 *
 *   1. window API      (window as any).__obsAgentBridge.exec("LINE 0,0 100,0")
 *                      — console, browser automation agents, bookmarklets.
 *   2. postMessage     embedded parents (e.g. the AlphaCLI web client hosting
 *                      the studio in an iframe) — origin allow-listed.
 *   3. URL deep link   #agent-cmd=<enc> / #agent-ask=<enc> — one-shot on boot.
 *   4. local relay     the collab server (server/index.mjs) relays HTTP POSTs
 *                      from terminal AI agents (AlphaCLI / AlphaCode) to the
 *                      browser over SSE and returns the execution result.
 *
 * Orders are executed through the SAME paths a human uses: CAD command strings
 * go through cad-viewer's runCadAiCommand (the exact command-line dispatcher)
 * and natural-language asks go to the AI copilot (ai-chat). Nothing bypasses
 * the user-visible UI, so every order is visible on screen and in the log.
 *
 * Privacy: the bridge is local-first. The relay is OPT-IN (connect button);
 * without it nothing ever leaves the device, and even the relay only talks to
 * the user's own local collab server.
 */
import { notify } from "../core/notify";
import { fmtDateTime } from "../core/region";

export interface AgentEngineState {
  open: boolean;
  drawing: string | null;
  dirty: boolean;
  tool: string | null;
  entityCount: number | null;
  ribbonTab: string;
}

export interface AgentOrderResult {
  ok: boolean;
  error?: string;
  state?: AgentEngineState;
}

export interface AgentLogEntry {
  at: string;
  source: string;
  kind: "exec" | "ask" | "state" | "commands" | "error";
  text: string;
  ok: boolean;
  detail?: string;
}

export type AgentListener = (entry: AgentLogEntry) => void;

const BRIDGE_VERSION = 1;
const LOG_LIMIT = 100;
/** Origins allowed to postMessage orders into the studio, beyond same-origin.
    The owner's platform client is allowed by default; more can be added at
    runtime via localStorage "obs.agent.allowedOrigins" (JSON array). */
const DEFAULT_ALLOWED_ORIGINS = ["https://alphacli.github.io"];
const EXTRA_ORIGINS_KEY = "obs.agent.allowedOrigins";
const RELAY_FLAG_KEY = "obs.agent.relay";
const DEEP_LINK_DELAY_MS = 1200;
const RETRY_AFTER_OPEN_MS = 700;

const log: AgentLogEntry[] = [];
const listeners = new Set<AgentListener>();

function emit(entry: AgentLogEntry): void {
  for (const cb of listeners) {
    try { cb(entry); } catch { /* listener error must not break the bridge */ }
  }
  refreshPanel();
}

function pushLog(kind: AgentLogEntry["kind"], source: string, text: string, ok: boolean, detail?: string): AgentLogEntry {
  const entry: AgentLogEntry = {
    at: fmtDateTime(new Date()),
    source,
    kind,
    text: String(text ?? ""),
    ok,
    detail,
  };
  log.push(entry);
  if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
  emit(entry);
  return entry;
}

/* ── Order execution — the single funnel for every source ────────────────── */

/** Run a CAD command-line string in the active drawing (exact user path).
    When the drawing editor is closed it is opened once and the order is
    retried, so agents can act right after boot. */
export async function execAgentOrder(text: string, source = "api"): Promise<AgentOrderResult> {
  const cmd = String(text ?? "").trim();
  if (!cmd) {
    pushLog("error", source, "(empty)", false, "No command text given.");
    return { ok: false, error: "No command text given." };
  }
  const viewer = await import("./cad-viewer");
  let res = viewer.runCadAiCommand(cmd);
  if (!res.ok && /not open/i.test(res.error || "")) {
    // Boot the 2D engine once, then retry the same order.
    try { viewer.openCadViewer(); } catch { /* open failure surfaces below */ }
    await new Promise((r) => setTimeout(r, RETRY_AFTER_OPEN_MS));
    res = viewer.runCadAiCommand(cmd);
  }
  const state = viewer.getCadAiState();
  pushLog("exec", source, cmd, res.ok, res.error);
  return res.ok ? { ok: true, state } : { ok: false, error: res.error, state };
}

/** Send a natural-language order to the AI copilot panel (opens it if needed).
    The copilot plans and executes through its approved tool loop. */
export async function askAgent(text: string, source = "api"): Promise<AgentOrderResult> {
  const q = String(text ?? "").trim();
  if (!q) {
    pushLog("error", source, "(empty)", false, "No ask text given.");
    return { ok: false, error: "No ask text given." };
  }
  const chat = await import("./ai-chat");
  try {
    chat.openAiChat();
    chat.askAiChat(q);
    pushLog("ask", source, q, true);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    pushLog("ask", source, q, false, error);
    return { ok: false, error };
  }
}

/** Engine + bridge status snapshot (async: the engine module is lazy). */
export async function getAgentState(): Promise<{
  bridge: { version: number; logSize: number; relay: RelayStatus; allowedOrigins: string[] };
  engine: AgentEngineState | null;
}> {
  let engine: AgentEngineState | null = null;
  try {
    const viewer = await import("./cad-viewer");
    engine = viewer.getCadAiState();
  } catch { /* engine module not loaded yet */ }
  return {
    bridge: {
      version: BRIDGE_VERSION,
      logSize: log.length,
      relay: relayStatus(),
      allowedOrigins: allAllowedOrigins(),
    },
    engine,
  };
}

/** Full CAD command catalog — lets an agent discover every command name and
    alias it is allowed to run (see cad-viewer.getCadCommandCatalog). */
export async function listAgentCommands(): Promise<Array<{ name: string; aliases: string[]; description: string }>> {
  const viewer = await import("./cad-viewer");
  const catalog = viewer.getCadCommandCatalog();
  pushLog("commands", "api", `${catalog.length} commands`, true);
  return catalog;
}

/* ── Origin policy for postMessage orders ────────────────────────────────── */

export function allAllowedOrigins(): string[] {
  const extra: string[] = [];
  try {
    const raw = localStorage.getItem(EXTRA_ORIGINS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const o of parsed) if (typeof o === "string" && o) extra.push(o);
      }
    }
  } catch { /* malformed extras are ignored */ }
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

export function originAllowed(origin: string): boolean {
  const o = String(origin || "");
  if (!o) return false;
  if (o === window.location.origin) return true;
  return allAllowedOrigins().includes(o);
}

/* ── postMessage channel (embedded AlphaCLI client, tools, tests) ────────── */

interface AgentPostMessage {
  __obsAgent?: boolean;
  id?: string | number;
  type?: "exec" | "ask" | "state" | "commands";
  text?: string;
}

function handlePostMessage(ev: MessageEvent): void {
  const data = ev.data as AgentPostMessage | null;
  if (!data || data.__obsAgent !== true) return;

  const source = "postmessage";
  const reply = (payload: Record<string, unknown>): void => {
    const win = ev.source as Window | null;
    if (!win) return;
    try { win.postMessage({ __obsAgent: true, id: data?.id, ...payload }, ev.origin || "*"); } catch { /* */ }
  };

  if (!originAllowed(ev.origin)) {
    pushLog("error", source, `origin ${ev.origin || "(empty)"} rejected`, false, "Origin not in the Agent Bridge allow-list.");
    reply({ ok: false, error: "Origin not allowed by the openBIMstudio Agent Bridge." });
    return;
  }

  const type = data.type;
  if (type === "state") {
    void getAgentState().then((s) => reply({ ok: true, state: s }));
    return;
  }
  if (type === "commands") {
    void listAgentCommands().then((cmds) => reply({ ok: true, commands: cmds }));
    return;
  }
  if (type === "exec" || type === "ask") {
    const text = String(data.text ?? "");
    const run = type === "exec" ? execAgentOrder(text, source) : askAgent(text, source);
    void run.then((r) => reply({ ok: r.ok, error: r.error, state: r.state }));
    return;
  }
  reply({ ok: false, error: "Unknown __obsAgent type (use exec | ask | state | commands)." });
}

/* ── URL deep link — one-shot order after boot ───────────────────────────── */

/** Parse "#agent-cmd=<enc>" / "#agent-ask=<enc>" — exported for tests. */
export function parseAgentDeepLink(hash: string): { kind: "cmd" | "ask"; text: string } | null {
  const m = String(hash || "").match(/^#agent-(cmd|ask)=(.*)$/);
  if (!m) return null;
  let text = "";
  try { text = decodeURIComponent(m[2].replace(/\+/g, "%20")); } catch { text = m[2]; }
  text = text.trim();
  if (!text) return null;
  return { kind: m[1] === "cmd" ? "cmd" : "ask", text };
}

let deepLinkHandled = false;

function handleDeepLink(): void {
  if (deepLinkHandled) return;
  const parsed = parseAgentDeepLink(window.location.hash);
  if (!parsed) return;
  deepLinkHandled = true;
  if (parsed.kind === "cmd") void execAgentOrder(parsed.text, "deeplink");
  else void askAgent(parsed.text, "deeplink");
}

/* ── Local relay client — terminal AI agents (AlphaCLI / AlphaCode) ──────── */

export interface RelayStatus {
  enabled: boolean;
  connected: boolean;
  lastOrderAt: number;
  base: string;
}

let relayEs: EventSource | null = null;
let relayConnected = false;
let relayLastOrderAt = 0;

function relayEnabled(): boolean {
  try { return localStorage.getItem(RELAY_FLAG_KEY) === "1"; } catch { return false; }
}

function collabApiBase(): string {
  return (globalThis as any).__OPENBIM_COLLAB_API__ || "http://localhost:4000/api";
}

function collabToken(): string {
  return (globalThis as any).__OPENBIM_COLLAB_TOKEN__ || "";
}

export function relayStatus(): RelayStatus {
  return { enabled: relayEnabled(), connected: relayConnected, lastOrderAt: relayLastOrderAt, base: collabApiBase() };
}

/** Connect to the local collab server agent relay (opt-in; enables the flag). */
export function connectRelay(): { ok: boolean; error?: string } {
  try { localStorage.setItem(RELAY_FLAG_KEY, "1"); } catch { /* */ }
  if (relayEs) return { ok: true };
  const base = collabApiBase();
  const token = collabToken();
  const url = `${base}/agent/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  try {
    const es = new EventSource(url);
    es.addEventListener("hello", () => {
      relayConnected = true;
      notify("success", "Agent relay connected — terminal AI agents can now send orders.");
      refreshPanel();
    });
    es.addEventListener("agent-order", (ev) => {
      let data: { orderId?: string; cmd?: string; ask?: string } = {};
      try { data = JSON.parse((ev as MessageEvent).data as string); } catch { return; }
      relayLastOrderAt = Date.now();
      const orderId = String(data.orderId || "");
      const done = (ok: boolean, extra?: { error?: string; state?: AgentEngineState }): void => {
        void fetch(`${base}/agent/result`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ orderId, ok, ...extra }),
        }).catch(() => { /* result delivery is best-effort */ });
      };
      if (data.ask) void askAgent(String(data.ask), "relay").then((r) => done(r.ok, { error: r.error, state: r.state }));
      else if (data.cmd) void execAgentOrder(String(data.cmd), "relay").then((r) => done(r.ok, { error: r.error, state: r.state }));
      else done(false, { error: "No cmd or ask in the relay order." });
      refreshPanel();
    });
    es.onerror = () => {
      relayConnected = false;
      refreshPanel();
    };
    relayEs = es;
    notify("info", "Agent relay: connecting to " + base + " …");
    return { ok: true };
  } catch (err) {
    relayConnected = false;
    const error = err instanceof Error ? err.message : String(err);
    notify("error", "Agent relay failed: " + error);
    return { ok: false, error };
  }
}

export function disconnectRelay(): void {
  try { relayEs?.close(); } catch { /* */ }
  relayEs = null;
  relayConnected = false;
  notify("info", "Agent relay disconnected — orders from terminal agents are refused.");
  refreshPanel();
}

/* ── Docked panel — status, try-it box, live order log ───────────────────── */

let panel: HTMLDivElement | null = null;
let els: { engine: HTMLSpanElement; chat: HTMLSpanElement; relay: HTMLSpanElement; api: HTMLSpanElement; log: HTMLDivElement; input: HTMLInputElement } | null = null;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderLog(): void {
  if (!els) return;
  const rows = log.slice(-30).reverse();
  els.log.innerHTML = rows
    .map(
      (e) =>
        `<div class="obsab__row${e.ok ? "" : " obsab__row--err"}">` +
        `<span class="obsab__t">${esc(e.at)}</span><span class="obsab__src">${esc(e.source)}</span>` +
        `<span class="obsab__txt">${esc(e.text)}${e.detail ? ` — ${esc(e.detail)}` : ""}</span></div>`,
    )
    .join("") || `<div class="obsab__empty">No agent orders yet. Run one from the box above, the console, or a connected AI agent.</div>`;
}

function refreshPanel(): void {
  if (!panel || !els) return;
  const r = relayStatus();
  els.chat.textContent = "AI copilot — ask orders open the copilot and run through its approved tool loop";
  els.relay.textContent = r.connected
    ? `connected → ${r.base}`
    : r.enabled
      ? "enabled — reconnecting…"
      : "off (click Connect Relay to let terminal agents in)";
  els.api.textContent = "listening — __obsAgentBridge · postMessage __obsAgent · #agent-cmd / #agent-ask deep links";
  els.engine.textContent = "checking…";
  void getAgentState().then((s) => {
    if (!els) return;
    const e = s.engine;
    els.engine.textContent = e && e.open
      ? `open — drawing ${e.drawing ?? "(untitled)"}, tool ${e.tool ?? "-"}, ${e.entityCount ?? "?"} entities${e.dirty ? ", unsaved" : ""}`
      : "closed — an exec order opens it automatically";
  });
  renderLog();
  const btn = panel.querySelector<HTMLButtonElement>("[data-ab=relaytoggle]");
  if (btn) btn.textContent = relayEs ? "Disconnect Relay" : "Connect Relay";
}

const SNIPPET = [
  "/* Control openBIMstudio from any AI agent (console / automation) */",
  '__obsAgentBridge.exec("CIRCLE 0,0 50");              // run a CAD command now',
  'await __obsAgentBridge.ask("draw a gear profile");   // natural language via the AI copilot',
  "const s = await __obsAgentBridge.state();            // engine state snapshot",
  "const c = await __obsAgentBridge.commands();         // every command name + alias",
  "",
  "/* Terminal AI agent (AlphaCLI / AlphaCode) — through the local relay:",
  "   1. openBIMstudio -> AI Agent Bridge -> Connect Relay",
  "   2. from the terminal: */",
  "curl -s -X POST http://localhost:4000/api/agent/exec \\",
  '  -H "Authorization: Bearer $OBS_SERVER_TOKEN" \\',
  '  -H "Content-Type: application/json" \\',
  '  -d \'{"cmd":"CIRCLE 0,0 50"}\'',
].join("\n");

function buildPanel(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "obsab";
  el.style.cssText =
    "position:fixed;top:96px;right:16px;width:400px;max-height:calc(100vh - 140px);z-index:10070;" +
    "background:#0b0f17;color:#e5e7eb;border:1px solid #334155;border-radius:10px;" +
    "box-shadow:0 12px 40px rgba(0,0,0,.5);display:none;flex-direction:column;overflow:hidden;" +
    "font:12px/1.45 system-ui,sans-serif;";
  el.innerHTML =
    `<div class="obsab__head" style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:#111827;cursor:grab;user-select:none;">` +
    `<strong style="flex:1;">AI Agent Bridge</strong>` +
    `<button data-ab="copy" title="Copy the integration snippet for your AI agent" style="background:#1e293b;color:#e5e7eb;border:1px solid #334155;border-radius:6px;padding:2px 8px;cursor:pointer;">Copy Snippet</button>` +
    `<button data-ab="close" aria-label="Close Agent Bridge" style="background:transparent;border:0;color:#94a3b8;font-size:14px;cursor:pointer;">✕</button></div>` +
    `<div class="obsab__body" style="padding:10px;overflow:auto;display:flex;flex-direction:column;gap:8px;">` +
    `<div class="obsab__status" style="display:flex;flex-direction:column;gap:4px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:8px;">` +
    `<div><b>Engine:</b> <span data-ab="st-engine"></span></div>` +
    `<div><b>Copilot:</b> <span data-ab="st-chat"></span></div>` +
    `<div><b>Relay:</b> <span data-ab="st-relay"></span></div>` +
    `<div><b>Channels:</b> <span data-ab="st-api"></span></div></div>` +
    `<div style="display:flex;gap:6px;flex-wrap:wrap;">` +
    `<button data-ab="copilot" style="flex:1;background:#164e63;border:1px solid #22d3ee;color:#e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;">Open AI Copilot</button>` +
    `<button data-ab="relaytoggle" style="flex:1;background:#1e293b;border:1px solid #334155;color:#e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;">Connect Relay</button>` +
    `<button data-ab="clear" style="background:#1e293b;border:1px solid #334155;color:#e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;">Clear Log</button></div>` +
    `<div style="display:flex;gap:6px;">` +
    `<input data-ab="input" placeholder='Order for the engine — e.g. CIRCLE 0,0 50' style="flex:1;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:5px 8px;color:#e5e7eb;">` +
    `<button data-ab="run" style="background:#166534;border:1px solid #22c55e;color:#e5e7eb;border-radius:6px;padding:4px 10px;cursor:pointer;">Run</button>` +
    `<button data-ab="ask" style="background:#1e3a8a;border:1px solid #60a5fa;color:#e5e7eb;border-radius:6px;padding:4px 10px;cursor:pointer;">Ask AI</button></div>` +
    `<div data-ab="log" style="display:flex;flex-direction:column;gap:3px;min-height:60px;"></div></div>`;

  // Drag by the header (same feel as the other dockable panels).
  const head = el.querySelector<HTMLDivElement>(".obsab__head")!;
  let drag: { dx: number; dy: number } | null = null;
  head.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = el.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    el.style.left = Math.max(0, e.clientX - drag.dx) + "px";
    el.style.top = Math.max(0, e.clientY - drag.dy) + "px";
    el.style.right = "auto";
  });
  head.addEventListener("pointerup", () => { drag = null; });

  el.querySelector<HTMLButtonElement>('[data-ab="close"]')!.onclick = () => closeAgentPanel();
  el.querySelector<HTMLButtonElement>('[data-ab="copy"]')!.onclick = () => {
    void navigator.clipboard?.writeText(SNIPPET).then(
      () => notify("success", "Agent Bridge snippet copied — paste it to your AI agent."),
      () => notify("error", "Clipboard unavailable — the snippet is printed in the console instead."),
    );
    console.info("[agent-bridge] integration snippet:\n" + SNIPPET);
  };
  el.querySelector<HTMLButtonElement>('[data-ab="copilot"]')!.onclick = () => {
    void import("./ai-chat").then((m) => m.openAiChat());
  };
  el.querySelector<HTMLButtonElement>('[data-ab="relaytoggle"]')!.onclick = () => {
    if (relayEs) disconnectRelay();
    else connectRelay();
  };
  el.querySelector<HTMLButtonElement>('[data-ab="clear"]')!.onclick = () => {
    log.length = 0;
    refreshPanel();
  };
  const input = el.querySelector<HTMLInputElement>('[data-ab="input"]')!;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      void execAgentOrder(input.value, "panel");
      input.value = "";
    }
  });
  el.querySelector<HTMLButtonElement>('[data-ab="run"]')!.onclick = () => {
    if (input.value.trim()) { void execAgentOrder(input.value, "panel"); input.value = ""; }
  };
  el.querySelector<HTMLButtonElement>('[data-ab="ask"]')!.onclick = () => {
    if (input.value.trim()) { void askAgent(input.value, "panel"); input.value = ""; }
  };

  els = {
    engine: el.querySelector('[data-ab="st-engine"]')!,
    chat: el.querySelector('[data-ab="st-chat"]')!,
    relay: el.querySelector('[data-ab="st-relay"]')!,
    api: el.querySelector('[data-ab="st-api"]')!,
    log: el.querySelector('[data-ab="log"]')!,
    input,
  };
  return el;
}

export function openAgentPanel(): void {
  if (!panel) panel = buildPanel();
  if (!panel.isConnected) document.body.appendChild(panel);
  panel.style.display = "flex";
  refreshPanel();
}

export function closeAgentPanel(): void {
  if (panel) panel.style.display = "none";
}

export function isAgentPanelVisible(): boolean {
  return !!panel && panel.style.display !== "none" && panel.isConnected;
}

/** Other features can open the bridge without importing this module. */
window.addEventListener("obs-agent-bridge", () => openAgentPanel());

/* ── Setup — installs every channel once ─────────────────────────────────── */

let initialized = false;

export function setupAgentBridge(): void {
  if (initialized) return;
  initialized = true;

  window.addEventListener("message", handlePostMessage);

  (window as any).__obsAgentBridge = {
    version: BRIDGE_VERSION,
    exec: (text: string) => execAgentOrder(text, "api"),
    ask: (text: string) => askAgent(text, "api"),
    state: () => getAgentState(),
    commands: () => listAgentCommands(),
    log: () => log.slice(),
    on: (cb: AgentListener) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    openPanel: openAgentPanel,
    connectRelay: () => connectRelay(),
    disconnectRelay: () => disconnectRelay(),
    relayStatus: () => relayStatus(),
  };

  // One-shot deep-link orders (#agent-cmd=… / #agent-ask=…), after boot settles.
  setTimeout(handleDeepLink, DEEP_LINK_DELAY_MS);
  window.addEventListener("hashchange", handleDeepLink);

  // Auto-reconnect the relay when it was left enabled in a previous session.
  if (relayEnabled()) connectRelay();

  console.log("[agent-bridge] ready · window.__obsAgentBridge, postMessage __obsAgent, #agent-cmd/#agent-ask, relay " + (relayEnabled() ? "on" : "off"));
}
