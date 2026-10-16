/**
 * AI chat panel.
 *
 * Features:
 *   • Streaming token-by-token responses
 *   • Stop button while a response is in flight
 *   • Regenerate the last response
 *   • Persistent conversation history (localStorage)
 *   • Markdown rendering (bold, italic, code, lists, headings, links)
 *   • Copy to clipboard on any message
 *   • Confirmation cards for destructive tools
 *   • Semantic index build/clear controls in settings
 *
 * Settings persistence
 * ────────────────────
 * Every text/password field saves on `oninput`, so nothing is lost when
 * the user closes the panel, clicks Test connection, or refreshes the page.
 * A visible warning banner appears if localStorage rejects the save.
 *
 * Agent loop:
 *   1. Append user message
 *   2. Stream the response from the provider
 *   3. Intercept destructive tool calls → await user approval
 *   4. Execute approved tools, feed results back
 *   5. Stop when the provider returns a text-only response
 */
import { ctx } from "../core/context";
import { makeDockable, type DockHandle } from "./dockable";
import {
  callChatStream,
  loadProviderConfig,
  saveProviderConfig,
  getLastSaveError,
  testProvider,
  listModels,
  DEFAULT_CONFIG,
  type ChatMessage,
  type ProviderConfig,
} from "./ai-providers";
import {
  TOOLS,
  executeTool,
  setupAiTools,
  isDestructiveTool,
} from "./ai-tools";
import {
  buildIndex,
  clearIndex,
  getIndexStats,
  loadEmbeddingConfig,
  saveEmbeddingConfig,
  DEFAULT_EMBEDDING_CONFIG,
  type EmbeddingConfig,
} from "./ai-embeddings";

const SYSTEM_PROMPT = `You are the AI assistant inside Open BIM Studio, a browser-based openBIM coordination viewer.

You help the user by:
- Answering questions about the loaded model (categories, counts, selection, current tool)
- Running app commands on their behalf (loading, clash, view, MEP colors, authoring tools)
- Guiding them through workflows

Guidelines:
- Be concise. Users are BIM professionals.
- When you need to act, call a tool — do not describe what you would do.
- After a tool runs, briefly confirm what happened in one sentence.
- If a tool fails, explain the failure in plain terms and suggest the fix.
- Never invent model data. If you do not know, call get_app_state or get_model_categories.
- Prefer specific commands over generic ones. list_commands first if unsure.

Tool usage:
- Call get_app_state first if you need context about what is loaded.
- Call list_commands to discover what actions are available.
- Call run_command with the id from list_commands to execute.
- Use semantic_search for natural-language queries about elements.
- Destructive tools (delete_elements, clear_all_elements) will be shown to the user for approval — do not hesitate to call them when the user asks.`;

const MAX_ITERATIONS = 8;
const CONV_KEY = "obs.ai.conversations";
const MAX_CONVERSATIONS = 40;

/* ═════════════════════════════════════════════════════════════════════════
   Model classification
   ═════════════════════════════════════════════════════════════════════════ */
function rankModel(id: string, provider: ProviderConfig): number {
  const s = id.toLowerCase();

  if (/\bembedding\b|\bembed\b|\baqa\b/.test(s)) return -100;
  if (/\btts\b|text-to-speech/.test(s)) return -100;
  if (/\bimage\b|\bimagen\b|\bveo\b|dall-e/.test(s)) return -100;
  if (/\bwhisper\b|\bspeech\b/.test(s)) return -100;
  if (/antigravity/.test(s)) return -90;
  if (/learnlm|codey|text-bison|chat-bison/.test(s)) return -80;
  if (/\bgemma\b/.test(s) && !/gemma-3/.test(s)) return -70;
  if (/realtime|realtime-preview/.test(s)) return -60;

  if (/gemini-2\.0/.test(s)) return -50;
  if (/gemini-2\.5-flash(?!-thinking)/.test(s)) return -50;

  let score = 10;

  if (/gemini-3\.6/.test(s)) score += 60;
  else if (/gemini-3\.5/.test(s)) score += 55;
  else if (/gemini-3\b/.test(s)) score += 50;
  else if (/gemini-2\.5-pro/.test(s)) score += 40;
  else if (/gemini-2\.5/.test(s)) score += 30;

  if (/\bflash\b/.test(s)) score += 20;
  else if (/\bpro\b/.test(s)) score += 15;
  else if (/\bmini\b|\bnano\b/.test(s)) score += 10;

  if (/preview|exp|experimental/.test(s)) score -= 5;
  if (provider.kind === "ollama" && s.endsWith(":latest")) score -= 3;

  if (/gpt-4o|gpt-5|o1|o3/.test(s)) score += 25;
  if (/llama-3\.[23]/.test(s)) score += 20;
  if (/qwen/.test(s)) score += 15;
  if (/mixtral|mistral-large/.test(s)) score += 10;
  if (/claude-3[.-]5|claude-4/.test(s)) score += 25;

  return score;
}

/* ═════════════════════════════════════════════════════════════════════════
   State
   ═════════════════════════════════════════════════════════════════════════ */
interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

let history: ChatMessage[] = [];
let cfg: ProviderConfig = loadProviderConfig();
let busy = false;
let abort: AbortController | null = null;
let dock: DockHandle | null = null;
let showSettings = false;
let autoScroll = true;
let showAllModels = false;

let initialized = false;
let renderingHeader = false;

let conversations: Conversation[] = [];
let currentConvId: string | null = null;
let historyDropdown: HTMLDivElement | null = null;

/* ═════════════════════════════════════════════════════════════════════════
   Panel shell
   ═════════════════════════════════════════════════════════════════════════ */
const panel = document.createElement("div");
panel.id = "obs-ai-chat";
panel.style.cssText =
  "z-index:37;display:none;flex-direction:column;background:var(--bg-floating,#1c1e28);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:10px;" +
  "box-shadow:0 12px 36px rgba(0,0,0,.55);font:12px system-ui,sans-serif;" +
  "color:var(--text-primary,#e8eaf0);min-height:0;position:relative";
panel.addEventListener("mousedown", (e) => e.stopPropagation());
panel.addEventListener("pointerdown", (e) => e.stopPropagation());
panel.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

const header = document.createElement("div");
header.style.cssText =
  "display:flex;align-items:center;gap:6px;padding:8px 10px;" +
  "border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "border-top-left-radius:9px;border-top-right-radius:9px;" +
  "background:var(--bg-elevated,#181a23);cursor:grab;user-select:none;" +
  "flex-shrink:0;min-height:36px";

const settingsPane = document.createElement("div");
settingsPane.style.cssText =
  "display:none;padding:10px 12px;border-bottom:1px solid var(--border-subtle,#1e2029);" +
  "background:var(--bg-elevated,#181a23);gap:6px;flex-direction:column;" +
  "overflow-y:auto;max-height:70%;flex-shrink:0;" +
  "scrollbar-width:thin;scrollbar-color:var(--border-default,#2a2e3a) transparent";

const messages = document.createElement("div");
messages.style.cssText =
  "flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;" +
  "min-height:100px;scrollbar-width:thin;" +
  "scrollbar-color:var(--border-default,#2a2e3a) transparent";

