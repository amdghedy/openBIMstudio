/**
 * App Loader — blocking progress overlay for long operations.
 *
 * Usage:
 *   appLoader.begin("Opening project…");
 *   appLoader.set("Loading models", 0.4);
 *   appLoader.set("Rebuilding", 0.8);
 *   appLoader.finish();
 *
 * While active, the overlay:
 *   • Covers the entire app with a dim + blurred backdrop
 *   • Shows a spinner + progress bar + status line
 *   • Captures pointer events on the capture phase so no underlying button
 *     can be clicked (prevents duplicate operations and hangs)
 *   • Cancels wheel/scroll outside the overlay
 *
 * The overlay is fully self-contained; nothing else in the app has to change.
 */
import { ctx } from "../core/context";
import { register, type AppLoaderService } from "../core/services";

class AppLoader {
  private overlay: HTMLDivElement | null = null;
  private messageEl: HTMLDivElement | null = null;
  private statusEl: HTMLDivElement | null = null;
  private progressEl: HTMLDivElement | null = null;
  private spinner: HTMLDivElement | null = null;
  private cancelBtn: HTMLButtonElement | null = null;
  private cancelCb: (() => void) | null = null;
  private active = false;

  private ensure(): void {
    if (this.overlay) return;

    const ov = document.createElement("div");
    ov.id = "obs-app-loader";
    ov.style.cssText =
      "position:fixed;inset:0;z-index:99998;display:none;" +
      "align-items:center;justify-content:center;background:rgba(8,9,12,.72);" +
      "backdrop-filter:blur(6px);cursor:progress;user-select:none";

    const card = document.createElement("div");
    card.style.cssText =
      "width:min(440px,90vw);background:var(--bg-floating,#1c1e28);" +
      "border:1px solid var(--border-default,#2a2e3a);border-radius:12px;" +
      "padding:22px;box-shadow:0 24px 64px rgba(0,0,0,.65);" +
      "display:flex;flex-direction:column;gap:14px;align-items:center;" +
      "font:13px system-ui,sans-serif;color:var(--text-primary,#e8eaf0)";

    const spinner = document.createElement("div");
    spinner.style.cssText =
      "width:36px;height:36px;border-radius:50%;" +
      "border:3px solid rgba(56,189,248,.2);border-top-color:#38bdf8;" +
      "animation:obs-spin 0.9s linear infinite";
    const styleEl = document.createElement("style");
    styleEl.textContent =
      "@keyframes obs-spin { to { transform: rotate(360deg); } }";
    document.head.appendChild(styleEl);

    const message = document.createElement("div");
    message.style.cssText =
      "font-weight:700;font-size:14px;text-align:center";

    const progress = document.createElement("div");
    progress.style.cssText =
      "width:100%;height:6px;background:rgba(255,255,255,.06);border-radius:3px;" +
      "overflow:hidden";
    const bar = document.createElement("div");
    bar.style.cssText =
      "height:100%;width:0%;background:linear-gradient(90deg,#38bdf8,#818cf8);" +
      "transition:width .18s ease-out";
    progress.appendChild(bar);

    const status = document.createElement("div");
    status.style.cssText =
      "font-size:11.5px;opacity:.7;text-align:center;min-height:16px;line-height:1.5";

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText =
      "display:none;padding:6px 14px;background:transparent;color:#fca5a5;" +
      "border:1px solid rgba(239,68,68,.6);border-radius:6px;cursor:pointer;" +
      "font:600 11.5px system-ui;margin-top:4px";

    card.append(spinner, message, progress, status, cancel);
    ov.appendChild(card);
    document.body.appendChild(ov);

    // ── Block underlying interaction while the overlay is visible ──
    const blockEvent = (e: Event) => {
      if (!this.active) return;
      const target = e.target as Node | null;
      if (target && this.overlay && this.overlay.contains(target)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    // Capture-phase listeners on the whole window.
    window.addEventListener("pointerdown", blockEvent, true);
    window.addEventListener("mousedown", blockEvent, true);
    window.addEventListener("click", blockEvent, true);
    window.addEventListener("wheel", blockEvent, { capture: true, passive: false });
    window.addEventListener("contextmenu", blockEvent, true);
    window.addEventListener("keydown", (e) => {
      if (!this.active) return;
      // Allow Escape to trigger cancel.
      if (e.key === "Escape" && this.cancelCb) {
        e.preventDefault();
        try { this.cancelCb(); } catch { /* */ }
        return;
      }
      // Swallow everything else so hotkeys don't fire mid-load.
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    this.overlay = ov;
    this.messageEl = message;
    this.statusEl = status;
    this.progressEl = bar;
    this.spinner = spinner;
    this.cancelBtn = cancel;
    cancel.onclick = () => { try { this.cancelCb?.(); } catch { /* */ } };
  }

  begin(message: string, opts: { cancellable?: boolean; onCancel?: () => void } = {}): void {
    this.ensure();
    if (!this.overlay) return;
    this.active = true;
    if (this.messageEl) this.messageEl.textContent = message;
    if (this.statusEl) this.statusEl.textContent = "";
    if (this.progressEl) this.progressEl.style.width = "0%";
    if (this.cancelBtn) {
      this.cancelBtn.style.display = opts.cancellable ? "inline-block" : "none";
    }
    this.cancelCb = opts.onCancel ?? null;
    this.overlay.style.display = "flex";

    // Block the ribbon tabs and any hover state that could interfere.
    try { (ctx.rightHost as HTMLElement).style.pointerEvents = "none"; } catch { /* */ }
  }

  set(status: string, progress?: number): void {
    if (!this.active) return;
    if (this.statusEl) this.statusEl.textContent = status;
    if (this.progressEl && typeof progress === "number") {
      const pct = Math.max(0, Math.min(100, progress * 100));
      this.progressEl.style.width = `${pct}%`;
    }
  }

  finish(): void {
    if (!this.overlay) return;
    this.active = false;
    this.overlay.style.display = "none";
    try { (ctx.rightHost as HTMLElement).style.pointerEvents = ""; } catch { /* */ }
  }

  isActive(): boolean {
    return this.active;
  }
}

export const appLoader = new AppLoader();

export function setupAppLoader(): void {
  // Pre-warm the DOM so the first show is instant.
  (appLoader as any).ensure?.();
  const svc: AppLoaderService = {
    begin: (msg, opts) => appLoader.begin(msg, opts),
    set: (s, p) => appLoader.set(s, p),
    finish: () => appLoader.finish(),
    isActive: () => appLoader.isActive(),
  };
  ctx.features.appLoader = svc;
  register("appLoader", svc);
  console.log("[app-loader] ready");
}