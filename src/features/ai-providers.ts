/**
 * LLM provider abstraction with reliable persistence.
 *
 * Persistence improvements:
 *   • saveProviderConfig reports failures instead of swallowing them
 *   • loadProviderConfig validates each field independently so a partial
 *     config doesn't reset the whole thing to defaults
 *   • onProviderConfigChanged lets UI subscribe to storage updates
 */

export type ProviderKind = "ollama" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  endpoint: string;
  model: string;
  apiKey?: string;
}

export const DEFAULT_CONFIG: ProviderConfig = {
  kind: "ollama",
  endpoint: "http://localhost:11434",
  model: "llama3.1",
};

const CONFIG_KEY = "obs.ai.provider";
const GEMINI_THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

/* ── Persistence ─────────────────────────────────────────────────────── */

let lastSaveError: string | null = null;
const listeners = new Set<(cfg: ProviderConfig) => void>();

export function onProviderConfigChanged(cb: (cfg: ProviderConfig) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(cfg: ProviderConfig): void {
  for (const cb of listeners) {
    try { cb(cfg); } catch { /* */ }
  }
}

export function getLastSaveError(): string | null {
  return lastSaveError;
}

export function loadProviderConfig(): ProviderConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };

    const parsed = JSON.parse(raw);

    // Validate each field independently — a bad `kind` doesn't reset `model`.
    const kind: ProviderKind = parsed?.kind === "openai" ? "openai" : "ollama";
    const endpoint = typeof parsed?.endpoint === "string" && parsed.endpoint
      ? parsed.endpoint
      : DEFAULT_CONFIG.endpoint;
    const model = typeof parsed?.model === "string" && parsed.model
      ? parsed.model
      : DEFAULT_CONFIG.model;
    const apiKey = typeof parsed?.apiKey === "string" && parsed.apiKey
      ? parsed.apiKey
      : undefined;

    return { kind, endpoint, model, apiKey };
  } catch (err) {
    console.warn("[ai-providers] load failed, using defaults", err);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveProviderConfig(cfg: ProviderConfig): boolean {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    lastSaveError = null;
    emit(cfg);
    console.log("[ai-providers] saved", {
      kind: cfg.kind,
      endpoint: cfg.endpoint,
      model: cfg.model,
      hasKey: !!cfg.apiKey,
    });
    return true;
  } catch (err: any) {
    lastSaveError = err?.message ?? String(err);
    console.error("[ai-providers] save FAILED:", lastSaveError, {
      kind: cfg.kind,
      endpoint: cfg.endpoint,
      model: cfg.model,
      hasKey: !!cfg.apiKey,
    });
    return false;
  }
}

/** Wipe the saved config and reload defaults. */
export function resetProviderConfig(): ProviderConfig {
  try { localStorage.removeItem(CONFIG_KEY); } catch { /* */ }
  const fresh = { ...DEFAULT_CONFIG };
  saveProviderConfig(fresh);
  return fresh;
}

/* ── The rest of the file is unchanged from here ── */
/* (ToolDef, ToolCall, ChatMessage, ChatResult, ChatRequest, TokenCallback,
    callChat, callChatStream, resolveEndpoint, classifyHttpError,
    networkErrorHint, callOllama, callOllamaStream, toOllamaMessage,
    callOpenAICompat, callOpenAIStream, buildOpenAIHeaders, toOpenAIMessage,
    joinUrl, normaliseArgs, testProvider, listModels — all identical.) */

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  extraContent?: Record<string, any>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ChatResult {
  message: ChatMessage;
  toolCalls: ToolCall[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
}

export type TokenCallback = (delta: string) => void;

export async function callChat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  if (cfg.kind === "ollama") return callOllama(cfg, req);
  return callOpenAICompat(cfg, req);
}

export async function callChatStream(
  cfg: ProviderConfig,
  req: ChatRequest,
  onToken: TokenCallback,
): Promise<ChatResult> {
  if (cfg.kind === "ollama") return callOllamaStream(cfg, req, onToken);
  return callOpenAIStream(cfg, req, onToken);
}

