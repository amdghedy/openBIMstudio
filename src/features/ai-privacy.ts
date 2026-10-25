/**
 * Privacy gate for AI features.
 *
 * Local models (Ollama / LM Studio / anything on this machine or LAN) keep all data on your own
 * network. Any other endpoint is a cloud service: your prompts and the model data excerpts the assistant
 * attaches leave this computer. The first time a cloud host is used the user must approve it explicitly,
 * and the approval is remembered per host.
 */
import { escapeHtml } from "../core/html-escape";

const CONSENT_KEY = "obs.ai.consent.hosts";

/** True for loopback, private-network and same-origin proxy endpoints (data stays on this machine/LAN). */
export function isPrivateEndpoint(endpoint: string, origin = typeof location !== "undefined" ? location.origin : "http://localhost"): boolean {
  let u: URL;
  try { u = new URL(endpoint, origin); } catch { return false; }
  if (u.origin === origin && /^\/(ollama|lmstudio)(\/|$)/.test(u.pathname)) return true;   // local proxies
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(h);                                                     // IPv6 unique-local
}

export function endpointHost(endpoint: string): string {
  try { return new URL(endpoint, location.origin).host; } catch { return endpoint; }
}

function approvedHosts(): string[] {
  try { const v = JSON.parse(localStorage.getItem(CONSENT_KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
export function revokeAiConsent(): void { try { localStorage.removeItem(CONSENT_KEY); } catch { /* */ } }

function askConsent(host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center";
    wrap.innerHTML = `
      <div role="dialog" aria-modal="true" style="background:#141821;color:#e8eaf0;border:1px solid #2a2e3a;border-radius:10px;padding:18px 20px;width:400px;font:13px/1.45 system-ui,sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.6)">
        <div style="font-weight:700;font-size:14px;margin-bottom:8px">Send data to a cloud AI service?</div>
        <div style="opacity:.85;margin-bottom:12px">Your messages, and the parts of your model the assistant looks at (element names, properties, quantities), will be sent over the internet to
          <b>${escapeHtml(host)}</b>. That service's own privacy terms apply.<br><br>
          To keep everything on this computer, choose a local model (Ollama or LM Studio) instead.</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button data-a="no" style="padding:7px 14px;border-radius:6px;border:1px solid #2a2e3a;background:#1e2430;color:#e8eaf0;cursor:pointer">Don't send</button>
          <button data-a="yes" style="padding:7px 14px;border-radius:6px;border:1px solid #2563eb;background:#2563eb;color:#fff;cursor:pointer">Allow ${escapeHtml(host)}</button>
        </div>
      </div>`;
    const done = (v: boolean) => { wrap.remove(); resolve(v); };
    wrap.querySelector('[data-a="no"]')!.addEventListener("click", () => done(false));
    wrap.querySelector('[data-a="yes"]')!.addEventListener("click", () => done(true));
    wrap.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") done(false); e.stopPropagation(); });
    document.body.appendChild(wrap);
    (wrap.querySelector('[data-a="no"]') as HTMLElement).focus();
  });
}

/** Resolve if the endpoint is private or already approved (or the user approves now); otherwise throw. */
export async function ensureAiConsent(endpoint: string): Promise<void> {
  if (isPrivateEndpoint(endpoint)) return;
  const host = endpointHost(endpoint);
  const ok = approvedHosts();
  if (ok.includes(host)) return;
  if (!(await askConsent(host))) throw new Error(`Not sent: you did not approve sending data to ${host}. Use a local model to keep data on this computer.`);
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify([...ok, host])); } catch { /* */ }
}

/* ── Secret redaction for cloud endpoints ────────────────────────────────────
 *
 * Even with per-host consent, the safest default is to never let credentials
 * leave the machine. `redactForCloud` performs a best-effort, high-precision
 * scrub of well-known secret shapes before text is handed to a cloud AI
 * endpoint: API keys, tokens, passwords, bearer/basic/JWT credentials, PEM
 * private keys and credential key/value pairs. Patterns are deliberately
 * conservative to avoid mangling ordinary engineering text (dimensions,
 * quantities, element names); anything that looks like real credentials is
 * replaced with a marker so the model still understands the sentence shape.
 * Pure functions only — no DOM — so the behaviour is unit-testable in Node. */

const REDACTED = "[redacted]";

type Redactor = { re: RegExp; to: (m: string, ...groups: string[]) => string };

const REDACTORS: Redactor[] = [
  // PEM private-key blocks — the whole block including its body.
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, to: () => "[redacted private key]" },
  // JSON Web Tokens (three base64url segments).
  { re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, to: () => REDACTED },
  // Authorization-style schemes: "Bearer <token>", "Basic <base64>".
  { re: /\b(bearer|basic)(\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: (_m, scheme, sep) => `${scheme}${sep}${REDACTED}` },
  // GitHub personal access tokens (classic + fine-grained).
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, to: () => REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, to: () => REDACTED },
  // OpenAI / DeepSeek-style keys (sk-…, sk-proj-…, sk-svcacct-…).
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}\b/g, to: () => REDACTED },
  // AWS access key ids.
  { re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, to: () => REDACTED },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, to: () => REDACTED },
  // Slack tokens.
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, to: () => REDACTED },
  // Groq / Hugging Face keys.
  { re: /\bgsk_[A-Za-z0-9]{20,}\b/g, to: () => REDACTED },
  { re: /\bhf_[A-Za-z0-9]{20,}\b/g, to: () => REDACTED },
  // Credential key/value pairs: token=…, api_key: '…', password = hunter2 …
  // The label list excludes generic words (e.g. "tokens: 4096" stays intact);
  // values that start with an auth scheme word (Bearer/Basic) are left to the
  // dedicated scheme rule above so output stays readable ("Bearer [redacted]").
  {
    re: /\b(token|api[\s_-]?key|api[\s_-]?secret|apikey|secret|client[_-]?secret|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|pwd|passphrase|private[_-]?key|authorization|auth|credential|credentials)\b(\s*["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\b)([^\s"',;)\]}]{3,})/gi,
    to: (_m, label, sep) => `${label}${sep}${REDACTED}`,
  },
  // URL userinfo: https://user:password@host → keep user, drop password.
  { re: /\b(https?:\/\/)([^\s:/@"']+):([^\s@/\"']+)(@)/g, to: (_m, scheme, user, _pw, at) => `${scheme}${user}:${REDACTED}${at}` },
];

/**
 * Return `text` with anything that looks like a credential replaced by
 * `[redacted]`. Never throws; non-string input is returned unchanged.
 */
export function redactForCloud(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const r of REDACTORS) out = out.replace(r.re, r.to as any);
  return out;
}

/** True when `redactForCloud(text)` would change the text (i.e. it contains a likely secret). */
export function containsSecret(text: string): boolean {
  return redactForCloud(text) !== text;
}

/**
 * Deep-scrub every string inside a JSON-like value (tool-call arguments,
 * provider payloads). Arrays and plain objects are traversed up to
 * `maxDepth` levels; primitives are returned via {@link redactForCloud}.
 */
export function redactJsonStringsForCloud(value: unknown, maxDepth = 8): unknown {
  const walk = (v: unknown, d: number): unknown => {
    if (typeof v === "string") return redactForCloud(v);
    if (d <= 0) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, d - 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, d - 1);
      return out;
    }
    return v;
  };
  return walk(value, maxDepth);
}