const footer = document.createElement("div");
footer.style.cssText =
  "display:flex;gap:6px;padding:6px 8px 0;align-items:center;" +
  "background:var(--bg-elevated,#181a23);border-top:1px solid var(--border-subtle,#1e2029);" +
  "flex-shrink:0";

const regenBtn = document.createElement("button");
regenBtn.textContent = "↻ Regenerate";
regenBtn.title = "Regenerate the last response";
regenBtn.style.cssText =
  "padding:3px 9px;font-size:10.5px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;cursor:pointer;display:none";
regenBtn.onclick = () => void regenerate();

const footerSpacer = document.createElement("div");
footerSpacer.style.cssText = "flex:1";

const tokenCountEl = document.createElement("span");
tokenCountEl.style.cssText =
  "font-size:10px;color:var(--text-tertiary,#6b7280);" +
  "font-family:var(--font-mono,monospace)";

footer.append(regenBtn, footerSpacer, tokenCountEl);

const inputRow = document.createElement("div");
inputRow.style.cssText =
  "display:flex;gap:6px;padding:8px;padding-top:4px;" +
  "background:var(--bg-elevated,#181a23);border-bottom-left-radius:9px;" +
  "border-bottom-right-radius:9px;" +
  "flex-shrink:0;align-items:flex-end";

const input = document.createElement("textarea");
input.placeholder = "Ask about the model, or tell me what to do…";
input.rows = 2;
input.style.cssText =
  "flex:1;box-sizing:border-box;padding:6px 8px;background:var(--bg-inset,#0e1017);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:6px;" +
  "color:var(--text-primary,#e8eaf0);font:12px system-ui;resize:none;outline:none;" +
  "max-height:120px";

const inputTools = document.createElement("div");
inputTools.style.cssText =
  "display:flex;flex-direction:column;gap:4px;align-items:flex-end";

const autoScrollLbl = document.createElement("label");
autoScrollLbl.style.cssText =
  "display:flex;align-items:center;gap:4px;font-size:10px;" +
  "color:var(--text-tertiary,#6b7280);cursor:pointer;user-select:none";
const autoScrollCb = document.createElement("input");
autoScrollCb.type = "checkbox";
autoScrollCb.checked = autoScroll;
autoScrollCb.style.cssText = "cursor:pointer;margin:0";
autoScrollCb.onchange = () => {
  autoScroll = autoScrollCb.checked;
};
autoScrollLbl.append(autoScrollCb, document.createTextNode("Auto-scroll"));

const sendBtn = document.createElement("button");
sendBtn.textContent = "Send";
sendBtn.style.cssText =
  "padding:6px 14px;background:var(--accent,#38bdf8);color:#0b0d12;border:none;" +
  "border-radius:6px;cursor:pointer;font:600 12px system-ui;height:32px;" +
  "min-width:64px";

inputTools.append(autoScrollLbl, sendBtn);
inputRow.append(input, inputTools);
panel.append(header, settingsPane, messages, footer, inputRow);

/* ═════════════════════════════════════════════════════════════════════════
   Markdown rendering
   ═════════════════════════════════════════════════════════════════════════ */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    } as any)[c],
  );
}

function inlineMd(text: string): string {
  let s = esc(text);
  s = s.replace(
    /`([^`]+)`/g,
    '<code style="background:rgba(255,255,255,.09);padding:1px 5px;' +
      'border-radius:3px;font-family:var(--font-mono,monospace);font-size:11px">$1</code>',
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" ' +
      'style="color:var(--accent,#38bdf8);text-decoration:underline">$1</a>',
  );
  return s;
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeLines: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const flushList = () => {
    if (listType === "ul") out.push("</ul>");
    else if (listType === "ol") out.push("</ol>");
    listType = null;
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeLines = [];
      } else {
        inCode = false;
        out.push(
          `<pre style="margin:6px 0;padding:8px 10px;background:var(--bg-inset,#0e1017);` +
            `border:1px solid var(--border-subtle,#1e2029);border-radius:5px;` +
            `font-size:11px;line-height:1.45;overflow-x:auto;white-space:pre">` +
            `<code>${esc(codeLines.join("\n"))}</code></pre>`,
        );
        codeLines = [];
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch) {
      if (listType !== "ul") {
        flushList();
        out.push('<ul style="margin:4px 0 4px 18px;padding:0">');
        listType = "ul";
      }
      out.push(`<li>${inlineMd(bulletMatch[1])}</li>`);
      continue;
    }

    const numMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (numMatch) {
      if (listType !== "ol") {
        flushList();
        out.push('<ol style="margin:4px 0 4px 18px;padding:0">');
        listType = "ol";
      }
      out.push(`<li>${inlineMd(numMatch[1])}</li>`);
      continue;
    }

    flushList();

    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const size = [15, 13.5, 12.5, 12][level - 1] ?? 12;
      out.push(
        `<div style="font-weight:700;font-size:${size}px;margin:6px 0 3px">` +
          `${inlineMd(headingMatch[2])}</div>`,
      );
      continue;
    }

    if (!line.trim()) {
      out.push('<div style="height:6px"></div>');
      continue;
    }

    out.push(`<div>${inlineMd(line)}</div>`);
  }

  flushList();
  return out.join("");
}

/* ═════════════════════════════════════════════════════════════════════════
   Persistent history
   ═════════════════════════════════════════════════════════════════════════ */
function loadConversationsFromStorage(): void {
  try {
    const raw = localStorage.getItem(CONV_KEY);
    if (!raw) {
      conversations = [];
      return;
    }
    const parsed = JSON.parse(raw);
    conversations = Array.isArray(parsed) ? parsed : [];
  } catch {
    conversations = [];
  }
}

function persistConversations(): void {
  try {
    const trimmed = conversations.slice(0, MAX_CONVERSATIONS);
    localStorage.setItem(CONV_KEY, JSON.stringify(trimmed));
  } catch (err) {
    console.warn("[ai-chat] failed to save conversations", err);
  }
}