function resolveEndpoint(cfg: ProviderConfig): string {
  if (cfg.kind === "ollama") return "/ollama";
  const ep = cfg.endpoint.toLowerCase();
  if (ep.includes("localhost:1234") || ep.includes("127.0.0.1:1234")) return "/lmstudio";
  if (ep.includes("api.anthropic.com")) return "/anthropic";
  return cfg.endpoint;
}

function isGeminiEndpoint(cfg: ProviderConfig): boolean {
  return cfg.endpoint.includes("generativelanguage.googleapis.com");
}

function classifyHttpError(status: number, statusText: string, body: string): string {
  const trimmedBody = body.length > 240 ? body.slice(0, 240) + "…" : body;

  if (status === 400 && /thought_signature|thought signature/i.test(body)) {
    return `400 — Gemini rejected the request because a function call is missing its thought_signature. Try clearing the chat history (Clear button) and sending the message again.\n\nProvider said: ${trimmedBody}`;
  }
  switch (status) {
    case 401: return `401 Unauthorized — the API key is missing or invalid. Get one from the provider's dashboard and paste it in the API key field.` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    case 402: return `402 Payment Required — the provider account has no balance. Add funds or switch to a free-tier provider (Gemini, Groq, OpenRouter).` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    case 403: return `403 Forbidden — the API key is valid but does not have access to "${statusText}". Check your provider's billing / model access.` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    case 404: return `404 Not Found — the endpoint URL is wrong, or the model name does not exist on this provider.` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    case 429: return `429 Rate limit — the provider is throttling requests. Wait a moment or upgrade your plan.` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    case 500: case 502: case 503: case 504:
      return `${status} — the provider's server is having problems. Try again in a minute.` + (trimmedBody ? `\n\nProvider said: ${trimmedBody}` : "");
    default: return `${status} ${statusText}${trimmedBody ? `\n\n${trimmedBody}` : ""}`;
  }
}

function networkErrorHint(err: unknown, cfg: ProviderConfig): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch/i.test(msg)) {
    if (cfg.kind === "ollama") return `Cannot reach Ollama at ${cfg.endpoint}. Check that "ollama serve" is running.`;
    if (cfg.endpoint.includes("localhost") || cfg.endpoint.includes("127.0.0.1")) {
      return `Cannot reach ${cfg.endpoint}. The local server is not running, or it does not allow requests from the browser (CORS).`;
    }
    return `Cannot reach ${cfg.endpoint}. Either the network is down, or the provider does not send CORS headers for browser requests.`;
  }
  return msg;
}

/* Non-streaming Ollama */
async function callOllama(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const url = joinUrl(resolveEndpoint(cfg), "/api/chat");
  const body = {
    model: cfg.model,
    messages: req.messages.map(toOllamaMessage),
    tools: req.tools.map((t) => ({ type: "function", function: t })),
    stream: false,
  };
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: req.signal });
  } catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  const json: any = await res.json();
  const msg = json?.message ?? {};
  const content = String(msg.content ?? "");
  const rawCalls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
    const fn = c?.function ?? c;
    return {
      id: c?.id ?? `ollama-${Date.now()}-${i}`,
      name: String(fn?.name ?? ""),
      args: normaliseArgs(fn?.arguments),
      extraContent: c?.extra_content && typeof c.extra_content === "object" ? c.extra_content : undefined,
    };
  });
  return {
    message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) },
    toolCalls,
  };
}

/* Streaming Ollama — same as before */
async function callOllamaStream(cfg: ProviderConfig, req: ChatRequest, onToken: TokenCallback): Promise<ChatResult> {
  const url = joinUrl(resolveEndpoint(cfg), "/api/chat");
  const body = { model: cfg.model, messages: req.messages.map(toOllamaMessage), tools: req.tools.map((t) => ({ type: "function", function: t })), stream: true };
  let res: Response;
  try { res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: req.signal }); }
  catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  if (!res.body) throw new Error("Ollama returned no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  const toolCalls: ToolCall[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let obj: any;
        try { obj = JSON.parse(line); } catch { continue; }
        const content = obj?.message?.content;
        if (typeof content === "string" && content.length) { fullContent += content; onToken(content); }
        const rawCalls = obj?.message?.tool_calls;
        if (Array.isArray(rawCalls) && rawCalls.length) {
          for (const c of rawCalls) {
            const fn = c?.function ?? c;
            toolCalls.push({ id: c?.id ?? `ollama-${Date.now()}-${toolCalls.length}`, name: String(fn?.name ?? ""), args: normaliseArgs(fn?.arguments), extraContent: c?.extra_content && typeof c.extra_content === "object" ? c.extra_content : undefined });
          }
        }
        if (obj?.done) break;
      }
    }
  } finally { try { reader.releaseLock(); } catch { /* */ } }
  return {
    message: { role: "assistant", content: fullContent, ...(toolCalls.length ? { toolCalls } : {}) },
    toolCalls,
  };
}

