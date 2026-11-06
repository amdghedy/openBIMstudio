/**
 * Provider presets for the AI settings pane. Pure data so a test can check
 * that every cloud host is allowed by the Content-Security-Policy.
 * Anything not listed here still works through "OpenAI-compatible" with a
 * custom endpoint (Azure OpenAI, Perplexity, Cohere, ... need a CSP entry, docs/CSP.md).
 * Model ids are defaults: providers rename models, so pick from the list after Test connection.
 */
import type { ProviderConfig } from "./ai-providers";

export interface Preset {
  group: string;
  label: string;
  needsKey: boolean;
  cfg: ProviderConfig;
}

export const PRESETS: Preset[] = [
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
    group: "Local · coding",
    label: "Ollama · qwen2.5-coder",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "qwen2.5-coder" },
  },
  {
    group: "Local · coding",
    label: "Ollama · qwen2.5-coder:7b",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "qwen2.5-coder:7b" },
  },
  {
    group: "Local · coding",
    label: "Ollama · qwen2.5-coder:14b",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "qwen2.5-coder:14b" },
  },
  {
    group: "Local · coding",
    label: "Ollama · deepseek-coder-v2",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "deepseek-coder-v2" },
  },
  {
    group: "Local · coding",
    label: "Ollama · codellama",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "codellama" },
  },
  {
    group: "Local · coding",
    label: "Ollama · starcoder2",
    needsKey: false,
    cfg: { kind: "ollama", endpoint: "http://localhost:11434", model: "starcoder2" },
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
    label: "Claude · Sonnet",
    needsKey: true,
    cfg: { kind: "anthropic", endpoint: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
  },
  {
    group: "Cloud (paid)",
    label: "Claude · Haiku (fast, cheap)",
    needsKey: true,
    cfg: { kind: "anthropic", endpoint: "https://api.anthropic.com", model: "claude-haiku-4-5" },
  },
  /* ── More OpenAI-compatible cloud providers (tool calling; base URL + /v1) ── */
  {
    group: "Cloud (free tier / trial credits)",
    label: "SambaNova · llama-3.3-70b",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.sambanova.ai", model: "Meta-Llama-3.3-70B-Instruct" },
  },
  {
    group: "Cloud (free tier / trial credits)",
    label: "NVIDIA NIM · llama-3.3-70b",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://integrate.api.nvidia.com", model: "meta/llama-3.3-70b-instruct" },
  },
  {
    group: "Cloud (paid)",
    label: "xAI · Grok",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.x.ai", model: "grok-4" },
  },
  {
    group: "Cloud (paid)",
    label: "Fireworks · llama-3.3-70b",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.fireworks.ai/inference", model: "accounts/fireworks/models/llama-v3p3-70b-instruct" },
  },
  {
    group: "Cloud (paid)",
    label: "Hyperbolic · llama-3.3-70b",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.hyperbolic.xyz", model: "meta-llama/Llama-3.3-70B-Instruct" },
  },
  {
    group: "Cloud (paid)",
    label: "Moonshot · Kimi K2",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://api.moonshot.ai", model: "kimi-k2-0905-preview" },
  },
  {
    group: "Cloud (paid)",
    label: "Alibaba Qwen · plus",
    needsKey: true,
    cfg: { kind: "openai", endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode", model: "qwen-plus" },
  },
  /* ── More local runtimes (data stays on your machine) ── */
  {
    group: "Local",
    label: "llama.cpp server",
    needsKey: false,
    cfg: { kind: "openai", endpoint: "http://localhost:8080", model: "local-model" },
  },
  {
    group: "Local",
    label: "vLLM",
    needsKey: false,
    cfg: { kind: "openai", endpoint: "http://localhost:8000", model: "local-model" },
  },
  {
    group: "Local",
    label: "Jan",
    needsKey: false,
    cfg: { kind: "openai", endpoint: "http://localhost:1337", model: "local-model" },
  },
];