function ensureConversation(): Conversation {
  let conv = conversations.find((c) => c.id === currentConvId);
  if (!conv) {
    conv = {
      id: (crypto as any).randomUUID?.() ?? `c-${Date.now()}`,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    conversations.unshift(conv);
    currentConvId = conv.id;
  }
  return conv;
}

function persistCurrent(): void {
  if (!currentConvId) return;
  const conv = conversations.find((c) => c.id === currentConvId);
  if (!conv) return;
  conv.messages = history.map((m) => ({ ...m }));
  conv.updatedAt = Date.now();
  const firstUser = history.find((m) => m.role === "user");
  if (firstUser && (!conv.title || conv.title === "New chat")) {
    conv.title = firstUser.content.slice(0, 60) || "New chat";
  }
  persistConversations();
}

function loadConversation(id: string): void {
  const conv = conversations.find((c) => c.id === id);
  if (!conv) return;
  currentConvId = conv.id;
  history = conv.messages.map((m) => ({ ...m }));
  renderHeader();
  renderSettings();
  renderMessages();
}

function deleteConversation(id: string): void {
  conversations = conversations.filter((c) => c.id !== id);
  if (currentConvId === id) {
    currentConvId = null;
    history = [];
    renderMessages();
  }
  persistConversations();
}

function newConversation(): void {
  currentConvId = null;
  history = [];
  renderHeader();
  renderMessages();
}

/* ═════════════════════════════════════════════════════════════════════════
   Header
   ═════════════════════════════════════════════════════════════════════════ */
function renderHeader(): void {
  if (renderingHeader) return;
  renderingHeader = true;
  try {
    header.innerHTML = "";

    const icon = document.createElement("span");
    icon.style.cssText = "display:flex;color:var(--accent,#38bdf8)";
    icon.textContent = "◆";

    const text = document.createElement("div");
    text.style.cssText = "flex:1;min-width:0";
    const title = document.createElement("div");
    const conv = conversations.find((c) => c.id === currentConvId);
    title.textContent =
      conv?.title && conv.title !== "New chat" ? conv.title : "AI assistant";
    title.style.cssText =
      "font-weight:700;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const sub = document.createElement("div");
    sub.textContent = `${cfg.kind} · ${cfg.model}`;
    sub.style.cssText =
      "font-size:10px;color:var(--text-tertiary,#6b7280);" +
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    text.append(title, sub);

    const histBtn = document.createElement("button");
    histBtn.textContent = "🕘";
    histBtn.title = "Conversation history";
    histBtn.style.cssText = smallBtnCss();
    histBtn.onclick = (e) => {
      e.stopPropagation();
      toggleHistoryDropdown(histBtn);
    };

    const gear = document.createElement("button");
    gear.textContent = "⚙";
    gear.title = "Settings";
    gear.style.cssText = smallBtnCss(showSettings);
    gear.onclick = () => {
      showSettings = !showSettings;
      renderHeader();
      renderSettings();
    };

    const clearBtn = document.createElement("button");
    clearBtn.textContent = "Clear";
    clearBtn.title = "Clear this conversation";
    clearBtn.style.cssText = smallBtnCss();
    clearBtn.onclick = () => {
      history = [];
      persistCurrent();
      renderMessages();
    };

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "Close (Esc)";
    closeBtn.style.cssText = smallBtnCss();
    closeBtn.onclick = () => closeAiChat();

    header.append(icon, text, histBtn, gear, clearBtn, closeBtn);
  } finally {
    renderingHeader = false;
  }
}

function smallBtnCss(active = false): string {
  return (
    "padding:3px 8px;background:" +
    (active ? "var(--accent-dim,rgba(56,189,248,.14))" : "transparent") +
    ";color:" +
    (active ? "var(--accent,#38bdf8)" : "var(--text-secondary,#a0a6b5)") +
    ";border:1px solid var(--border-default,#2a2e3a);border-radius:5px;" +
    "cursor:pointer;font-size:10.5px"
  );
}

/* ═════════════════════════════════════════════════════════════════════════
   History dropdown
   ═════════════════════════════════════════════════════════════════════════ */
function toggleHistoryDropdown(anchor: HTMLElement): void {
  if (historyDropdown) {
    historyDropdown.remove();
    historyDropdown = null;
    return;
  }

  historyDropdown = document.createElement("div");
  historyDropdown.style.cssText =
    "position:absolute;z-index:200;min-width:260px;max-width:340px;" +
    "max-height:380px;overflow-y:auto;background:var(--bg-floating,#1c1e28);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:8px;" +
    "box-shadow:0 12px 36px rgba(0,0,0,.65);padding:6px;font:12px system-ui;" +
    "scrollbar-width:thin";
  historyDropdown.onmousedown = (e) => e.stopPropagation();

  const panelRect = panel.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const top = anchorRect.bottom - panelRect.top + 4;
  const right = panelRect.right - anchorRect.right + 4;
  historyDropdown.style.top = `${top}px`;
  historyDropdown.style.right = `${right}px`;

  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:14px;text-align:center;color:var(--text-tertiary,#6b7280);font-size:11px";
    empty.textContent = "No saved conversations yet.";
    historyDropdown.appendChild(empty);
    panel.appendChild(historyDropdown);
    bindHistoryOutsideClick();
    return;
  }

  const listHeader = document.createElement("div");
  listHeader.style.cssText =
    "display:flex;align-items:center;gap:6px;padding:4px 8px 8px;" +
    "border-bottom:1px solid var(--border-subtle,#1e2029);margin-bottom:6px";
  const hTitle = document.createElement("div");
  hTitle.textContent = `Recent (${conversations.length})`;
  hTitle.style.cssText =
    "flex:1;font-size:10px;color:var(--text-tertiary,#6b7280);" +
    "text-transform:uppercase;letter-spacing:.4px";
  const newBtn = document.createElement("button");
  newBtn.textContent = "+ New";
  newBtn.style.cssText =
    "padding:2px 8px;font-size:10px;background:var(--accent,#38bdf8);color:#0b0d12;" +
    "border:none;border-radius:3px;cursor:pointer;font-weight:600";
  newBtn.onclick = () => {
    newConversation();
    historyDropdown?.remove();
    historyDropdown = null;
  };
  listHeader.append(hTitle, newBtn);
  historyDropdown.appendChild(listHeader);

  for (const c of conversations) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:6px;padding:6px 8px;" +
      "border-radius:5px;cursor:pointer;margin-bottom:1px";
    row.onmouseenter = () => (row.style.background = "var(--bg-hover,#232633)");
    row.onmouseleave = () => (row.style.background = "transparent");

    const info = document.createElement("div");
    info.style.cssText = "flex:1;min-width:0";
    const name = document.createElement("div");
    name.textContent = c.title || "Untitled";
    name.style.cssText =
      "font-weight:600;font-size:11.5px;overflow:hidden;" +
      "text-overflow:ellipsis;white-space:nowrap";
    const meta = document.createElement("div");
    meta.textContent = `${c.messages.length} msg · ${new Date(c.updatedAt).toLocaleString()}`;
    meta.style.cssText = "font-size:9.5px;color:var(--text-tertiary,#6b7280)";
    info.append(name, meta);

    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete conversation";
    del.style.cssText =
      "padding:2px 5px;background:transparent;color:var(--text-secondary);" +
      "border:1px solid var(--border-default);border-radius:3px;" +
      "cursor:pointer;font-size:10px;flex-shrink:0";
    del.onclick = (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete "${c.title}"?`)) return;
      deleteConversation(c.id);
      historyDropdown?.remove();
      historyDropdown = null;
      toggleHistoryDropdown(anchor);
    };

    row.onclick = () => {
      loadConversation(c.id);
      historyDropdown?.remove();
      historyDropdown = null;
    };

    row.append(info, del);
    historyDropdown.appendChild(row);
  }

  panel.appendChild(historyDropdown);
  bindHistoryOutsideClick();
}

function bindHistoryOutsideClick(): void {
  setTimeout(() => {
    const close = (ev: MouseEvent) => {
      if (!historyDropdown) return;
      const tgt = ev.target as Node;
      if (!historyDropdown.contains(tgt)) {
        historyDropdown.remove();
        historyDropdown = null;
        document.removeEventListener("mousedown", close);
      }
    };
    document.addEventListener("mousedown", close);
  }, 0);
}

/* ═════════════════════════════════════════════════════════════════════════
   Settings pane
   ═════════════════════════════════════════════════════════════════════════ */
const INPUT_CSS =
  "width:100%;box-sizing:border-box;padding:5px 7px;background:var(--bg-inset,#0e1017);" +
  "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;" +
  "color:var(--text-primary,#e8eaf0);font:11.5px system-ui;outline:none";

interface Preset {
  group: string;
  label: string;
  needsKey: boolean;
  cfg: ProviderConfig;
}

const PRESETS: Preset[] = [
  {
    group: "Local",
    label: "Ollama · llama3.1",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "llama3.1" },
  },
  {
    group: "Local",
    label: "Ollama · qwen2.5",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "qwen2.5:7b" },
  },
  {
    group: "Local",
    label: "Ollama · mistral-nemo",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "mistral-nemo" },
  },
  {
    group: "Local",
    label: "Ollama · command-r",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "command-r" },
  },
  {
    group: "Local",
    label: "LM Studio",
    needsKey: false,
    cfg: { kind: "openai", endpoint: "http://localhost:1234", model: "local-model" },
  },
  {
    group: "Cloud (free)",
    label: "Gemini · 3.6 Flash",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.6-flash",
    },
  },
  {
    group: "Cloud (free)",
    label: "Gemini · 3.5 Flash",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-3.5-flash",
    },
  },
  {
    group: "Cloud (free)",
    label: "Groq · qwen3.8-27b",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://api.groq.com/openai",
      model: "qwen/qwen3.8-27b",
    },
  },
  {
    group: "Cloud (free)",
    label: "Groq · llama-3.1-8b",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://api.groq.com/openai",
      model: "llama-3.1-8b-instant",
    },
  },
  {
    group: "Cloud (free)",
    label: "OpenRouter · llama free",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://openrouter.ai/api",
      model: "meta-llama/llama-3.3-70b-instruct:free",
    },
  },
  {
    group: "Cloud (free)",
    label: "Cerebras · llama-3.3",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.cerebras.ai", model: "llama-3.3-70b" },
  },
  {
    group: "Cloud (paid)",
    label: "OpenAI · gpt-4o-mini",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.openai.com", model: "gpt-4o-mini" },
  },
  {
    group: "Cloud (paid)",
    label: "OpenAI · gpt-4o",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.openai.com", model: "gpt-4o" },
  },
  {
    group: "Cloud (paid)",
    label: "DeepSeek · chat",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.deepseek.com", model: "deepseek-chat" },
  },
  {
    group: "Cloud (paid)",
    label: "Mistral · large",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.mistral.ai", model: "mistral-large-latest" },
  },
  {
    group: "Cloud (paid)",
    label: "Together · llama-70b",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://api.together.xyz",
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    },
  },
  {
    group: "Cloud (paid)",
    label: "Anthropic · claude-3.5",
    needsKey: true,
    cfg: {
      kind: "openai",
      endpoint: "https://api.anthropic.com",
      model: "claude-3-5-sonnet-20241022",
    },
  },
];

/* ── Save helper — reports failure visibly ─────────────────────────────── */
function commitConfig(): void {
  const ok = saveProviderConfig(cfg);
  if (ok) {
    const warn = settingsPane.querySelector("[data-save-warning]");
    if (warn) warn.remove();
    return;
  }

  // Save failed — surface it in the pane.
  let warn = settingsPane.querySelector("[data-save-warning]") as HTMLElement | null;
  if (!warn) {
    warn = document.createElement("div");
    warn.dataset.saveWarning = "1";
    warn.style.cssText =
      "padding:6px 8px;margin:4px 0;font:11px system-ui;" +
      "color:#fca5a5;background:rgba(239,68,68,.12);" +
      "border:1px solid rgba(239,68,68,.4);border-radius:4px;line-height:1.5";
    settingsPane.prepend(warn);
  }
  warn.textContent =
    "Could not save settings: " +
    (getLastSaveError() ||
      "localStorage unavailable. Try disabling private/incognito mode.");

  console.error("[ai-chat] settings save failed:", getLastSaveError());
}

function renderSettings(): void {
  if (!showSettings) {
    settingsPane.style.display = "none";
    return;
  }
  settingsPane.style.display = "flex";
  settingsPane.innerHTML = "";

  const row = (label: string, control: HTMLElement): HTMLElement => {
    const r = document.createElement("div");
    r.style.cssText =
      "display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center";
    const l = document.createElement("label");
    l.textContent = label;
    l.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
    r.append(l, control);
    return r;
  };

  /* ── Provider kind ── */
  const pSel = document.createElement("select");
  pSel.style.cssText = INPUT_CSS;
  pSel.innerHTML =
    `<option value="ollama">Ollama (local)</option>` +
    `<option value="openai">OpenAI-compatible</option>`;
  pSel.value = cfg.kind;
  pSel.onchange = () => {
    cfg.kind = pSel.value as any;
    if (cfg.kind === "ollama") {
      cfg.endpoint = "http://localhost:11434";
      cfg.model = "llama3.1";
      cfg.apiKey = undefined;
    } else {
      cfg.endpoint = "https://api.openai.com";
      cfg.model = "gpt-4o-mini";
    }
    commitConfig();
    renderHeader();
    renderSettings();
  };
  settingsPane.appendChild(row("Provider", pSel));

  /* ── Endpoint ──
     oninput → saves on every keystroke, so nothing is lost. */
  const ep = document.createElement("input");
  ep.type = "text";
  ep.value = cfg.endpoint;
  ep.style.cssText = INPUT_CSS;
  ep.placeholder =
    cfg.kind === "ollama" ? "http://localhost:11434" : "https://api.openai.com";
  ep.oninput = () => {
    cfg.endpoint = ep.value.trim() || DEFAULT_CONFIG.endpoint;
    commitConfig();
    renderHeader();
  };
  settingsPane.appendChild(row("Endpoint", ep));

  /* ── Model dropdown ── */
  const modelSelect = document.createElement("select");
  modelSelect.style.cssText = INPUT_CSS + ";cursor:pointer";
  modelSelect.innerHTML = `<option value="${esc(cfg.model)}">${esc(cfg.model)}</option>`;
  modelSelect.value = cfg.model;
  modelSelect.onchange = () => {
    if (!modelSelect.value) return;
    cfg.model = modelSelect.value;
    commitConfig();
    renderHeader();
    const manual = settingsPane.querySelector(
      "input[data-manual-model]",
    ) as HTMLInputElement | null;
    if (manual) manual.value = cfg.model;
  };
  settingsPane.appendChild(row("Model", modelSelect));

  /* ── Manual model override ── */
  const manual = document.createElement("input");
  manual.type = "text";
  manual.value = cfg.model;
  manual.dataset.manualModel = "1";
  manual.style.cssText = INPUT_CSS;
  manual.placeholder = cfg.kind === "ollama" ? "custom model tag" : "model id";
  manual.oninput = () => {
    cfg.model = manual.value.trim() || DEFAULT_CONFIG.model;
    commitConfig();
    renderHeader();
    modelSelect.value = cfg.model;
  };
  settingsPane.appendChild(row("Custom", manual));

  /* ── API key ──
     oninput → saves on every keystroke. onpaste → belt-and-braces for
     browser autofill and middle-click paste. */
  if (cfg.kind === "openai") {
    const k = document.createElement("input");
    k.type = "password";
    k.value = cfg.apiKey ?? "";
    k.style.cssText = INPUT_CSS;
    k.placeholder = "paste your key here";
    k.oninput = () => {
      cfg.apiKey = k.value || undefined;
      commitConfig();
    };
    k.onpaste = () => {
      setTimeout(() => {
        cfg.apiKey = k.value || undefined;
        commitConfig();
      }, 0);
    };
    settingsPane.appendChild(row("API key", k));
  }

  /* ── Test connection ── */
  const testRow = document.createElement("div");
  testRow.style.cssText =
    "display:flex;gap:8px;align-items:flex-start;margin-top:4px";
  const test = document.createElement("button");
  test.textContent = "Test connection";
  test.style.cssText =
    "padding:5px 12px;background:var(--bg-hover,#232633);color:var(--text-primary,#e8eaf0);" +
    "border:1px solid var(--border-default,#2a2e3a);border-radius:5px;cursor:pointer;" +
    "font:11.5px system-ui;flex-shrink:0";
  const status = document.createElement("span");
  status.style.cssText =
    "font-size:11px;color:var(--text-tertiary,#6b7280);line-height:1.4;" +
    "word-break:break-word;white-space:pre-wrap;flex:1";
  testRow.append(test, status);
  settingsPane.appendChild(testRow);

  /* ── Model list (populated by Test connection) ── */
  const modelsWrap = document.createElement("div");
  modelsWrap.style.cssText = "display:none;margin-top:6px";
  settingsPane.appendChild(modelsWrap);

  function renderModelsList(models: string[]): void {
    modelsWrap.innerHTML = "";
    if (!models.length) {
      modelsWrap.style.display = "none";
      return;
    }

    const scored = models
      .map((m) => ({ id: m, score: rankModel(m, cfg) }))
      .sort((a, b) => b.score - a.score);
    const chatModels = scored.filter((s) => s.score > 0);
    const otherModels = scored.filter((s) => s.score <= 0);

    const listHeader = document.createElement("div");
    listHeader.style.cssText =
      "font-size:10px;color:var(--text-tertiary,#6b7280);margin-bottom:6px";
    listHeader.innerHTML =
      `Click a model to use it · ` +
      `<b style="color:var(--accent,#38bdf8)">${chatModels.length}</b> chat-capable` +
      (otherModels.length ? `, ${otherModels.length} other` : "");
    modelsWrap.appendChild(listHeader);

    const list = document.createElement("div");
    list.style.cssText =
      "display:flex;flex-wrap:wrap;gap:4px;padding:8px;" +
      "background:var(--bg-inset,#0e1017);border:1px solid var(--border-subtle,#1e2029);" +
      "border-radius:5px;max-height:260px;overflow-y:auto;scrollbar-width:thin";
    modelsWrap.appendChild(list);

    const makeChip = (id: string, warn: boolean) => {
      const btn = document.createElement("button");
      const active = id === cfg.model;
      btn.textContent = warn ? `⚠ ${id}` : id;
      btn.title = warn ? `${id} — may not support chat` : `Use ${id}`;
      btn.style.cssText =
        "padding:3px 8px;border-radius:4px;cursor:pointer;font-size:10px;" +
        "font-family:var(--font-mono,monospace);white-space:nowrap;" +
        (active
          ? "background:var(--accent-dim,rgba(56,189,248,.14));color:var(--accent,#38bdf8);" +
            "border:1px solid var(--accent,#38bdf8)"
          : warn
            ? "background:transparent;color:#a0a6b5;border:1px solid rgba(245,158,11,.35)"
            : "background:transparent;color:var(--text-secondary,#a0a6b5);" +
              "border:1px solid var(--border-default,#2a2e3a)");
      btn.onclick = () => {
        cfg.model = id;
        commitConfig();
        renderHeader();
        manual.value = id;
        modelSelect.value = id;
        renderSettings();
      };
      return btn;
    };

    for (const { id } of chatModels) list.appendChild(makeChip(id, false));

    if (otherModels.length) {
      const toggle = document.createElement("button");
      toggle.textContent = showAllModels
        ? `Hide ${otherModels.length} other models`
        : `Show ${otherModels.length} other models`;
      toggle.style.cssText =
        "margin-top:6px;padding:3px 8px;background:transparent;" +
        "color:var(--text-tertiary,#6b7280);border:1px dashed var(--border-default,#2a2e3a);" +
        "border-radius:4px;cursor:pointer;font-size:10px";
      toggle.onclick = () => {
        showAllModels = !showAllModels;
        renderModelsList(models);
      };
      modelsWrap.appendChild(toggle);

      if (showAllModels) {
        const otherList = document.createElement("div");
        otherList.style.cssText =
          "display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;padding:8px;" +
          "background:var(--bg-inset,#0e1017);border:1px solid var(--border-subtle,#1e2029);" +
          "border-radius:5px;max-height:200px;overflow-y:auto";
        for (const { id } of otherModels) otherList.appendChild(makeChip(id, true));
        modelsWrap.appendChild(otherList);
      }
    }

    modelsWrap.style.display = "block";
  }

  test.onclick = async () => {
    status.textContent = "Testing…";
    status.style.color = "var(--text-tertiary,#6b7280)";
    modelsWrap.style.display = "none";
    try {
      const msg = await testProvider(cfg);
      status.textContent = msg;
      status.style.color = "#22c55e";
      try {
        const models = await listModels(cfg);
        renderModelsList(models);
      } catch {
        /* */
      }
    } catch (err) {
      status.textContent = err instanceof Error ? err.message : String(err);
      status.style.color = "#ef4444";
    }
  };

  /* ── Presets ── */
  const presetHeader = document.createElement("div");
  presetHeader.textContent = "Presets";
  presetHeader.style.cssText =
    "font-size:10.5px;color:var(--text-tertiary,#6b7280);margin-top:12px;" +
    "text-transform:uppercase;letter-spacing:.5px";
  settingsPane.appendChild(presetHeader);

  const groups = new Map<string, Preset[]>();
  for (const p of PRESETS) {
    const arr = groups.get(p.group) ?? [];
    arr.push(p);
    groups.set(p.group, arr);
  }

  for (const [groupName, items] of groups) {
    const gLabel = document.createElement("div");
    gLabel.textContent = groupName;
    gLabel.style.cssText =
      "font-size:10px;color:var(--text-tertiary,#6b7280);margin-top:8px";
    settingsPane.appendChild(gLabel);

    const gRow = document.createElement("div");
    gRow.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
    for (const p of items) {
      const btn = document.createElement("button");
      btn.textContent = p.needsKey ? `🔑 ${p.label}` : p.label;
      btn.title = p.needsKey ? `${p.label} — API key required` : p.label;
      btn.style.cssText =
        "padding:4px 9px;background:transparent;color:var(--text-secondary,#a0a6b5);" +
        "border:1px solid var(--border-default,#2a2e3a);border-radius:4px;" +
        "cursor:pointer;font-size:10.5px;white-space:nowrap";
      btn.onmouseenter = () => {
        btn.style.background = "var(--bg-hover,#232633)";
        btn.style.color = "var(--text-primary,#e8eaf0)";
      };
      btn.onmouseleave = () => {
        btn.style.background = "transparent";
        btn.style.color = "var(--text-secondary,#a0a6b5)";
      };
      btn.onclick = () => {
        // Read the live value from the API key input so we do not wipe a
        // key the user just typed without blurring.
        const liveKeyInput = settingsPane.querySelector(
          "input[type='password']",
        ) as HTMLInputElement | null;
        const liveKey = liveKeyInput?.value || cfg.apiKey;

        const keepKey = p.cfg.kind === "openai" ? liveKey : undefined;
        cfg = { ...p.cfg, apiKey: keepKey };
        commitConfig();
        renderHeader();
        renderSettings();
        settingsPane.scrollTop = 0;
      };
      gRow.appendChild(btn);
    }
    settingsPane.appendChild(gRow);
  }

  /* ═══════════════════════════════════════════════════════════════════
     Semantic index section
     ═══════════════════════════════════════════════════════════════════ */
  const idxHeader = document.createElement("div");
  idxHeader.textContent = "Semantic index";
  idxHeader.style.cssText =
    "font-size:10.5px;color:var(--text-tertiary,#6b7280);margin-top:14px;" +
    "text-transform:uppercase;letter-spacing:.5px";
  settingsPane.appendChild(idxHeader);

  const idxStatus = document.createElement("div");
  idxStatus.style.cssText = "font-size:11px;margin-top:4px;line-height:1.5";
  idxStatus.textContent = "Loading…";
  settingsPane.appendChild(idxStatus);

  void getIndexStats().then((stats) => {
    idxStatus.innerHTML = stats.total
      ? `${stats.total.toLocaleString()} element(s) indexed · ` +
        `${Object.keys(stats.byModel).length} model(s) · ` +
        `updated ${new Date(stats.updatedAt ?? 0).toLocaleString()}`
      : `Index is empty. Click Build to enable semantic search.`;
  });

  const idxRow = document.createElement("div");
  idxRow.style.cssText = "display:flex;gap:6px;margin-top:6px";

  const idxBuild = document.createElement("button");
  idxBuild.textContent = "Build index";
  idxBuild.style.cssText =
    "padding:5px 12px;background:var(--accent,#38bdf8);color:#0b0d12;border:none;" +
    "border-radius:5px;cursor:pointer;font:600 11.5px system-ui";
  idxBuild.onclick = async () => {
    idxBuild.disabled = true;
    const orig = idxBuild.textContent;
    idxBuild.textContent = "Building…";
    try {
      const embCfg: EmbeddingConfig =
        (settingsPane as any).__embCfg ?? loadEmbeddingConfig();
      await buildIndex({
        cfg: embCfg,
        onProgress: (p) => {
          const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
          idxStatus.textContent =
            `${p.phase} · ${p.current}/${p.total} (${pct}%) · model ${p.modelId || "—"}`;
        },
      });
      const stats = await getIndexStats();
      idxStatus.innerHTML = `${stats.total.toLocaleString()} element(s) indexed`;
    } catch (err) {
      idxStatus.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      idxBuild.disabled = false;
      idxBuild.textContent = orig;
    }
  };

  const idxClear = document.createElement("button");
  idxClear.textContent = "Clear index";
  idxClear.style.cssText =
    "padding:5px 12px;background:transparent;color:#fca5a5;" +
    "border:1px solid rgba(239,68,68,.5);border-radius:5px;cursor:pointer;" +
    "font:600 11.5px system-ui";
  idxClear.onclick = async () => {
    if (!confirm("Clear the semantic index?")) return;
    await clearIndex();
    idxStatus.textContent = "Index cleared.";
  };

  idxRow.append(idxBuild, idxClear);
  settingsPane.appendChild(idxRow);

  const embRow = document.createElement("div");
  embRow.style.cssText =
    "display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;margin-top:6px";
  const embLbl = document.createElement("label");
  embLbl.textContent = "Embeddings";
  embLbl.style.cssText = "font-size:11px;color:var(--text-secondary,#a0a6b5)";
  const embSel = document.createElement("select");
  embSel.style.cssText = INPUT_CSS;
  const embCfgInit = loadEmbeddingConfig();
  embSel.innerHTML =
    `<option value="ollama">Ollama · ${DEFAULT_EMBEDDING_CONFIG.model}</option>` +
    `<option value="openai">OpenAI-compatible</option>`;
  embSel.value = embCfgInit.provider;
  (settingsPane as any).__embCfg = embCfgInit;
  embSel.onchange = () => {
    const next: EmbeddingConfig =
      embSel.value === "ollama"
        ? { ...DEFAULT_EMBEDDING_CONFIG }
        : {
            provider: "openai",
            endpoint: "https://api.openai.com",
            model: "text-embedding-3-small",
            apiKey: cfg.apiKey,
          };
    saveEmbeddingConfig(next);
    (settingsPane as any).__embCfg = next;
  };
  embRow.append(embLbl, embSel);
  settingsPane.appendChild(embRow);

  /* ── Hint block ── */
  const hint = document.createElement("div");
  hint.style.cssText =
    "font-size:10px;color:var(--text-tertiary,#6b7280);margin-top:12px;" +
    "line-height:1.6;border-top:1px solid var(--border-subtle,#1e2029);padding-top:8px";
  if (cfg.kind === "ollama") {
    hint.innerHTML =
      `<b style="color:var(--text-secondary,#a0a6b5)">Ollama quick start</b><br>` +
      `1. Install from ollama.com<br>` +
      `2. Terminal: <span style="font-family:var(--font-mono,monospace)">ollama pull llama3.1</span><br>` +
      `3. Terminal: <span style="font-family:var(--font-mono,monospace)">ollama pull nomic-embed-text</span><br>` +
      `4. Click Test connection<br>` +
      `5. Build the semantic index`;
  } else if (cfg.endpoint.includes("generativelanguage.googleapis.com")) {
    hint.innerHTML =
      `<b style="color:var(--text-secondary,#a0a6b5)">Google Gemini</b><br>` +
      `Get a free key at <b>aistudio.google.com</b>. ` +
      `If a model 400s or 404s, pick a different one from the list above.`;
  } else if (
    /openai\.com|groq\.com|deepseek\.com|mistral\.ai|together\.xyz|openrouter\.ai|cerebras\.ai/i.test(
      cfg.endpoint,
    )
  ) {
    hint.innerHTML =
      `<b style="color:var(--text-secondary,#a0a6b5)">API key required</b><br>` +
      `Sign up at the provider's website, copy an API key, and paste it ` +
      `above.`;
  } else if (
    cfg.endpoint.includes("localhost") ||
    cfg.endpoint.includes("127.0.0.1")
  ) {
    hint.innerHTML =
      `<b style="color:var(--text-secondary,#a0a6b5)">Local endpoint</b><br>` +
      `Make sure the local server is running.`;
  }
  settingsPane.appendChild(hint);
}

/* ═════════════════════════════════════════════════════════════════════════
   Messages
   ═════════════════════════════════════════════════════════════════════════ */
function scrollMessagesIfFollowing(): void {
  if (autoScroll) {
    messages.scrollTop = messages.scrollHeight;
    return;
  }
  const dist =
    messages.scrollHeight - messages.scrollTop - messages.clientHeight;
  if (dist < 60) messages.scrollTop = messages.scrollHeight;
}

function renderMessages(): void {
  messages.innerHTML = "";

  if (!history.length) {
    const empty = document.createElement("div");
    empty.style.cssText =
      "padding:20px 12px;text-align:center;color:var(--text-tertiary,#6b7280);" +
      "font-size:11.5px;line-height:1.7";
    empty.innerHTML =
      `Ask me anything about the model.<br><br>` +
      `<span style="opacity:.7">Examples:</span><br>` +
      `<code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">how many doors are loaded?</code><br>` +
      `<code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">select all walls and focus</code><br>` +
      `<code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">run a clash test</code><br>` +
      `<code style="background:rgba(255,255,255,.06);padding:1px 5px;border-radius:3px">find the fire-rated doors near the stair core</code>`;
    messages.appendChild(empty);
    updateRegenVisibility();
    return;
  }

  for (const m of history) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      messages.appendChild(renderToolResult(m));
      continue;
    }
    messages.appendChild(renderBubble(m));
  }

  scrollMessagesIfFollowing();
  updateRegenVisibility();
  updateTokenCount();
}

