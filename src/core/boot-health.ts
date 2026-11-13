/**
 * Boot health — tracked initialization with visible, recoverable failures.
 *
 * Boot previously swallowed every init error with a console.warn inside
 * `safe()` helpers, so a broken module looked identical to a healthy one in
 * the UI. This manager gives every init step:
 *   • timing + outcome tracking (ok / failed, duration, error message)
 *   • one authoritative place to ask "did boot fully succeed?" (`status()`)
 *   • per-step and bulk retry so a transient failure is recoverable without
 *     a full page reload
 *   • a visible surface: a red chip when boot finished with failures, a panel
 *     listing every step, and a persistence layer so the last boot outcome
 *     survives a reload (evidence, not hearsay)
 */

import { ctx } from "./context";
import { diagnostics } from "./diagnostics";

type Any = Record<string, any>;

export interface BootStepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Set when this success came from a retry after a failure. */
  retried?: boolean;
  at: number;
}

export interface BootHealthStatus {
  steps: BootStepResult[];
  failed: string[];
  ok: boolean;
  totalMs: number;
  finalized: boolean;
}

const STORE_KEY = "obs.boot.health.v1";
/** Ring cap for recorded step results. */
const MAX_STEPS = 400;
const listeners = new Set<() => void>();

let steps: BootStepResult[] = [];
let finalized = false;

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener must never break health tracking */
    }
  }
}

function persist(): void {
  try {
    const map = new Map<string, BootStepResult>();
    for (const s of steps) map.set(s.name, s);
    const failed = [...map.values()].filter((s) => !s.ok).map((s) => s.name);
    const totalMs = [...map.values()].reduce((a, s) => a + s.ms, 0);
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({ at: Date.now(), ok: failed.length === 0, totalMs, failed }),
    );
  } catch {
    /* quota — health evidence is best-effort */
  }
}

function lastFailureFor(name: string): BootStepResult | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].name === name) return steps[i];
  }
  return undefined;
}

export const bootHealth = {
  /** Run one named init step, timing it and recording the outcome. Never throws. */
  async runStep(name: string, fn: () => unknown): Promise<boolean> {
    const t0 = Date.now();
    try {
      await fn();
      steps.push({ name, ok: true, ms: Date.now() - t0, at: Date.now(), ...(lastFailureFor(name) ? { retried: true } : {}) });
      emit();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      steps.push({ name, ok: false, ms: Date.now() - t0, error: message, at: Date.now() });
      if (steps.length > MAX_STEPS) steps = steps.slice(-MAX_STEPS);
      diagnostics.warn("boot-health", `init step "${name}" failed: ${message}`, err);
      emit();
      return false;
    }
  },

  status(): BootHealthStatus {
    // Latest outcome per step: a retried-and-fixed step is healthy again.
    const latest = bootHealth.latestPerStep();
    const failed = latest.filter((s) => !s.ok).map((s) => s.name);
    return {
      steps: steps.slice(),
      failed,
      ok: failed.length === 0,
      totalMs: latest.reduce((a, s) => a + s.ms, 0),
      finalized,
    };
  },

  /** Latest result per step name (retries collapse to their newest outcome). */
  latestPerStep(): BootStepResult[] {
    const map = new Map<string, BootStepResult>();
    for (const s of steps) map.set(s.name, s);
    return Array.from(map.values());
  },

  /** Re-run every step whose newest outcome is a failure. Returns names fixed.
   *  Latest outcome per step: a retried-and-fixed step is not re-run again. */
  async retryFailed(): Promise<string[]> {
    const failedNames = bootHealth
      .latestPerStep()
      .filter((s) => !s.ok)
      .map((s) => s.name);
    const fixed: string[] = [];
    for (const name of failedNames) {
      const runner = registry.get(name);
      if (!runner) continue;
      const ok = await bootHealth.runStep(name, runner);
      if (ok) fixed.push(name);
    }
    if (failedNames.length) {
      persist();
      emit();
    }
    return fixed;
  },

  /** Mark the boot sequence complete — flips the chip on if anything failed. */
  finalize(): BootHealthStatus {
    finalized = true;
    persist();
    emit();
    return bootHealth.status();
  },

  /** Last persisted boot summary from a previous page load. */
  lastPersisted(): { at: number; ok: boolean; totalMs: number; failed: string[] } | null {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && typeof p === "object" && Array.isArray(p.failed) ? p : null;
    } catch {
      return null;
    }
  },

  onChange(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  /** Test hook — reset all state. */
  reset(): void {
    steps = [];
    finalized = false;
    registry.clear();
    emit();
  },
};

/** Name → step runner, kept so retries can re-execute the original work. */
const registry = new Map<string, () => unknown>();

/**
 * Register a named step so `retryFailed()` can re-run it.
 * Returns a runner compatible with the existing `safe()` call sites.
 */
export function trackedBootStep(name: string, fn: () => unknown): () => unknown {
  registry.set(name, fn);
  return fn;
}

/* ── Visible recovery surface ────────────────────────────────────────────── */

let chip: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;

