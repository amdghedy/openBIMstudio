/**
 * Local model modes for the AI chat (Ollama).
 *
 * The user named these models. The tags are kept exactly as given. Nothing
 * here claims a model works: whether a tag is installed is read from the
 * user's own Ollama (GET /api/tags) at run time, and a mode only uses a tag
 * that Ollama reports. If none of a mode's tags is installed, the mode says so.
 */

export type ModelMode = "fast" | "analyze" | "reason";

export const MODEL_MODE_ORDER: ModelMode[] = ["fast", "analyze", "reason"];

export const MODEL_MODE_LABEL: Record<ModelMode, string> = {
  fast: "Fast",
  analyze: "Analyze",
  reason: "Reason",
};

/** Preference order per mode, exactly as the user listed them. */
export const MODEL_MODE_TAGS: Record<ModelMode, readonly string[]> = {
  fast: ["qwen3:8b", "qwen3:latest", "qwen3:4b"],
  analyze: ["gemma4:12b", "gemma4:latest", "gemma3:12b", "qwen3:8b"],
  reason: ["deepseek-r1:14b", "gemma4:12b"],
};

/** Every distinct tag the modes know about, in first-seen order. */
export function knownModeTags(): string[] {
  const seen: string[] = [];
  for (const m of MODEL_MODE_ORDER) for (const t of MODEL_MODE_TAGS[m]) if (!seen.includes(t)) seen.push(t);
  return seen;
}

/** Compare two Ollama tags: "qwen3" and "qwen3:latest" are the same tag, anything else is exact. */
export function sameTag(a: string, b: string): boolean {
  const n = (s: string) => {
    const t = s.trim().toLowerCase();
    return t.includes(":") ? t : `${t}:latest`;
  };
  return n(a) === n(b);
}

export interface ModePick {
  mode: ModelMode;
  /** The installed tag to use, or null when none of the mode's tags is installed. */
  model: string | null;
  /** Mode tags that are installed, in preference order. */
  installed: string[];
  /** Mode tags that are not installed. */
  missing: string[];
}

/** Choose the first of the mode's tags that the user's Ollama reports as installed. */
export function pickModelForMode(mode: ModelMode, installedTags: readonly string[]): ModePick {
  const installed: string[] = [];
  const missing: string[] = [];
  let model: string | null = null;
  for (const tag of MODEL_MODE_TAGS[mode]) {
    const found = installedTags.find((t) => sameTag(t, tag));
    if (found) {
      installed.push(tag);
      // Use the name Ollama reported so the request matches what is installed.
      if (model === null) model = found;
    } else missing.push(tag);
  }
  return { mode, model, installed, missing };
}

export function describeModePick(p: ModePick): string {
  const label = MODEL_MODE_LABEL[p.mode];
  if (p.model) return `${label}: ${p.model}`;
  return `${label}: none of ${MODEL_MODE_TAGS[p.mode].join(", ")} is installed in Ollama. Run: ollama pull ${MODEL_MODE_TAGS[p.mode][0]}`;
}

/** True when Ollama refused a request because the model has no tool-calling support. */
export function isToolsUnsupportedError(status: number, body: string): boolean {
  if (status !== 400 && status !== 501) return false;
  return /does not support tools|tools? (is|are) not supported|doesn'?t support tools/i.test(body);
}

/** Remove <think>…</think> reasoning blocks that some models (deepseek-r1) put in the reply text. */
export function stripThinking(text: string): string {
  if (!text || !/<think>/i.test(text)) return text;
  const out = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "");
  // An unclosed block means the reply was cut off inside its reasoning.
  return out.replace(/<think>[\s\S]*$/i, "").trim();
}

/**
 * Context window to request from Ollama for a prompt of `chars` characters.
 * Ollama's default window is small and silently drops the start of a long
 * prompt, so a request that carries a document must ask for a bigger one.
 * About 3.2 characters per token is a cautious estimate for mixed text.
 */
export function ollamaNumCtx(chars: number): number {
  const tokens = Math.ceil(chars / 3.2) + 1536;
  const step = 4096;
  const rounded = Math.ceil(tokens / step) * step;
  return Math.min(Math.max(rounded, 8192), 32768);
}