function updateRegenVisibility(): void {
  const hasUser = history.some((m) => m.role === "user");
  regenBtn.style.display = !busy && hasUser ? "inline-block" : "none";
}

function updateTokenCount(): void {
  let total = 0;
  for (const m of history) {
    const text = m.content || "";
    total += Math.ceil(text.length / 4);
  }
  if (total > 0) tokenCountEl.textContent = `~${total.toLocaleString()} tok`;
  else tokenCountEl.textContent = "";
}

function attachCopyButton(wrap: HTMLElement, getText: () => string): void {
  const copy = document.createElement("button");
  copy.textContent = "📋";
  copy.title = "Copy message";
  copy.style.cssText =
    "position:absolute;top:4px;right:4px;padding:2px 6px;font-size:10px;" +
    "background:rgba(0,0,0,.35);color:#fff;border:none;border-radius:3px;" +
    "cursor:pointer;opacity:0;transition:opacity .15s";
  wrap.style.position = "relative";
  wrap.appendChild(copy);
  wrap.onmouseenter = () => (copy.style.opacity = "1");
  wrap.onmouseleave = () => (copy.style.opacity = "0");
  copy.onclick = (ev) => {
    ev.stopPropagation();
    const text = getText();
    void navigator.clipboard.writeText(text).then(
      () => {
        copy.textContent = "✓";
        setTimeout(() => (copy.textContent = "📋"), 1200);
      },
      () => {
        copy.textContent = "✗";
        setTimeout(() => (copy.textContent = "📋"), 1200);
      },
    );
  };
}