function ensureChip(): HTMLDivElement | null {
  if (chip) return chip;
  try {
    const host = (ctx as Any).rightHost as HTMLElement | undefined;
    if (!host) return null;
    chip = document.createElement("div");
    chip.id = "obs-boot-health-chip";
    chip.style.cssText =
      "position:absolute;left:14px;bottom:40px;z-index:57;display:none;padding:2px 10px;" +
      "border-radius:10px;background:rgba(239,68,68,.9);color:#fff;" +
      "font:700 11px/20px system-ui,sans-serif;cursor:pointer;pointer-events:auto;" +
      "box-shadow:0 4px 12px rgba(0,0,0,.4)";
    chip.title = "Startup health — click for details and retry";
    chip.addEventListener("click", () => showBootHealthPanel());
    host.appendChild(chip);
    return chip;
  } catch {
    return null;
  }
}

function refreshChip(): void {
  try {
    const el = ensureChip();
    if (!el) return;
    const failed = bootHealth.status().failed.length;
    if (!finalized || failed === 0) {
      el.style.display = "none";
      return;
    }
    el.style.display = "block";
    el.textContent = `${failed} startup failure${failed === 1 ? "" : "s"}`;
  } catch {
    /* */
  }
}

function rowColor(r: BootStepResult): string {
  return r.ok ? "#4ade80" : "#f87171";
}

function renderPanel(): void {
  if (!panel) return;
  const body = panel.querySelector("[data-body]") as HTMLElement | null;
  if (!body) return;
  const st = bootHealth.status();
  body.innerHTML = "";
  const summary = document.createElement("div");
  summary.style.cssText = "font-size:11px;color:#cbd5e1;margin-bottom:8px";
  summary.textContent =
    `${st.ok ? "Boot complete" : "Boot finished with failures"} · ` +
    `${st.steps.length} step(s) · ${(st.totalMs / 1000).toFixed(1)}s total`;
  body.appendChild(summary);

  const retryBtn = document.createElement("button");
  retryBtn.type = "button";
  retryBtn.textContent = st.failed.length ? `Retry ${st.failed.length} failed step(s)` : "All steps healthy";
  retryBtn.disabled = st.failed.length === 0;
  retryBtn.style.cssText =
    "padding:6px 10px;border-radius:6px;border:1px solid #0284c7;background:#0369a1;color:#fff;" +
    "font-weight:600;cursor:pointer;font-size:11px;margin-bottom:10px";
  retryBtn.onclick = () => {
    void (async () => {
      retryBtn.disabled = true;
      retryBtn.textContent = "Retrying…";
      try {
        await bootHealth.retryFailed();
      } finally {
        renderPanel();
        refreshChip();
      }
    })();
  };
  body.appendChild(retryBtn);

  for (const r of bootHealth.latestPerStep().slice().reverse()) {
    const row = document.createElement("div");
    row.style.cssText =
      "font-size:11px;padding:4px 6px;border-bottom:1px solid #1e2230;color:#cbd5e1;" +
      "display:flex;gap:8px;align-items:baseline";
    row.innerHTML =
      `<span style="color:${rowColor(r)};font-weight:700">${r.ok ? "OK" : "FAIL"}</span>` +
      `<span style="font-family:ui-monospace,monospace">${r.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</span>` +
      `<span style="margin-left:auto;color:#64748b;font-size:10px">${r.ms}ms${r.retried ? " · retried" : ""}</span>` +
      (r.error
        ? `<div style="color:#f87171;font-size:10px;word-break:break-word">${String(r.error).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`
        : "");
    body.appendChild(row);
  }
}

export function showBootHealthPanel(): void {
  try {
    const host = (ctx as Any).rightHost as HTMLElement | undefined;
    if (!host) return;
    if (panel) {
      panel.style.display = "flex";
      renderPanel();
      return;
    }
    panel = document.createElement("div");
    panel.id = "obs-boot-health-panel";
    panel.style.cssText =
      "position:absolute;left:14px;top:14px;width:380px;max-height:70vh;z-index:58;display:flex;" +
      "flex-direction:column;background:#1c1e28;border:1px solid #2a2e3a;border-radius:10px;" +
      "box-shadow:0 16px 44px rgba(0,0,0,.55);color:#e8eaf0;font:12px system-ui,sans-serif;overflow:hidden";
    panel.addEventListener("mousedown", (e) => e.stopPropagation());
    const header = document.createElement("div");
    header.style.cssText =
      "display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid #1e2029;background:#181a23";
    header.innerHTML = `<b style="flex:1">Startup health</b>`;
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText =
      "padding:3px 8px;background:transparent;color:#9ca3af;border:1px solid #2a2e3a;border-radius:5px;cursor:pointer;font-size:11px";
    close.onclick = () => {
      if (panel) panel.style.display = "none";
    };
    header.appendChild(close);
    const body = document.createElement("div");
    body.setAttribute("data-body", "");
    body.style.cssText = "flex:1;overflow-y:auto;padding:10px";
    panel.append(header, body);
    host.appendChild(panel);
    renderPanel();
  } catch (err) {
    console.warn("[boot-health] panel failed", err);
  }
}

export function setupBootHealth(): void {
  bootHealth.onChange(refreshChip);
  refreshChip();
  try {
    (ctx as Any).features = (ctx as Any).features || {};
    (ctx as Any).features.bootHealth = bootHealth;
  } catch {
    /* */
  }
  console.log("[boot-health] ready — init steps tracked, failures visible and retryable");
}