function toOllamaMessage(m: ChatMessage): any {
  if (m.role === "tool") return { role: "tool", content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return { role: "assistant", content: m.content, tool_calls: m.toolCalls.map((tc) => { const call: any = { function: { name: tc.name, arguments: tc.args } }; if (tc.extraContent) call.extra_content = tc.extraContent; return call; }) };
  }
  return { role: m.role, content: m.content };
}

/* OpenAI-compatible non-streaming */
async function callOpenAICompat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const url = joinUrl(resolveEndpoint(cfg), "/v1/chat/completions");
  const isGemini = isGeminiEndpoint(cfg);
  const body = { model: cfg.model, messages: req.messages.map((m) => toOpenAIMessage(m, isGemini)), tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: req.tools.length ? "auto" : undefined };
  const headers = buildOpenAIHeaders(cfg);
  let res: Response;
  try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal }); }
  catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  const json: any = await res.json();
  const choice = json?.choices?.[0]?.message ?? {};
  const content = typeof choice.content === "string" ? choice.content : Array.isArray(choice.content) ? choice.content.map((c: any) => c?.text ?? "").join("") : "";
  const rawCalls: any[] = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
  const toolCalls: ToolCall[] = rawCalls.map((c, i) => ({ id: c?.id ?? `oai-${Date.now()}-${i}`, name: String(c?.function?.name ?? ""), args: normaliseArgs(c?.function?.arguments), extraContent: c?.extra_content && typeof c.extra_content === "object" ? c.extra_content : undefined }));
  return { message: { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) }, toolCalls };
}

/* OpenAI-compatible streaming — same as before */
async function callOpenAIStream(cfg: ProviderConfig, req: ChatRequest, onToken: TokenCallback): Promise<ChatResult> {
  const url = joinUrl(resolveEndpoint(cfg), "/v1/chat/completions");
  const isGemini = isGeminiEndpoint(cfg);
  const body = { model: cfg.model, messages: req.messages.map((m) => toOpenAIMessage(m, isGemini)), tools: req.tools.map((t) => ({ type: "function", function: t })), tool_choice: req.tools.length ? "auto" : undefined, stream: true };
  const headers = buildOpenAIHeaders(cfg);
  let res: Response;
  try { res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: req.signal }); }
  catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  if (!res.body) throw new Error("Provider returned no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullContent = "";
  interface PartialToolCall { id?: string; name?: string; argsStr?: string; extraContent?: any; }
  const toolCallMap = new Map<number, PartialToolCall>();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (line === "data: [DONE]") continue;
        if (!line.startsWith("data:")) continue;
        const jsonStr = line.slice(line.indexOf(":") + 1).trim();
        let obj: any;
        try { obj = JSON.parse(jsonStr); } catch { continue; }
        const delta = obj?.choices?.[0]?.delta ?? {};
        const content = delta.content;
        if (typeof content === "string" && content.length) { fullContent += content; onToken(content); }
        else if (Array.isArray(content)) { for (const part of content) { if (typeof part?.text === "string" && part.text.length) { fullContent += part.text; onToken(part.text); } } }
        const rawCalls = delta.tool_calls;
        if (Array.isArray(rawCalls)) {
          for (const c of rawCalls) {
            const idx = typeof c.index === "number" ? c.index : toolCallMap.size;
            let entry = toolCallMap.get(idx);
            if (!entry) { entry = {}; toolCallMap.set(idx, entry); }
            if (typeof c.id === "string" && c.id.length) entry.id = c.id;
            if (typeof c.function?.name === "string" && c.function.name.length) entry.name = (entry.name ?? "") + c.function.name;
            if (typeof c.function?.arguments === "string") entry.argsStr = (entry.argsStr ?? "") + c.function.arguments;
            if (c.extra_content && typeof c.extra_content === "object") entry.extraContent = c.extra_content;
          }
        }
      }
    }
  } finally { try { reader.releaseLock(); } catch { /* */ } }
  const toolCalls: ToolCall[] = [];
  const sortedIdx = [...toolCallMap.keys()].sort((a, b) => a - b);
  for (const idx of sortedIdx) {
    const entry = toolCallMap.get(idx)!;
    if (!entry.name) continue;
    toolCalls.push({ id: entry.id ?? `oai-${Date.now()}-${idx}`, name: entry.name, args: normaliseArgs(entry.argsStr), extraContent: entry.extraContent });
  }
  return { message: { role: "assistant", content: fullContent, ...(toolCalls.length ? { toolCalls } : {}) }, toolCalls };
}