function renderBubble(m: ChatMessage): HTMLElement {
  const wrap = document.createElement("div");
  const isUser = m.role === "user";
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:4px;" +
    (isUser ? "align-items:flex-end" : "align-items:flex-start");

  const bubble = document.createElement("div");
  bubble.style.cssText =
    "max-width:88%;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;" +
    "word-break:break-word;overflow-wrap:anywhere;" +
    (isUser
      ? "background:var(--accent,#38bdf8);color:#0b0d12;border-bottom-right-radius:2px;white-space:pre-wrap"
      : "background:var(--bg-hover,#232633);color:var(--text-primary,#e8eaf0);" +
        "border-bottom-left-radius:2px");

  if (isUser) {
    bubble.textContent = m.content;
  } else {
    const html = renderMarkdown(m.content || "");
    bubble.innerHTML =
      html ||
      (m.toolCalls?.length ? "<em>(calling tools…)</em>" : "<em>(empty)</em>");
  }

  wrap.appendChild(bubble);
  attachCopyButton(wrap, () => m.content || "");

  if (m.toolCalls?.length) {
    const chips = document.createElement("div");
    chips.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;max-width:88%";
    for (const tc of m.toolCalls) {
      const chip = document.createElement("span");
      chip.style.cssText =
        "padding:2px 7px;background:rgba(56,189,248,.14);color:var(--accent,#38bdf8);" +
        "border:1px solid rgba(56,189,248,.35);border-radius:4px;font-size:10px;" +
        "font-family:var(--font-mono,monospace)";
      chip.textContent = `▶ ${tc.name}`;
      chip.title = JSON.stringify(tc.args, null, 2);
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);
  }

  return wrap;
}

