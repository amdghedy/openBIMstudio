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
