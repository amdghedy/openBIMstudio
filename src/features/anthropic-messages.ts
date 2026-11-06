/**
 * Pure helpers for Anthropic's native Messages API (POST /v1/messages).
 * No DOM, no fetch, no storage: request building, response parsing and the
 * SSE stream reducer live here so they can be unit-tested without a network.
 *
 * Each user supplies their OWN Anthropic API key. A consumer Claude.ai
 * (free/Pro) login is not an API credential and cannot be used by a
 * third-party app, so this module never handles one.
 */

export interface AnthropicToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, any>; required?: string[] };
}
export interface AnthropicToolCall { id: string; name: string; args: Record<string, any>; }
export interface AnthropicChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: AnthropicToolCall[];
  toolCallId?: string;
}

export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_BASE = "https://api.anthropic.com";
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";
export const ANTHROPIC_MAX_TOKENS = 4096;

export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    // Required by Anthropic for calls made straight from a browser with the user's own key.
    "anthropic-dangerous-direct-browser-access": "true",
  };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

/** Keys look like sk-ant-...; this is a format hint only, never proof of validity. */
export function looksLikeAnthropicKey(key: string | undefined): boolean {
  return !!key && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "tool_result"; tool_use_id: string; content: string };

/**
 * OpenAI-style history -> Anthropic. System text is hoisted to `system`;
 * consecutive tool results are merged into ONE user turn (the API requires
 * all tool_result blocks for an assistant turn to arrive together); adjacent
 * same-role turns are merged because the API requires alternation.
 */
export function toAnthropicMessages(messages: AnthropicChatMessage[]): {
  system: string | undefined;
  messages: { role: "user" | "assistant"; content: Block[] }[];
} {
  const systemParts: string[] = [];
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "system") { if (m.content) systemParts.push(m.content); continue; }
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId ?? "unknown", content: m.content }]);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Block[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      push("assistant", blocks);
      continue;
    }
    if (m.content) push("user", [{ type: "text", text: m.content }]);
  }
  // The conversation must start with a user turn.
  if (out.length && out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });
  return { system: systemParts.length ? systemParts.join("\n\n") : undefined, messages: out };
}

export function buildAnthropicBody(
  model: string,
  messages: AnthropicChatMessage[],
  tools: AnthropicToolDef[],
  stream: boolean,
  maxTokens = ANTHROPIC_MAX_TOKENS,
): Record<string, any> {
  const mapped = toAnthropicMessages(messages);
  const body: Record<string, any> = { model, max_tokens: maxTokens, messages: mapped.messages };
  if (mapped.system) body.system = mapped.system;
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    body.tool_choice = { type: "auto" };
  }
  if (stream) body.stream = true;
  return body;
}

export interface ParsedAnthropic { content: string; toolCalls: AnthropicToolCall[]; stopReason?: string; }

/** Non-streaming response -> text + tool calls. */
export function parseAnthropicResponse(json: any): ParsedAnthropic {
  const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
  let content = "";
  const toolCalls: AnthropicToolCall[] = [];
  for (const b of blocks) {
    if (b?.type === "text" && typeof b.text === "string") content += b.text;
    else if (b?.type === "tool_use") {
      toolCalls.push({
        id: String(b.id ?? `toolu-${toolCalls.length}`),
        name: String(b.name ?? ""),
        args: b.input && typeof b.input === "object" ? b.input : {},
      });
    }
  }
  return { content, toolCalls: toolCalls.filter((t) => t.name), stopReason: json?.stop_reason };
}

/** Incremental reducer for the Messages SSE stream. Feed it each `data:` JSON object. */
export class AnthropicStreamReducer {
  content = "";
  stopReason: string | undefined;
  error: string | undefined;
  private blocks = new Map<number, { id: string; name: string; json: string }>();

  /** Returns the text delta to show (if any). */
  push(ev: any): string {
    if (!ev || typeof ev !== "object") return "";
    switch (ev.type) {
      case "content_block_start": {
        const cb = ev.content_block;
        if (cb?.type === "tool_use") this.blocks.set(ev.index, { id: String(cb.id ?? ""), name: String(cb.name ?? ""), json: "" });
        return "";
      }
      case "content_block_delta": {
        const d = ev.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") { this.content += d.text; return d.text; }
        if (d?.type === "input_json_delta" && typeof d.partial_json === "string") {
          const b = this.blocks.get(ev.index);
          if (b) b.json += d.partial_json;
        }
        return "";
      }
      case "message_delta":
        if (ev.delta?.stop_reason) this.stopReason = ev.delta.stop_reason;
        return "";
      case "error":
        this.error = String(ev.error?.message ?? "stream error");
        return "";
      default:
        return "";
    }
  }

  result(): ParsedAnthropic {
    const toolCalls: AnthropicToolCall[] = [];
    for (const idx of [...this.blocks.keys()].sort((a, b) => a - b)) {
      const b = this.blocks.get(idx)!;
      if (!b.name) continue;
      let args: Record<string, any> = {};
      if (b.json.trim()) { try { const p = JSON.parse(b.json); if (p && typeof p === "object") args = p; } catch { /* truncated JSON -> no args */ } }
      toolCalls.push({ id: b.id || `toolu-${idx}`, name: b.name, args });
    }
    return { content: this.content, toolCalls, stopReason: this.stopReason };
  }
}

/** Anthropic-specific, plain-language HTTP error text. */
export function anthropicErrorMessage(status: number, body: string): string {
  let detail = "";
  try { detail = JSON.parse(body)?.error?.message ?? ""; } catch { detail = body.slice(0, 240); }
  const tail = detail ? `\n\nAnthropic said: ${detail}` : "";
  switch (status) {
    case 401: return "401 — the Anthropic API key is missing or invalid. Create one at console.anthropic.com → API keys and paste it in the API key field." + tail;
    case 403: return "403 — this key is not allowed to use that model or feature." + tail;
    case 404: return "404 — the model name does not exist on your account. Pick one from the model list." + tail;
    case 429: return "429 — rate limit or usage limit reached on your Anthropic account. Wait a moment or check your limits at console.anthropic.com." + tail;
    case 400: return "400 — Anthropic rejected the request (for example a credit balance of zero)." + tail;
    case 529: return "529 — Anthropic is overloaded. Try again shortly." + tail;
    default: return `${status} — Anthropic request failed.` + tail;
  }
}