function renderToolResult(m: ChatMessage): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "max-width:88%;align-self:flex-start";

  const details = document.createElement("details");
  details.style.cssText = "font-size:10.5px";

  const summary = document.createElement("summary");
  summary.style.cssText =
    "cursor:pointer;padding:2px 6px;color:var(--text-tertiary,#6b7280);" +
    "font-family:var(--font-mono,monospace);user-select:none";
  summary.textContent = `← ${m.name ?? "tool"} result`;
  details.appendChild(summary);

  const pre = document.createElement("pre");
  pre.style.cssText =
    "margin:4px 0;padding:6px 8px;background:var(--bg-inset,#0e1017);" +
    "border:1px solid var(--border-subtle,#1e2029);border-radius:5px;" +
    "font-size:10px;line-height:1.45;overflow:auto;max-height:240px;" +
    "white-space:pre-wrap;color:var(--text-secondary,#a0a6b5)";
  try {
    const parsed = JSON.parse(m.content);
    pre.textContent = JSON.stringify(parsed, null, 2);
  } catch {
    pre.textContent = m.content;
  }
  details.appendChild(pre);

  wrap.appendChild(details);
  return wrap;
}

/* ═════════════════════════════════════════════════════════════════════════
   Streaming bubble
   ═════════════════════════════════════════════════════════════════════════ */