function buildOpenAIHeaders(cfg: ProviderConfig): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.endpoint.includes("api.anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  return headers;
}

function toOpenAIMessage(m: ChatMessage, isGemini: boolean): any {
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "unknown", name: m.name };
  if (m.role === "assistant" && m.toolCalls?.length) {
    const tool_calls = m.toolCalls.map((tc, index) => {
      const base: any = { id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } };
      if (isGemini) {
        if (tc.extraContent?.google?.thought_signature) base.extra_content = tc.extraContent;
        else if (index === 0) base.extra_content = { google: { thought_signature: GEMINI_THOUGHT_SIGNATURE_BYPASS } };
      }
      return base;
    });
    return { role: "assistant", content: m.content || null, tool_calls };
  }
  return { role: m.role, content: m.content };
}

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path : "/" + path;
  return b + p;
}

function normaliseArgs(raw: any): Record<string, any> {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { return {}; }
  }
  return {};
}

export async function testProvider(cfg: ProviderConfig): Promise<string> {
  if (cfg.kind === "ollama") {
    const url = joinUrl(resolveEndpoint(cfg), "/api/tags");
    let res: Response;
    try { res = await fetch(url); } catch (err) { throw new Error(networkErrorHint(err, cfg)); }
    if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
    const json: any = await res.json();
    const names = (json?.models ?? []).map((m: any) => String(m?.name ?? m?.model ?? "")).filter(Boolean);
    return `OK · ${names.length} model(s): ${names.slice(0, 4).join(", ")}`;
  }
  const url = joinUrl(resolveEndpoint(cfg), "/v1/models");
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.endpoint.includes("api.anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  let res: Response;
  try { res = await fetch(url, { headers }); } catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  const json: any = await res.json();
  const ids = (json?.data ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
  return `OK · ${ids.length} model(s): ${ids.slice(0, 4).join(", ")}`;
}

export async function listModels(cfg: ProviderConfig): Promise<string[]> {
  if (cfg.kind === "ollama") {
    const url = joinUrl(resolveEndpoint(cfg), "/api/tags");
    let res: Response;
    try { res = await fetch(url); } catch (err) { throw new Error(networkErrorHint(err, cfg)); }
    if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
    const json: any = await res.json();
    const names = (json?.models ?? []).map((m: any) => String(m?.name ?? m?.model ?? "")).filter(Boolean);
    names.sort((a: string, b: string) => {
      const aLatest = a.endsWith(":latest") ? 1 : 0;
      const bLatest = b.endsWith(":latest") ? 1 : 0;
      if (aLatest !== bLatest) return aLatest - bLatest;
      return a.localeCompare(b);
    });
    return names;
  }
  const url = joinUrl(resolveEndpoint(cfg), "/v1/models");
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.endpoint.includes("api.anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  let res: Response;
  try { res = await fetch(url, { headers }); } catch (err) { throw new Error(networkErrorHint(err, cfg)); }
  if (!res.ok) { const txt = await res.text().catch(() => ""); throw new Error(classifyHttpError(res.status, res.statusText, txt)); }
  const json: any = await res.json();
  const ids = (json?.data ?? []).map((m: any) => String(m?.id ?? "")).filter(Boolean);
  ids.sort((a: string, b: string) => a.localeCompare(b));
  return ids;
}