function createStreamingBubble(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:4px;align-items:flex-start";

  const bubble = document.createElement("div");
  bubble.style.cssText =
    "max-width:88%;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.5;" +
    "background:var(--bg-hover,#232633);color:var(--text-primary,#e8eaf0);" +
    "border-bottom-left-radius:2px;white-space:pre-wrap;word-break:break-word;" +
    "overflow-wrap:anywhere;min-height:18px;min-width:24px";
  bubble.textContent = "…";

  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  scrollMessagesIfFollowing();

  return bubble;
}

/* ═════════════════════════════════════════════════════════════════════════
   Confirmation card
   ═════════════════════════════════════════════════════════════════════════ */
function showConfirmationCard(
  toolName: string,
  args: Record<string, any>,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "max-width:92%;align-self:flex-start;border:1px solid #f59e0b;" +
      "border-left:3px solid #f59e0b;border-radius:6px;padding:10px 12px;" +
      "background:rgba(245,158,11,.08);font-size:11.5px;line-height:1.5";
    wrap.onmousedown = (e) => e.stopPropagation();

    const title = document.createElement("div");
    title.style.cssText =
      "font-weight:700;color:#fbbf24;margin-bottom:4px;display:flex;gap:6px;align-items:center";
    title.innerHTML = `<span style="font-size:14px">⚠</span> Confirmation required`;

    const msg = document.createElement("div");
    msg.style.cssText = "margin-bottom:8px;color:var(--text-primary,#e8eaf0)";
    msg.innerHTML =
      `The AI wants to run <code style="background:rgba(255,255,255,.08);` +
      `padding:1px 5px;border-radius:3px;font-family:var(--font-mono,monospace)">` +
      `${toolName}</code>.`;

    const detail = document.createElement("details");
    detail.style.cssText = "margin-bottom:10px;font-size:10.5px";
    const detailSum = document.createElement("summary");
    detailSum.textContent = "Show arguments";
    detailSum.style.cssText =
      "cursor:pointer;color:var(--text-tertiary,#6b7280);" +
      "font-family:var(--font-mono,monospace);user-select:none";
    const detailPre = document.createElement("pre");
    detailPre.style.cssText =
      "margin:4px 0;padding:6px 8px;background:var(--bg-inset,#0e1017);" +
      "border:1px solid var(--border-subtle,#1e2029);border-radius:4px;" +
      "font-size:10px;white-space:pre-wrap;max-height:180px;overflow:auto";
    detailPre.textContent = JSON.stringify(args, null, 2);
    detail.append(detailSum, detailPre);

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px";

    const allow = document.createElement("button");
    allow.textContent = "✓ Allow";
    allow.style.cssText =
      "padding:5px 14px;background:#22c55e;color:#0b0d12;border:none;" +
      "border-radius:5px;cursor:pointer;font:600 11.5px system-ui";

    const deny = document.createElement("button");
    deny.textContent = "✕ Deny";
    deny.style.cssText =
      "padding:5px 14px;background:transparent;color:#fca5a5;" +
      "border:1px solid rgba(239,68,68,.6);border-radius:5px;cursor:pointer;" +
      "font:600 11.5px system-ui";

    let resolved = false;
    const finish = (approved: boolean) => {
      if (resolved) return;
      resolved = true;
      wrap.remove();
      resolve(approved);
    };
    allow.onclick = () => finish(true);
    deny.onclick = () => finish(false);

    btnRow.append(allow, deny);
    wrap.append(title, msg, detail, btnRow);
    messages.appendChild(wrap);
    scrollMessagesIfFollowing();

    setTimeout(() => deny.focus(), 30);
  });
}

/* ═════════════════════════════════════════════════════════════════════════
   Agent loop
   ═════════════════════════════════════════════════════════════════════════ */
async function runAgentLoop(): Promise<void> {
  if (busy) return;
  if (!history.length) return;
  const last = history[history.length - 1];
  if (last.role !== "user") return;

  busy = true;
  abort = new AbortController();
  sendBtn.textContent = "Stop";
  sendBtn.style.background = "#ef4444";
  regenBtn.style.display = "none";

  try {
    const sys: ChatMessage = { role: "system", content: SYSTEM_PROMPT };

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const bubble = createStreamingBubble();
      let acc = "";
      let firstToken = true;

      const result = await callChatStream(
        cfg,
        {
          messages: [sys, ...history],
          tools: TOOLS,
          signal: abort.signal,
        },
        (delta) => {
          if (firstToken) {
            bubble.textContent = "";
            firstToken = false;
          }
          acc += delta;
          bubble.textContent = acc;
          scrollMessagesIfFollowing();
        },
      );

      history.push(result.message);
      renderMessages();
      persistCurrent();

      if (!result.toolCalls.length) break;

      for (const call of result.toolCalls) {
        let output: { ok: boolean; data?: any; error?: string };
        if (isDestructiveTool(call.name)) {
          const approved = await showConfirmationCard(call.name, call.args);
          if (approved) {
            output = await executeTool(call);
          } else {
            output = { ok: false, error: "User declined to run this tool." };
          }
        } else {
          output = await executeTool(call);
        }
        history.push({
          role: "tool",
          content: JSON.stringify(output),
          toolCallId: call.id,
          name: call.name,
        });
      }
      renderMessages();
      persistCurrent();
    }
  } catch (err) {
    if ((err as any)?.name === "AbortError") {
      console.log("[ai-chat] aborted by user");
      renderMessages();
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      history.push({ role: "assistant", content: `⚠ ${msg}` });
      renderMessages();
      persistCurrent();
    }
  } finally {
    busy = false;
    sendBtn.textContent = "Send";
    sendBtn.style.background = "var(--accent,#38bdf8)";
    abort = null;
    updateRegenVisibility();
    renderHeader();
  }
}

/* ═════════════════════════════════════════════════════════════════════════
   Send / Regenerate
   ═════════════════════════════════════════════════════════════════════════ */
async function send(): Promise<void> {
  if (busy) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  input.style.height = "auto";

  ensureConversation();
  history.push({ role: "user", content: text });
  renderMessages();
  persistCurrent();

  await runAgentLoop();
}

async function regenerate(): Promise<void> {
  if (busy) return;
  let lastUserIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return;
  history.length = lastUserIdx + 1;
  renderMessages();
  persistCurrent();
  await runAgentLoop();
}

/* ═════════════════════════════════════════════════════════════════════════
   Input
   ═════════════════════════════════════════════════════════════════════════ */
sendBtn.onclick = () => {
  if (busy) {
    try {
      abort?.abort();
    } catch {
      /* */
    }
  } else {
    void send();
  }
};

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (busy) return;
    void send();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  const h = Math.min(120, Math.max(36, input.scrollHeight));
  input.style.height = `${h}px`;
});

/* ═════════════════════════════════════════════════════════════════════════
   Public API
   ═════════════════════════════════════════════════════════════════════════ */
export function openAiChat(): void {
  try {
    dock?.show();
  } catch (err) {
    console.warn("[ai-chat] dock.show threw", err);
  }
  if (panel.style.display === "none" || !panel.style.display) {
    panel.style.display = "flex";
  }
  renderHeader();
  renderSettings();
  renderMessages();
  setTimeout(() => {
    try {
      input.focus();
    } catch {
      /* */
    }
  }, 50);
}

export function closeAiChat(): void {
  try {
    dock?.hide();
  } catch {
    /* */
  }
  panel.style.display = "none";
}

export function toggleAiChat(): void {
  if (isAiChatVisible()) closeAiChat();
  else openAiChat();
}

export function isAiChatVisible(): boolean {
  return panel.style.display !== "none" && !!panel.style.display;
}

/* ═════════════════════════════════════════════════════════════════════════
   Setup
   ═════════════════════════════════════════════════════════════════════════ */
export function setupAiChat(): void {
  if (initialized) {
    console.log("[ai-chat] already initialized, skipping setup");
    return;
  }
  initialized = true;

  loadConversationsFromStorage();

  ctx.rightHost.appendChild(panel);

  dock = makeDockable(panel, {
    id: "ai-chat",
    host: ctx.rightHost,
    header,
    minWidth: 320,
    minHeight: 360,
    defaultDock: "right",
    defaultWidth: 420,
    defaultHeight: 640,
    margin: 8,
    snapThreshold: 32,
  });

  setupAiTools();
  renderHeader();
  renderSettings();
  renderMessages();

  const observer = new MutationObserver(() => {
    if (panel.style.display !== "none" && header.children.length === 0) {
      console.warn("[ai-chat] header empty while visible — re-rendering");
      renderHeader();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["style"] });
  observer.observe(header, { childList: true });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isAiChatVisible()) {
      if (historyDropdown) {
        historyDropdown.remove();
        historyDropdown = null;
        return;
      }
      closeAiChat();
    }
  });

  (ctx.features as any).aiChat = {
    open: openAiChat,
    close: closeAiChat,
    toggle: toggleAiChat,
    isVisible: isAiChatVisible,
    send,
    regenerate,
    clear: () => {
      history = [];
      persistCurrent();
      renderMessages();
    },
    newChat: newConversation,
    getProvider: () => ({ ...cfg }),
    setProvider: (patch: Partial<ProviderConfig>) => {
      cfg = { ...cfg, ...patch };
      saveProviderConfig(cfg);
      renderHeader();
      renderSettings();
    },
  };

  console.log("[ai-chat] ready · provider:", cfg.kind, cfg.model);
}